import { describe, expect, it } from 'vitest';
import { visibleTranscriptRuns } from './transcript-view';
import type { CaptureRun } from './types';

function run(id: string, sequence: number, source: string, translation: string): CaptureRun {
	return {
		id,
		threadId: 'thread-1',
		sequence,
		status: sequence === 1 ? 'completed' : 'live',
		targetLanguage: 'zh',
		createdAt: `2026-08-31T00:00:0${sequence}.000Z`,
		mediaStartedAt: `2026-08-31T00:00:0${sequence + 1}.000Z`,
		endedAt: sequence === 1 ? '2026-08-31T00:00:03.000Z' : null,
		lastActivityAt: null,
		hiddenAt: null,
		audioDurationMs: 0,
		endTimeEstimated: false,
		endReason: sequence === 1 ? 'user-paused' : null,
		recoveredFromRunId: null,
		clientPlatform: 'test',
		lastError: null,
		sourceStream: { text: source, lastElapsedMs: null, updatedAt: null },
		translationStream: { text: translation, lastElapsedMs: null, updatedAt: null },
		currentSegmentRevision: null
	};
}

describe('visibleTranscriptRuns', () => {
	it('shows the complete transcript when no view limit is requested', () => {
		const longOpening = `opening ${'x'.repeat(2_100)} ending`;
		const runs = [
			run('run-1', 1, longOpening, '第一段'),
			run('run-2', 2, 'second source', '第二段')
		];

		expect(visibleTranscriptRuns(runs, 'source')).toEqual([
			expect.objectContaining({ runId: 'run-1', text: longOpening, truncated: false }),
			expect.objectContaining({ runId: 'run-2', text: 'second source', truncated: false })
		]);
	});

	it('keeps completed run text visible while a new run is still empty', () => {
		const runs = [run('run-1', 1, 'first source', '第一段'), run('run-2', 2, '', '')];

		expect(visibleTranscriptRuns(runs, 'source', 2_000)).toMatchObject([
			{ runId: 'run-1', sequence: 1, text: 'first source' }
		]);
		expect(visibleTranscriptRuns(runs, 'translation', 2_000)).toMatchObject([
			{ runId: 'run-1', sequence: 1, text: '第一段' }
		]);
	});

	it('shows multiple runs in order while keeping the two streams independent', () => {
		const runs = [
			run('run-1', 1, 'first source', '第一段'),
			run('run-2', 2, 'second source', '第二段')
		];

		expect(visibleTranscriptRuns(runs, 'source', 2_000).map((item) => item.text)).toEqual([
			'first source',
			'second source'
		]);
		expect(visibleTranscriptRuns(runs, 'translation', 2_000).map((item) => item.text)).toEqual([
			'第一段',
			'第二段'
		]);
	});

	it('renders only the newest bounded tail without modifying the facts', () => {
		const older = run('run-1', 1, 'old facts', '旧内容');
		const newer = run('run-2', 2, 'abcdefghij', '新内容');

		expect(visibleTranscriptRuns([older, newer], 'source', 5)).toEqual([
			{
				runId: 'run-2',
				sequence: 2,
				targetLanguage: 'zh',
				startedAt: '2026-08-31T00:00:03.000Z',
				text: '…fghij',
				truncated: true
			}
		]);
		expect(newer.sourceStream.text).toBe('abcdefghij');
	});

	it('rejects a non-positive view limit', () => {
		expect(() => visibleTranscriptRuns([], 'source', 0)).toThrow(RangeError);
	});
});
