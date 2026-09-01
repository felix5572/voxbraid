import type { ModelUsage, SidecarErrorCode, SidecarInvokeResult } from '../sidecar/types';
import { json } from '@sveltejs/kit';
import {
	parseSidecarInvokeRequest,
	prepareSidecarCall,
	SidecarRequestValidationError,
	type PreparedSidecarCall
} from './sidecar-tasks';

const INPUT_TOKENS_URL = 'https://api.openai.com/v1/responses/input_tokens';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const SIDECAR_REQUEST_TIMEOUT_MS = 60_000;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type UpstreamTerminalStatus = 'failed' | 'incomplete' | 'cancelled';

interface InvokeSidecarOptions {
	request: Request;
	fetcher: Fetcher;
	apiKey: string;
	now?: () => string;
	timeoutMs?: number;
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

function upstreamErrorMessage(value: unknown): string | null {
	return isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string'
		? value.error.message
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
		error: { code, message },
		failedAt: now()
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
	return error.code === 'context-too-large' ? 413 : 400;
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
	timeoutMs = SIDECAR_REQUEST_TIMEOUT_MS
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

	let countResponse: Response;
	try {
		countResponse = await upstreamFetch(INPUT_TOKENS_URL, responseBody(prepared), {
			fetcher,
			apiKey,
			timeoutMs
		});
	} catch (error) {
		console.error('[sidecar] input token count failed', {
			name: error instanceof Error ? error.name : 'UnknownError',
			message: error instanceof Error ? error.message : 'Unknown failure'
		});
		return json(
			failure(
				prepared.clientRequestId,
				now,
				'budget-check-failed',
				`输入 token 计数请求失败：${error instanceof Error ? error.message : '未知错误'}`,
				{ model: prepared.model }
			),
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	const countRequestId = requestId(countResponse);
	const countBody: unknown = await countResponse.json().catch(() => null);
	if (!countResponse.ok || !isRecord(countBody) || !nonNegativeNumber(countBody.input_tokens)) {
		const upstreamMessage = upstreamErrorMessage(countBody);
		console.error('[sidecar] input token count rejected', {
			status: countResponse.status,
			requestId: countRequestId,
			code: stringField(isRecord(countBody) ? countBody.error : null, 'code')
		});
		return json(
			failure(
				prepared.clientRequestId,
				now,
				'budget-check-failed',
				`OpenAI 输入 token 计数失败（HTTP ${countResponse.status}${requestIdSuffix(countRequestId)}）${upstreamMessage ? `：${upstreamMessage}` : '。'}`,
				{ model: prepared.model }
			),
			{ status: 502, headers: noStoreHeaders() }
		);
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

	let upstream: Response;
	try {
		upstream = await upstreamFetch(
			RESPONSES_URL,
			{
				...responseBody(prepared),
				max_output_tokens: prepared.maxOutputTokens,
				store: false,
				stream: false
			},
			{ fetcher, apiKey, timeoutMs }
		);
	} catch (error) {
		const timedOut = error instanceof Error && error.name === 'AbortError';
		console.error('[sidecar] response request failed', {
			name: error instanceof Error ? error.name : 'UnknownError',
			message: error instanceof Error ? error.message : 'Unknown failure'
		});
		return json(
			failure(
				prepared.clientRequestId,
				now,
				timedOut ? 'request-timeout' : 'upstream-failed',
				timedOut
					? `模型调用在 ${timeoutMs} ms 后超时；上游可能已经产生费用。`
					: `模型调用失败：${error instanceof Error ? error.message : '未知错误'}`,
				{ model: prepared.model }
			),
			{ status: timedOut ? 504 : 502, headers: noStoreHeaders() }
		);
	}

	const upstreamRequestId = requestId(upstream);
	const body: unknown = await upstream.json().catch(() => null);
	if (!upstream.ok || !isRecord(body)) {
		const upstreamMessage = upstreamErrorMessage(body);
		console.error('[sidecar] response rejected', {
			status: upstream.status,
			requestId: upstreamRequestId,
			code: stringField(isRecord(body) ? body.error : null, 'code')
		});
		return json(
			failure(
				prepared.clientRequestId,
				now,
				'upstream-failed',
				`OpenAI 模型调用失败（HTTP ${upstream.status}${requestIdSuffix(upstreamRequestId)}）${upstreamMessage ? `：${upstreamMessage}` : '。'}`,
				{ model: prepared.model }
			),
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	const responseId = stringField(body, 'id');
	const model = stringField(body, 'model') ?? prepared.model;
	const outputText = extractOutputText(body);
	const usage = extractUsage(body);
	if (body.status === 'completed' && responseId) {
		const result: SidecarInvokeResult = {
			status: 'completed',
			clientRequestId: prepared.clientRequestId,
			responseId,
			model,
			outputText,
			usageStatus: usage ? 'recorded' : 'unavailable',
			usage,
			completedAt: now()
		};
		return json(result, { headers: noStoreHeaders() });
	}

	const status = terminalStatus(body.status);
	return json(
		failure(
			prepared.clientRequestId,
			now,
			status === 'incomplete' ? 'upstream-incomplete' : 'upstream-failed',
			`OpenAI 返回终态 ${String(body.status ?? 'unknown')}${requestIdSuffix(upstreamRequestId)}。`,
			{
				responseId,
				model,
				outputText: outputText || null,
				upstreamStatus: status,
				usage
			}
		),
		{ status: 502, headers: noStoreHeaders() }
	);
}
