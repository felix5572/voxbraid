import { describe, expect, it } from 'vitest';
import {
	capturedRevisionSourceEnd,
	commitRevisionGroups,
	modelSourceTokens,
	revisionTrigger,
	tokenizeRevisionSource
} from './revision-projection';

describe('revision projection', () => {
	it('tokens preserve the exact raw range and expose explicit model indexes', () => {
		const text = 'Before.  Hello, 世界！ after';
		const tokens = tokenizeRevisionSource(text, 7, text.length - 6, 'en');
		expect(tokens.map((token) => token.text).join('')).toBe('  Hello, 世界！');
		expect(tokens[0].start).toBe(7);
		expect(tokens.at(-1)?.end).toBe(text.length - 6);
		expect(modelSourceTokens(tokens)).toEqual(
			tokens.map((token, index) => ({ i: index + 1, t: token.text }))
		);
	});

	it('bounds every recovery request and leaves the rest pending', () => {
		expect(capturedRevisionSourceEnd(10_000, 2_000)).toBe(3_600);
		expect(capturedRevisionSourceEnd(2_100, 2_000)).toBe(2_100);
	});

	it('enforces the automatic interval but lets finalizing bypass it', () => {
		const base = {
			text: 'First sentence. Second sentence.',
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

	it('uses only newly captured text for sentence triggers', () => {
		const text = 'First sentence. Second sentence. new fragment';
		expect(
			revisionTrigger({
				text,
				frozenEnd: 0,
				latestCapturedEnd: 'First sentence. Second sentence.'.length,
				nowMs: 10_000,
				streamUpdatedAt: new Date(10_000).toISOString(),
				pendingSinceMs: 1_000,
				lastAutomaticRequestAtMs: null,
				manual: false,
				finalizing: false
			})
		).toMatchObject({ ready: false, waitingFor: 'sentence-ending' });
	});

	it('keeps a bounded tail and forces progress at a full window', () => {
		const rawText = 'x'.repeat(1_600);
		const plan = commitRevisionGroups({
			requestStart: 0,
			requestEnd: 1_600,
			rawText,
			groups: [{ sourceStart: 0, sourceEnd: 1_600, oversized: true }],
			finalizing: false,
			quietForMs: 0
		});
		expect(plan).toEqual({ frozenEnd: 1_600, openStart: 1_600, openEnd: 1_600 });
	});

	it('freezes all groups when finalizing', () => {
		expect(
			commitRevisionGroups({
				requestStart: 10,
				requestEnd: 30,
				rawText: 'a'.repeat(20),
				groups: [
					{ sourceStart: 10, sourceEnd: 20, oversized: false },
					{ sourceStart: 20, sourceEnd: 30, oversized: false }
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
				groups: [{ sourceStart: 0, sourceEnd: 16, oversized: false }],
				finalizing: false,
				quietForMs: 1_200
			})
		).toEqual({ frozenEnd: 16, openStart: 16, openEnd: 16 });
	});
});
