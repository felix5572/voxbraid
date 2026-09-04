import type {
	ModelUsage,
	SidecarErrorCode,
	SidecarInvokeResult,
	SidecarTransportDiagnostic,
	SidecarRetryDisposition,
	SidecarWarning
} from '../sidecar/types';
import { errorDetails } from '../error-details';
import {
	parseRevisionModelOutput,
	RevisionBoundaryError,
	REVISION_OUTPUT_SCHEMA
} from '../projection/revision-output';
import { json } from '@sveltejs/kit';
import {
	parseSidecarInvokeRequest,
	prepareSidecarCall,
	SidecarRequestValidationError,
	type PreparedSidecarCall
} from './sidecar-tasks';
import {
	type ResponsesTransportResult,
	type RevisionResponsesTransport,
	WebSocketBeforeSendError,
	WebSocketOutcomeUnknownError
} from './responses-websocket';

const INPUT_TOKENS_URL = 'https://api.openai.com/v1/responses/input_tokens';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type UpstreamTerminalStatus = 'failed' | 'incomplete' | 'cancelled';

interface InvokeSidecarOptions {
	request: Request;
	fetcher: Fetcher;
	apiKey: string;
	now?: () => string;
	timeoutMs?: number;
	revisionResponsesTransport?: RevisionResponsesTransport | null;
}

