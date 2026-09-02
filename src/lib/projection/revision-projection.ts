import { clauseBoundaries, type ClauseBoundaryKind } from '../session/clause-boundary';
import { sentenceBoundaries } from '../session/sentence-boundary';
import {
	REVISION_HARD_SOURCE_CHARACTERS,
	REVISION_HARD_WINDOW_MS,
	REVISION_MAX_ATOM_SOURCE_CHARACTERS,
	REVISION_MAX_GROUP_SOURCE_CHARACTERS,
	REVISION_MAX_OPEN_SOURCE_CHARACTERS,
	REVISION_MIN_QUIET_SOURCE_CHARACTERS,
	REVISION_MIN_REQUEST_INTERVAL_MS,
	REVISION_QUIET_WINDOW_MS,
	REVISION_TOKENIZER_VERSION
} from './revision-constants';

export type SourceAtomBoundary = ClauseBoundaryKind | 'open' | 'forced';

export interface SourceClauseAtom {
	index: number;
	start: number;
	end: number;
	text: string;
	boundary: SourceAtomBoundary;
}

export interface ModelSourceAtom {
	i: number;
	t: string;
	boundary: SourceAtomBoundary;
}

export type RevisionWaitingFor = 'nothing' | 'request-interval' | 'punctuation-or-quiet' | 'ready';

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
	endingBoundary: SourceAtomBoundary;
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
		throw new Error('Intl.Segmenter is required to atomize revision source text.');
	}
	const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
	return [...segmenter.segment(value)].map((item) => ({
		segment: item.segment,
		index: item.index
	}));
}

function forcedSplitEnd(value: string, start: number, end: number, locale?: string): number {
	const target = Math.min(end, start + REVISION_MAX_ATOM_SOURCE_CHARACTERS);
	if (target === end) return end;
	const candidates = segmented(value.slice(start, end), locale)
		.map((piece) => start + piece.index + piece.segment.length)
		.filter(
			(candidate) =>
				candidate > start && candidate <= target && value.slice(start, candidate).trim().length > 0
		);
	return candidates.at(-1) ?? target;
}

export function sourceClauseAtoms(
	text: string,
	start: number,
	end: number,
	locale?: string
): SourceClauseAtom[] {
	assertRange(text, start, end);
	const raw = text.slice(start, end);
	const atoms: SourceClauseAtom[] = [];
	let relativeStart = 0;

	const appendSpan = (relativeEnd: number, boundary: SourceAtomBoundary): void => {
		while (relativeEnd - relativeStart > REVISION_MAX_ATOM_SOURCE_CHARACTERS) {
			const split = forcedSplitEnd(raw, relativeStart, relativeEnd, locale);
			atoms.push({
				index: atoms.length + 1,
				start: start + relativeStart,
				end: start + split,
				text: raw.slice(relativeStart, split),
				boundary: 'forced'
			});
			relativeStart = split;
		}
		if (relativeEnd > relativeStart) {
			atoms.push({
				index: atoms.length + 1,
				start: start + relativeStart,
				end: start + relativeEnd,
				text: raw.slice(relativeStart, relativeEnd),
				boundary
			});
			relativeStart = relativeEnd;
		}
	};

	for (const boundary of clauseBoundaries(raw)) appendSpan(boundary.end, boundary.kind);
	if (relativeStart < raw.length) {
		const tail = raw.slice(relativeStart);
		if (!tail.trim() && atoms.length > 0) {
			const previous = atoms.at(-1)!;
			previous.end = end;
			previous.text += tail;
			relativeStart = raw.length;
		} else {
			appendSpan(raw.length, 'open');
		}
	}
	if (atoms.length === 0 || atoms.map((atom) => atom.text).join('') !== raw) {
		throw new Error('Revision atomizer did not preserve the source range.');
	}
	return atoms;
}

export function modelSourceAtoms(atoms: readonly SourceClauseAtom[]): ModelSourceAtom[] {
	return atoms.map((atom) => ({ i: atom.index, t: atom.text, boundary: atom.boundary }));
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
	const punctuationBoundaryCount = clauseBoundaries(newlyCapturedText.trimEnd()).length;
	const ready =
		input.manual ||
		input.finalizing ||
		capturedSourceEnd < input.text.length ||
		pendingCharacters >= REVISION_HARD_SOURCE_CHARACTERS ||
		pendingForMs >= REVISION_HARD_WINDOW_MS ||
		punctuationBoundaryCount >= 1 ||
		(quietForMs >= REVISION_QUIET_WINDOW_MS &&
			newlyCapturedText.length >= REVISION_MIN_QUIET_SOURCE_CHARACTERS);
	return {
		ready,
		waitingFor: ready ? 'ready' : 'punctuation-or-quiet',
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

	const endsNaturally = revisionTextEndsNaturally(rawText);
	if (input.finalizing || (endsNaturally && input.quietForMs >= REVISION_QUIET_WINDOW_MS)) {
		return { frozenEnd: requestEnd, openStart: requestEnd, openEnd: requestEnd };
	}

	const sentenceEndingGroups = groups.filter((group) => group.endingBoundary === 'sentence');
	const freezeThrough =
		sentenceEndingGroups.length > 2
			? sentenceEndingGroups[sentenceEndingGroups.length - 3].sourceEnd
			: requestStart;
	let frozenEnd = freezeThrough;
	if (
		frozenEnd === requestStart &&
		requestEnd - requestStart >= REVISION_MAX_OPEN_SOURCE_CHARACTERS
	) {
		frozenEnd = groups[0]?.sourceEnd ?? requestEnd;
	}
	return { frozenEnd, openStart: frozenEnd, openEnd: requestEnd };
}

export const REVISION_PROJECTION_METADATA = Object.freeze({
	tokenizerVersion: REVISION_TOKENIZER_VERSION,
	maxAtomCharacters: REVISION_MAX_ATOM_SOURCE_CHARACTERS,
	maxGroupCharacters: REVISION_MAX_GROUP_SOURCE_CHARACTERS
});
