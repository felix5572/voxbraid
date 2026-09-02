import type { StoredRevisedSegment } from './revision-records';

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
