import {
	REALTIME_TRANSCRIPTION_MODEL,
	REALTIME_TRANSLATION_MODEL
} from '../realtime/usage-estimate';

const OPENAI_COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const REALTIME_LINE_ITEMS = new Set([REALTIME_TRANSLATION_MODEL, REALTIME_TRANSCRIPTION_MODEL]);

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAIUsageSummary {
	periodStart: string;
	periodEnd: string;
	durationSeconds: number;
	costUsd: number;
	updatedAt: string;
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

function monthStart(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function addResults(body: unknown, totals: Map<string, CostTotals>): void {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new OpenAIUsageRequestError('OpenAI Costs API 返回了无法识别的响应。', null, null, null);
	}

	for (const bucket of body.data) {
		if (!isRecord(bucket) || !Array.isArray(bucket.results)) continue;
		for (const result of bucket.results) {
			if (!isRecord(result) || typeof result.line_item !== 'string') continue;
			const total = totals.get(result.line_item);
			if (!total) continue;

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

			if (result.quantity_unit === 'duration_seconds') total.seconds += quantity;
			total.usd += amount;
		}
	}
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

	const start = monthStart(now);
	const endTimeSeconds = Math.ceil(now.getTime() / 1_000);
	const totals = new Map<string, CostTotals>(
		[...REALTIME_LINE_ITEMS].map((lineItem) => [lineItem, { seconds: 0, usd: 0 }])
	);
	let page: string | null = null;

	do {
		const url = new URL(OPENAI_COSTS_URL);
		url.searchParams.set('start_time', String(start.getTime() / 1_000));
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

		addResults(body, totals);
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

	const translation = totals.get(REALTIME_TRANSLATION_MODEL);
	const transcription = totals.get(REALTIME_TRANSCRIPTION_MODEL);
	if (!translation || !transcription) throw new Error('Realtime cost totals were not initialized.');

	return {
		periodStart: start.toISOString(),
		periodEnd: now.toISOString(),
		durationSeconds: Math.round(Math.max(translation.seconds, transcription.seconds)),
		costUsd: translation.usd + transcription.usd,
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
