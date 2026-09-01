import { REALTIME_TRANSLATION_MODEL } from '../realtime/usage-estimate';
import { REALTIME_TRANSCRIPTION_MODELS } from '../realtime/types';
import {
	SIDECAR_CLEAN_MODEL,
	SIDECAR_FAST_MODEL,
	SIDECAR_INTERACTIVE_MODEL
} from './sidecar-tasks';

const OPENAI_COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const REALTIME_TRANSCRIPTION_LINE_ITEMS = REALTIME_TRANSCRIPTION_MODELS.map((model) => model.code);
const REALTIME_LINE_ITEMS = new Set([
	REALTIME_TRANSLATION_MODEL,
	...REALTIME_TRANSCRIPTION_LINE_ITEMS
]);
const SIDECAR_LINE_ITEM_MODELS = [
	SIDECAR_FAST_MODEL,
	SIDECAR_INTERACTIVE_MODEL,
	SIDECAR_CLEAN_MODEL
] as const;
const DAY_SECONDS = 24 * 60 * 60;
const WINDOW_DAYS = [1, 7, 30] as const;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAIUsageSummary {
	periodStart: string;
	periodEnd: string;
	windows: OpenAIUsageWindow[];
	updatedAt: string;
}

export interface OpenAIUsageWindow {
	days: (typeof WINDOW_DAYS)[number];
	durationSeconds: number;
	costUsd: number;
}

export interface FetchOpenAIUsageSummaryOptions {
	apiKey: string;
	fetcher?: Fetcher;
	now?: Date;
}

export class OpenAIUsageRequestError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly requestId: string | null,
		readonly upstreamCode: string | null
	) {
		super(message);
		this.name = 'OpenAIUsageRequestError';
	}
}

interface CostTotals {
	seconds: number;
	usd: number;
}

