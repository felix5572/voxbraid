import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueTranslationToken } from './realtime-token';

const API_KEY = 'server-only-test-key';

function tokenRequest(targetLanguage: unknown): Request {
	return new Request('http://localhost/api/realtime/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ targetLanguage })
	});
}

afterEach(() => vi.restoreAllMocks());

describe('issueTranslationToken', () => {
	it('rejects an unsupported target language before calling OpenAI', async () => {
		const fetcher = vi.fn();
		const response = await issueTranslationToken({
			request: tokenRequest('unsupported'),
			fetcher,
			apiKey: API_KEY
		});

		expect(response.status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(API_KEY);
	});

	it('rejects an incomplete OpenAI response without exposing the API key', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ value: 'temporary-client-secret' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
		);
		const response = await issueTranslationToken({
			request: tokenRequest('zh'),
			fetcher,
			apiKey: API_KEY
		});

		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain(API_KEY);
	});

	it('returns only the validated short-lived credential fields', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						value: 'temporary-client-secret',
						expires_at: 2_000_000_000,
						session: { id: 'session-test' },
						ignored: API_KEY
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
		);
		const response = await issueTranslationToken({
			request: tokenRequest('zh'),
			fetcher,
			apiKey: API_KEY
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			clientSecret: 'temporary-client-secret',
			expiresAt: 2_000_000_000
		});
	});
});
