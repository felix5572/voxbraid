import { describe, expect, it } from 'vitest';
import {
	reconcileRevisionSegmentPresentation,
	revisionLongGroupSummary,
	revisionSegmentDisplayId,
	supersededFailedBatches
} from './revision-display';
import type { StoredRevisedSegment, StoredRevisionBatch } from './revision-records';

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

function batch(
	sequence: number,
	status: StoredRevisionBatch['status'],
	overrides: Partial<StoredRevisionBatch> = {}
): StoredRevisionBatch {
	return {
		id: `batch-${sequence}`,
		threadId: 'thread-1',
		runId: 'run-1',
		runSequence: 1,
		sequence,
		openStart: 100,
		openEnd: 300,
		tokenizerVersion: 2,
		taskVersion: 4,
		trigger: 'periodic',
		status,
		capturedAt: '2026-09-02T10:00:00.000Z',
		completedAt: status === 'completed' ? '2026-09-02T10:00:01.000Z' : null,
		clientRequestId: `request-${sequence}`,
		responseId: status === 'completed' ? `response-${sequence}` : null,
		model: 'gpt-5.6-luna',
		usageStatus: 'unavailable',
		usage: null,
		upstreamStatus: status === 'failed' ? 'failed' : null,
		errorCode: status === 'failed' ? 'invalid-revision-boundary' : null,
		error: status === 'failed' ? 'failed' : null,
		diagnostic: null,
		transportDiagnostic: null,
		updatedAt: '2026-09-02T10:00:01.000Z',
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

	it('marks a failed batch superseded only when a later success fully covers its range', () => {
		const failed = batch(1, 'failed');
		const covered = batch(2, 'completed', { openStart: 80, openEnd: 320 });
		const partial = batch(3, 'completed', { openStart: 120, openEnd: 320 });
		const laterFailure = batch(4, 'failed', { openStart: 80, openEnd: 320 });

		expect(supersededFailedBatches([failed, covered]).map((item) => item.id)).toEqual([failed.id]);
		expect(supersededFailedBatches([failed, partial])).toEqual([]);
		expect(supersededFailedBatches([failed, laterFailure])).toEqual([]);
	});

	it('counts groups longer than the observation threshold without rejecting them', () => {
		expect(
			revisionLongGroupSummary([
				segment({ sourceStart: 0, sourceEnd: 480 }),
				segment({ sourceStart: 480, sourceEnd: 961 })
			])
		).toEqual({ long: 1, total: 2 });
	});
});
