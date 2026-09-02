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
import type {
	StoredTranslationPairBatch,
	StoredTranslationPairProjection,
	StoredTranslationPairSegment,
	TranslationPairFailureAttempt
} from '../projection/translation-pair-records';
import type { ModelUsage, SidecarErrorCode, SidecarFailureDiagnostic } from '../sidecar/types';

export const SESSION_ARCHIVE_VERSION = 2 as const;

export interface SessionArchive {
	schemaVersion: typeof SESSION_ARCHIVE_VERSION;
	exportedAt: string;
	thread: TranslationThread;
	runs: CaptureRun[];
	segments: TranscriptSegment[];
	translationPairs: StoredTranslationPairProjection;
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
	'duration-limit',
	'connection-lost',
	'page-suspended',
	'page-terminated',
	'permission-denied',
	'startup-failed'
]);
const ALIGNMENTS = new Set<SegmentAlignment>(['approximate', 'unpaired']);
const SIDECAR_ERROR_CODES = new Set<SidecarErrorCode>([
	'invalid-request',
	'empty-context',
	'context-too-large',
	'browser-network-failed',
	'invalid-response',
	'budget-check-failed',
	'request-timeout',
	'upstream-failed',
	'upstream-incomplete'
]);

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

function nullableNonnegativeNumber(value: unknown, label: string): number | null {
	return value === null ? null : nonnegativeNumber(value, label);
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
	return value;
}

function modelUsage(value: unknown, label: string): ModelUsage {
	const input = record(value, label);
	return {
		inputTokens: nonnegativeNumber(input.inputTokens, `${label}.inputTokens`),
		cachedInputTokens: nullableNonnegativeNumber(
			input.cachedInputTokens,
			`${label}.cachedInputTokens`
		),
		outputTokens: nonnegativeNumber(input.outputTokens, `${label}.outputTokens`),
		reasoningTokens: nullableNonnegativeNumber(input.reasoningTokens, `${label}.reasoningTokens`),
		totalTokens: nonnegativeNumber(input.totalTokens, `${label}.totalTokens`)
	};
}

function failureDiagnostic(value: unknown, label: string): SidecarFailureDiagnostic | null {
	if (value === null) return null;
	const input = record(value, label);
	return {
		durationMs: nullableNonnegativeNumber(input.durationMs, `${label}.durationMs`),
		visibilityState: nullableString(input.visibilityState, `${label}.visibilityState`),
		online: input.online === null ? null : boolean(input.online, `${label}.online`),
		requestBytes: nullableNonnegativeNumber(input.requestBytes, `${label}.requestBytes`),
		httpStatus: nullableNonnegativeNumber(input.httpStatus, `${label}.httpStatus`)
	};
}

function upstreamStatus(
	value: unknown,
	label: string
): 'failed' | 'incomplete' | 'cancelled' | null {
	if (value === null) return null;
	const result = string(value, label);
	if (result !== 'failed' && result !== 'incomplete' && result !== 'cancelled') {
		throw new Error(`${label} is invalid.`);
	}
	return result;
}

function sidecarErrorCode(value: unknown, label: string): SidecarErrorCode | null {
	if (value === null) return null;
	const result = string(value, label) as SidecarErrorCode;
	if (!SIDECAR_ERROR_CODES.has(result)) throw new Error(`${label} is invalid.`);
	return result;
}

function failureAttempt(value: unknown, label: string): TranslationPairFailureAttempt {
	const input = record(value, label);
	return {
		capturedAt: timestamp(input.capturedAt, `${label}.capturedAt`),
		failedAt: timestamp(input.failedAt, `${label}.failedAt`),
		clientRequestId: string(input.clientRequestId, `${label}.clientRequestId`),
		responseId: nullableString(input.responseId, `${label}.responseId`),
		model: nullableString(input.model, `${label}.model`),
		upstreamStatus: upstreamStatus(input.upstreamStatus, `${label}.upstreamStatus`),
		errorCode: sidecarErrorCode(input.errorCode, `${label}.errorCode`),
		error: string(input.error, `${label}.error`),
		diagnostic: failureDiagnostic(input.diagnostic, `${label}.diagnostic`)
	};
}

