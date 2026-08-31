import { describe, expect, it } from 'vitest';
import timingProbe from './fixtures/realtime-timing-probe.json';
import { reduceTranscriptFacts, type TranscriptFactEvent } from './transcript-facts';
import type { CaptureRun } from './types';

function createRun(): CaptureRun {
	return {
		id: 'run-1',
		threadId: 'thread-1',
		sequence: 1,
		status: 'live',
		targetLanguage: 'zh',
		createdAt: '2026-08-31T00:00:00.000Z',
		mediaStartedAt: '2026-08-31T00:00:01.000Z',
		endedAt: null,
		lastActivityAt: null,
		hiddenAt: null,
		audioDurationMs: 0,
		endTimeEstimated: false,
		endReason: null,
		recoveredFromRunId: null,
		clientPlatform: 'test',
		lastError: null,
		sourceStream: { text: '', lastElapsedMs: null, updatedAt: null },
		translationStream: { text: '', lastElapsedMs: null, updatedAt: null },
		currentSegmentRevision: null
	};
}

describe('reduceTranscriptFacts', () => {
	it('appends source and translation deltas without truncation or cross-stream alignment', () => {
		const source = 'S'.repeat(20_000);
		let result = reduceTranscriptFacts(createRun(), {
			type: 'source-delta',
			delta: source,
			elapsedMs: 200,
			at: '2026-08-31T00:00:02.000Z'
		});
		result = reduceTranscriptFacts(result.run, {
			type: 'translation-delta',
			delta: '译文',
			elapsedMs: 400,
			at: '2026-08-31T00:00:03.000Z'
		});

		expect(result.run.sourceStream.text).toBe(source);
		expect(result.run.translationStream.text).toBe('译文');
		expect(result.run.audioDurationMs).toBe(400);
		expect(result.run.lastActivityAt).toBe('2026-08-31T00:00:03.000Z');
	});

	it('accepts missing timing and ignores invalid elapsed values', () => {
		const missing = reduceTranscriptFacts(createRun(), {
			type: 'source-delta',
			delta: 'hello',
			elapsedMs: null,
			at: '2026-08-31T00:00:02.000Z'
		});
		const invalid = reduceTranscriptFacts(missing.run, {
			type: 'translation-delta',
			delta: '你好',
			elapsedMs: Number.NaN,
			at: '2026-08-31T00:00:03.000Z'
		});

		expect(invalid.run.sourceStream.lastElapsedMs).toBeNull();
		expect(invalid.run.translationStream.lastElapsedMs).toBeNull();
		expect(invalid.run.audioDurationMs).toBe(0);
	});

	it('closes the run without inventing segment state', () => {
		const result = reduceTranscriptFacts(createRun(), {
			type: 'run-closed',
			outcome: 'completed',
			reason: 'user-paused',
			at: '2026-08-31T00:00:03.000Z'
		});

		expect(result.run).toMatchObject({
			status: 'completed',
			endReason: 'user-paused',
			endedAt: '2026-08-31T00:00:03.000Z'
		});
	});

	it('preserves late deltas after close and reports the adapter ordering issue', () => {
		const closed = reduceTranscriptFacts(createRun(), {
			type: 'run-closed',
			outcome: 'completed',
			reason: 'user-paused',
			at: '2026-08-31T00:00:03.000Z'
		}).run;
		const result = reduceTranscriptFacts(closed, {
			type: 'translation-delta',
			delta: '迟到但不能丢',
			elapsedMs: 900,
			at: '2026-08-31T00:00:04.000Z'
		});

		expect(result.run.status).toBe('completed');
		expect(result.run.translationStream.text).toBe('迟到但不能丢');
		expect(result.run.lastActivityAt).toBeNull();
		expect(result.run.endedAt).toBe('2026-08-31T00:00:03.000Z');
		expect(result.run.audioDurationMs).toBe(900);
		expect(result.diagnostics.deltasAfterClose).toBe(1);
	});

	it('replays the real timing trace into two lossless streams', () => {
		let run = createRun();
		for (const sample of timingProbe) {
			const event: TranscriptFactEvent = {
				type: sample.stream === 'source' ? 'source-delta' : 'translation-delta',
				delta: sample.delta,
				elapsedMs: sample.elapsedMs,
				at: new Date(Date.parse(run.createdAt) + sample.receivedAfterStartMs).toISOString()
			};
			run = reduceTranscriptFacts(run, event).run;
		}

		expect(run.sourceStream.text).toBe(
			' This is the first sentence. and this is the second sentence. and this is the third sentence.'
		);
		expect(run.translationStream.text).toBe('这是第一句话。这是第二句话。这是第三句话。');
		expect(run.sourceStream.lastElapsedMs).toBe(17_200);
		expect(run.translationStream.lastElapsedMs).toBe(18_000);
		expect(run.audioDurationMs).toBe(18_000);
	});
});
