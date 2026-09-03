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

function noSpendLimitResponse(): Response {
	return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
}

function spendLimitResponse(thresholdCents: number): Response {
	return new Response(
		JSON.stringify({
			object: 'organization.spend_limit',
			threshold_amount: thresholdCents,
			currency: 'USD',
			interval: 'month',
			enforcement: { status: 'enforcing' }
		})
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

function tokenCost(lineItem: string, tokens: number, usd: number): object {
	return {
		line_item: lineItem,
		quantity: tokens,
		quantity_unit: 'tokens',
		amount: { value: usd, currency: 'usd' }
	};
}

describe('fetchOpenAIUsageSummary', () => {
	it('derives one, seven, and thirty-day windows from one daily-bucket query', async () => {
		let requestedUrl: RequestInfo | URL | undefined;
		let requestInit: RequestInit | undefined;
		const fetcher = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
			if (new URL(String(args[0])).pathname.endsWith('/spend_limit')) {
				return spendLimitResponse(1_200);
			}
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
					cost('gpt-realtime-whisper', 19, 0.0055),
					cost('gpt-live-transcribe', 10, 0.003),
					tokenCost('gpt-5.6-luna, input_tokens', 1_000, 0.001),
					tokenCost('gpt-5.6-luna, output_tokens', 200, 0.002),
					tokenCost('gpt-5.6-sol, input_tokens', 1_000, 0.003),
					tokenCost('gpt-5.6-terra, output_tokens', 200, 0.004),
					cost('gpt-5', 999, 9.99)
				])
			]);
		});

		const summary = await fetchOpenAIUsageSummary({ apiKey: API_KEY, fetcher, now: NOW });

		expect(summary).toEqual({
			periodStart: '2026-01-01T00:00:00.000Z',
			periodEnd: NOW.toISOString(),
			windows: [
				{
					days: 1,
					durationSeconds: 30,
					costUsd: 0.0355,
					accountCostUsd: 10.0255,
					breakdown: {
						translationUsd: 0.017,
						transcriptionUsd: 0.0085,
						sidecarUsd: 0.01,
						otherUsd: 9.99
					}
				},
				{
					days: 7,
					durationSeconds: 50,
					costUsd: 0.0525,
					accountCostUsd: 10.0425,
					breakdown: {
						translationUsd: 0.02833,
						transcriptionUsd: 0.01417,
						sidecarUsd: 0.01,
						otherUsd: 9.99
					}
				},
				{
					days: 30,
					durationSeconds: 60,
					costUsd: 0.061,
					accountCostUsd: 10.051,
					breakdown: {
						translationUsd: 0.034,
						transcriptionUsd: 0.017,
						sidecarUsd: 0.01,
						otherUsd: 9.99
					}
				}
			],
			monthToDate: {
				periodStart: '2026-09-01T00:00:00.000Z',
				durationSeconds: 50,
				costUsd: 0.0525,
				accountCostUsd: 10.0425,
				breakdown: {
					translationUsd: 0.02833,
					transcriptionUsd: 0.01417,
					sidecarUsd: 0.01,
					otherUsd: 9.99
				}
			},
			costMeter: {
				periodStart: '2026-01-01T00:00:00.000Z',
				accountCostUsd: 10.051
			},
			hardSpendLimit: {
				status: 'configured',
				thresholdUsd: 12,
				remainingUsd: 1.9575,
				enforcementStatus: 'enforcing'
			},
			updatedAt: NOW.toISOString()
		});
		const request = new URL(String(requestedUrl));
		expect(request.pathname).toBe('/v1/organization/costs');
		expect(request.searchParams.get('start_time')).toBe('1767225600');
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
			.mockResolvedValueOnce(costsResponse([bucket(1, [cost('gpt-realtime-whisper', 10, 0.005)])]))
			.mockResolvedValueOnce(noSpendLimitResponse());

		const summary = await fetchOpenAIUsageSummary({ apiKey: API_KEY, fetcher, now: NOW });

		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('page')).toBe('next-token');
		expect(
			summary.windows.map(({ days, durationSeconds, costUsd }) => ({
				days,
				durationSeconds,
				costUsd
			}))
		).toEqual([
			{ days: 1, durationSeconds: 10, costUsd: 0.015 },
			{ days: 7, durationSeconds: 10, costUsd: 0.015 },
			{ days: 30, durationSeconds: 10, costUsd: 0.015 }
		]);
		expect(summary.hardSpendLimit).toEqual({ status: 'not-configured' });
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
	it('reuses a summary until expiry and lets a manual refresh bypass the cache', async () => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) =>
			new URL(String(input)).pathname.endsWith('/spend_limit')
				? noSpendLimitResponse()
				: costsResponse([])
		);
		const cache = new OpenAIUsageSummaryCache(300_000);

		await cache.get({ apiKey: API_KEY, fetcher, now: NOW });
		await cache.get({
			apiKey: API_KEY,
			fetcher,
			now: new Date(NOW.getTime() + 299_999)
		});
		await cache.get({ apiKey: API_KEY, fetcher, now: new Date(NOW.getTime() + 300_000) });
		await cache.get({ apiKey: API_KEY, fetcher, now: new Date(NOW.getTime() + 300_001) }, true);

		expect(fetcher).toHaveBeenCalledTimes(6);
	});
});
