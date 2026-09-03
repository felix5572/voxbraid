export type OperationalLogSeverity = 'warning' | 'error';
export type OperationalLogState = 'active' | 'recovered' | 'corrected';
export type OperationalLogSource =
	'realtime' | 'storage' | 'revision' | 'clean-transcript' | 'conversation' | 'server' | 'system';

export interface OperationalLogEntry {
	id: string;
	severity: OperationalLogSeverity;
	source: OperationalLogSource;
	code: string;
	summary: string;
	details: string | null;
	occurredAt: string;
	lastOccurredAt: string;
	threadId: string | null;
	runId: string | null;
	requestId: string | null;
	dedupeKey: string;
	state: OperationalLogState;
	count: number;
}

export interface OperationalLogInput {
	severity: OperationalLogSeverity;
	source: OperationalLogSource;
	code: string;
	summary: string;
	details?: string | null;
	threadId?: string | null;
	runId?: string | null;
	requestId?: string | null;
	dedupeKey?: string;
}

export const OPERATIONAL_LOG_LIMIT = 300;
export const OPERATIONAL_LOG_EVENT = 'voxbraid:operational-log';

export type OperationalLogEventDetail =
	| { action: 'record'; input: OperationalLogInput }
	| { action: 'resolve'; dedupeKey: string; state: 'recovered' | 'corrected' };

function boundedDetails(value: string | null | undefined): string | null {
	if (!value) return null;
	const limit = 8_192;
	return value.length > limit
		? `${value.slice(0, limit)}\n[详情已截断；原文共 ${value.length} 字符]`
		: value;
}

export function defaultOperationalLogDedupeKey(input: OperationalLogInput): string {
	return [input.source, input.code, input.threadId ?? '', input.runId ?? ''].join(':');
}

export function recordOperationalLog(
	entries: readonly OperationalLogEntry[],
	input: OperationalLogInput,
	options: { id: string; now: string }
): OperationalLogEntry[] {
	const dedupeKey = input.dedupeKey ?? defaultOperationalLogDedupeKey(input);
	const existing = entries.find(
		(entry) => entry.dedupeKey === dedupeKey && entry.state === 'active'
	);
	const nextEntry: OperationalLogEntry = existing
		? {
				...existing,
				severity: input.severity,
				summary: input.summary,
				details: boundedDetails(input.details),
				lastOccurredAt: options.now,
				requestId: input.requestId ?? existing.requestId,
				count: existing.count + 1
			}
		: {
				id: options.id,
				severity: input.severity,
				source: input.source,
				code: input.code,
				summary: input.summary,
				details: boundedDetails(input.details),
				occurredAt: options.now,
				lastOccurredAt: options.now,
				threadId: input.threadId ?? null,
				runId: input.runId ?? null,
				requestId: input.requestId ?? null,
				dedupeKey,
				state: 'active',
				count: 1
			};
	return [nextEntry, ...entries.filter((entry) => entry.id !== existing?.id)].slice(
		0,
		OPERATIONAL_LOG_LIMIT
	);
}

export function resolveOperationalLog(
	entries: readonly OperationalLogEntry[],
	dedupeKey: string,
	state: 'recovered' | 'corrected',
	now: string
): OperationalLogEntry[] {
	return entries.map((entry) =>
		entry.dedupeKey === dedupeKey && entry.state === 'active'
			? { ...entry, state, lastOccurredAt: now }
			: entry
	);
}

export function emitOperationalLog(input: OperationalLogInput): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(
		new CustomEvent<OperationalLogEventDetail>(OPERATIONAL_LOG_EVENT, {
			detail: { action: 'record', input }
		})
	);
}

export function resolveOperationalIssue(
	dedupeKey: string,
	state: 'recovered' | 'corrected' = 'recovered'
): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(
		new CustomEvent<OperationalLogEventDetail>(OPERATIONAL_LOG_EVENT, {
			detail: { action: 'resolve', dedupeKey, state }
		})
	);
}
