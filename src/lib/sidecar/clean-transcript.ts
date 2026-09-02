import { sentenceBoundaries } from '../session/sentence-boundary';
import type { CaptureRun } from '../session/types';
import type { ProjectionPolicy } from '../projection/projection-worker';
import type {
	ModelUsage,
	ModelUsageStatus,
	SidecarErrorCode,
	SidecarFailureDiagnostic
} from './types';

export const CLEAN_TRANSCRIPT_TARGET_SOURCE_CHARACTERS = 5_000;
export const CLEAN_TRANSCRIPT_HARD_SOURCE_CHARACTERS = 8_000;
export const CLEAN_TRANSCRIPT_TARGET_TRANSLATION_CHARACTERS = 1_800;
export const CLEAN_TRANSCRIPT_HARD_TRANSLATION_CHARACTERS = 3_000;
export const CLEAN_TRANSCRIPT_FINAL_SOURCE_CHARACTERS = 300;
export const CLEAN_TRANSCRIPT_FINAL_TRANSLATION_CHARACTERS = 120;
export const CLEAN_TRANSCRIPT_MAX_WINDOW_MS = 10 * 60 * 1_000;
export const CLEAN_TRANSCRIPT_SETTLE_TOLERANCE_MS = 2_000;
export const CLEAN_TRANSCRIPT_CONTINUITY_CHARACTERS = 1_000;
export const CLEAN_TRANSCRIPT_TASK_VERSION = 5;

export type CleanTranscriptBlockStatus = 'completed' | 'failed';

export interface CleanTranscriptFailureAttempt {
	capturedAt: string;
	failedAt: string;
	clientRequestId: string;
	responseId: string | null;
	model: string | null;
	upstreamStatus: 'failed' | 'incomplete' | 'cancelled' | null;
	errorCode: SidecarErrorCode | null;
	error: string;
	diagnostic: SidecarFailureDiagnostic | null;
}

export interface CleanTranscriptCursor {
	sourceEnd: number;
	translationEnd: number;
	sourceElapsedEndMs: number | null;
	translationElapsedEndMs: number | null;
}

export interface CleanTranscriptCandidate extends CleanTranscriptCursor {
	runId: string;
	runSequence: number;
	targetLanguage: string;
	sourceStart: number;
	translationStart: number;
	sourceText: string;
	translationText: string;
}

export interface StoredCleanTranscriptBlock extends CleanTranscriptCursor {
	id: string;
	threadId: string;
	runId: string;
	sequence: number;
	runSequence: number;
	targetLanguage: string;
	sourceStart: number;
	translationStart: number;
	status: CleanTranscriptBlockStatus;
	text: string;
	capturedAt: string;
	model: string | null;
	taskVersion: number;
	usageStatus: ModelUsageStatus;
	usage: ModelUsage | null;
	clientRequestId?: string;
	responseId?: string | null;
	upstreamStatus?: 'failed' | 'incomplete' | 'cancelled' | null;
	errorCode?: SidecarErrorCode | null;
	diagnostic?: SidecarFailureDiagnostic | null;
	failureAttempts?: CleanTranscriptFailureAttempt[];
	error: string | null;
	updatedAt: string;
}

export interface CleanTranscriptCandidateOptions {
	force: boolean;
	allowShort: boolean;
}

export interface CleanTranscriptProgress {
	sourceRemaining: number;
	translationRemaining: number;
	ready: boolean;
}

export const EMPTY_CLEAN_TRANSCRIPT_CURSOR: CleanTranscriptCursor = Object.freeze({
	sourceEnd: 0,
	translationEnd: 0,
	sourceElapsedEndMs: 0,
	translationElapsedEndMs: 0
});

function safeBoundary(value: string, offset: number): number {
	let end = Math.max(0, Math.min(value.length, offset));
	if (end > 0) {
		const codeUnit = value.charCodeAt(end - 1);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) end -= 1;
	}
	return end;
}

function sentenceEndNear(value: string, minimum: number, maximum: number): number {
	const boundary = sentenceBoundaries(value).find(
		(candidate) => candidate.end >= minimum && candidate.end <= maximum
	);
	return safeBoundary(value, boundary?.end ?? maximum);
}

