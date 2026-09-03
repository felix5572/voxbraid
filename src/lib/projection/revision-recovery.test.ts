import { describe, expect, it } from 'vitest';
import type { SidecarInvokeResult } from '../sidecar/types';
import { canAutomaticallyRetryFinalizing, revisionBackoffMs } from './revision-recovery';

function failure(
	retryDisposition: 'automatic' | 'manual-only' | 'reload-required'
): SidecarInvokeResult {
	return {
		status: 'failed',
		clientRequestId: 'request-1',
		responseId: null,
		model: 'gpt-5.6-luna',
		outputText: null,
		upstreamStatus: null,
		usageStatus: 'unavailable',
		usage: null,
		retryDisposition,
		error: { code: 'upstream-failed', message: 'failed' },
		failedAt: '2026-09-03T00:00:00.000Z'
	};
}

describe('revision recovery', () => {
	it('backs off after the third consecutive infrastructure failure', () => {
		expect(revisionBackoffMs(1)).toBe(0);
		expect(revisionBackoffMs(2)).toBe(0);
		expect(revisionBackoffMs(3)).toBe(30_000);
		expect(revisionBackoffMs(4)).toBe(60_000);
		expect(revisionBackoffMs(5)).toBe(120_000);
		expect(revisionBackoffMs(9)).toBe(120_000);
	});

	it('only repeats a finalizing range when the server marks the outcome safe', () => {
		expect(canAutomaticallyRetryFinalizing(failure('automatic'))).toBe(true);
		expect(canAutomaticallyRetryFinalizing(failure('manual-only'))).toBe(false);
		expect(canAutomaticallyRetryFinalizing(failure('reload-required'))).toBe(false);
	});
});
