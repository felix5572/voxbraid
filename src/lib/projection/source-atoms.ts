import { sentenceBoundaries } from '../session/sentence-boundary';
import type { CaptureRun } from '../session/types';
import type { ProjectionPolicy } from './projection-worker';
import {
	TRANSLATION_PAIR_MAX_CONTINUITY_CHARACTERS,
	TRANSLATION_PAIR_MAX_SOURCE_CHARACTERS
} from './translation-pair-constants';

export const TRANSLATION_PAIR_QUIET_WINDOW_MS = 1_200;
export const TRANSLATION_PAIR_HARD_WINDOW_MS = 20_000;
export const TRANSLATION_PAIR_HARD_SOURCE_CHARACTERS = 800;
export const TRANSLATION_PAIR_CONTINUITY_CHARACTERS = TRANSLATION_PAIR_MAX_CONTINUITY_CHARACTERS;

export type SourceAtomBoundary = 'sentence' | 'forced-tail';
export type TranslationPairProjectionState = 'stable' | 'provisional';
export type TranslationPairWaitingFor = 'nothing' | 'sentence-ending' | 'quiet-window' | 'ready';

export interface SourceSentenceAtom {
	id: string;
	runId: string;
	sequence: number;
	sourceStart: number;
	sourceEnd: number;
	text: string;
	boundary: SourceAtomBoundary;
}

export interface TranslationPairCursor {
	sourceEnd: number;
	sourceElapsedEndMs: number | null;
}

export interface TranslationPairCandidate extends TranslationPairCursor {
	runId: string;
	runSequence: number;
	targetLanguage: string;
	sourceStart: number;
	sourceText: string;
	atoms: SourceSentenceAtom[];
	projectionState: TranslationPairProjectionState;
	finalizing: boolean;
}

export interface TranslationPairCandidateOptions {
	nowMs: number;
	pendingSinceMs: number | null;
	finalizing: boolean;
}

export interface TranslationPairProvisionalRange {
	sourceStart: number;
	sourceEnd: number;
	runSequence: number;
	targetLanguage: string;
}

export interface TranslationPairFixedRange extends TranslationPairProvisionalRange {
	sourceElapsedEndMs: number | null;
}

export interface TranslationPairProgress {
	sourceRemaining: number;
	completeSentenceAtoms: number;
	quietForMs: number;
	pendingForMs: number;
	waitingFor: TranslationPairWaitingFor;
}

export const EMPTY_TRANSLATION_PAIR_CURSOR: TranslationPairCursor = Object.freeze({
	sourceEnd: 0,
	sourceElapsedEndMs: 0
});

function assertCursor(run: CaptureRun, cursor: TranslationPairCursor): void {
	if (
		!Number.isSafeInteger(cursor.sourceEnd) ||
		cursor.sourceEnd < 0 ||
		cursor.sourceEnd > run.sourceStream.text.length
	) {
		throw new RangeError('Translation pair cursor is outside the source stream.');
	}
}

function safeBoundary(value: string, offset: number): number {
	let end = Math.max(0, Math.min(value.length, offset));
	if (end > 0) {
		const codeUnit = value.charCodeAt(end - 1);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) end -= 1;
	}
	return end;
}

function wordBoundary(value: string, start: number, maximumEnd: number): number {
	const safeMaximum = safeBoundary(value, maximumEnd);
	for (let index = safeMaximum; index > start; index -= 1) {
		if (/\s/u.test(value[index - 1])) return safeBoundary(value, index);
	}
	return safeMaximum;
}

function atom(
	runId: string,
	sequence: number,
	text: string,
	sourceStart: number,
	sourceEnd: number,
	boundary: SourceAtomBoundary
): SourceSentenceAtom {
	return {
		id: `${runId}:${sourceStart}:${sourceEnd}`,
		runId,
		sequence,
		sourceStart,
		sourceEnd,
		text: text.slice(sourceStart, sourceEnd),
		boundary
	};
}

