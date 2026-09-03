import type { SidecarInvokeResult } from '../sidecar/types';

export const REVISION_FAILURES_BEFORE_BACKOFF = 3;
export const REVISION_BACKOFF_MAX_MS = 120_000;
export const REVISION_FINALIZING_RETRY_DELAY_MS = 30_000;

export function revisionBackoffMs(consecutiveInfrastructureFailures: number): number {
	if (consecutiveInfrastructureFailures < REVISION_FAILURES_BEFORE_BACKOFF) return 0;
	return Math.min(
		REVISION_BACKOFF_MAX_MS,
		30_000 * 2 ** (consecutiveInfrastructureFailures - REVISION_FAILURES_BEFORE_BACKOFF)
	);
}

export function canAutomaticallyRetryFinalizing(result: SidecarInvokeResult): boolean {
	return result.status === 'failed' && result.retryDisposition === 'automatic';
}
