import { describe, expect, it } from 'vitest';
import type { CaptureRun } from '../session/types';
import {
	REALTIME_TRANSLATION_PRICING,
	estimateRealtimeUsage,
	estimatedRunDurationMs,
	formatEstimatedCostUsd
} from './usage-estimate';

function run(overrides: Partial<CaptureRun> = {}): CaptureRun {
	return {
		id: 'run-1',
		threadId: 'thread-1',
		sequence: 1,
		status: 'completed',
		targetLanguage: 'zh',
		createdAt: '2026-09-01T12:00:00.000Z',
		mediaStartedAt: '2026-09-01T12:00:01.000Z',
		endedAt: '2026-09-01T12:01:01.000Z',
		lastActivityAt: null,
		hiddenAt: null,
		audioDurationMs: 58_000,
		endTimeEstimated: false,
		endReason: 'user-paused',
		recoveredFromRunId: null,
		clientPlatform: null,
		lastError: null,
		sourceStream: { text: '', lastElapsedMs: null, updatedAt: null },
		translationStream: { text: '', lastElapsedMs: null, updatedAt: null },
		currentSegmentRevision: null,
		...overrides
	};
}

describe('realtime usage estimate', () => {
	it('uses connected wall-clock time when it exceeds observed transcript progress', () => {
		expect(estimatedRunDurationMs(run(), Date.parse('2026-09-01T13:00:00.000Z'))).toBe(60_000);
	});

	it('keeps an active run increasing even before another transcript delta arrives', () => {
		const active = run({
			status: 'live',
			endedAt: null,
			audioDurationMs: 3_000
		});
		expect(estimatedRunDurationMs(active, Date.parse('2026-09-01T12:00:11.500Z'))).toBe(10_500);
	});

	it('adds paused and active runs within the current product session', () => {
		const estimate = estimateRealtimeUsage(
			[
				run(),
				run({
					id: 'run-2',
					sequence: 2,
					status: 'live',
					mediaStartedAt: '2026-09-01T12:02:00.000Z',
					endedAt: null,
					audioDurationMs: 10_000
				})
			],
			Date.parse('2026-09-01T12:02:30.000Z')
		);

		expect(estimate.durationMs).toBe(90_000);
		expect(estimate.durationSeconds).toBe(90);
		expect(estimate.estimatedCostUsd).toBeCloseTo(1.5 * REALTIME_TRANSLATION_PRICING.usdPerMinute);
	});

	it('includes both translation and source-transcription charges', () => {
		const estimate = estimateRealtimeUsage([run()], Date.parse('2026-09-01T13:00:00.000Z'));

		expect(REALTIME_TRANSLATION_PRICING.components).toEqual([
			{ model: 'gpt-realtime-translate', usdPerMinute: 0.034 },
			{ model: 'gpt-realtime-whisper', usdPerMinute: 0.017 }
		]);
		expect(estimate.durationSeconds).toBe(60);
		expect(estimate.estimatedCostUsd).toBeCloseTo(0.051);
	});

	it('falls back to protocol duration when media timestamps are unavailable', () => {
		expect(
			estimatedRunDurationMs(
				run({ mediaStartedAt: null, endedAt: null, audioDurationMs: 12_345 }),
				Date.now()
			)
		).toBe(12_345);
	});

	it('formats small estimates without hiding sub-cent costs', () => {
		expect(formatEstimatedCostUsd(0.005666)).toBe('0.0057');
		expect(formatEstimatedCostUsd(0.34)).toBe('0.340');
		expect(formatEstimatedCostUsd(12.34)).toBe('12.34');
		expect(() => formatEstimatedCostUsd(-1)).toThrow('non-negative');
	});
});
