import { REVISION_LONG_GROUP_CHARACTERS } from './revision-constants';
import type { StoredRevisedSegment, StoredRevisionBatch } from './revision-records';

export function supersededFailedBatches(
	batches: readonly StoredRevisionBatch[]
): StoredRevisionBatch[] {
	return batches.filter(
		(failed) =>
			failed.status === 'failed' &&
			batches.some(
				(candidate) =>
					candidate.status === 'completed' &&
					candidate.threadId === failed.threadId &&
					candidate.runId === failed.runId &&
					candidate.sequence > failed.sequence &&
					candidate.openStart <= failed.openStart &&
					candidate.openEnd >= failed.openEnd
			)
	);
}

export function revisionLongGroupSummary(
	segments: readonly Pick<StoredRevisedSegment, 'sourceStart' | 'sourceEnd'>[]
): { long: number; total: number } {
	return {
		long: segments.filter(
			(segment) => segment.sourceEnd - segment.sourceStart > REVISION_LONG_GROUP_CHARACTERS
		).length,
		total: segments.length
	};
}

export function revisionSegmentDisplayId(
	segment: Pick<StoredRevisedSegment, 'runId' | 'sourceStart' | 'sourceEnd'>
): string {
	return `${segment.runId}:${segment.sourceStart}:${segment.sourceEnd}`;
}

export function reconcileRevisionSegmentPresentation(
	previousOpenSegments: readonly StoredRevisedSegment[],
	nextSegments: readonly StoredRevisedSegment[]
): StoredRevisedSegment[] {
	return nextSegments.map((segment) => {
		const matching = previousOpenSegments.find(
			(candidate) =>
				candidate.sourceStart === segment.sourceStart && candidate.sourceEnd === segment.sourceEnd
		);
		const textChanged =
			!matching ||
			matching.revisedSourceText !== segment.revisedSourceText ||
			matching.translatedText !== segment.translatedText;
		return {
			...segment,
			id: revisionSegmentDisplayId(segment),
			updatedAt: textChanged ? segment.updatedAt : matching.updatedAt
		};
	});
}
