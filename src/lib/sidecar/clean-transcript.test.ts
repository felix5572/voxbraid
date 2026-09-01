import { describe, expect, it } from 'vitest';
import type { CaptureRun } from '../session/types';
import {
	CLEAN_TRANSCRIPT_TARGET_SOURCE_CHARACTERS,
	EMPTY_CLEAN_TRANSCRIPT_CURSOR,
	cleanTranscriptContinuity,
	cleanTranscriptCursorForRun,
	nextCleanTranscriptCandidate,
	nextCleanTranscriptSequence,
	type StoredCleanTranscriptBlock
} from './clean-transcript';

function run(source: string, translation = '译文。', elapsedMs = 600_000): CaptureRun {
	return {
		id: 'run-1',
		threadId: 'thread-1',
		sequence: 1,
		status: 'live',
		targetLanguage: 'zh',
		createdAt: '2026-09-01T00:00:00.000Z',
		mediaStartedAt: '2026-09-01T00:00:01.000Z',
		endedAt: null,
		lastActivityAt: '2026-09-01T00:10:00.000Z',
		hiddenAt: null,
		audioDurationMs: elapsedMs,
		endTimeEstimated: false,
		endReason: null,
		recoveredFromRunId: null,
		clientPlatform: 'test',
		lastError: null,
		sourceStream: { text: source, lastElapsedMs: elapsedMs, updatedAt: null },
		translationStream: { text: translation, lastElapsedMs: elapsedMs, updatedAt: null },
		currentSegmentRevision: null
	};
}

function block(overrides: Partial<StoredCleanTranscriptBlock> = {}): StoredCleanTranscriptBlock {
	return {
		id: 'block-1',
		threadId: 'thread-1',
		runId: 'run-1',
		sequence: 1,
		runSequence: 1,
		targetLanguage: 'zh',
		sourceStart: 0,
		sourceEnd: 500,
		translationStart: 0,
		translationEnd: 200,
		sourceElapsedEndMs: 10_000,
		translationElapsedEndMs: 10_000,
		status: 'completed',
		text: '整理后的课堂内容。',
		capturedAt: '2026-09-01T00:00:10.000Z',
		model: 'gpt-5.6-terra',
		taskVersion: 5,
		usageStatus: 'unavailable',
		usage: null,
		error: null,
		updatedAt: '2026-09-01T00:00:20.000Z',
		...overrides
	};
}

