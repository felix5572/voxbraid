import { describe, expect, it, vi } from 'vitest';
import {
	OpenAIUsageRequestError,
	OpenAIUsageSummaryCache,
	fetchOpenAIUsageSummary
} from './openai-usage-summary';

const NOW = new Date('2026-09-15T12:34:56.000Z');
const API_KEY = 'admin-test-key';

function costsResponse(
	results: unknown[],
	options: { hasMore?: boolean; nextPage?: string } = {}
): Response {
	return new Response(
		JSON.stringify({
			data: [{ object: 'bucket', results }],
			has_more: options.hasMore ?? false,
			next_page: options.nextPage ?? null
		}),
		{ headers: { 'Content-Type': 'application/json' } }
	);
}

function cost(lineItem: string, seconds: number, usd: number): object {
	return {
		line_item: lineItem,
		quantity: seconds,
		quantity_unit: 'duration_seconds',
		amount: { value: usd, currency: 'usd' }
	};
}

describe('fetchOpenAIUsageSummary', () => {
	it('sums realtime costs while counting shared audio duration once', async () => {
		let requestedUrl: RequestInfo | URL | undefined;
		let requestInit: RequestInit | undefined;
		const fetcher = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
			requestedUrl = args[0];
			requestInit = args[1];
			return costsResponse([
				cost('gpt-realtime-translate', 121, 0.06897),
				cost('gpt-realtime-whisper', 120, 0.03388),
				cost('gpt-5', 999, 9.99)
			]);
		});

		const summary = await fetchOpenAIUsageSummary({ apiKey: API_KEY, fetcher, now: NOW });

		expect(summary).toEqual({
			periodStart: '2026-09-01T00:00:00.000Z',
			periodEnd: NOW.toISOString(),
			durationSeconds: 121,
			costUsd: 0.10285,
			updatedAt: NOW.toISOString()
		});
		const request = new URL(String(requestedUrl));
		expect(request.pathname).toBe('/v1/organization/costs');
		expect(request.searchParams.get('start_time')).toBe('1788220800');
		expect(request.searchParams.getAll('group_by')).toEqual(['project_id', 'line_item']);
		expect(requestInit?.headers).toEqual({
			Authorization: `Bearer ${API_KEY}`
		});
	});

	it('follows cost pagination', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				costsResponse([cost('gpt-realtime-translate', 10, 0.01)], {
					hasMore: true,
					nextPage: 'next-token'
				})
			)
			.mockResolvedValueOnce(costsResponse([cost('gpt-realtime-whisper', 10, 0.005)]));

		const summary = await fetchOpenAIUsageSummary({ apiKey: API_KEY, fetcher, now: NOW });

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('page')).toBe('next-token');
		expect(summary).toMatchObject({ durationSeconds: 10, costUsd: 0.015 });
	});

	it('preserves upstream diagnostics without exposing the admin key', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No access' } }), {
					status: 403,
					headers: { 'x-request-id': 'request-test' }
				})
		);

		await expect(fetchOpenAIUsageSummary({ apiKey: API_KEY, fetcher, now: NOW })).rejects.toEqual(
			expect.objectContaining<Partial<OpenAIUsageRequestError>>({
				status: 403,
				requestId: 'request-test',
				upstreamCode: 'forbidden'
			})
		);
	});
});

describe('OpenAIUsageSummaryCache', () => {
	it('reuses a summary until the five-minute cache expires', async () => {
		const fetcher = vi.fn(async () => costsResponse([]));
		const cache = new OpenAIUsageSummaryCache(300_000);

		await cache.get({ apiKey: API_KEY, fetcher, now: NOW });
		await cache.get({
			apiKey: API_KEY,
			fetcher,
			now: new Date(NOW.getTime() + 299_999)
		});
		await cache.get({ apiKey: API_KEY, fetcher, now: new Date(NOW.getTime() + 300_000) });

		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
