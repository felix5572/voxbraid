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
	StoredRevisedSegment,
	StoredRevisionBatch,
	StoredRevisionProjection
} from '../projection/revision-records';
import { REVISION_MAX_OPEN_SOURCE_CHARACTERS } from '../projection/revision-constants';
import type { StoredAutoSummary } from '../sidecar/auto-summary';
import type {
	CleanTranscriptFailureAttempt,
	StoredCleanTranscriptBlock
} from '../sidecar/clean-transcript';
import type {
	ModelUsage,
	SidecarErrorCode,
	SidecarFailureDiagnostic,
	SidecarTransportDiagnostic
} from '../sidecar/types';

export const SESSION_ARCHIVE_VERSION = 4 as const;

export interface StoredCleanTranscriptProjection {
	legacySummary: StoredAutoSummary | null;
	blocks: StoredCleanTranscriptBlock[];
}

export interface SessionArchive {
	schemaVersion: typeof SESSION_ARCHIVE_VERSION;
	exportedAt: string;
	thread: TranslationThread;
	runs: CaptureRun[];
	segments: TranscriptSegment[];
	revisionProjection: StoredRevisionProjection;
	cleanTranscriptProjection: StoredCleanTranscriptProjection;
}

export interface ParsedSessionArchive {
	archive: SessionArchive;
	warnings: string[];
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
	'atomizer-version-mismatch',
	'empty-context',
	'context-too-large',
	'browser-network-failed',
	'invalid-response',
	'invalid-revision-boundary',
	'budget-check-failed',
	'request-timeout',
	'websocket-outcome-unknown',
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

function nonnegativeInteger(value: unknown, label: string): number {
	const result = nonnegativeNumber(value, label);
	if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer.`);
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

function cleanFailureAttempt(value: unknown, label: string): CleanTranscriptFailureAttempt {
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

function autoSummary(value: unknown): StoredAutoSummary | null {
	if (value === null) return null;
	const label = 'cleanTranscriptProjection.legacySummary';
	const input = record(value, label);
	const usageStatus = string(input.usageStatus, `${label}.usageStatus`);
	if (usageStatus !== 'recorded' && usageStatus !== 'unavailable') {
		throw new Error(`${label}.usageStatus is invalid.`);
	}
	const usage = input.usage === null ? null : modelUsage(input.usage, `${label}.usage`);
	if ((usageStatus === 'recorded') !== (usage !== null)) {
		throw new Error(`${label}.usage does not match usageStatus.`);
	}
	return {
		threadId: string(input.threadId, `${label}.threadId`),
		revision: positiveInteger(input.revision, `${label}.revision`),
		text: string(input.text, `${label}.text`),
		sourceCharacters: nonnegativeInteger(input.sourceCharacters, `${label}.sourceCharacters`),
		translationCharacters: nonnegativeInteger(
			input.translationCharacters,
			`${label}.translationCharacters`
		),
		capturedAt: timestamp(input.capturedAt, `${label}.capturedAt`),
		model: string(input.model, `${label}.model`),
		usageStatus,
		usage,
		updatedAt: timestamp(input.updatedAt, `${label}.updatedAt`)
	};
}

function cleanTranscriptBlock(value: unknown, index: number): StoredCleanTranscriptBlock {
	const label = `cleanTranscriptProjection.blocks[${index}]`;
	const input = record(value, label);
	const status = string(input.status, `${label}.status`);
	const usageStatus = string(input.usageStatus, `${label}.usageStatus`);
	if (status !== 'completed' && status !== 'failed') throw new Error(`${label}.status is invalid.`);
	if (usageStatus !== 'recorded' && usageStatus !== 'unavailable') {
		throw new Error(`${label}.usageStatus is invalid.`);
	}
	const usage = input.usage === null ? null : modelUsage(input.usage, `${label}.usage`);
	if ((usageStatus === 'recorded') !== (usage !== null)) {
		throw new Error(`${label}.usage does not match usageStatus.`);
	}
	const attemptsInput = input.failureAttempts;
	if (attemptsInput !== undefined && !Array.isArray(attemptsInput)) {
		throw new Error(`${label}.failureAttempts must be an array.`);
	}
	return {
		id: string(input.id, `${label}.id`),
		threadId: string(input.threadId, `${label}.threadId`),
		runId: string(input.runId, `${label}.runId`),
		sequence: positiveInteger(input.sequence, `${label}.sequence`),
		runSequence: positiveInteger(input.runSequence, `${label}.runSequence`),
		targetLanguage: string(input.targetLanguage, `${label}.targetLanguage`),
		sourceStart: nonnegativeInteger(input.sourceStart, `${label}.sourceStart`),
		sourceEnd: nonnegativeInteger(input.sourceEnd, `${label}.sourceEnd`),
		translationStart: nonnegativeInteger(input.translationStart, `${label}.translationStart`),
		translationEnd: nonnegativeInteger(input.translationEnd, `${label}.translationEnd`),
		sourceElapsedEndMs: nullableNonnegativeNumber(
			input.sourceElapsedEndMs,
			`${label}.sourceElapsedEndMs`
		),
		translationElapsedEndMs: nullableNonnegativeNumber(
			input.translationElapsedEndMs,
			`${label}.translationElapsedEndMs`
		),
		status,
		text: string(input.text, `${label}.text`),
		capturedAt: timestamp(input.capturedAt, `${label}.capturedAt`),
		model: nullableString(input.model, `${label}.model`),
		taskVersion: positiveInteger(input.taskVersion, `${label}.taskVersion`),
		usageStatus,
		usage,
		...(input.clientRequestId === undefined
			? {}
			: { clientRequestId: string(input.clientRequestId, `${label}.clientRequestId`) }),
		...(input.responseId === undefined
			? {}
			: { responseId: nullableString(input.responseId, `${label}.responseId`) }),
		...(input.upstreamStatus === undefined
			? {}
			: { upstreamStatus: upstreamStatus(input.upstreamStatus, `${label}.upstreamStatus`) }),
		...(input.errorCode === undefined
			? {}
			: { errorCode: sidecarErrorCode(input.errorCode, `${label}.errorCode`) }),
		...(input.diagnostic === undefined
			? {}
			: { diagnostic: failureDiagnostic(input.diagnostic, `${label}.diagnostic`) }),
		...(attemptsInput === undefined
			? {}
			: {
					failureAttempts: attemptsInput.map((attempt, attemptIndex) =>
						cleanFailureAttempt(attempt, `${label}.failureAttempts[${attemptIndex}]`)
					)
				}),
		error: nullableString(input.error, `${label}.error`),
		updatedAt: timestamp(input.updatedAt, `${label}.updatedAt`)
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

function transportDiagnostic(value: unknown, label: string): SidecarTransportDiagnostic | null {
	if (value === undefined || value === null) return null;
	const input = record(value, label);
	const transport = string(input.transport, `${label}.transport`);
	const chainAction = string(input.chainAction, `${label}.chainAction`);
	if (transport !== 'http' && transport !== 'http-fallback' && transport !== 'websocket') {
		throw new Error(`${label}.transport is invalid.`);
	}
	if (
		chainAction !== 'none' &&
		chainAction !== 'bootstrap' &&
		chainAction !== 'continued' &&
		chainAction !== 'rebuilt'
	) {
		throw new Error(`${label}.chainAction is invalid.`);
	}
	return {
		transport,
		chainAction,
		streamId: nullableString(input.streamId, `${label}.streamId`),
		chainTurn: nullableNonnegativeNumber(input.chainTurn, `${label}.chainTurn`),
		chainAgeMs: nullableNonnegativeNumber(input.chainAgeMs, `${label}.chainAgeMs`),
		firstEventMs: nullableNonnegativeNumber(input.firstEventMs, `${label}.firstEventMs`),
		completedMs: nullableNonnegativeNumber(input.completedMs, `${label}.completedMs`),
		...(input.fallbackError === undefined
			? {}
			: { fallbackError: nullableString(input.fallbackError, `${label}.fallbackError`) })
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

function revisionBatch(value: unknown, index: number): StoredRevisionBatch {
	const label = `revisionProjection.batches[${index}]`;
	const input = record(value, label);
	const status = string(input.status, `${label}.status`);
	const trigger = string(input.trigger, `${label}.trigger`);
	const usageStatus = string(input.usageStatus, `${label}.usageStatus`);
	if (status !== 'completed' && status !== 'failed') throw new Error(`${label}.status is invalid.`);
	if (trigger !== 'periodic' && trigger !== 'manual' && trigger !== 'finalizing') {
		throw new Error(`${label}.trigger is invalid.`);
	}
	if (usageStatus !== 'recorded' && usageStatus !== 'unavailable') {
		throw new Error(`${label}.usageStatus is invalid.`);
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
		openStart: nonnegativeInteger(input.openStart, `${label}.openStart`),
		openEnd: nonnegativeInteger(input.openEnd, `${label}.openEnd`),
		tokenizerVersion: positiveInteger(input.tokenizerVersion, `${label}.tokenizerVersion`),
		taskVersion: positiveInteger(input.taskVersion, `${label}.taskVersion`),
		trigger,
		status,
		capturedAt: timestamp(input.capturedAt, `${label}.capturedAt`),
		completedAt: nullableTimestamp(input.completedAt, `${label}.completedAt`),
		model: nullableString(input.model, `${label}.model`),
		clientRequestId: string(input.clientRequestId, `${label}.clientRequestId`),
		responseId: nullableString(input.responseId, `${label}.responseId`),
		usageStatus,
		usage,
		upstreamStatus: upstreamStatus(input.upstreamStatus, `${label}.upstreamStatus`),
		errorCode: sidecarErrorCode(input.errorCode, `${label}.errorCode`),
		error: nullableString(input.error, `${label}.error`),
		diagnostic: failureDiagnostic(input.diagnostic, `${label}.diagnostic`),
		...(input.transportDiagnostic === undefined
			? {}
			: {
					transportDiagnostic: transportDiagnostic(
						input.transportDiagnostic,
						`${label}.transportDiagnostic`
					)
				}),
		updatedAt: timestamp(input.updatedAt, `${label}.updatedAt`)
	};
}

function revisedSegment(value: unknown, index: number): StoredRevisedSegment {
	const label = `revisionProjection.segments[${index}]`;
	const input = record(value, label);
	const state = string(input.state, `${label}.state`);
	const boundaryState = string(input.boundaryState, `${label}.boundaryState`);
	if (state !== 'open' && state !== 'frozen') throw new Error(`${label}.state is invalid.`);
	if (boundaryState !== 'complete' && boundaryState !== 'forced-tail') {
		throw new Error(`${label}.boundaryState is invalid.`);
	}
	return {
		id: string(input.id, `${label}.id`),
		threadId: string(input.threadId, `${label}.threadId`),
		runId: string(input.runId, `${label}.runId`),
		runSequence: positiveInteger(input.runSequence, `${label}.runSequence`),
		sourceStart: nonnegativeInteger(input.sourceStart, `${label}.sourceStart`),
		sourceEnd: nonnegativeInteger(input.sourceEnd, `${label}.sourceEnd`),
		rawText: string(input.rawText, `${label}.rawText`),
		revisedSourceText: string(input.revisedSourceText, `${label}.revisedSourceText`),
		translatedText: string(input.translatedText, `${label}.translatedText`),
		paragraphBreakBefore: boolean(input.paragraphBreakBefore, `${label}.paragraphBreakBefore`),
		state,
		boundaryState,
		producedByBatchId: string(input.producedByBatchId, `${label}.producedByBatchId`),
		sourceElapsedEndMs: nullableNonnegativeNumber(
			input.sourceElapsedEndMs,
			`${label}.sourceElapsedEndMs`
		),
		frozenAt: nullableTimestamp(input.frozenAt, `${label}.frozenAt`),
		updatedAt: timestamp(input.updatedAt, `${label}.updatedAt`)
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
		archive.revisionProjection.batches.map((item) => item.id),
		'revision batch IDs'
	);
	unique(
		archive.revisionProjection.batches.map((item) => `${item.runId}:${item.sequence}`),
		'revision batch run sequences'
	);
	unique(
		archive.revisionProjection.segments.map((item) => item.id),
		'revised segment IDs'
	);
	unique(
		archive.revisionProjection.segments.map((item) => `${item.runId}:${item.sourceStart}`),
		'revised segment run/start coordinates'
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
	unique(
		archive.cleanTranscriptProjection.blocks.map((item) => item.id),
		'clean transcript block IDs'
	);
	unique(
		archive.cleanTranscriptProjection.blocks.map((item) => String(item.sequence)),
		'clean transcript block sequences'
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
	const legacySummary = archive.cleanTranscriptProjection.legacySummary;
	if (legacySummary && legacySummary.threadId !== archive.thread.id) {
		throw new Error('Legacy clean transcript summary does not belong to the archived thread.');
	}
	for (const block of archive.cleanTranscriptProjection.blocks) {
		const parentRun = runsById.get(block.runId);
		if (
			block.threadId !== archive.thread.id ||
			!parentRun ||
			parentRun.sequence !== block.runSequence ||
			block.targetLanguage !== parentRun.targetLanguage ||
			block.sourceEnd < block.sourceStart ||
			block.translationEnd < block.translationStart ||
			(block.sourceEnd === block.sourceStart && block.translationEnd === block.translationStart) ||
			block.sourceEnd > parentRun.sourceStream.text.length ||
			block.translationEnd > parentRun.translationStream.text.length ||
			(block.status === 'completed' &&
				(!block.text.trim() || block.model === null || block.error !== null)) ||
			(block.status === 'failed' && block.error === null)
		) {
			throw new Error(`Clean transcript block ${block.id} does not match its run.`);
		}
	}
	const batchesById = new Map(archive.revisionProjection.batches.map((item) => [item.id, item]));
	for (const batch of archive.revisionProjection.batches) {
		const parentRun = runsById.get(batch.runId);
		if (
			batch.threadId !== archive.thread.id ||
			!parentRun ||
			parentRun.sequence !== batch.runSequence ||
			batch.openEnd <= batch.openStart ||
			batch.openEnd - batch.openStart > REVISION_MAX_OPEN_SOURCE_CHARACTERS ||
			batch.openEnd > parentRun.sourceStream.text.length
		) {
			throw new Error(`Revision batch ${batch.id} does not match its run.`);
		}
		if (
			(batch.status === 'completed' &&
				(batch.completedAt === null ||
					batch.model === null ||
					batch.responseId === null ||
					batch.upstreamStatus !== null ||
					batch.errorCode !== null ||
					batch.error !== null)) ||
			(batch.status === 'failed' &&
				(batch.completedAt !== null || batch.errorCode === null || batch.error === null))
		) {
			throw new Error(`Revision batch ${batch.id} has inconsistent outcome fields.`);
		}
	}
	for (const run of archive.runs) {
		const revised = archive.revisionProjection.segments
			.filter((item) => item.runId === run.id)
			.sort((left, right) => left.sourceStart - right.sourceStart);
		let expectedStart = 0;
		let sawOpen = false;
		for (const item of revised) {
			const producer = batchesById.get(item.producedByBatchId);
			if (
				item.threadId !== archive.thread.id ||
				item.runSequence !== run.sequence ||
				!producer ||
				producer.status !== 'completed' ||
				producer.runId !== run.id ||
				item.sourceStart !== expectedStart ||
				item.sourceEnd <= item.sourceStart ||
				item.rawText.length !== item.sourceEnd - item.sourceStart ||
				item.rawText !== run.sourceStream.text.slice(item.sourceStart, item.sourceEnd) ||
				!item.revisedSourceText.trim() ||
				!item.translatedText.trim() ||
				(item.state === 'frozen' && sawOpen) ||
				(item.state === 'frozen' && item.frozenAt === null) ||
				(item.state === 'open' && item.frozenAt !== null)
			) {
				throw new Error(`Revised segment ${item.id} changed or misaligned facts.`);
			}
			if (item.state === 'open') sawOpen = true;
			expectedStart = item.sourceEnd;
		}
	}
	return structuredClone(archive);
}

export function parseSessionArchive(value: string): ParsedSessionArchive {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error('Session archive is not valid JSON.', { cause: error });
	}
	const input = record(parsed, 'archive');
	if (
		input.schemaVersion !== 1 &&
		input.schemaVersion !== 2 &&
		input.schemaVersion !== 3 &&
		input.schemaVersion !== SESSION_ARCHIVE_VERSION
	) {
		throw new Error(`Unsupported session archive version: ${String(input.schemaVersion)}.`);
	}
	if (!Array.isArray(input.runs)) throw new Error('archive.runs must be an array.');
	if (!Array.isArray(input.segments)) throw new Error('archive.segments must be an array.');
	const current = input.schemaVersion === SESSION_ARCHIVE_VERSION;
	const hasRevisionProjection = input.schemaVersion === 3 || current;
	const revisionInput = hasRevisionProjection
		? record(input.revisionProjection, 'archive.revisionProjection')
		: { batches: [], segments: [] };
	if (!Array.isArray(revisionInput.batches)) {
		throw new Error('archive.revisionProjection.batches must be an array.');
	}
	if (!Array.isArray(revisionInput.segments)) {
		throw new Error('archive.revisionProjection.segments must be an array.');
	}
	const cleanInput = current
		? record(input.cleanTranscriptProjection, 'archive.cleanTranscriptProjection')
		: { legacySummary: null, blocks: [] };
	if (!Array.isArray(cleanInput.blocks)) {
		throw new Error('archive.cleanTranscriptProjection.blocks must be an array.');
	}

	const archive = validateSessionArchive({
		schemaVersion: SESSION_ARCHIVE_VERSION,
		exportedAt: timestamp(input.exportedAt, 'archive.exportedAt'),
		thread: thread(input.thread),
		runs: input.runs.map(run),
		segments: input.segments.map(segment),
		revisionProjection: {
			batches: revisionInput.batches.map(revisionBatch),
			segments: revisionInput.segments.map(revisedSegment)
		},
		cleanTranscriptProjection: {
			legacySummary: autoSummary(cleanInput.legacySummary),
			blocks: cleanInput.blocks.map(cleanTranscriptBlock)
		}
	});
	return {
		archive,
		warnings: current
			? []
			: hasRevisionProjection
				? ['该备份不含课堂清稿；事实与修订对照已恢复，课堂清稿将从此重新开始。']
				: ['该备份不含当前修订对照与课堂清稿；Live 原文已恢复，派生内容将从此重新开始。']
	};
}

export function stringifySessionArchive(archive: SessionArchive): string {
	return JSON.stringify(validateSessionArchive(archive), null, 2);
}
