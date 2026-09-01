import { describe, expect, it, vi } from 'vitest';
import {
	OpenAIUsageRequestError,
	OpenAIUsageSummaryCache,
	fetchOpenAIUsageSummary
} from './openai-usage-summary';

const NOW = new Date('2026-09-15T12:34:56.000Z');
const API_KEY = 'admin-test-key';
const DAY_SECONDS = 24 * 60 * 60;
const NOW_SECONDS = NOW.getTime() / 1_000;

function costsResponse(
	buckets: unknown[],
	options: { hasMore?: boolean; nextPage?: string } = {}
): Response {
	return new Response(
		JSON.stringify({
			data: buckets,
			has_more: options.hasMore ?? false,
			next_page: options.nextPage ?? null
		}),
		{ headers: { 'Content-Type': 'application/json' } }
	);
}

function bucket(daysAgo: number, results: unknown[]): object {
	const startTime = NOW_SECONDS - daysAgo * DAY_SECONDS;
	return {
		object: 'bucket',
		start_time: startTime,
		end_time: startTime + DAY_SECONDS,
		results
	};
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
	it('derives one, seven, and thirty-day windows from one daily-bucket query', async () => {
		let requestedUrl: RequestInfo | URL | undefined;
		let requestInit: RequestInit | undefined;
		const fetcher = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
			requestedUrl = args[0];
			requestInit = args[1];
			return costsResponse([
				bucket(30, [
					cost('gpt-realtime-translate', 10, 0.00567),
					cost('gpt-realtime-whisper', 10, 0.00283)
				]),
				bucket(7, [
					cost('gpt-realtime-translate', 20, 0.01133),
					cost('gpt-realtime-whisper', 20, 0.00567)
				]),
				bucket(1, [
					cost('gpt-realtime-translate', 30, 0.017),
					cost('gpt-realtime-whisper', 29, 0.0085),
					cost('gpt-5', 999, 9.99)
				])
			]);
		});

		const summary = await fetchOpenAIUsageSummary({ apiKey: API_KEY, fetcher, now: NOW });

		expect(summary).toEqual({
			periodStart: '2026-08-16T12:34:56.000Z',
			periodEnd: NOW.toISOString(),
			windows: [
				{ days: 1, durationSeconds: 30, costUsd: 0.0255 },
				{ days: 7, durationSeconds: 50, costUsd: 0.0425 },
				{ days: 30, durationSeconds: 60, costUsd: 0.051 }
			],
			updatedAt: NOW.toISOString()
		});
		const request = new URL(String(requestedUrl));
		expect(request.pathname).toBe('/v1/organization/costs');
		expect(request.searchParams.get('start_time')).toBe(String(NOW_SECONDS - 30 * DAY_SECONDS));
		expect(request.searchParams.getAll('group_by')).toEqual(['project_id', 'line_item']);
		expect(requestInit?.headers).toEqual({
			Authorization: `Bearer ${API_KEY}`
		});
	});

	it('follows cost pagination', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				costsResponse([bucket(1, [cost('gpt-realtime-translate', 10, 0.01)])], {
					hasMore: true,
					nextPage: 'next-token'
				})
			)
			.mockResolvedValueOnce(costsResponse([bucket(1, [cost('gpt-realtime-whisper', 10, 0.005)])]));

		const summary = await fetchOpenAIUsageSummary({ apiKey: API_KEY, fetcher, now: NOW });

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('page')).toBe('next-token');
		expect(summary.windows).toEqual([
			{ days: 1, durationSeconds: 10, costUsd: 0.015 },
			{ days: 7, durationSeconds: 10, costUsd: 0.015 },
			{ days: 30, durationSeconds: 10, costUsd: 0.015 }
		]);
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
