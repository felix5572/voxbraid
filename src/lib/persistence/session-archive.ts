import type {
	CaptureRun,
	CaptureRunEndReason,
	CaptureRunStatus,
	RunError,
	SegmentAlignment,
	TranscriptSegment,
	TranscriptStreamSnapshot,
	TranslationThread
} from '../session/types';

export const SESSION_ARCHIVE_VERSION = 1 as const;

export interface SessionArchive {
	schemaVersion: typeof SESSION_ARCHIVE_VERSION;
	exportedAt: string;
	thread: TranslationThread;
	runs: CaptureRun[];
	segments: TranscriptSegment[];
}

const RUN_STATUSES = new Set<CaptureRunStatus>([
	'starting',
	'live',
	'stopping',
	'completed',
	'interrupted',
	'failed'
]);
const ACTIVE_RUN_STATUSES = new Set<CaptureRunStatus>(['starting', 'live', 'stopping']);
const END_REASONS = new Set<CaptureRunEndReason>([
	'user-paused',
	'connection-lost',
	'page-suspended',
	'page-terminated',
	'permission-denied',
	'startup-failed'
]);
const ALIGNMENTS = new Set<SegmentAlignment>(['approximate', 'unpaired']);

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
	return value;
}

function nullableString(value: unknown, label: string): string | null {
	if (value === null) return null;
	return string(value, label);
}

