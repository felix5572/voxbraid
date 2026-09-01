import type { TranslationSessionState } from '../session/translation-session';
import type { ModelUsage, ModelUsageStatus, SidecarInvokeResult } from './types';

export const AUTO_SUMMARY_CONTENT_THRESHOLD = 3_000;
export const AUTO_SUMMARY_FINAL_CONTENT_THRESHOLD = 300;
export const AUTO_SUMMARY_COOLDOWN_MS = 5 * 60 * 1_000;

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

export interface AutoSummaryTriggerInput {
	extent: TranscriptExtent;
	baselineSourceCharacters: number;
	requesting: boolean;
	nowMs: number;
	lastRequestedAtMs: number | null;
	runJustEnded: boolean;
}

export function transcriptExtent(state: TranslationSessionState | null): TranscriptExtent {
	return (state?.runs ?? []).reduce<TranscriptExtent>(
		(total, run) => ({
			sourceCharacters: total.sourceCharacters + run.sourceStream.text.length,
			translationCharacters: total.translationCharacters + run.translationStream.text.length
		}),
		{ sourceCharacters: 0, translationCharacters: 0 }
	);
}

export function shouldAutomaticallySummarize(input: AutoSummaryTriggerInput): boolean {
	if (input.requesting) return false;
	const addedSourceCharacters = Math.max(
		0,
		input.extent.sourceCharacters - input.baselineSourceCharacters
	);
	if (input.runJustEnded) {
		return addedSourceCharacters >= AUTO_SUMMARY_FINAL_CONTENT_THRESHOLD;
	}
	if (addedSourceCharacters < AUTO_SUMMARY_CONTENT_THRESHOLD) return false;
	return (
		input.lastRequestedAtMs === null ||
		input.nowMs - input.lastRequestedAtMs >= AUTO_SUMMARY_COOLDOWN_MS
	);
}

export function stopsAutomaticSummaries(result: SidecarInvokeResult): boolean {
	return result.status === 'failed' && result.error.code === 'context-too-large';
}
