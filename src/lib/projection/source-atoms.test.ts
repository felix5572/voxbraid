import { describe, expect, it } from 'vitest';
import type { CaptureRun } from '../session/types';
import {
	EMPTY_TRANSLATION_PAIR_CURSOR,
	nextTranslationPairCandidate,
	nextProvisionalTranslationPairCandidate,
	sourceSentenceAtoms,
	TRANSLATION_PAIR_HARD_SOURCE_CHARACTERS,
	translationPairCandidateFromRange,
	translationPairProgress,
	type TranslationPairCandidateOptions
} from './source-atoms';

const NOW = Date.parse('2026-09-02T12:00:10.000Z');

function run(sourceText: string, updatedAt = '2026-09-02T12:00:09.000Z'): CaptureRun {
	return {
		id: 'run-1',
		threadId: 'thread-1',
		sequence: 1,
		status: 'live',
		targetLanguage: 'zh',
		createdAt: '2026-09-02T12:00:00.000Z',
		mediaStartedAt: '2026-09-02T12:00:00.000Z',
		endedAt: null,
		lastActivityAt: updatedAt,
		hiddenAt: null,
		audioDurationMs: 10_000,
		endTimeEstimated: false,
		endReason: null,
		recoveredFromRunId: null,
		clientPlatform: 'test',
		lastError: null,
		sourceStream: { text: sourceText, lastElapsedMs: 10_000, updatedAt },
		translationStream: { text: '', lastElapsedMs: null, updatedAt: null },
		currentSegmentRevision: null
	};
}

function options(
	overrides: Partial<TranslationPairCandidateOptions> = {}
): TranslationPairCandidateOptions {
	return { nowMs: NOW, pendingSinceMs: NOW - 5_000, finalizing: false, ...overrides };
}

describe('source sentence atoms', () => {
	it('uses the shared sentence boundary rules and preserves exact source slices', () => {
		const text = 'It is 3.14 today. Next sentence? unfinished';
		const atoms = sourceSentenceAtoms('run-1', text, EMPTY_TRANSLATION_PAIR_CURSOR, {
			forceTail: false
		});

		expect(atoms.map((item) => item.text)).toEqual(['It is 3.14 today.', ' Next sentence?']);
		expect(atoms.map((item) => item.id)).toEqual(['run-1:0:17', 'run-1:17:32']);
		expect(atoms.every((item) => item.boundary === 'sentence')).toBe(true);
	});

	it('forces a long unpunctuated tail without splitting a surrogate pair', () => {
		const text = `${'word '.repeat(159)}😀remaining`;
		const atoms = sourceSentenceAtoms('run-1', text, EMPTY_TRANSLATION_PAIR_CURSOR, {
			forceTail: false
		});

		expect(atoms).toHaveLength(1);
		expect(atoms[0].boundary).toBe('forced-tail');
		expect(atoms[0].text.length).toBeLessThanOrEqual(TRANSLATION_PAIR_HARD_SOURCE_CHARACTERS);
		expect(atoms[0].text.endsWith('\ud83d')).toBe(false);
	});
});

describe('translation pair candidates', () => {
	it('waits for the quiet window after one complete sentence', () => {
		const value = run('A complete sentence.', '2026-09-02T12:00:09.500Z');

		expect(
			nextTranslationPairCandidate(value, EMPTY_TRANSLATION_PAIR_CURSOR, options())
		).toBeNull();
		expect(
			translationPairProgress(value, EMPTY_TRANSLATION_PAIR_CURSOR, options()).waitingFor
		).toBe('quiet-window');
	});

	it('emits one sentence after the quiet window and two sentences immediately', () => {
		const one = nextTranslationPairCandidate(
			run('A complete sentence.', '2026-09-02T12:00:08.000Z'),
			EMPTY_TRANSLATION_PAIR_CURSOR,
			options()
		);
		const two = nextTranslationPairCandidate(
			run('First sentence. Second sentence.', '2026-09-02T12:00:09.900Z'),
			EMPTY_TRANSLATION_PAIR_CURSOR,
			options()
		);

		expect(one).toMatchObject({ sourceText: 'A complete sentence.', projectionState: 'stable' });
		expect(two?.atoms).toHaveLength(2);
		expect(two?.projectionState).toBe('stable');
	});

	it('forces a provisional candidate after the hard wall-clock window', () => {
		const value = run('A partial sentence without punctuation', '2026-09-02T12:00:09.900Z');
		const candidate = nextTranslationPairCandidate(
			value,
			EMPTY_TRANSLATION_PAIR_CURSOR,
			options({ pendingSinceMs: NOW - 21_000 })
		);

		expect(candidate).toMatchObject({
			sourceText: value.sourceStream.text,
			projectionState: 'provisional'
		});
		expect(candidate?.atoms[0].boundary).toBe('forced-tail');
	});

	it('forces the remaining tail when a run ends', () => {
		const value = run('short tail');
		const candidate = nextTranslationPairCandidate(
			value,
			EMPTY_TRANSLATION_PAIR_CURSOR,
			options({ pendingSinceMs: null, finalizing: true })
		);

		expect(candidate).toMatchObject({ sourceText: 'short tail', finalizing: true });
	});

	it('revises a provisional tail when its real sentence ending arrives', () => {
		const value = run('This thought started earlier and now finishes.');
		const candidate = nextProvisionalTranslationPairCandidate(
			value,
			{
				sourceStart: 0,
				sourceEnd: 20,
				runSequence: 1,
				targetLanguage: 'zh'
			},
			options({ pendingSinceMs: NOW - 2_000 })
		);

		expect(candidate).toMatchObject({
			sourceStart: 0,
			sourceEnd: value.sourceStream.text.length,
			projectionState: 'stable'
		});
		expect(candidate?.atoms).toHaveLength(1);
	});

	it('keeps a provisional revision bounded when punctuation never arrives', () => {
		const text = 'x'.repeat(2_000);
		const candidate = nextProvisionalTranslationPairCandidate(
			run(text),
			{ sourceStart: 0, sourceEnd: 500, runSequence: 1, targetLanguage: 'zh' },
			options({ pendingSinceMs: NOW - 21_000 })
		);

		expect(candidate?.sourceEnd).toBe(1_600);
		expect(candidate?.projectionState).toBe('provisional');
	});

	it('stops revising at the bounded range so the next batch can advance', () => {
		const candidate = nextProvisionalTranslationPairCandidate(
			run('x'.repeat(2_000)),
			{ sourceStart: 0, sourceEnd: 1_600, runSequence: 1, targetLanguage: 'zh' },
			options({ pendingSinceMs: NOW - 21_000 })
		);

		expect(candidate).toBeNull();
	});

	it('re-atomizes a fixed failed range instead of collapsing it into one atom', () => {
		const value = run('First sentence. Second sentence.');
		const candidate = translationPairCandidateFromRange(value, {
			sourceStart: 0,
			sourceEnd: value.sourceStream.text.length,
			sourceElapsedEndMs: value.sourceStream.lastElapsedMs,
			runSequence: value.sequence,
			targetLanguage: value.targetLanguage
		});

		expect(candidate.atoms.map((item) => item.text)).toEqual([
			'First sentence.',
			' Second sentence.'
		]);
		expect(candidate.projectionState).toBe('stable');
	});

	it('rejects a cursor outside the source stream', () => {
		expect(() =>
			nextTranslationPairCandidate(run('text'), { sourceEnd: 5, sourceElapsedEndMs: 0 }, options())
		).toThrow('outside the source stream');
	});
});
