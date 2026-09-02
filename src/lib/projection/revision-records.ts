import type {
	ModelUsage,
	ModelUsageStatus,
	SidecarErrorCode,
	SidecarFailureDiagnostic
} from '../sidecar/types';

export type RevisionBatchStatus = 'completed' | 'failed';
export type RevisionTrigger = 'periodic' | 'manual' | 'finalizing';
export type RevisionSegmentState = 'open' | 'frozen';
export type RevisionBoundaryState = 'complete' | 'forced-tail';

export interface StoredRevisionBatch {
	id: string;
	threadId: string;
	runId: string;
	runSequence: number;
	sequence: number;
	openStart: number;
	openEnd: number;
	tokenizerVersion: number;
	taskVersion: number;
	trigger: RevisionTrigger;
	status: RevisionBatchStatus;
	capturedAt: string;
	completedAt: string | null;
	clientRequestId: string;
	responseId: string | null;
	model: string | null;
	usageStatus: ModelUsageStatus;
	usage: ModelUsage | null;
	upstreamStatus: 'failed' | 'incomplete' | 'cancelled' | null;
	errorCode: SidecarErrorCode | null;
	error: string | null;
	diagnostic: SidecarFailureDiagnostic | null;
	updatedAt: string;
}

export interface StoredRevisedSegment {
	id: string;
	threadId: string;
	runId: string;
	runSequence: number;
	sourceStart: number;
	sourceEnd: number;
	rawText: string;
	revisedSourceText: string;
	translatedText: string;
	paragraphBreakBefore: boolean;
	state: RevisionSegmentState;
	boundaryState: RevisionBoundaryState;
	producedByBatchId: string;
	sourceElapsedEndMs: number | null;
	frozenAt: string | null;
	updatedAt: string;
}

export interface StoredRevisionProjection {
	batches: StoredRevisionBatch[];
	segments: StoredRevisedSegment[];
}
