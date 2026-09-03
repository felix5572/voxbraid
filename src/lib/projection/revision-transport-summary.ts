import type { StoredRevisionBatch } from './revision-records';
import { supersededFailedBatches } from './revision-display';

export interface RevisionTransportBucket {
	label: 'turn 1' | 'turn 2–10' | 'turn 11+';
	count: number;
	averageInputTokens: number | null;
	averageCachedInputTokens: number | null;
	averageCompletedMs: number | null;
}

export interface RevisionTransportSummary {
	total: number;
	websocket: number;
	continued: number;
	bootstrap: number;
	rebuilt: number;
	httpFallback: number;
	chainHitRate: number | null;
	averageCompletedMs: number | null;
	turnBuckets: RevisionTransportBucket[];
	correctedFailures: number;
	failures: Array<{ code: string; count: number }>;
}

function average(values: number[]): number | null {
	if (values.length === 0) return null;
	return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function turnBucket(turn: number | null): RevisionTransportBucket['label'] | null {
	if (turn === null) return null;
	if (turn <= 1) return 'turn 1';
	if (turn <= 10) return 'turn 2–10';
	return 'turn 11+';
}

export function revisionTransportSummary(
	batches: readonly StoredRevisionBatch[]
): RevisionTransportSummary {
	const withTransport = batches.filter((batch) => batch.transportDiagnostic);
	const websocket = withTransport.filter(
		(batch) => batch.transportDiagnostic?.transport === 'websocket'
	);
	const continued = websocket.filter(
		(batch) => batch.transportDiagnostic?.chainAction === 'continued'
	).length;
	const correctedFailureIds = new Set(supersededFailedBatches(batches).map((batch) => batch.id));
	const failureCounts = new Map<string, number>();
	for (const batch of batches) {
		if (batch.status !== 'failed' || correctedFailureIds.has(batch.id)) continue;
		const code = batch.errorCode ?? 'unknown';
		failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);
	}
	const labels: RevisionTransportBucket['label'][] = ['turn 1', 'turn 2–10', 'turn 11+'];

	return {
		total: withTransport.length,
		websocket: websocket.length,
		continued,
		bootstrap: websocket.filter((batch) => batch.transportDiagnostic?.chainAction === 'bootstrap')
			.length,
		rebuilt: websocket.filter((batch) => batch.transportDiagnostic?.chainAction === 'rebuilt')
			.length,
		httpFallback: withTransport.filter(
			(batch) => batch.transportDiagnostic?.transport === 'http-fallback'
		).length,
		chainHitRate: websocket.length === 0 ? null : continued / websocket.length,
		averageCompletedMs: average(
			withTransport.flatMap((batch) => {
				const value = batch.transportDiagnostic?.completedMs;
				return value === null || value === undefined ? [] : [value];
			})
		),
		correctedFailures: correctedFailureIds.size,
		turnBuckets: labels.map((label) => {
			const matching = websocket.filter(
				(batch) => turnBucket(batch.transportDiagnostic?.chainTurn ?? null) === label
			);
			const recordedUsage = matching.flatMap((batch) =>
				batch.usageStatus === 'recorded' && batch.usage ? [batch.usage] : []
			);
			return {
				label,
				count: matching.length,
				averageInputTokens: average(recordedUsage.map((usage) => usage.inputTokens)),
				averageCachedInputTokens: average(
					recordedUsage.flatMap((usage) =>
						usage.cachedInputTokens === null ? [] : [usage.cachedInputTokens]
					)
				),
				averageCompletedMs: average(
					matching.flatMap((batch) => {
						const value = batch.transportDiagnostic?.completedMs;
						return value === null || value === undefined ? [] : [value];
					})
				)
			};
		}),
		failures: [...failureCounts]
			.map(([code, count]) => ({ code, count }))
			.sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
	};
}
