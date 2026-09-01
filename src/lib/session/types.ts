export interface TranslationThread {
	id: string;
	ownerId: string | null;
	title: string | null;
	defaultTargetLanguage: string;
	status: 'active' | 'archived';
	createdAt: string;
	updatedAt: string;
}

export type CaptureRunStatus =
	'starting' | 'live' | 'stopping' | 'completed' | 'interrupted' | 'failed';

export type CaptureRunEndReason =
	| 'user-paused'
	| 'duration-limit'
	| 'connection-lost'
	| 'page-suspended'
	| 'page-terminated'
	| 'permission-denied'
	| 'startup-failed';

export interface RunError {
	code: string | null;
	message: string;
}

export interface TranscriptStreamSnapshot {
	text: string;
	lastElapsedMs: number | null;
	updatedAt: string | null;
}

export interface CaptureRun {
	id: string;
	threadId: string;
	sequence: number;
	status: CaptureRunStatus;
	targetLanguage: string;
	createdAt: string;
	mediaStartedAt: string | null;
	endedAt: string | null;
	lastActivityAt: string | null;
	hiddenAt: string | null;
	audioDurationMs: number;
	endTimeEstimated: boolean;
	endReason: CaptureRunEndReason | null;
	recoveredFromRunId: string | null;
	clientPlatform: string | null;
	lastError: RunError | null;
	sourceStream: TranscriptStreamSnapshot;
	translationStream: TranscriptStreamSnapshot;
	currentSegmentRevision: number | null;
}

export type SegmentAlignment = 'approximate' | 'unpaired';

export interface TranscriptSegment {
	id: string;
	runId: string;
	revision: number;
	sequence: number;
	sourceText: string;
	translatedText: string;
	alignment: SegmentAlignment;
	createdAt: string;
	updatedAt: string;
}
