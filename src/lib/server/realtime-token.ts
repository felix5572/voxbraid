import { isTargetLanguage } from '../realtime/types';
import { json } from '@sveltejs/kit';

const CLIENT_SECRET_URL = 'https://api.openai.com/v1/realtime/translations/client_secrets';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ClientSecretResponse {
	value?: unknown;
	expires_at?: unknown;
	session?: { id?: unknown };
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

	if (!isTargetLanguage(targetLanguage)) {
		return json(
			{ message: '请选择受支持的目标语言。' },
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
					model: 'gpt-realtime-translate',
					audio: {
						input: {
							transcription: { model: 'gpt-realtime-whisper' },
							noise_reduction: { type: 'far_field' }
						},
						output: { language: targetLanguage }
					}
				}
			})
		});
	} catch (error) {
		console.error('[realtime-token] OpenAI request failed', {
			name: error instanceof Error ? error.name : 'UnknownError',
			message: error instanceof Error ? error.message : 'Unknown failure'
		});
		return json(
			{ message: '暂时无法连接 OpenAI，请稍后重试。' },
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	if (!upstream.ok) {
		const requestId = upstream.headers.get('x-request-id');
		const upstreamBody: unknown = await upstream.json().catch(() => null);
		console.error('[realtime-token] OpenAI rejected client secret request', {
			status: upstream.status,
			requestId,
			code: readUpstreamErrorCode(upstreamBody)
		});
		return json(
			{
				message: `OpenAI 拒绝了实时翻译凭证请求（HTTP ${upstream.status}）。`,
				requestId
			},
			{ status: 502, headers: noStoreHeaders() }
		);
	}

	const data = (await upstream.json()) as ClientSecretResponse;
	if (
		typeof data.value !== 'string' ||
		typeof data.expires_at !== 'number' ||
		typeof data.session?.id !== 'string'
	) {
		console.error('[realtime-token] OpenAI returned an unexpected client secret response');
		return json(
			{ message: 'OpenAI 返回了无法识别的凭证响应。' },
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
