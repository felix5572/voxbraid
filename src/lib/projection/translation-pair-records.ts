import type {
	ModelUsage,
	ModelUsageStatus,
	SidecarErrorCode,
	SidecarFailureDiagnostic
} from '../sidecar/types';
import type { TranslationPairProjectionState } from './source-atoms';

export type TranslationPairBatchStatus = 'completed' | 'failed';

export interface TranslationPairFailureAttempt {
	capturedAt: string;
	failedAt: string;
	clientRequestId: string;
	responseId: string | null;
	model: string | null;
	upstreamStatus: 'failed' | 'incomplete' | 'cancelled' | null;
	errorCode: SidecarErrorCode | null;
	error: string;
	diagnostic: SidecarFailureDiagnostic | null;
}

export interface StoredTranslationPairBatch {
	id: string;
	threadId: string;
	runId: string;
	runSequence: number;
	sequence: number;
	revision: number;
	projectionState: TranslationPairProjectionState;
	targetLanguage: string;
	sourceStart: number;
	sourceEnd: number;
	sourceElapsedEndMs: number | null;
	status: TranslationPairBatchStatus;
	capturedAt: string;
	completedAt: string | null;
	model: string | null;
	taskVersion: number;
	clientRequestId: string;
	responseId: string | null;
	usageStatus: ModelUsageStatus;
	usage: ModelUsage | null;
	upstreamStatus: 'failed' | 'incomplete' | 'cancelled' | null;
	errorCode: SidecarErrorCode | null;
	error: string | null;
	diagnostic: SidecarFailureDiagnostic | null;
	failureAttempts: TranslationPairFailureAttempt[];
	updatedAt: string;
}

export interface StoredTranslationPairSegment {
	id: string;
	batchId: string;
	batchRevision: number;
	threadId: string;
	runId: string;
	runSequence: number;
	sequence: number;
	sourceStart: number;
	sourceEnd: number;
	sourceText: string;
	translatedText: string;
	paragraphBreakBefore: boolean;
	createdAt: string;
}

export interface StoredTranslationPairProjection {
	batches: StoredTranslationPairBatch[];
	segments: StoredTranslationPairSegment[];
}

export function isCurrentProvisionalBatch(
	batch: StoredTranslationPairBatch,
	batches: readonly StoredTranslationPairBatch[]
): boolean {
	if (batch.projectionState !== 'provisional') return false;
	const latest = batches
		.filter((candidate) => candidate.runId === batch.runId)
		.sort((left, right) => left.sequence - right.sequence)
		.at(-1);
	return latest?.id === batch.id;
}
