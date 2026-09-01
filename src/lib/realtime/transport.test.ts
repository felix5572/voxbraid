import { describe, expect, it, vi } from 'vitest';
import {
	exchangeTranslationSdp,
	fetchTranslationToken,
	REALTIME_TRANSLATION_CALLS_URL
} from './transport';

describe('fetchTranslationToken', () => {
	it('validates the complete token response', async () => {
		let requestInit: RequestInit | undefined;
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestInit = init;
			return new Response(
				JSON.stringify({
					clientSecret: 'test-client-secret',
					expiresAt: 2_000_000_000
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		});

		await expect(fetchTranslationToken('zh', fetcher)).resolves.toEqual({
			clientSecret: 'test-client-secret',
			expiresAt: 2_000_000_000
		});
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			targetLanguage: 'zh',
			transcriptionModel: 'gpt-live-transcribe',
			noiseReduction: 'off'
		});
	});

	it('requests the selected source transcription model and noise reduction mode', async () => {
		let requestInit: RequestInit | undefined;
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestInit = init;
			return new Response(
				JSON.stringify({ clientSecret: 'test-client-secret', expiresAt: 2_000_000_000 }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		});

		await fetchTranslationToken('zh', fetcher, undefined, 'gpt-live-transcribe', 'near_field');

		expect(JSON.parse(String(requestInit?.body))).toEqual({
			targetLanguage: 'zh',
			transcriptionModel: 'gpt-live-transcribe',
			noiseReduction: 'near_field'
		});
	});

	it('rejects an incomplete token response', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ clientSecret: 'test-client-secret' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(fetchTranslationToken('zh', fetcher)).rejects.toThrow(
			'服务端没有返回有效的实时翻译凭证。'
		);
	});
});

describe('exchangeTranslationSdp', () => {
	it('uses the dedicated realtime translation WebRTC endpoint', async () => {
		const fetcher = vi.fn(async () => new Response('answer-sdp', { status: 200 }));

		await expect(exchangeTranslationSdp('test-client-secret', 'offer-sdp', fetcher)).resolves.toBe(
			'answer-sdp'
		);
		expect(fetcher).toHaveBeenCalledWith(REALTIME_TRANSLATION_CALLS_URL, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer test-client-secret',
				'Content-Type': 'application/sdp'
			},
			body: 'offer-sdp',
			signal: undefined
		});
		expect(REALTIME_TRANSLATION_CALLS_URL).toBe(
			'https://api.openai.com/v1/realtime/translations/calls'
		);
	});

	it('surfaces a nested OpenAI API error message', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: 'Translation call rejected.' } }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				})
		);

		await expect(
			exchangeTranslationSdp('test-client-secret', 'offer-sdp', fetcher)
		).rejects.toThrow('Translation call rejected.');
	});
});
