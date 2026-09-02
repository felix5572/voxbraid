import { describe, expect, it } from 'vitest';
import type { StoredTranslationPairBatch } from './translation-pair-records';
import { isCurrentProvisionalBatch } from './translation-pair-records';

function batch(id: string, sequence: number): StoredTranslationPairBatch {
	return {
		id,
		threadId: 'thread-1',
		runId: 'run-1',
		runSequence: 1,
		sequence,
		revision: 1,
		projectionState: 'provisional',
		targetLanguage: 'zh',
		sourceStart: sequence - 1,
		sourceEnd: sequence,
		sourceElapsedEndMs: sequence,
		status: 'completed',
		capturedAt: '2026-09-02T00:00:00.000Z',
		completedAt: '2026-09-02T00:00:01.000Z',
		model: 'gpt-5.6-luna',
		taskVersion: 1,
		clientRequestId: `request-${sequence}`,
		responseId: `response-${sequence}`,
		usageStatus: 'unavailable',
		usage: null,
		upstreamStatus: null,
		errorCode: null,
		error: null,
		diagnostic: null,
		failureAttempts: [],
		updatedAt: '2026-09-02T00:00:01.000Z'
	};
}

describe('translation pair records', () => {
	it('only labels the latest provisional batch in each run', () => {
		const first = batch('batch-1', 1);
		const latest = batch('batch-2', 2);
		expect(isCurrentProvisionalBatch(first, [latest, first])).toBe(false);
		expect(isCurrentProvisionalBatch(latest, [latest, first])).toBe(true);
	});
});
