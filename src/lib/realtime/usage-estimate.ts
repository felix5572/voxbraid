import type { CaptureRun } from '../session/types';

export const REALTIME_TRANSLATION_MODEL = 'gpt-realtime-translate';
export const REALTIME_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';

export const REALTIME_TRANSLATION_PRICING = Object.freeze({
	components: Object.freeze([
		Object.freeze({ model: REALTIME_TRANSLATION_MODEL, usdPerMinute: 0.034 }),
		Object.freeze({ model: REALTIME_TRANSCRIPTION_MODEL, usdPerMinute: 0.017 })
	]),
	usdPerMinute: 0.051,
	verifiedAt: '2026-09-01'
});

export interface RealtimeUsageEstimate {
	durationMs: number;
	durationSeconds: number;
	estimatedCostUsd: number;
}

function timestampMs(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function estimatedRunDurationMs(run: CaptureRun, nowMs: number): number {
	const mediaStartedAt = timestampMs(run.mediaStartedAt);
	if (mediaStartedAt === null) return run.audioDurationMs;

	const endedAt = timestampMs(run.endedAt);
	const wallClockEnd = endedAt ?? nowMs;
	const wallClockDuration = Math.max(0, wallClockEnd - mediaStartedAt);
	return Math.max(run.audioDurationMs, wallClockDuration);
}

export function estimateRealtimeUsage(
	runs: readonly CaptureRun[],
	nowMs: number
): RealtimeUsageEstimate {
	const durationMs = runs.reduce((total, run) => total + estimatedRunDurationMs(run, nowMs), 0);
	return {
		durationMs,
		durationSeconds: Math.floor(durationMs / 1_000),
		estimatedCostUsd: (durationMs / 60_000) * REALTIME_TRANSLATION_PRICING.usdPerMinute
	};
}

export function formatEstimatedCostUsd(value: number): string {
	if (!Number.isFinite(value) || value < 0) throw new Error('Estimated cost must be non-negative.');
	if (value < 0.1) return value.toFixed(4);
	if (value < 10) return value.toFixed(3);
	return value.toFixed(2);
}