function translationPairBatch(value: unknown, index: number): StoredTranslationPairBatch {
	const label = `translationPairs.batches[${index}]`;
	const input = record(value, label);
	const status = string(input.status, `${label}.status`);
	const projectionState = string(input.projectionState, `${label}.projectionState`);
	const usageStatus = string(input.usageStatus, `${label}.usageStatus`);
	if (status !== 'completed' && status !== 'failed') throw new Error(`${label}.status is invalid.`);
	if (projectionState !== 'stable' && projectionState !== 'provisional') {
		throw new Error(`${label}.projectionState is invalid.`);
	}
	if (usageStatus !== 'recorded' && usageStatus !== 'unavailable') {
		throw new Error(`${label}.usageStatus is invalid.`);
	}
	if (!Array.isArray(input.failureAttempts)) {
		throw new Error(`${label}.failureAttempts must be an array.`);
	}
	const usage = input.usage === null ? null : modelUsage(input.usage, `${label}.usage`);
	if ((usageStatus === 'recorded') !== (usage !== null)) {
		throw new Error(`${label}.usage does not match usageStatus.`);
	}
	return {
		id: string(input.id, `${label}.id`),
		threadId: string(input.threadId, `${label}.threadId`),
		runId: string(input.runId, `${label}.runId`),
		runSequence: positiveInteger(input.runSequence, `${label}.runSequence`),
		sequence: positiveInteger(input.sequence, `${label}.sequence`),
		revision: positiveInteger(input.revision, `${label}.revision`),
		projectionState,
		targetLanguage: string(input.targetLanguage, `${label}.targetLanguage`),
		sourceStart: nonnegativeNumber(input.sourceStart, `${label}.sourceStart`),
		sourceEnd: nonnegativeNumber(input.sourceEnd, `${label}.sourceEnd`),
		sourceElapsedEndMs: nullableNonnegativeNumber(
			input.sourceElapsedEndMs,
			`${label}.sourceElapsedEndMs`
		),
		status,
		capturedAt: timestamp(input.capturedAt, `${label}.capturedAt`),
		completedAt: nullableTimestamp(input.completedAt, `${label}.completedAt`),
		model: nullableString(input.model, `${label}.model`),
		taskVersion: positiveInteger(input.taskVersion, `${label}.taskVersion`),
		clientRequestId: string(input.clientRequestId, `${label}.clientRequestId`),
		responseId: nullableString(input.responseId, `${label}.responseId`),
		usageStatus,
		usage,
		upstreamStatus: upstreamStatus(input.upstreamStatus, `${label}.upstreamStatus`),
		errorCode: sidecarErrorCode(input.errorCode, `${label}.errorCode`),
		error: nullableString(input.error, `${label}.error`),
		diagnostic: failureDiagnostic(input.diagnostic, `${label}.diagnostic`),
		failureAttempts: input.failureAttempts.map((attempt, attemptIndex) =>
			failureAttempt(attempt, `${label}.failureAttempts[${attemptIndex}]`)
		),
		updatedAt: timestamp(input.updatedAt, `${label}.updatedAt`)
	};
}