export function sourceSentenceAtoms(
	runId: string,
	text: string,
	cursor: TranslationPairCursor,
	options: { forceTail: boolean; hardSourceCharacters?: number }
): SourceSentenceAtom[] {
	if (cursor.sourceEnd < 0 || cursor.sourceEnd > text.length) {
		throw new RangeError('Translation pair cursor is outside the source text.');
	}

	const atoms: SourceSentenceAtom[] = [];
	let sourceStart = cursor.sourceEnd;
	let sequence = 1;
	const hardSourceCharacters =
		options.hardSourceCharacters ?? TRANSLATION_PAIR_HARD_SOURCE_CHARACTERS;
	const tail = text.slice(cursor.sourceEnd);
	const absoluteSentenceEnds = sentenceBoundaries(tail).map(
		(boundary) => cursor.sourceEnd + boundary.end
	);

	for (const sentenceEnd of absoluteSentenceEnds) {
		while (sentenceEnd - sourceStart > hardSourceCharacters) {
			const sourceEnd = wordBoundary(text, sourceStart, sourceStart + hardSourceCharacters);
			if (sourceEnd <= sourceStart) break;
			atoms.push(atom(runId, sequence, text, sourceStart, sourceEnd, 'forced-tail'));
			sequence += 1;
			sourceStart = sourceEnd;
		}
		if (sentenceEnd > sourceStart) {
			atoms.push(atom(runId, sequence, text, sourceStart, sentenceEnd, 'sentence'));
			sequence += 1;
			sourceStart = sentenceEnd;
		}
	}

	while (text.length - sourceStart >= hardSourceCharacters) {
		const sourceEnd = wordBoundary(text, sourceStart, sourceStart + hardSourceCharacters);
		if (sourceEnd <= sourceStart) break;
		atoms.push(atom(runId, sequence, text, sourceStart, sourceEnd, 'forced-tail'));
		sequence += 1;
		sourceStart = sourceEnd;
	}

	if (options.forceTail && sourceStart < text.length) {
		atoms.push(atom(runId, sequence, text, sourceStart, text.length, 'forced-tail'));
	}
	return atoms;
}

function elapsedFromTimestamp(nowMs: number, timestamp: string | null): number {
	if (!timestamp) return 0;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
}

function pendingFor(options: TranslationPairCandidateOptions): number {
	return options.pendingSinceMs === null ? 0 : Math.max(0, options.nowMs - options.pendingSinceMs);
}

function candidateAtoms(
	run: CaptureRun,
	cursor: TranslationPairCursor,
	options: TranslationPairCandidateOptions
): SourceSentenceAtom[] {
	const hardWindowReached = pendingFor(options) >= TRANSLATION_PAIR_HARD_WINDOW_MS;
	const atoms = sourceSentenceAtoms(run.id, run.sourceStream.text, cursor, {
		forceTail: options.finalizing || hardWindowReached
	});
	if (atoms.length === 0) return [];

	const sentenceAtoms = atoms.filter((item) => item.boundary === 'sentence');
	const quietForMs = elapsedFromTimestamp(options.nowMs, run.sourceStream.updatedAt);
	const ready =
		options.finalizing ||
		hardWindowReached ||
		atoms.some((item) => item.boundary === 'forced-tail') ||
		sentenceAtoms.length >= 2 ||
		(sentenceAtoms.length >= 1 && quietForMs >= TRANSLATION_PAIR_QUIET_WINDOW_MS);
	if (!ready) return [];

	const selected: SourceSentenceAtom[] = [];
	let characters = 0;
	for (const item of atoms) {
		const nextCharacters = characters + item.text.length;
		if (selected.length > 0 && nextCharacters > TRANSLATION_PAIR_HARD_SOURCE_CHARACTERS) break;
		selected.push(item);
		characters = nextCharacters;
		if (selected.filter((candidate) => candidate.boundary === 'sentence').length >= 2) break;
	}
	return selected;
}

export function translationPairProgress(
	run: CaptureRun,
	cursor: TranslationPairCursor,
	options: TranslationPairCandidateOptions
): TranslationPairProgress {
	assertCursor(run, cursor);
	const sourceRemaining = run.sourceStream.text.length - cursor.sourceEnd;
	if (sourceRemaining === 0) {
		return {
			sourceRemaining,
			completeSentenceAtoms: 0,
			quietForMs: 0,
			pendingForMs: 0,
			waitingFor: 'nothing'
		};
	}

	const quietForMs = elapsedFromTimestamp(options.nowMs, run.sourceStream.updatedAt);
	const pendingForMs = pendingFor(options);
	const completeSentenceAtoms = sourceSentenceAtoms(run.id, run.sourceStream.text, cursor, {
		forceTail: false
	}).filter((item) => item.boundary === 'sentence').length;
	const ready = candidateAtoms(run, cursor, options).length > 0;
	return {
		sourceRemaining,
		completeSentenceAtoms,
		quietForMs,
		pendingForMs,
		waitingFor: ready ? 'ready' : completeSentenceAtoms > 0 ? 'quiet-window' : 'sentence-ending'
	};
}

