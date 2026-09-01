import {
	DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
	type RealtimeTranscriptionModel,
	type TargetLanguage,
	type TranslationTokenResponse
} from './types';

export const REALTIME_TRANSLATION_CALLS_URL =
	'https://api.openai.com/v1/realtime/translations/calls';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function apiResponseError(response: Response, fallback: string): Promise<Error> {
	const body = await response.text();
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === 'object' && parsed !== null) {
			if ('message' in parsed && typeof parsed.message === 'string') {
				return new Error(parsed.message);
			}
			if (
				'error' in parsed &&
				typeof parsed.error === 'object' &&
				parsed.error !== null &&
				'message' in parsed.error &&
				typeof parsed.error.message === 'string'
			) {
				return new Error(parsed.error.message);
			}
		}
	} catch {
		// SDP errors may be plain text instead of JSON.
	}
	return new Error(`${fallback}（HTTP ${response.status}）`);
}

export async function fetchTranslationToken(
	targetLanguage: TargetLanguage,
	fetcher: Fetcher = fetch,
	signal?: AbortSignal,
	transcriptionModel: RealtimeTranscriptionModel = DEFAULT_REALTIME_TRANSCRIPTION_MODEL
): Promise<TranslationTokenResponse> {
	const response = await fetcher('/api/realtime/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ targetLanguage, transcriptionModel }),
		signal
	});

	if (!response.ok) {
		throw await apiResponseError(response, '无法创建实时翻译凭证');
	}

	const token: unknown = await response.json();
	if (
		typeof token !== 'object' ||
		token === null ||
		!('clientSecret' in token) ||
		typeof token.clientSecret !== 'string' ||
		!('expiresAt' in token) ||
		typeof token.expiresAt !== 'number'
	) {
		throw new Error('服务端没有返回有效的实时翻译凭证。');
	}

	return token as TranslationTokenResponse;
}

export async function exchangeTranslationSdp(
	clientSecret: string,
	offerSdp: string,
	fetcher: Fetcher = fetch,
	signal?: AbortSignal
): Promise<string> {
	const response = await fetcher(REALTIME_TRANSLATION_CALLS_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${clientSecret}`,
			'Content-Type': 'application/sdp'
		},
		body: offerSdp,
		signal
	});

	if (!response.ok) {
		throw await apiResponseError(response, 'OpenAI WebRTC 握手失败');
	}

	return response.text();
}
