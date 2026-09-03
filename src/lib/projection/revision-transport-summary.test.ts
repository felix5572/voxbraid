import { describe, expect, it } from 'vitest';
import type { StoredRevisionBatch } from './revision-records';
import { revisionTransportSummary } from './revision-transport-summary';

function batch(input: {
	action: 'bootstrap' | 'continued' | 'rebuilt';
	turn: number;
	inputTokens: number;
	cachedInputTokens?: number;
	completedMs: number;
	status?: 'completed' | 'failed';
	errorCode?: StoredRevisionBatch['errorCode'];
}): StoredRevisionBatch {
	const status = input.status ?? 'completed';
	return {
		id: crypto.randomUUID(),
		threadId: 'thread-1',
		runId: 'run-1',
		runSequence: 1,
		sequence: input.turn,
		openStart: 0,
		openEnd: 10,
		tokenizerVersion: 2,
		taskVersion: 4,
		trigger: 'periodic',
		status,
		capturedAt: '2026-09-03T00:00:00.000Z',
		completedAt: status === 'completed' ? '2026-09-03T00:00:01.000Z' : null,
		clientRequestId: crypto.randomUUID(),
		responseId: status === 'completed' ? crypto.randomUUID() : null,
		model: 'gpt-5.6-luna',
		usageStatus: 'recorded',
		usage: {
			inputTokens: input.inputTokens,
			cachedInputTokens: input.cachedInputTokens ?? 0,
			outputTokens: 10,
			reasoningTokens: 0,
			totalTokens: input.inputTokens + 10
		},
		upstreamStatus: null,
		errorCode: input.errorCode ?? null,
		error: status === 'failed' ? 'failed' : null,
		diagnostic: null,
		transportDiagnostic: {
			transport: 'websocket',
			chainAction: input.action,
			streamId: 'revision.1.1',
			chainTurn: input.turn,
			chainAgeMs: input.turn * 1_000,
			firstEventMs: 100,
			completedMs: input.completedMs
		},
		updatedAt: '2026-09-03T00:00:01.000Z'
	};
}

describe('revisionTransportSummary', () => {
	it('aggregates chain hits, turn buckets, latency, tokens, and failure reasons', () => {
		const summary = revisionTransportSummary([
			batch({ action: 'bootstrap', turn: 1, inputTokens: 1_000, completedMs: 3_000 }),
			batch({
				action: 'continued',
				turn: 2,
				inputTokens: 1_500,
				cachedInputTokens: 800,
				completedMs: 2_000
			}),
			batch({
				action: 'continued',
				turn: 11,
				inputTokens: 2_500,
				completedMs: 1_000,
				status: 'failed',
				errorCode: 'websocket-outcome-unknown'
			})
		]);

		expect(summary).toMatchObject({
			total: 3,
			websocket: 3,
			continued: 2,
			bootstrap: 1,
			rebuilt: 0,
			chainHitRate: 2 / 3,
			averageCompletedMs: 2_000,
			failures: [{ code: 'websocket-outcome-unknown', count: 1 }]
		});
		expect(summary.turnBuckets).toEqual([
			{
				label: 'turn 1',
				count: 1,
				averageInputTokens: 1_000,
				averageCachedInputTokens: 0,
				averageCompletedMs: 3_000
			},
			{
				label: 'turn 2–10',
				count: 1,
				averageInputTokens: 1_500,
				averageCachedInputTokens: 800,
				averageCompletedMs: 2_000
			},
			{
				label: 'turn 11+',
				count: 1,
				averageInputTokens: 2_500,
				averageCachedInputTokens: 0,
				averageCompletedMs: 1_000
			}
		]);
	});
});