function translationEndForSourceSplit(
	run: CaptureRun,
	cursor: CleanTranscriptCursor,
	sourceEnd: number
): number {
	const sourceRemaining = run.sourceStream.text.length - cursor.sourceEnd;
	const translationRemaining = run.translationStream.text.length - cursor.translationEnd;
	if (sourceRemaining <= 0 || sourceEnd >= run.sourceStream.text.length) {
		return run.translationStream.text.length;
	}
	const fraction = (sourceEnd - cursor.sourceEnd) / sourceRemaining;
	const approximate = Math.round(translationRemaining * fraction);
	const translation = run.translationStream.text.slice(cursor.translationEnd);
	const minimum = Math.max(1, approximate - 300);
	const maximum = Math.min(translation.length, approximate + 500);
	if (maximum <= minimum) return cursor.translationEnd + safeBoundary(translation, approximate);
	return cursor.translationEnd + sentenceEndNear(translation, minimum, maximum);
}

function hasSentenceEnding(value: string): boolean {
	const trimmed = value.trimEnd();
	if (!trimmed) return false;
	return sentenceBoundaries(trimmed).at(-1)?.end === trimmed.length;
}

function elapsedSince(current: number | null, previous: number | null): number {
	if (current === null || previous === null) return 0;
	return Math.max(0, current - previous);
}

function translationSettled(run: CaptureRun): boolean {
	const sourceElapsed = run.sourceStream.lastElapsedMs;
	const translationElapsed = run.translationStream.lastElapsedMs;
	if (sourceElapsed === null || translationElapsed === null) return true;
	return translationElapsed >= sourceElapsed - CLEAN_TRANSCRIPT_SETTLE_TOLERANCE_MS;
}

export function cleanTranscriptCursorForRun(
	blocks: readonly StoredCleanTranscriptBlock[],
	runId: string
): CleanTranscriptCursor {
	const latest = blocks
		.filter((block) => block.runId === runId)
		.sort((left, right) => left.sequence - right.sequence)
		.at(-1);
	return latest
		? {
				sourceEnd: latest.sourceEnd,
				translationEnd: latest.translationEnd,
				sourceElapsedEndMs: latest.sourceElapsedEndMs,
				translationElapsedEndMs: latest.translationElapsedEndMs
			}
		: { ...EMPTY_CLEAN_TRANSCRIPT_CURSOR };
}

export function nextCleanTranscriptSequence(blocks: readonly StoredCleanTranscriptBlock[]): number {
	return blocks.reduce((maximum, block) => Math.max(maximum, block.sequence), 0) + 1;
}

export function cleanTranscriptContinuity(
	blocks: readonly StoredCleanTranscriptBlock[],
	beforeSequence = Number.POSITIVE_INFINITY
): string {
	const latest = blocks
		.filter(
			(block) =>
				block.sequence < beforeSequence && block.status === 'completed' && block.text.trim()
		)
		.sort((left, right) => left.sequence - right.sequence)
		.at(-1);
	if (!latest) return '';
	let start = Math.max(0, latest.text.length - CLEAN_TRANSCRIPT_CONTINUITY_CHARACTERS);
	const codeUnit = latest.text.charCodeAt(start);
	if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) start += 1;
	return latest.text.slice(start).trimStart();
}

export function cleanTranscriptCandidateFromBlock(
	run: CaptureRun,
	block: StoredCleanTranscriptBlock
): CleanTranscriptCandidate {
	if (
		block.runId !== run.id ||
		block.sourceEnd > run.sourceStream.text.length ||
		block.translationEnd > run.translationStream.text.length
	) {
		throw new RangeError(`Clean transcript block ${block.id} no longer matches its run.`);
	}
	return {
		runId: block.runId,
		runSequence: block.runSequence,
		targetLanguage: block.targetLanguage,
		sourceStart: block.sourceStart,
		sourceEnd: block.sourceEnd,
		translationStart: block.translationStart,
		translationEnd: block.translationEnd,
		sourceElapsedEndMs: block.sourceElapsedEndMs,
		translationElapsedEndMs: block.translationElapsedEndMs,
		sourceText: run.sourceStream.text.slice(block.sourceStart, block.sourceEnd),
		translationText: run.translationStream.text.slice(block.translationStart, block.translationEnd)
	};
}