interface DailyCostBucket {
	startTime: number;
	endTime: number;
	realtimeTotals: Map<string, CostTotals>;
	sidecarUsd: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | null {
	if (typeof value !== 'number' && typeof value !== 'string') return null;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function readErrorField(body: unknown, field: 'code' | 'message'): string | null {
	if (!isRecord(body) || !isRecord(body.error)) return null;
	const value = body.error[field];
	return typeof value === 'string' ? value : null;
}

function emptyRealtimeTotals(): Map<string, CostTotals> {
	return new Map([...REALTIME_LINE_ITEMS].map((lineItem) => [lineItem, { seconds: 0, usd: 0 }]));
}

function isSidecarLineItem(lineItem: string): boolean {
	return SIDECAR_LINE_ITEM_MODELS.some(
		(model) => lineItem === model || lineItem.startsWith(`${model},`)
	);
}

function addBuckets(body: unknown, buckets: DailyCostBucket[]): void {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new OpenAIUsageRequestError('OpenAI Costs API 返回了无法识别的响应。', null, null, null);
	}

	for (const bucket of body.data) {
		const startTime = isRecord(bucket) ? finiteNumber(bucket.start_time) : null;
		const endTime = isRecord(bucket) ? finiteNumber(bucket.end_time) : null;
		if (
			!isRecord(bucket) ||
			!Array.isArray(bucket.results) ||
			startTime === null ||
			endTime === null
		) {
			throw new OpenAIUsageRequestError(
				'OpenAI Costs API 返回了无法识别的时间桶。',
				null,
				null,
				null
			);
		}

		const realtimeTotals = emptyRealtimeTotals();
		let sidecarUsd = 0;
		for (const result of bucket.results) {
			if (!isRecord(result) || typeof result.line_item !== 'string') continue;
			const realtimeTotal = realtimeTotals.get(result.line_item);
			const sidecarLineItem = isSidecarLineItem(result.line_item);
			if (!realtimeTotal && !sidecarLineItem) continue;

			const quantity = finiteNumber(result.quantity);
			const amount = isRecord(result.amount) ? finiteNumber(result.amount.value) : null;
			const currency = isRecord(result.amount) ? result.amount.currency : null;
			if (quantity === null || amount === null || currency !== 'usd') {
				throw new OpenAIUsageRequestError(
					'OpenAI Costs API 返回了无法识别的费用明细。',
					null,
					null,
					null
				);
			}

			if (realtimeTotal) {
				if (result.quantity_unit === 'duration_seconds') realtimeTotal.seconds += quantity;
				realtimeTotal.usd += amount;
			} else {
				sidecarUsd += amount;
			}
		}
		buckets.push({ startTime, endTime, realtimeTotals, sidecarUsd });
	}
}

function summarizeWindow(
	buckets: readonly DailyCostBucket[],
	endTimeSeconds: number,
	days: OpenAIUsageWindow['days']
): OpenAIUsageWindow {
	const cutoff = endTimeSeconds - days * DAY_SECONDS;
	const totals = emptyRealtimeTotals();
	let sidecarUsd = 0;
	for (const bucket of buckets) {
		if (bucket.endTime <= cutoff) continue;
		for (const [lineItem, bucketTotal] of bucket.realtimeTotals) {
			const total = totals.get(lineItem);
			if (!total) continue;
			total.seconds += bucketTotal.seconds;
			total.usd += bucketTotal.usd;
		}
		sidecarUsd += bucket.sidecarUsd;
	}

	const translation = totals.get(REALTIME_TRANSLATION_MODEL);
	const transcription = REALTIME_TRANSCRIPTION_LINE_ITEMS.reduce(
		(sum, model) => {
			const total = totals.get(model);
			if (!total) throw new Error('Realtime cost totals were not initialized.');
			return { seconds: sum.seconds + total.seconds, usd: sum.usd + total.usd };
		},
		{ seconds: 0, usd: 0 }
	);
	if (!translation) throw new Error('Realtime cost totals were not initialized.');
	return {
		days,
		durationSeconds: Math.round(Math.max(translation.seconds, transcription.seconds)),
		costUsd: Number((translation.usd + transcription.usd + sidecarUsd).toFixed(10))
	};
}

function pagination(body: unknown): { hasMore: boolean; nextPage: string | null } {
	if (!isRecord(body)) return { hasMore: false, nextPage: null };
	return {
		hasMore: body.has_more === true,
		nextPage: typeof body.next_page === 'string' ? body.next_page : null
	};
}

export async function fetchOpenAIUsageSummary({
	apiKey,
	fetcher = fetch,
	now = new Date()
}: FetchOpenAIUsageSummaryOptions): Promise<OpenAIUsageSummary> {
	const normalizedKey = apiKey.trim();
	if (!normalizedKey) throw new Error('OPENAI_ADMIN_KEY must not be empty.');

	const endTimeSeconds = Math.floor(now.getTime() / 1_000);
	const startTimeSeconds = endTimeSeconds - 30 * DAY_SECONDS;
	const buckets: DailyCostBucket[] = [];
	let page: string | null = null;

	do {
		const url = new URL(OPENAI_COSTS_URL);
		url.searchParams.set('start_time', String(startTimeSeconds));
		url.searchParams.set('end_time', String(endTimeSeconds));
		url.searchParams.set('bucket_width', '1d');
		url.searchParams.set('limit', '31');
		url.searchParams.append('group_by', 'project_id');
		url.searchParams.append('group_by', 'line_item');
		if (page) url.searchParams.set('page', page);

		let response: Response;
		try {
			response = await fetcher(url, {
				headers: { Authorization: `Bearer ${normalizedKey}` }
			});
		} catch (error) {
			throw new OpenAIUsageRequestError(
				error instanceof Error ? error.message : 'OpenAI Costs API request failed.',
				null,
				null,
				null
			);
		}

		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			throw new OpenAIUsageRequestError(
				readErrorField(body, 'message') ?? `OpenAI Costs API returned HTTP ${response.status}.`,
				response.status,
				response.headers.get('x-request-id'),
				readErrorField(body, 'code')
			);
		}

		addBuckets(body, buckets);
		const next = pagination(body);
		if (next.hasMore && !next.nextPage) {
			throw new OpenAIUsageRequestError(
				'OpenAI Costs API 分页响应缺少 next_page。',
				null,
				null,
				null
			);
		}
		page = next.hasMore ? next.nextPage : null;
	} while (page);

	return {
		periodStart: new Date(startTimeSeconds * 1_000).toISOString(),
		periodEnd: now.toISOString(),
		windows: WINDOW_DAYS.map((days) => summarizeWindow(buckets, endTimeSeconds, days)),
		updatedAt: now.toISOString()
	};
}

export class OpenAIUsageSummaryCache {
	private cached: { expiresAt: number; value: OpenAIUsageSummary } | null = null;
	private inFlight: Promise<OpenAIUsageSummary> | null = null;

	constructor(private readonly ttlMs = 5 * 60_000) {}

	async get(options: FetchOpenAIUsageSummaryOptions): Promise<OpenAIUsageSummary> {
		const nowMs = (options.now ?? new Date()).getTime();
		if (this.cached && this.cached.expiresAt > nowMs) return this.cached.value;
		if (this.inFlight) return this.inFlight;

		this.inFlight = fetchOpenAIUsageSummary(options)
			.then((value) => {
				this.cached = { expiresAt: nowMs + this.ttlMs, value };
				return value;
			})
			.finally(() => {
				this.inFlight = null;
			});
		return this.inFlight;
	}
}
