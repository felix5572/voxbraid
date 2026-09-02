import { sentenceBoundaries } from '../session/sentence-boundary';
import {
	REVISION_HARD_SOURCE_CHARACTERS,
	REVISION_HARD_WINDOW_MS,
	REVISION_MAX_GROUP_SOURCE_CHARACTERS,
	REVISION_MAX_OPEN_SOURCE_CHARACTERS,
	REVISION_MAX_RETAINED_CHARACTERS,
	REVISION_MIN_REQUEST_INTERVAL_MS,
	REVISION_MIN_RETAINED_CHARACTERS,
	REVISION_QUIET_WINDOW_MS,
	REVISION_TOKENIZER_VERSION
} from './revision-constants';

export interface SourceToken {
	index: number;
	start: number;
	end: number;
	text: string;
}

export interface ModelSourceToken {
	i: number;
	t: string;
}

export type RevisionWaitingFor =
	'nothing' | 'request-interval' | 'sentence-ending' | 'quiet-window' | 'ready';

export interface RevisionTriggerInput {
	text: string;
	frozenEnd: number;
	latestCapturedEnd: number;
	nowMs: number;
	streamUpdatedAt: string | null;
	pendingSinceMs: number | null;
	lastAutomaticRequestAtMs: number | null;
	manual: boolean;
	finalizing: boolean;
}

export interface RevisionTriggerResult {
	ready: boolean;
	waitingFor: RevisionWaitingFor;
	capturedSourceEnd: number;
	pendingCharacters: number;
	quietForMs: number;
	pendingForMs: number;
	requestIntervalRemainingMs: number;
}

export interface RevisionGroupRange {
	sourceStart: number;
	sourceEnd: number;
	oversized: boolean;
}

export interface RevisionCommitPlan {
	frozenEnd: number;
	openStart: number;
	openEnd: number;
}

function assertRange(text: string, start: number, end: number): void {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end <= start ||
		end > text.length
	) {
		throw new RangeError('Revision source range is invalid.');
	}
}

export function capturedRevisionSourceEnd(textLength: number, frozenEnd: number): number {
	if (
		!Number.isSafeInteger(textLength) ||
		!Number.isSafeInteger(frozenEnd) ||
		textLength < 0 ||
		frozenEnd < 0 ||
		frozenEnd > textLength
	) {
		throw new RangeError('Revision cursor is outside the source stream.');
	}
	return Math.min(textLength, frozenEnd + REVISION_MAX_OPEN_SOURCE_CHARACTERS);
}

function segmented(value: string, locale?: string): Array<{ segment: string; index: number }> {
	if (typeof Intl.Segmenter !== 'function') {
		throw new Error('Intl.Segmenter is required to tokenize revision source text.');
	}
	const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
	return [...segmenter.segment(value)].map((item) => ({
		segment: item.segment,
		index: item.index
	}));
}

export function tokenizeRevisionSource(
	text: string,
	start: number,
	end: number,
	locale?: string
): SourceToken[] {
	assertRange(text, start, end);
	const raw = text.slice(start, end);
	const pieces = segmented(raw, locale);
	const tokens: SourceToken[] = [];
	let pendingWhitespace = '';
	let pendingStart = start;

	for (const piece of pieces) {
		const absoluteStart = start + piece.index;
		if (/^\s+$/u.test(piece.segment)) {
			if (!pendingWhitespace) pendingStart = absoluteStart;
			pendingWhitespace += piece.segment;
			continue;
		}
		const tokenStart = pendingWhitespace ? pendingStart : absoluteStart;
		const tokenText = pendingWhitespace + piece.segment;
		tokens.push({
			index: tokens.length + 1,
			start: tokenStart,
			end: absoluteStart + piece.segment.length,
			text: tokenText
		});
		pendingWhitespace = '';
	}

	if (pendingWhitespace) {
		const previous = tokens.at(-1);
		if (previous) {
			previous.end = end;
			previous.text += pendingWhitespace;
		} else {
			tokens.push({ index: 1, start, end, text: pendingWhitespace });
		}
	}
	if (tokens.length === 0 || tokens.map((token) => token.text).join('') !== raw) {
		throw new Error('Revision tokenizer did not preserve the source range.');
	}
	return tokens;
}

export function modelSourceTokens(tokens: readonly SourceToken[]): ModelSourceToken[] {
	return tokens.map((token) => ({ i: token.index, t: token.text }));
}

function elapsed(nowMs: number, timestamp: string | null): number {
	if (!timestamp) return 0;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
}