export function nextCleanTranscriptCandidate(
	run: CaptureRun,
	cursor: CleanTranscriptCursor,
	options: CleanTranscriptCandidateOptions
): CleanTranscriptCandidate | null {
	if (
		cursor.sourceEnd < 0 ||
		cursor.translationEnd < 0 ||
		cursor.sourceEnd > run.sourceStream.text.length ||
		cursor.translationEnd > run.translationStream.text.length
	) {
		throw new RangeError('Clean transcript cursor is outside the run streams.');
	}

	const sourceRemaining = run.sourceStream.text.length - cursor.sourceEnd;
	const translationRemaining = run.translationStream.text.length - cursor.translationEnd;
	if (sourceRemaining === 0 && translationRemaining === 0) return null;

	const enoughForFinal =
		sourceRemaining >= CLEAN_TRANSCRIPT_FINAL_SOURCE_CHARACTERS ||
		translationRemaining >= CLEAN_TRANSCRIPT_FINAL_TRANSLATION_CHARACTERS;
	if (options.force && !options.allowShort && !enoughForFinal) return null;

	const elapsedWindow = Math.max(
		elapsedSince(run.sourceStream.lastElapsedMs, cursor.sourceElapsedEndMs),
		elapsedSince(run.translationStream.lastElapsedMs, cursor.translationElapsedEndMs)
	);
	const sourceTail = run.sourceStream.text.slice(cursor.sourceEnd);
	const regularThresholdReached =
		sourceRemaining >= CLEAN_TRANSCRIPT_TARGET_SOURCE_CHARACTERS ||
		(sourceRemaining === 0 &&
			translationRemaining >= CLEAN_TRANSCRIPT_TARGET_TRANSLATION_CHARACTERS) ||
		(elapsedWindow >= CLEAN_TRANSCRIPT_MAX_WINDOW_MS && enoughForFinal);
	const hardLimitReached =
		sourceRemaining >= CLEAN_TRANSCRIPT_HARD_SOURCE_CHARACTERS ||
		translationRemaining >= CLEAN_TRANSCRIPT_HARD_TRANSLATION_CHARACTERS ||
		(elapsedWindow >= CLEAN_TRANSCRIPT_MAX_WINDOW_MS && enoughForFinal);

	if (!options.force) {
		if (!regularThresholdReached || (!hardLimitReached && !translationSettled(run))) return null;
		if (
			!hardLimitReached &&
			sourceRemaining > 0 &&
			sourceRemaining < CLEAN_TRANSCRIPT_HARD_SOURCE_CHARACTERS &&
			elapsedWindow < CLEAN_TRANSCRIPT_MAX_WINDOW_MS &&
			!hasSentenceEnding(sourceTail)
		) {
			return null;
		}
	}

	let sourceEnd = run.sourceStream.text.length;
	if (sourceRemaining > CLEAN_TRANSCRIPT_HARD_SOURCE_CHARACTERS) {
		sourceEnd =
			cursor.sourceEnd +
			sentenceEndNear(
				sourceTail,
				CLEAN_TRANSCRIPT_TARGET_SOURCE_CHARACTERS,
				CLEAN_TRANSCRIPT_HARD_SOURCE_CHARACTERS
			);
	}

	let translationEnd = translationEndForSourceSplit(run, cursor, sourceEnd);
	if (
		sourceRemaining === 0 &&
		translationRemaining > CLEAN_TRANSCRIPT_HARD_TRANSLATION_CHARACTERS
	) {
		const translationTail = run.translationStream.text.slice(cursor.translationEnd);
		translationEnd =
			cursor.translationEnd +
			sentenceEndNear(
				translationTail,
				CLEAN_TRANSCRIPT_TARGET_TRANSLATION_CHARACTERS,
				CLEAN_TRANSCRIPT_HARD_TRANSLATION_CHARACTERS
			);
	}

	return {
		runId: run.id,
		runSequence: run.sequence,
		targetLanguage: run.targetLanguage,
		sourceStart: cursor.sourceEnd,
		sourceEnd,
		translationStart: cursor.translationEnd,
		translationEnd,
		sourceElapsedEndMs: run.sourceStream.lastElapsedMs,
		translationElapsedEndMs: run.translationStream.lastElapsedMs,
		sourceText: run.sourceStream.text.slice(cursor.sourceEnd, sourceEnd),
		translationText: run.translationStream.text.slice(cursor.translationEnd, translationEnd)
	};
}

export function cleanTranscriptProgress(
	run: CaptureRun,
	cursor: CleanTranscriptCursor,
	options: CleanTranscriptCandidateOptions
): CleanTranscriptProgress {
	return {
		sourceRemaining: Math.max(0, run.sourceStream.text.length - cursor.sourceEnd),
		translationRemaining: Math.max(0, run.translationStream.text.length - cursor.translationEnd),
		ready: nextCleanTranscriptCandidate(run, cursor, options) !== null
	};
}

export const CLEAN_TRANSCRIPT_POLICY: ProjectionPolicy<
	CaptureRun,
	CleanTranscriptCursor,
	CleanTranscriptCandidateOptions,
	CleanTranscriptCandidate,
	CleanTranscriptProgress
> = Object.freeze({
	nextCandidate: nextCleanTranscriptCandidate,
	progress: cleanTranscriptProgress
});