function noStoreHeaders(): HeadersInit {
	return { 'Cache-Control': 'no-store, private' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function nonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stringField(value: unknown, key: string): string | null {
	return isRecord(value) && typeof value[key] === 'string' ? value[key] : null;
}

function boundedResponseBody(value: string): string {
	const limit = 4_096;
	if (!value) return '[上游响应体为空]';
	return value.length > limit
		? `[上游响应共 ${value.length} 字符；以下为前 ${limit} 字符]\n${value.slice(0, limit)}\n[上游响应已截断]`
		: `[上游响应共 ${value.length} 字符]\n${value}`;
}

async function readUpstreamBody(response: Response): Promise<{ raw: string; parsed: unknown }> {
	let raw: string;
	try {
		raw = await response.text();
	} catch (error) {
		raw = `[读取上游响应体失败]\n${errorDetails(error)}`;
	}
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Non-JSON proxy, CDN and overload responses remain available through raw.
	}
	return { raw, parsed };
}

function upstreamErrorDetails(value: unknown): string | null {
	if (!isRecord(value) || !isRecord(value.error)) return null;
	const error = value.error;
	const message = typeof error.message === 'string' ? error.message : null;
	const fields = [
		typeof error.type === 'string' ? `type=${error.type}` : null,
		typeof error.code === 'string' ? `code=${error.code}` : null,
		typeof error.param === 'string' ? `param=${error.param}` : null
	].filter((field): field is string => field !== null);
	if (!message && fields.length === 0) return null;
	return `${message ?? 'OpenAI 返回错误'}${fields.length > 0 ? `（${fields.join('，')}）` : ''}`;
}

function incompleteReason(value: unknown): string | null {
	return isRecord(value) &&
		isRecord(value.incomplete_details) &&
		typeof value.incomplete_details.reason === 'string'
		? value.incomplete_details.reason
		: null;
}

function requestId(response: Response): string | null {
	return response.headers.get('x-request-id');
}

function requestIdSuffix(value: string | null): string {
	return value ? `，request ID ${value}` : '';
}

function failure(
	clientRequestId: string,
	now: () => string,
	code: SidecarErrorCode,
	message: string,
	options: {
		responseId?: string | null;
		model?: string | null;
		outputText?: string | null;
		upstreamStatus?: UpstreamTerminalStatus | null;
		usage?: ModelUsage | null;
		transportDiagnostic?: SidecarTransportDiagnostic | null;
		warnings?: readonly SidecarWarning[];
		retryDisposition?: SidecarRetryDisposition;
	} = {}
): SidecarInvokeResult {
	const usage = options.usage ?? null;
	return {
		status: 'failed',
		clientRequestId,
		responseId: options.responseId ?? null,
		model: options.model ?? null,
		outputText: options.outputText ?? null,
		upstreamStatus: options.upstreamStatus ?? null,
		usageStatus: usage ? 'recorded' : 'unavailable',
		usage,
		transportDiagnostic: options.transportDiagnostic ?? null,
		warnings: options.warnings ? [...options.warnings] : undefined,
		retryDisposition:
			options.retryDisposition ??
			(code === 'atomizer-version-mismatch' ? 'reload-required' : 'manual-only'),
		diagnostic: null,
		error: { code, message },
		failedAt: now()
	};
}

function httpTransportDiagnostic(
	transport: 'http' | 'http-fallback',
	startedAtMs: number,
	completedAtMs: number,
	fallbackError: string | null
): SidecarTransportDiagnostic {
	return {
		transport,
		chainAction: 'none',
		streamId: null,
		chainTurn: null,
		chainAgeMs: null,
		firstEventMs: null,
		completedMs: completedAtMs - startedAtMs,
		fallbackError
	};
}

function responseBody(prepared: PreparedSidecarCall): Record<string, unknown> {
	return {
		model: prepared.model,
		instructions: prepared.instructions,
		input: prepared.inputText,
		truncation: 'disabled'
	};
}

function preparedInputBytes(prepared: PreparedSidecarCall): number {
	return new TextEncoder().encode(
		JSON.stringify({ instructions: prepared.instructions, input: prepared.inputText })
	).byteLength;
}

async function upstreamFetch(
	url: string,
	body: object,
	options: { fetcher: Fetcher; apiKey: string; timeoutMs: number }
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		return await options.fetcher(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}

function extractOutputText(value: unknown): string {
	if (!isRecord(value)) return '';
	if (typeof value.output_text === 'string') return value.output_text;
	if (!Array.isArray(value.output)) return '';
	const parts: string[] = [];
	for (const item of value.output) {
		if (!isRecord(item) || !Array.isArray(item.content)) continue;
		for (const content of item.content) {
			if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
				parts.push(content.text);
			}
		}
	}
	return parts.join('');
}

function extractUsage(value: unknown): ModelUsage | null {
	if (!isRecord(value) || !isRecord(value.usage)) return null;
	const usage = value.usage;
	if (
		!nonNegativeNumber(usage.input_tokens) ||
		!nonNegativeNumber(usage.output_tokens) ||
		!nonNegativeNumber(usage.total_tokens)
	) {
		return null;
	}
	const cachedInputTokens = isRecord(usage.input_tokens_details)
		? usage.input_tokens_details.cached_tokens
		: null;
	const reasoningTokens = isRecord(usage.output_tokens_details)
		? usage.output_tokens_details.reasoning_tokens
		: null;
	return {
		inputTokens: usage.input_tokens,
		cachedInputTokens: nonNegativeNumber(cachedInputTokens) ? cachedInputTokens : null,
		outputTokens: usage.output_tokens,
		reasoningTokens: nonNegativeNumber(reasoningTokens) ? reasoningTokens : null,
		totalTokens: usage.total_tokens
	};
}

function terminalStatus(value: unknown): UpstreamTerminalStatus | null {
	return value === 'failed' || value === 'incomplete' || value === 'cancelled' ? value : null;
}

function validationStatus(error: SidecarRequestValidationError): number {
	if (error.code === 'context-too-large') return 413;
	if (error.code === 'atomizer-version-mismatch') return 409;
	return 400;
}

function clientRequestIdFrom(value: unknown): string {
	return isRecord(value) && typeof value.clientRequestId === 'string'
		? value.clientRequestId.slice(0, 256)
		: '';
}

export async function invokeSidecar({
	request,
	fetcher,
	apiKey,
	now = () => new Date().toISOString(),
	timeoutMs,
	revisionResponsesTransport = null
}: InvokeSidecarOptions): Promise<Response> {
	const rawBody: unknown = await request.json().catch(() => null);
	const clientRequestId = clientRequestIdFrom(rawBody);
	let prepared: PreparedSidecarCall;
	try {
		prepared = prepareSidecarCall(parseSidecarInvokeRequest(rawBody));
	} catch (error) {
		if (!(error instanceof SidecarRequestValidationError)) throw error;
		return json(failure(clientRequestId, now, error.code, error.message), {
			status: validationStatus(error),
			headers: noStoreHeaders()
		});
	}
	const effectiveTimeoutMs = timeoutMs ?? prepared.requestTimeoutMs;
	if (prepared.warnings.length > 0) {
		console.warn('[sidecar] request prepared with warnings', {
			clientRequestId: prepared.clientRequestId,
			warnings: prepared.warnings
		});
	}
	console.info('[sidecar] request started', {
		clientRequestId: prepared.clientRequestId,
		kind: prepared.kind,
		taskVersion: prepared.taskVersion,
		model: prepared.model
	});
	const inputBytes = preparedInputBytes(prepared);
	if (prepared.maxPreparedInputBytes !== null && inputBytes > prepared.maxPreparedInputBytes) {
		return json(
			failure(
				prepared.clientRequestId,
				now,
				'context-too-large',
				`句段对照最终模型输入为 ${inputBytes} 字节，超过 ${prepared.maxPreparedInputBytes} 字节上限。`,
				{ model: prepared.model }
			),
			{ status: 413, headers: noStoreHeaders() }
		);
	}

	if (prepared.inputTokenPreflight === 'required') {
		let countResponse: Response;
		try {
			countResponse = await upstreamFetch(INPUT_TOKENS_URL, responseBody(prepared), {
				fetcher,
				apiKey,
				timeoutMs: effectiveTimeoutMs
			});
		} catch (error) {
			const details = errorDetails(error);
			console.error('[sidecar] input token count failed', {
				clientRequestId: prepared.clientRequestId,
				error: details
			});
			return json(
				failure(
					prepared.clientRequestId,
					now,
					'budget-check-failed',
					`输入 token 计数请求失败。原始错误：\n${details}`,
					{ model: prepared.model }
				),
				{ status: 502, headers: noStoreHeaders() }
			);
		}

		const countRequestId = requestId(countResponse);
		const countResult = await readUpstreamBody(countResponse);
		const countBody = countResult.parsed;
		if (!countResponse.ok || !isRecord(countBody) || !nonNegativeNumber(countBody.input_tokens)) {
			const upstreamDetails = upstreamErrorDetails(countBody);
			const rawUpstream = boundedResponseBody(countResult.raw);
			console.error('[sidecar] input token count rejected', {
				clientRequestId: prepared.clientRequestId,
				status: countResponse.status,
				requestId: countRequestId,
				code: stringField(isRecord(countBody) ? countBody.error : null, 'code'),
				body: rawUpstream
			});
			return json(
				failure(
					prepared.clientRequestId,
					now,
					'budget-check-failed',
					`OpenAI 输入 token 计数失败（HTTP ${countResponse.status}${requestIdSuffix(countRequestId)}）${upstreamDetails ? `：${upstreamDetails}` : '。'}\n原始响应：\n${rawUpstream}`,
					{ model: prepared.model }
				),
				{ status: 502, headers: noStoreHeaders() }
			);
		}

		if (prepared.maxInputTokens === null) {
			throw new Error('A task requiring token preflight must define maxInputTokens.');
		}
		if (countBody.input_tokens > prepared.maxInputTokens) {
			return json(
				failure(
					prepared.clientRequestId,
					now,
					'context-too-large',
					`所选字幕共 ${countBody.input_tokens} 个输入 token，超过此任务 ${prepared.maxInputTokens} 个的上限。`,
					{ model: prepared.model }
				),
				{ status: 413, headers: noStoreHeaders() }
			);
		}
	}

	const generationBody = {
		...responseBody(prepared),
		max_output_tokens: prepared.maxOutputTokens,
		store: false,
		stream: false,
		...(prepared.reasoningEffort ? { reasoning: { effort: prepared.reasoningEffort } } : {}),
		...(prepared.structuredOutput === 'revision-pairs'
			? { text: { format: REVISION_OUTPUT_SCHEMA } }
			: {})
	};
	let upstreamResult: ResponsesTransportResult;
	let transport: 'http' | 'http-fallback' = 'http';
	let webSocketBeforeSendDetails: string | null = null;
	const invokeHttp = async (): Promise<ResponsesTransportResult> => {
		const startedAtMs = Date.now();
		const response = await upstreamFetch(RESPONSES_URL, generationBody, {
			fetcher,
			apiKey,
			timeoutMs: effectiveTimeoutMs
		});
		const result = await readUpstreamBody(response);
		return {
			ok: response.ok,
			status: response.status,
			body: result.parsed,
			rawBody: result.raw,
			requestId: requestId(response),
			transportDiagnostic: httpTransportDiagnostic(
				transport,
				startedAtMs,
				Date.now(),
				webSocketBeforeSendDetails
			)
		};
	};

	try {
		if (revisionResponsesTransport && prepared.kind === 'revise-pairs') {
			try {
				upstreamResult = await revisionResponsesTransport.invoke({
					prepared,
					body: generationBody,
					apiKey,
					timeoutMs: effectiveTimeoutMs
				});
			} catch (error) {
				if (error instanceof WebSocketOutcomeUnknownError) {
					const details = errorDetails(error);
					console.error('[sidecar] websocket outcome unknown', {
						clientRequestId: prepared.clientRequestId,
						transport: error.diagnostic,
						error: details
					});
					return json(
						failure(
							prepared.clientRequestId,
							now,
							'websocket-outcome-unknown',
							`Responses WebSocket 请求已发出，但没有收到可确认的终态；为避免重复计费，本次不会自动改走 HTTP。原始错误：\n${details}`,
							{ model: prepared.model, transportDiagnostic: error.diagnostic }
						),
						{ status: 502, headers: noStoreHeaders() }
					);
				}
				if (!(error instanceof WebSocketBeforeSendError)) throw error;
				transport = 'http-fallback';
				webSocketBeforeSendDetails = errorDetails(error);
				console.error('[sidecar] websocket failed before send; using HTTP', {
					clientRequestId: prepared.clientRequestId,
					error: webSocketBeforeSendDetails
				});
				upstreamResult = await invokeHttp();
			}
		} else {
			upstreamResult = await invokeHttp();
		}
	} catch (error) {
		const timedOut = error instanceof Error && error.name === 'AbortError';
		const details = errorDetails(error);
		console.error('[sidecar] response request failed', {
			clientRequestId: prepared.clientRequestId,
			error: details
		});
		return json(
			failure(
				prepared.clientRequestId,
				now,
				timedOut ? 'request-timeout' : 'upstream-failed',
				timedOut
					? `模型调用在 ${effectiveTimeoutMs} ms 后超时；上游可能已经产生费用。${webSocketBeforeSendDetails ? `此前 WebSocket 在发送前失败并转用 HTTP：\n${webSocketBeforeSendDetails}\n` : ''}原始错误：\n${details}`
					: `模型调用失败。${webSocketBeforeSendDetails ? `此前 WebSocket 在发送前失败并转用 HTTP：\n${webSocketBeforeSendDetails}\n` : ''}原始错误：\n${details}`,
				{ model: prepared.model }
			),
			{ status: timedOut ? 504 : 502, headers: noStoreHeaders() }
		);
	}

	const upstreamRequestId = upstreamResult.requestId;
	const body = upstreamResult.body;
	if (!upstreamResult.ok || !isRecord(body)) {
		revisionResponsesTransport?.invalidate(prepared);
		const upstreamDetails = upstreamErrorDetails(body);
		const rawUpstream = boundedResponseBody(upstreamResult.rawBody);
		console.error('[sidecar] response rejected', {
			clientRequestId: prepared.clientRequestId,
			status: upstreamResult.status,
			requestId: upstreamRequestId,
			code: stringField(isRecord(body) ? body.error : null, 'code'),
			transport: upstreamResult.transportDiagnostic,
			body: rawUpstream
		});
		return json(
			failure(
				prepared.clientRequestId,
				now,
				'upstream-failed',
				`OpenAI 模型调用失败（${upstreamResult.transportDiagnostic.transport === 'websocket' ? 'WebSocket 请求级错误' : `HTTP ${upstreamResult.status}`}${requestIdSuffix(upstreamRequestId)}）${upstreamDetails ? `：${upstreamDetails}` : '。'}\n原始响应：\n${rawUpstream}`,
				{
					model: prepared.model,
					transportDiagnostic: upstreamResult.transportDiagnostic,
					retryDisposition: 'automatic'
				}
			),
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	const responseId = stringField(body, 'id');
	const model = stringField(body, 'model') ?? prepared.model;
	let outputText = extractOutputText(body);
	const usage = extractUsage(body);
	if (body.status === 'completed' && responseId) {
		if (!outputText.trim()) {
			revisionResponsesTransport?.invalidate(prepared);
			const rawUpstream = boundedResponseBody(upstreamResult.rawBody);
			console.error('[sidecar] completed response contained no output text', {
				clientRequestId: prepared.clientRequestId,
				responseId,
				requestId: upstreamRequestId,
				model,
				transport: upstreamResult.transportDiagnostic,
				body: rawUpstream
			});
			return json(
				failure(
					prepared.clientRequestId,
					now,
					'invalid-response',
					`OpenAI 报告响应已完成，但没有返回非空 output_text${requestIdSuffix(upstreamRequestId)}。\n原始响应：\n${rawUpstream}`,
					{
						responseId,
						model,
						usage,
						transportDiagnostic: upstreamResult.transportDiagnostic
					}
				),
				{ status: 502, headers: noStoreHeaders() }
			);
		}
		if (prepared.structuredOutput === 'revision-pairs') {
			try {
				// Group length is a reading preference, not a correctness boundary.
				// Only atom coverage and the bounded request range can reject output.
				const parsedRevision = parseRevisionModelOutput(
					outputText,
					prepared.revisionAtoms.map((atom) => ({
						index: atom.i,
						start: atom.start,
						end: atom.end,
						text: atom.t,
						boundary: atom.boundary
					}))
				);
				outputText = JSON.stringify(parsedRevision.output);
			} catch (error) {
				revisionResponsesTransport?.invalidate(prepared);
				const details = errorDetails(error);
				const errorCode: SidecarErrorCode =
					error instanceof RevisionBoundaryError ? 'invalid-revision-boundary' : 'invalid-response';
				console.error('[sidecar] revision pair output validation failed', {
					clientRequestId: prepared.clientRequestId,
					responseId,
					requestId: upstreamRequestId,
					error: details,
					outputText: boundedResponseBody(outputText)
				});
				return json(
					failure(
						prepared.clientRequestId,
						now,
						errorCode,
						`OpenAI 修订对照输出没有通过原子覆盖校验${requestIdSuffix(upstreamRequestId)}。\n原始错误：\n${details}\n原始模型输出：\n${boundedResponseBody(outputText)}`,
						{
							responseId,
							model,
							outputText: outputText || null,
							usage,
							transportDiagnostic: upstreamResult.transportDiagnostic
						}
					),
					{ status: 502, headers: noStoreHeaders() }
				);
			}
		}
		console.info('[sidecar] request completed', {
			clientRequestId: prepared.clientRequestId,
			responseId,
			requestId: upstreamRequestId,
			model,
			transport: upstreamResult.transportDiagnostic
		});
		const result: SidecarInvokeResult = {
			status: 'completed',
			clientRequestId: prepared.clientRequestId,
			responseId,
			model,
			outputText,
			usageStatus: usage ? 'recorded' : 'unavailable',
			usage,
			transportDiagnostic: upstreamResult.transportDiagnostic,
			...(prepared.warnings.length > 0 ? { warnings: [...prepared.warnings] } : {}),
			completedAt: now()
		};
		return json(result, { headers: noStoreHeaders() });
	}

	const status = terminalStatus(body.status);
	const reason = incompleteReason(body);
	revisionResponsesTransport?.invalidate(prepared);
	const terminalBody = boundedResponseBody(upstreamResult.rawBody);
	console.error('[sidecar] response reached a non-completed terminal state', {
		clientRequestId: prepared.clientRequestId,
		status: body.status,
		reason,
		requestId: upstreamRequestId,
		transport: upstreamResult.transportDiagnostic,
		body: terminalBody
	});
	return json(
		failure(
			prepared.clientRequestId,
			now,
			status === 'incomplete' ? 'upstream-incomplete' : 'upstream-failed',
			`OpenAI 返回终态 ${String(body.status ?? 'unknown')}${requestIdSuffix(upstreamRequestId)}${reason ? `，incomplete_details.reason=${reason}` : ''}。\n原始响应：\n${terminalBody}`,
			{
				responseId,
				model,
				outputText: outputText || null,
				upstreamStatus: status,
				usage,
				transportDiagnostic: upstreamResult.transportDiagnostic,
				retryDisposition: 'automatic'
			}
		),
		{ status: 502, headers: noStoreHeaders() }
	);
}