export function nextTranslationPairCandidate(
	run: CaptureRun,
	cursor: TranslationPairCursor,
	options: TranslationPairCandidateOptions
): TranslationPairCandidate | null {
	assertCursor(run, cursor);
	const atoms = candidateAtoms(run, cursor, options);
	if (atoms.length === 0) return null;
	const last = atoms.at(-1)!;
	return {
		runId: run.id,
		runSequence: run.sequence,
		targetLanguage: run.targetLanguage,
		sourceStart: cursor.sourceEnd,
		sourceEnd: last.sourceEnd,
		sourceElapsedEndMs: run.sourceStream.lastElapsedMs,
		sourceText: run.sourceStream.text.slice(cursor.sourceEnd, last.sourceEnd),
		atoms,
		projectionState: atoms.some((item) => item.boundary === 'forced-tail')
			? 'provisional'
			: 'stable',
		finalizing: options.finalizing
	};
}

export function nextProvisionalTranslationPairCandidate(
	run: CaptureRun,
	previous: TranslationPairProvisionalRange,
	options: TranslationPairCandidateOptions
): TranslationPairCandidate | null {
	if (
		previous.sourceStart < 0 ||
		previous.sourceEnd <= previous.sourceStart ||
		previous.sourceEnd > run.sourceStream.text.length ||
		previous.runSequence !== run.sequence ||
		previous.targetLanguage !== run.targetLanguage
	) {
		throw new RangeError('Provisional translation pair range does not match its run.');
	}
	if (run.sourceStream.text.length <= previous.sourceEnd) return null;
	const hardWindowReached = pendingFor(options) >= TRANSLATION_PAIR_HARD_WINDOW_MS;
	const hardCharactersReached =
		run.sourceStream.text.length - previous.sourceStart >= TRANSLATION_PAIR_MAX_SOURCE_CHARACTERS;
	const atoms = sourceSentenceAtoms(
		run.id,
		run.sourceStream.text.slice(0, previous.sourceStart + TRANSLATION_PAIR_MAX_SOURCE_CHARACTERS),
		{ sourceEnd: previous.sourceStart, sourceElapsedEndMs: null },
		{
			forceTail: options.finalizing || hardWindowReached || hardCharactersReached,
			hardSourceCharacters: TRANSLATION_PAIR_MAX_SOURCE_CHARACTERS
		}
	);
	const completionIndex = atoms.findIndex(
		(atom) => atom.boundary === 'sentence' && atom.sourceEnd > previous.sourceEnd
	);
	if (completionIndex < 0 && !options.finalizing && !hardWindowReached && !hardCharactersReached) {
		return null;
	}
	const selected = completionIndex >= 0 ? atoms.slice(0, completionIndex + 1) : atoms;
	if (selected.length === 0) return null;
	const last = selected.at(-1)!;
	if (last.sourceEnd <= previous.sourceEnd) return null;
	return {
		runId: run.id,
		runSequence: run.sequence,
		targetLanguage: run.targetLanguage,
		sourceStart: previous.sourceStart,
		sourceEnd: last.sourceEnd,
		sourceElapsedEndMs: run.sourceStream.lastElapsedMs,
		sourceText: run.sourceStream.text.slice(previous.sourceStart, last.sourceEnd),
		atoms: selected,
		projectionState: selected.every((atom) => atom.boundary === 'sentence')
			? 'stable'
			: 'provisional',
		finalizing: options.finalizing
	};
}

export function translationPairCandidateFromRange(
	run: CaptureRun,
	range: TranslationPairFixedRange
): TranslationPairCandidate {
	if (
		range.sourceStart < 0 ||
		range.sourceEnd <= range.sourceStart ||
		range.sourceEnd > run.sourceStream.text.length ||
		range.runSequence !== run.sequence ||
		range.targetLanguage !== run.targetLanguage
	) {
		throw new RangeError('Translation pair fixed range does not match its run.');
	}
	const atoms = sourceSentenceAtoms(
		run.id,
		run.sourceStream.text.slice(0, range.sourceEnd),
		{ sourceEnd: range.sourceStart, sourceElapsedEndMs: range.sourceElapsedEndMs },
		{ forceTail: true }
	);
	if (atoms.length === 0) throw new RangeError('Translation pair fixed range is empty.');
	return {
		runId: run.id,
		runSequence: run.sequence,
		targetLanguage: run.targetLanguage,
		sourceStart: range.sourceStart,
		sourceEnd: range.sourceEnd,
		sourceElapsedEndMs: range.sourceElapsedEndMs,
		sourceText: run.sourceStream.text.slice(range.sourceStart, range.sourceEnd),
		atoms,
		projectionState: atoms.some((item) => item.boundary === 'forced-tail')
			? 'provisional'
			: 'stable',
		finalizing: true
	};
}

export const TRANSLATION_PAIR_POLICY: ProjectionPolicy<
	CaptureRun,
	TranslationPairCursor,
	TranslationPairCandidateOptions,
	TranslationPairCandidate,
	TranslationPairProgress
> = Object.freeze({
	nextCandidate: nextTranslationPairCandidate,
	progress: translationPairProgress
});
