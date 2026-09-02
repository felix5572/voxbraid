import { describe, expect, it } from 'vitest';
import {
	capturedRevisionSourceEnd,
	commitRevisionGroups,
	modelSourceAtoms,
	revisionTrigger,
	sourceClauseAtoms
} from './revision-projection';

describe('revision projection', () => {
	it('tiles the exact raw range into numbered clause atoms', () => {
		const text = 'Before.  Hello, world; 世界！ after';
		const start = 7;
		const end = text.length - 6;
		const atoms = sourceClauseAtoms(text, start, end, 'en');

		expect(atoms.map((atom) => atom.text).join('')).toBe(text.slice(start, end));
		expect(atoms.map((atom) => atom.boundary)).toEqual(['clause', 'clause', 'sentence']);
		expect(atoms[0].start).toBe(start);
		expect(atoms.at(-1)?.end).toBe(end);
		expect(modelSourceAtoms(atoms)).toEqual(
			atoms.map((atom, index) => ({ i: index + 1, t: atom.text, boundary: atom.boundary }))
		);
	});

	it('forces long unpunctuated speech into bounded atoms without changing text', () => {
		const text = ` ${'longword '.repeat(60)}${'x'.repeat(300)}`;
		const atoms = sourceClauseAtoms(text, 0, text.length, 'en');

		expect(atoms.map((atom) => atom.text).join('')).toBe(text);
		expect(atoms.every((atom) => atom.text.length <= 240)).toBe(true);
		expect(atoms.every((atom) => atom.text.trim().length > 0)).toBe(true);
		expect(atoms.slice(0, -1).every((atom) => atom.boundary === 'forced')).toBe(true);
		expect(atoms.at(-1)?.boundary).toBe('open');
	});

	it('bounds every recovery request and leaves the rest pending', () => {
		expect(capturedRevisionSourceEnd(10_000, 2_000)).toBe(3_600);
		expect(capturedRevisionSourceEnd(2_100, 2_000)).toBe(2_100);
	});

	it('enforces the automatic interval but lets finalizing bypass it', () => {
		const base = {
			text: 'First clause, second clause.',
			frozenEnd: 0,
			latestCapturedEnd: 0,
			nowMs: 10_000,
			streamUpdatedAt: new Date(9_000).toISOString(),
			pendingSinceMs: 1_000,
			lastAutomaticRequestAtMs: 8_000,
			manual: false,
			finalizing: false
		};
		expect(revisionTrigger(base)).toMatchObject({
			ready: false,
			waitingFor: 'request-interval',
			requestIntervalRemainingMs: 2_000
		});
		expect(revisionTrigger({ ...base, finalizing: true })).toMatchObject({
			ready: true,
			waitingFor: 'ready'
		});
	});

	it('triggers from new clause punctuation but not old punctuation', () => {
		const previous = 'First sentence.';
		const base = {
			text: `${previous} New clause, `,
			frozenEnd: 0,
			nowMs: 10_000,
			streamUpdatedAt: new Date(10_000).toISOString(),
			pendingSinceMs: 9_000,
			lastAutomaticRequestAtMs: null,
			manual: false,
			finalizing: false
		};
		expect(revisionTrigger({ ...base, latestCapturedEnd: previous.length })).toMatchObject({
			ready: true,
			waitingFor: 'ready'
		});
		expect(
			revisionTrigger({
				...base,
				text: `${previous} new fragment`,
				latestCapturedEnd: previous.length
			})
		).toMatchObject({ ready: false, waitingFor: 'punctuation-or-quiet' });
	});

	it('requires enough new text before an unpunctuated quiet pause triggers a request', () => {
		const input = {
			text: 'The',
			frozenEnd: 0,
			latestCapturedEnd: 0,
			nowMs: 10_000,
			streamUpdatedAt: new Date(8_000).toISOString(),
			pendingSinceMs: 8_000,
			lastAutomaticRequestAtMs: null,
			manual: false,
			finalizing: false
		};

		expect(revisionTrigger(input)).toMatchObject({
			ready: false,
			waitingFor: 'punctuation-or-quiet'
		});
		expect(revisionTrigger({ ...input, text: 'x'.repeat(40) })).toMatchObject({
			ready: true,
			waitingFor: 'ready'
		});
	});

	it('keeps a bounded tail and forces progress at a full window', () => {
		const rawText = 'x'.repeat(1_600);
		const plan = commitRevisionGroups({
			requestStart: 0,
			requestEnd: 1_600,
			rawText,
			groups: [{ sourceStart: 0, sourceEnd: 1_600, oversized: true, endingBoundary: 'forced' }],
			finalizing: false,
			quietForMs: 0
		});
		expect(plan).toEqual({ frozenEnd: 1_600, openStart: 1_600, openEnd: 1_600 });
	});

	it('freezes a continuous prefix while retaining the last two complete sentences', () => {
		const plan = commitRevisionGroups({
			requestStart: 0,
			requestEnd: 40,
			rawText: 'a'.repeat(40),
			groups: [
				{ sourceStart: 0, sourceEnd: 10, oversized: false, endingBoundary: 'sentence' },
				{ sourceStart: 10, sourceEnd: 20, oversized: false, endingBoundary: 'clause' },
				{ sourceStart: 20, sourceEnd: 30, oversized: false, endingBoundary: 'sentence' },
				{ sourceStart: 30, sourceEnd: 40, oversized: false, endingBoundary: 'sentence' }
			],
			finalizing: false,
			quietForMs: 0
		});

		expect(plan).toEqual({ frozenEnd: 10, openStart: 10, openEnd: 40 });
	});

	it('freezes all groups when finalizing', () => {
		expect(
			commitRevisionGroups({
				requestStart: 10,
				requestEnd: 30,
				rawText: 'a'.repeat(20),
				groups: [
					{ sourceStart: 10, sourceEnd: 20, oversized: false, endingBoundary: 'clause' },
					{ sourceStart: 20, sourceEnd: 30, oversized: false, endingBoundary: 'open' }
				],
				finalizing: true,
				quietForMs: 0
			})
		).toEqual({ frozenEnd: 30, openStart: 30, openEnd: 30 });
	});

	it('treats a sentence followed by whitespace as a natural ending', () => {
		expect(
			commitRevisionGroups({
				requestStart: 0,
				requestEnd: 16,
				rawText: 'First sentence. ',
				groups: [{ sourceStart: 0, sourceEnd: 16, oversized: false, endingBoundary: 'sentence' }],
				finalizing: false,
				quietForMs: 1_200
			})
		).toEqual({ frozenEnd: 16, openStart: 16, openEnd: 16 });
	});
});