describe('clean transcript block projection', () => {
	it('waits for a sentence ending after the target size', () => {
		const incomplete = run(
			'x'.repeat(CLEAN_TRANSCRIPT_TARGET_SOURCE_CHARACTERS),
			'译文。',
			100_000
		);
		expect(
			nextCleanTranscriptCandidate(incomplete, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: false,
				allowShort: false
			})
		).toBeNull();

		const complete = run(
			`${'x'.repeat(CLEAN_TRANSCRIPT_TARGET_SOURCE_CHARACTERS)}.`,
			'译文。',
			100_000
		);
		expect(
			nextCleanTranscriptCandidate(complete, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: false,
				allowShort: false
			})?.sourceEnd
		).toBe(complete.sourceStream.text.length);
	});

	it('splits oversized historical input near a sentence boundary', () => {
		const first = `${'a'.repeat(5_200)}. `;
		const capture = run(`${first}${'b'.repeat(4_000)}.`, `第一段。${'译'.repeat(3_500)}。`);
		const candidate = nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
			force: true,
			allowShort: true
		});

		expect(candidate?.sourceEnd).toBe(first.trimEnd().length);
		expect(candidate?.translationEnd).toBeGreaterThan(0);
		expect(candidate?.translationEnd).toBeLessThan(capture.translationStream.text.length);
	});

	it('flushes a short tail only when explicitly allowed', () => {
		const capture = run('A short final thought.', '最后一句。', 20_000);
		expect(
			nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: true,
				allowShort: false
			})
		).toBeNull();
		expect(
			nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: true,
				allowShort: true
			})?.sourceText
		).toBe('A short final thought.');
	});

	it('waits briefly for the translation stream before closing an automatic block', () => {
		const capture = run(
			`${'x'.repeat(CLEAN_TRANSCRIPT_TARGET_SOURCE_CHARACTERS)}.`,
			'译文。',
			100_000
		);
		capture.translationStream.lastElapsedMs = 97_000;
		expect(
			nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: false,
				allowShort: false
			})
		).toBeNull();
		capture.translationStream.lastElapsedMs = 98_000;
		expect(
			nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: false,
				allowShort: false
			})
		).not.toBeNull();
	});

	it('lets a hard-size block close even when translation remains behind', () => {
		const capture = run('x'.repeat(8_000), '译文。', 100_000);
		capture.translationStream.lastElapsedMs = 80_000;
		expect(
			nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: false,
				allowShort: false
			})?.sourceEnd
		).toBe(8_000);
	});

	it('forces a usable block after ten minutes even without punctuation', () => {
		const capture = run('x'.repeat(400), '译'.repeat(150), 600_000);
		expect(
			nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
				force: false,
				allowShort: false
			})?.sourceText
		).toBe(capture.sourceStream.text);
	});

	it('covers oversized streams without gaps when blocks are consumed in order', () => {
		const source = `${'a'.repeat(5_100)}. ${'b'.repeat(5_200)}. ${'c'.repeat(4_000)}.`;
		const translation = `${'甲'.repeat(2_000)}。${'乙'.repeat(2_000)}。${'丙'.repeat(1_000)}。`;
		const capture = run(source, translation);
		const sourcePieces: string[] = [];
		const translationPieces: string[] = [];
		let cursor = { ...EMPTY_CLEAN_TRANSCRIPT_CURSOR };
		while (true) {
			const candidate = nextCleanTranscriptCandidate(capture, cursor, {
				force: true,
				allowShort: true
			});
			if (!candidate) break;
			sourcePieces.push(candidate.sourceText);
			translationPieces.push(candidate.translationText);
			cursor = candidate;
		}

		expect(sourcePieces.join('')).toBe(source);
		expect(translationPieces.join('')).toBe(translation);
	});

	it('keeps a time anchor after an intermediate hard split', () => {
		const first = `${'a'.repeat(5_200)}. `;
		const capture = run(`${first}${'b'.repeat(3_500)}`, '译文。', 600_000);
		const initial = nextCleanTranscriptCandidate(capture, EMPTY_CLEAN_TRANSCRIPT_CURSOR, {
			force: false,
			allowShort: false
		});
		expect(initial?.sourceEnd).toBe(first.trimEnd().length);
		expect(initial?.sourceElapsedEndMs).toBe(600_000);

		capture.sourceStream.lastElapsedMs = 1_200_000;
		capture.translationStream.lastElapsedMs = 1_200_000;
		expect(
			nextCleanTranscriptCandidate(capture, initial!, {
				force: false,
				allowShort: false
			})?.sourceText
		).toBe(` ${'b'.repeat(3_500)}`);
	});

	it('derives the next cursor, sequence and continuity from stored blocks', () => {
		const blocks = [
			block(),
			block({
				id: 'block-2',
				sequence: 2,
				sourceStart: 500,
				sourceEnd: 900,
				translationStart: 200,
				translationEnd: 350,
				text: `开头${'续'.repeat(1_100)}`
			})
		];

		expect(cleanTranscriptCursorForRun(blocks, 'run-1')).toMatchObject({
			sourceEnd: 900,
			translationEnd: 350
		});
		expect(nextCleanTranscriptSequence(blocks)).toBe(3);
		expect(cleanTranscriptContinuity(blocks)).toHaveLength(1_000);
		expect(cleanTranscriptContinuity(blocks, 2)).toBe('整理后的课堂内容。');
	});
});
