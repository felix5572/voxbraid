import type { ModelUsage, ModelUsageStatus } from './types';

export interface TranscriptExtent {
	sourceCharacters: number;
	translationCharacters: number;
}

export interface StoredAutoSummary extends TranscriptExtent {
	threadId: string;
	revision: number;
	text: string;
	capturedAt: string;
	model: string;
	usageStatus: ModelUsageStatus;
	usage: ModelUsage | null;
	updatedAt: string;
}