function translationPairSegment(value: unknown, index: number): StoredTranslationPairSegment {
	const label = `translationPairs.segments[${index}]`;
	const input = record(value, label);
	return {
		id: string(input.id, `${label}.id`),
		batchId: string(input.batchId, `${label}.batchId`),
		batchRevision: positiveInteger(input.batchRevision, `${label}.batchRevision`),
		threadId: string(input.threadId, `${label}.threadId`),
		runId: string(input.runId, `${label}.runId`),
		runSequence: positiveInteger(input.runSequence, `${label}.runSequence`),
		sequence: positiveInteger(input.sequence, `${label}.sequence`),
		sourceStart: nonnegativeNumber(input.sourceStart, `${label}.sourceStart`),
		sourceEnd: nonnegativeNumber(input.sourceEnd, `${label}.sourceEnd`),
		sourceText: string(input.sourceText, `${label}.sourceText`),
		translatedText: string(input.translatedText, `${label}.translatedText`),
		paragraphBreakBefore: boolean(input.paragraphBreakBefore, `${label}.paragraphBreakBefore`),
		createdAt: timestamp(input.createdAt, `${label}.createdAt`)
	};
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
		archive.translationPairs.batches.map((item) => item.id),
		'translation pair batch IDs'
	);
	unique(
		archive.translationPairs.batches.map((item) => `${item.runId}:${item.sequence}`),
		'translation pair run sequences'
	);
	unique(
		archive.translationPairs.segments.map((item) => item.id),
		'translation pair segment IDs'
	);
	unique(
		archive.translationPairs.segments.map(
			(item) => `${item.batchId}:${item.batchRevision}:${item.sequence}`
		),
		'translation pair batch/revision sequences'
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
	const runsById = new Map(archive.runs.map((item) => [item.id, item]));
	const batchesById = new Map(archive.translationPairs.batches.map((item) => [item.id, item]));
	for (const batch of archive.translationPairs.batches) {
		const parentRun = runsById.get(batch.runId);
		if (
			batch.threadId !== archive.thread.id ||
			!parentRun ||
			parentRun.sequence !== batch.runSequence ||
			batch.sourceEnd <= batch.sourceStart ||
			batch.sourceEnd > parentRun.sourceStream.text.length
		) {
			throw new Error(`Translation pair batch ${batch.id} does not match its run.`);
		}
		const batchSegments = archive.translationPairs.segments
			.filter((segment) => segment.batchId === batch.id)
			.sort((left, right) => left.sequence - right.sequence);
		if ((batch.status === 'completed') !== batchSegments.length > 0) {
			throw new Error(`Translation pair batch ${batch.id} status does not match its segments.`);
		}
		let expectedStart = batch.sourceStart;
		for (const segment of batchSegments) {
			if (
				segment.batchRevision !== batch.revision ||
				segment.threadId !== batch.threadId ||
				segment.runId !== batch.runId ||
				segment.runSequence !== batch.runSequence ||
				segment.sourceStart !== expectedStart ||
				segment.sourceEnd <= segment.sourceStart ||
				segment.sourceText !==
					parentRun.sourceStream.text.slice(segment.sourceStart, segment.sourceEnd) ||
				!segment.translatedText.trim()
			) {
				throw new Error(`Translation pair segment ${segment.id} changed or misaligned facts.`);
			}
			expectedStart = segment.sourceEnd;
		}
		if (batchSegments.length > 0 && expectedStart !== batch.sourceEnd) {
			throw new Error(`Translation pair batch ${batch.id} is not completely covered.`);
		}
	}
	for (const segment of archive.translationPairs.segments) {
		if (!batchesById.has(segment.batchId)) {
			throw new Error(`Translation pair segment ${segment.id} points to a missing batch.`);
		}
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
	if (input.schemaVersion !== 1 && input.schemaVersion !== SESSION_ARCHIVE_VERSION) {
		throw new Error(`Unsupported session archive version: ${String(input.schemaVersion)}.`);
	}
	if (!Array.isArray(input.runs)) throw new Error('archive.runs must be an array.');
	if (!Array.isArray(input.segments)) throw new Error('archive.segments must be an array.');
	const pairInput =
		input.schemaVersion === 1
			? { batches: [], segments: [] }
			: record(input.translationPairs, 'archive.translationPairs');
	if (!Array.isArray(pairInput.batches)) {
		throw new Error('archive.translationPairs.batches must be an array.');
	}
	if (!Array.isArray(pairInput.segments)) {
		throw new Error('archive.translationPairs.segments must be an array.');
	}

	return validateSessionArchive({
		schemaVersion: SESSION_ARCHIVE_VERSION,
		exportedAt: timestamp(input.exportedAt, 'archive.exportedAt'),
		thread: thread(input.thread),
		runs: input.runs.map(run),
		segments: input.segments.map(segment),
		translationPairs: {
			batches: pairInput.batches.map(translationPairBatch),
			segments: pairInput.segments.map(translationPairSegment)
		}
	});
}

export function stringifySessionArchive(archive: SessionArchive): string {
	return JSON.stringify(validateSessionArchive(archive), null, 2);
}