export function revisionTrigger(input: RevisionTriggerInput): RevisionTriggerResult {
	if (
		!Number.isSafeInteger(input.latestCapturedEnd) ||
		input.latestCapturedEnd < input.frozenEnd ||
		input.latestCapturedEnd > input.text.length
	) {
		throw new RangeError('Latest revision capture is outside the open source range.');
	}
	const capturedSourceEnd = capturedRevisionSourceEnd(input.text.length, input.frozenEnd);
	const pendingCharacters = input.text.length - input.frozenEnd;
	const quietForMs = elapsed(input.nowMs, input.streamUpdatedAt);
	const pendingForMs =
		input.pendingSinceMs === null ? 0 : Math.max(0, input.nowMs - input.pendingSinceMs);
	const requestIntervalRemainingMs =
		input.manual || input.finalizing || input.lastAutomaticRequestAtMs === null
			? 0
			: Math.max(
					0,
					REVISION_MIN_REQUEST_INTERVAL_MS - (input.nowMs - input.lastAutomaticRequestAtMs)
				);
	if (pendingCharacters === 0) {
		return {
			ready: false,
			waitingFor: 'nothing',
			capturedSourceEnd,
			pendingCharacters,
			quietForMs,
			pendingForMs,
			requestIntervalRemainingMs
		};
	}
	if (requestIntervalRemainingMs > 0) {
		return {
			ready: false,
			waitingFor: 'request-interval',
			capturedSourceEnd,
			pendingCharacters,
			quietForMs,
			pendingForMs,
			requestIntervalRemainingMs
		};
	}

	const newlyCapturedText = input.text.slice(
		Math.min(input.latestCapturedEnd, capturedSourceEnd),
		capturedSourceEnd
	);
	const sentenceCount = sentenceBoundaries(newlyCapturedText.trimEnd()).length;
	const ready =
		input.manual ||
		input.finalizing ||
		capturedSourceEnd < input.text.length ||
		pendingCharacters >= REVISION_HARD_SOURCE_CHARACTERS ||
		pendingForMs >= REVISION_HARD_WINDOW_MS ||
		sentenceCount >= 2 ||
		(sentenceCount >= 1 && quietForMs >= REVISION_QUIET_WINDOW_MS);
	return {
		ready,
		waitingFor: ready ? 'ready' : sentenceCount > 0 ? 'quiet-window' : 'sentence-ending',
		capturedSourceEnd,
		pendingCharacters,
		quietForMs,
		pendingForMs,
		requestIntervalRemainingMs
	};
}

export function revisionTextEndsNaturally(rawText: string): boolean {
	const content = rawText.trimEnd();
	if (!content) return false;
	return sentenceBoundaries(content).at(-1)?.end === content.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

export function commitRevisionGroups(input: {
	requestStart: number;
	requestEnd: number;
	rawText: string;
	groups: readonly RevisionGroupRange[];
	finalizing: boolean;
	quietForMs: number;
}): RevisionCommitPlan {
	const { requestStart, requestEnd, rawText, groups } = input;
	if (rawText.length !== requestEnd - requestStart || groups.length === 0) {
		throw new Error('Revision commit input does not cover its request range.');
	}
	let expectedStart = requestStart;
	for (const group of groups) {
		if (group.sourceStart !== expectedStart || group.sourceEnd <= group.sourceStart) {
			throw new Error('Revision groups are not continuous.');
		}
		expectedStart = group.sourceEnd;
	}
	if (expectedStart !== requestEnd) throw new Error('Revision groups do not cover the request.');

	const naturalText = rawText.trimEnd();
	const boundaries = sentenceBoundaries(naturalText);
	const endsNaturally = revisionTextEndsNaturally(rawText);
	if (input.finalizing || (endsNaturally && input.quietForMs >= REVISION_QUIET_WINDOW_MS)) {
		return { frozenEnd: requestEnd, openStart: requestEnd, openEnd: requestEnd };
	}

	const previousBoundary = boundaries.length >= 3 ? boundaries.at(-3)!.end : 0;
	const lastTwoSentenceCharacters = rawText.length - previousBoundary;
	const desiredRetained =
		boundaries.length >= 2
			? clamp(
					lastTwoSentenceCharacters,
					REVISION_MIN_RETAINED_CHARACTERS,
					REVISION_MAX_RETAINED_CHARACTERS
				)
			: REVISION_MIN_RETAINED_CHARACTERS;
	const targetFrozenEnd = requestEnd - desiredRetained;
	const ordinaryBoundary = [...groups]
		.reverse()
		.find((group) => group.sourceEnd <= targetFrozenEnd)?.sourceEnd;
	let frozenEnd = ordinaryBoundary ?? requestStart;
	if (
		frozenEnd === requestStart &&
		requestEnd - requestStart >= REVISION_MAX_OPEN_SOURCE_CHARACTERS
	) {
		frozenEnd = groups.find((group) => group.sourceEnd > targetFrozenEnd)?.sourceEnd ?? requestEnd;
	}
	return { frozenEnd, openStart: frozenEnd, openEnd: requestEnd };
}

export const REVISION_PROJECTION_METADATA = Object.freeze({
	tokenizerVersion: REVISION_TOKENIZER_VERSION,
	maxGroupCharacters: REVISION_MAX_GROUP_SOURCE_CHARACTERS
});
