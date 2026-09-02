import { describe, expect, it } from 'vitest';
import { reconcileRevisionSegmentPresentation, revisionSegmentDisplayId } from './revision-display';
import type { StoredRevisedSegment } from './revision-records';

function segment(overrides: Partial<StoredRevisedSegment> = {}): StoredRevisedSegment {
	return {
		id: 'batch-old:1',
		threadId: 'thread-1',
		runId: 'run-1',
		runSequence: 1,
		sourceStart: 10,
		sourceEnd: 20,
		rawText: 'raw source',
		revisedSourceText: 'Revised source.',
		translatedText: '修订译文。',
		paragraphBreakBefore: false,
		state: 'open',
		boundaryState: 'complete',
		producedByBatchId: 'batch-old',
		sourceElapsedEndMs: 1_000,
		frozenAt: null,
		updatedAt: '2026-09-02T10:00:00.000Z',
		...overrides
	};
}

describe('revision segment presentation', () => {
	it('keeps the display timestamp when both texts and the raw range are unchanged', () => {
		const previous = segment();
		const next = segment({
			id: 'batch-new:1',
			producedByBatchId: 'batch-new',
			updatedAt: '2026-09-02T10:01:00.000Z'
		});
		expect(reconcileRevisionSegmentPresentation([previous], [next])).toEqual([
			{
				...next,
				id: 'run-1:10:20',
				updatedAt: previous.updatedAt
			}
		]);
	});

	it('uses the new timestamp when either displayed text changes', () => {
		const previous = segment();
		const next = segment({
			translatedText: '更新后的译文。',
			updatedAt: '2026-09-02T10:01:00.000Z'
		});
		expect(reconcileRevisionSegmentPresentation([previous], [next])[0]).toMatchObject({
			id: 'run-1:10:20',
			updatedAt: next.updatedAt
		});
	});

	it('creates a different stable id when the model changes a boundary', () => {
		const previous = segment();
		const next = segment({ sourceEnd: 24, updatedAt: '2026-09-02T10:01:00.000Z' });
		const reconciled = reconcileRevisionSegmentPresentation([previous], [next])[0];
		expect(reconciled.id).toBe('run-1:10:24');
		expect(reconciled.id).not.toBe(revisionSegmentDisplayId(previous));
		expect(reconciled.updatedAt).toBe(next.updatedAt);
	});
});