function timestamp(value: unknown, label: string): string {
	const result = string(value, label);
	if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a valid timestamp.`);
	return result;
}

function nullableTimestamp(value: unknown, label: string): string | null {
	if (value === null) return null;
	return timestamp(value, label);
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	const result = finiteNumber(value, label);
	if (!Number.isInteger(result) || result <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return result;
}

function nonnegativeNumber(value: unknown, label: string): number {
	const result = finiteNumber(value, label);
	if (result < 0) throw new Error(`${label} must not be negative.`);
	return result;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
	return value;
}

function stream(value: unknown, label: string): TranscriptStreamSnapshot {
	const input = record(value, label);
	return {
		text: string(input.text, `${label}.text`),
		lastElapsedMs:
			input.lastElapsedMs === null
				? null
				: nonnegativeNumber(input.lastElapsedMs, `${label}.lastElapsedMs`),
		updatedAt: nullableTimestamp(input.updatedAt, `${label}.updatedAt`)
	};
}

function runError(value: unknown, label: string): RunError | null {
	if (value === null) return null;
	const input = record(value, label);
	return {
		code: nullableString(input.code, `${label}.code`),
		message: string(input.message, `${label}.message`)
	};
}

function thread(value: unknown): TranslationThread {
	const input = record(value, 'thread');
	const status = string(input.status, 'thread.status');
	if (status !== 'active' && status !== 'archived') throw new Error('thread.status is invalid.');
	return {
		id: string(input.id, 'thread.id'),
		ownerId: nullableString(input.ownerId, 'thread.ownerId'),
		title: nullableString(input.title, 'thread.title'),
		defaultTargetLanguage: string(input.defaultTargetLanguage, 'thread.defaultTargetLanguage'),
		status,
		createdAt: timestamp(input.createdAt, 'thread.createdAt'),
		updatedAt: timestamp(input.updatedAt, 'thread.updatedAt')
	};
}

function run(value: unknown, index: number): CaptureRun {
	const label = `runs[${index}]`;
	const input = record(value, label);
	const status = string(input.status, `${label}.status`) as CaptureRunStatus;
	if (!RUN_STATUSES.has(status)) throw new Error(`${label}.status is invalid.`);
	const endReason = nullableString(
		input.endReason,
		`${label}.endReason`
	) as CaptureRunEndReason | null;
	if (endReason !== null && !END_REASONS.has(endReason)) {
		throw new Error(`${label}.endReason is invalid.`);
	}
	return {
		id: string(input.id, `${label}.id`),
		threadId: string(input.threadId, `${label}.threadId`),
		sequence: positiveInteger(input.sequence, `${label}.sequence`),
		status,
		targetLanguage: string(input.targetLanguage, `${label}.targetLanguage`),
		createdAt: timestamp(input.createdAt, `${label}.createdAt`),
		mediaStartedAt: nullableTimestamp(input.mediaStartedAt, `${label}.mediaStartedAt`),
		endedAt: nullableTimestamp(input.endedAt, `${label}.endedAt`),
		lastActivityAt: nullableTimestamp(input.lastActivityAt, `${label}.lastActivityAt`),
		hiddenAt: nullableTimestamp(input.hiddenAt, `${label}.hiddenAt`),
		audioDurationMs: nonnegativeNumber(input.audioDurationMs, `${label}.audioDurationMs`),
		endTimeEstimated: boolean(input.endTimeEstimated, `${label}.endTimeEstimated`),
		endReason,
		recoveredFromRunId: nullableString(input.recoveredFromRunId, `${label}.recoveredFromRunId`),
		clientPlatform: nullableString(input.clientPlatform, `${label}.clientPlatform`),
		lastError: runError(input.lastError, `${label}.lastError`),
		sourceStream: stream(input.sourceStream, `${label}.sourceStream`),
		translationStream: stream(input.translationStream, `${label}.translationStream`),
		currentSegmentRevision:
			input.currentSegmentRevision === null
				? null
				: positiveInteger(input.currentSegmentRevision, `${label}.currentSegmentRevision`)
	};
}

function segment(value: unknown, index: number): TranscriptSegment {
	const label = `segments[${index}]`;
	const input = record(value, label);
	const alignment = string(input.alignment, `${label}.alignment`) as SegmentAlignment;
	if (!ALIGNMENTS.has(alignment)) throw new Error(`${label}.alignment is invalid.`);
	return {
		id: string(input.id, `${label}.id`),
		runId: string(input.runId, `${label}.runId`),
		revision: positiveInteger(input.revision, `${label}.revision`),
		sequence: positiveInteger(input.sequence, `${label}.sequence`),
		sourceText: string(input.sourceText, `${label}.sourceText`),
		translatedText: string(input.translatedText, `${label}.translatedText`),
		alignment,
		createdAt: timestamp(input.createdAt, `${label}.createdAt`),
		updatedAt: timestamp(input.updatedAt, `${label}.updatedAt`)
	};
}

function unique(values: string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

export function validateSessionArchive(archive: SessionArchive): SessionArchive {
	unique(
		archive.runs.map((item) => item.id),
		'run IDs'
	);
	unique(
		archive.runs.map((item) => String(item.sequence)),
		'run sequences'
	);
	unique(
		archive.segments.map((item) => item.id),
		'segment IDs'
	);
	unique(
		archive.segments.map((item) => `${item.runId}:${item.revision}:${item.sequence}`),
		'segment run/revision sequences'
	);

	const runIds = new Set(archive.runs.map((item) => item.id));
	const activeRuns = archive.runs.filter((item) => ACTIVE_RUN_STATUSES.has(item.status));
	if (activeRuns.length > 1)
		throw new Error('A thread archive must not contain multiple active runs.');
	for (const item of archive.runs) {
		if (item.threadId !== archive.thread.id) {
			throw new Error(`Run ${item.id} does not belong to thread ${archive.thread.id}.`);
		}
		if (
			item.currentSegmentRevision !== null &&
			!archive.segments.some(
				(segment) => segment.runId === item.id && segment.revision === item.currentSegmentRevision
			)
		) {
			throw new Error(`Run ${item.id} points to a missing segment revision.`);
		}
	}
	for (const item of archive.segments) {
		if (!runIds.has(item.runId)) throw new Error(`Segment ${item.id} points to a missing run.`);
	}
	return structuredClone(archive);
}

export function parseSessionArchive(value: string): SessionArchive {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error('Session archive is not valid JSON.', { cause: error });
	}
	const input = record(parsed, 'archive');
	if (input.schemaVersion !== SESSION_ARCHIVE_VERSION) {
		throw new Error(`Unsupported session archive version: ${String(input.schemaVersion)}.`);
	}
	if (!Array.isArray(input.runs)) throw new Error('archive.runs must be an array.');
	if (!Array.isArray(input.segments)) throw new Error('archive.segments must be an array.');

	return validateSessionArchive({
		schemaVersion: SESSION_ARCHIVE_VERSION,
		exportedAt: timestamp(input.exportedAt, 'archive.exportedAt'),
		thread: thread(input.thread),
		runs: input.runs.map(run),
		segments: input.segments.map(segment)
	});
}

export function stringifySessionArchive(archive: SessionArchive): string {
	return JSON.stringify(validateSessionArchive(archive), null, 2);
}
