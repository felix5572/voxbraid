import { describe, expect, it } from 'vitest';
import {
	AUTO_SUMMARY_CONTENT_THRESHOLD,
	AUTO_SUMMARY_COOLDOWN_MS,
	AUTO_SUMMARY_FINAL_CONTENT_THRESHOLD,
	shouldAutomaticallySummarize,
	stopsAutomaticSummaries
} from './auto-summary';
import type { SidecarInvokeResult } from './types';

function triggerInput(
	overrides: Partial<Parameters<typeof shouldAutomaticallySummarize>[0]> = {}
): Parameters<typeof shouldAutomaticallySummarize>[0] {
	return {
		extent: { sourceCharacters: AUTO_SUMMARY_CONTENT_THRESHOLD, translationCharacters: 1_000 },
		baselineSourceCharacters: 0,
		requesting: false,
		nowMs: AUTO_SUMMARY_COOLDOWN_MS,
		lastRequestedAtMs: null,
		runJustEnded: false,
		...overrides
	};
}

describe('automatic summary trigger', () => {
	it('triggers on enough newly appended source text', () => {
		expect(shouldAutomaticallySummarize(triggerInput())).toBe(true);
	});

	it('uses a smaller final threshold when a run ends', () => {
		expect(
			shouldAutomaticallySummarize(
				triggerInput({
					extent: {
						sourceCharacters: AUTO_SUMMARY_FINAL_CONTENT_THRESHOLD,
						translationCharacters: 100
					},
					runJustEnded: true
				})
			)
		).toBe(true);
	});

	it('does not trigger during a request or before the live cooldown expires', () => {
		expect(shouldAutomaticallySummarize(triggerInput({ requesting: true }))).toBe(false);
		expect(
			shouldAutomaticallySummarize(
				triggerInput({ lastRequestedAtMs: 1, nowMs: AUTO_SUMMARY_COOLDOWN_MS })
			)
		).toBe(false);
	});

	it('measures only text added after the last completed or initialized baseline', () => {
		expect(
			shouldAutomaticallySummarize(
				triggerInput({
					extent: { sourceCharacters: 4_000, translationCharacters: 2_000 },
					baselineSourceCharacters: 3_500
				})
			)
		).toBe(false);
	});
});

describe('automatic summary terminal failures', () => {
	it('stops automatic retries only when the complete context exceeds the budget', () => {
		const failure = (code: 'context-too-large' | 'budget-check-failed'): SidecarInvokeResult => ({
			status: 'failed',
			clientRequestId: 'request-1',
			responseId: null,
			model: null,
			outputText: null,
			upstreamStatus: null,
			usageStatus: 'unavailable',
			usage: null,
			error: { code, message: 'failed' },
			failedAt: '2026-09-01T00:00:00.000Z'
		});

		expect(stopsAutomaticSummaries(failure('context-too-large'))).toBe(true);
		expect(stopsAutomaticSummaries(failure('budget-check-failed'))).toBe(false);
	});
});
