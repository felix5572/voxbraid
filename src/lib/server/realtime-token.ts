import {
	REALTIME_TRANSCRIPTION_MODEL,
	REALTIME_TRANSLATION_MODEL
} from '../realtime/usage-estimate';
import {
	DEFAULT_REALTIME_NOISE_REDUCTION_MODE,
	isRealtimeNoiseReductionMode,
	isRealtimeTranscriptionModel,
	isTargetLanguage
} from '../realtime/types';
import { errorDetails } from '../error-details';
import { json } from '@sveltejs/kit';

const CLIENT_SECRET_URL = 'https://api.openai.com/v1/realtime/translations/client_secrets';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ClientSecretResponse {
	value?: unknown;
	expires_at?: unknown;
	session?: { id?: unknown };
}

function boundedBody(value: string): string {
	const limit = 4_096;
	if (!value) return '[上游响应体为空]';
	return value.length > limit
		? `[上游响应共 ${value.length} 字符；以下为前 ${limit} 字符]\n${value.slice(0, limit)}\n[上游响应已截断]`
		: `[上游响应共 ${value.length} 字符]\n${value}`;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function upstreamErrorDetails(value: unknown): string | null {
	if (typeof value !== 'object' || value === null || !('error' in value)) return null;
	const candidate = value.error;
	if (typeof candidate !== 'object' || candidate === null) return null;
	const fields = [
		'message' in candidate && typeof candidate.message === 'string' ? candidate.message : null,
		'type' in candidate && typeof candidate.type === 'string' ? `type=${candidate.type}` : null,
		'code' in candidate && typeof candidate.code === 'string' ? `code=${candidate.code}` : null,
		'param' in candidate && typeof candidate.param === 'string' ? `param=${candidate.param}` : null
	].filter((field): field is string => field !== null);
	return fields.length > 0 ? fields.join('；') : null;
}

function responseShape(value: unknown): string {
	if (typeof value !== 'object' || value === null) return `responseType=${typeof value}`;
	const record = value as Record<string, unknown>;
	return [
		`value=${typeof record.value}`,
		`expires_at=${typeof record.expires_at}`,
		`session=${typeof record.session}`,
		`session.id=${
			typeof record.session === 'object' && record.session !== null
				? typeof (record.session as Record<string, unknown>).id
				: 'unavailable'
		}`
	].join('，');
}

export interface IssueTranslationTokenOptions {
	request: Request;
	fetcher: Fetcher;
	apiKey: string;
}

function noStoreHeaders(): HeadersInit {
	return { 'Cache-Control': 'no-store, private' };
}

function readUpstreamErrorCode(value: unknown): string | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('error' in value) ||
		typeof value.error !== 'object' ||
		value.error === null ||
		!('code' in value.error) ||
		typeof value.error.code !== 'string'
	) {
		return undefined;
	}
	return value.error.code;
}

export async function issueTranslationToken({
	request,
	fetcher,
	apiKey
}: IssueTranslationTokenOptions): Promise<Response> {
	const body: unknown = await request.json().catch(() => null);
	const targetLanguage =
		typeof body === 'object' && body !== null && 'targetLanguage' in body
			? body.targetLanguage
			: null;
	const requestedTranscriptionModel =
		typeof body === 'object' && body !== null && 'transcriptionModel' in body
			? body.transcriptionModel
			: REALTIME_TRANSCRIPTION_MODEL;
	const requestedNoiseReduction =
		typeof body === 'object' && body !== null && 'noiseReduction' in body
			? body.noiseReduction
			: DEFAULT_REALTIME_NOISE_REDUCTION_MODE;

	if (!isTargetLanguage(targetLanguage)) {
		return json(
			{ message: '请选择受支持的目标语言。' },
			{ status: 400, headers: noStoreHeaders() }
		);
	}
	if (!isRealtimeTranscriptionModel(requestedTranscriptionModel)) {
		return json(
			{ message: '请选择受支持的原文转写模型。' },
			{ status: 400, headers: noStoreHeaders() }
		);
	}
	if (!isRealtimeNoiseReductionMode(requestedNoiseReduction)) {
		return json(
			{ message: '请选择受支持的输入降噪模式。' },
			{ status: 400, headers: noStoreHeaders() }
		);
	}

	let upstream: Response;
	try {
		upstream = await fetcher(CLIENT_SECRET_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				expires_after: {
					anchor: 'created_at',
					seconds: 120
				},
				session: {
					model: REALTIME_TRANSLATION_MODEL,
					audio: {
						input: {
							transcription: { model: requestedTranscriptionModel },
							noise_reduction:
								requestedNoiseReduction === 'off' ? null : { type: requestedNoiseReduction }
						},
						output: { language: targetLanguage }
					}
				}
			})
		});
	} catch (error) {
		const details = errorDetails(error);
		console.error('[realtime-token] OpenAI request failed', {
			error: details
		});
		return json(
			{ message: `暂时无法连接 OpenAI。\n原始错误：\n${details}` },
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	const rawUpstream = await upstream
		.text()
		.catch((error) => `[读取上游响应体失败]\n${errorDetails(error)}`);
	const upstreamBody = parseJson(rawUpstream);
	if (!upstream.ok) {
		const requestId = upstream.headers.get('x-request-id');
		console.error('[realtime-token] OpenAI rejected client secret request', {
			status: upstream.status,
			requestId,
			code: readUpstreamErrorCode(upstreamBody),
			body: boundedBody(rawUpstream)
		});
		return json(
			{
				message: `OpenAI 拒绝了实时翻译凭证请求（HTTP ${upstream.status}${requestId ? `，request ID ${requestId}` : ''}）${upstreamErrorDetails(upstreamBody) ? `：${upstreamErrorDetails(upstreamBody)}` : '。'}\n原始响应：\n${boundedBody(rawUpstream)}`,
				requestId
			},
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	const data = upstreamBody as ClientSecretResponse | null;
	if (
		!data ||
		typeof data.value !== 'string' ||
		typeof data.expires_at !== 'number' ||
		typeof data.session?.id !== 'string'
	) {
		const requestId = upstream.headers.get('x-request-id');
		const shape = responseShape(upstreamBody);
		console.error('[realtime-token] OpenAI returned an unexpected client secret response', {
			requestId,
			shape
		});
		return json(
			{
				message: `OpenAI 返回了无法识别的凭证响应${requestId ? `（request ID ${requestId}）` : ''}。为避免泄露短期凭证，只报告字段形状：${shape}`,
				requestId
			},
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	return json(
		{
			clientSecret: data.value,
			expiresAt: data.expires_at
		},
		{ headers: noStoreHeaders() }
	);
}
