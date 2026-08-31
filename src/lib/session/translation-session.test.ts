import { describe, expect, it } from 'vitest';
import timingProbe from './fixtures/realtime-timing-probe.json';
import {
	activeCaptureRun,
	appendRealtimeTranscriptEvent,
	beginCaptureRun,
	createTranslationSession,
	currentCaptureRun,
	endActiveCaptureRun,
	markActiveRunConnected,
	markActiveRunHidden,
	markActiveRunStopping,
	markActiveRunVisible
} from './translation-session';
import type { TranslationSessionState } from './translation-session';

function createState(): TranslationSessionState {
	return createTranslationSession({
		threadId: 'thread-1',
		defaultTargetLanguage: 'zh',
		at: '2026-08-31T00:00:00.000Z'
	});
}

function beginRun(
	state: TranslationSessionState,
	runId = 'run-1',
	at = '2026-08-31T00:00:01.000Z'
): TranslationSessionState {
	return beginCaptureRun(state, {
		runId,
		targetLanguage: 'zh',
		clientPlatform: 'test',
		at
	});
}

describe('translation session lifecycle', () => {
	it('creates a live run and appends the real trace through the adapter', () => {
		let state = markActiveRunConnected(beginRun(createState()), '2026-08-31T00:00:02.000Z');

		for (const sample of timingProbe) {
			state = appendRealtimeTranscriptEvent(
				state,
				{
					type:
						sample.stream === 'source'
							? 'session.input_transcript.delta'
							: 'session.output_transcript.delta',
					delta: sample.delta,
					elapsed_ms: sample.elapsedMs
				},
				new Date(Date.parse('2026-08-31T00:00:00.000Z') + sample.receivedAfterStartMs).toISOString()
			);
		}

		const run = activeCaptureRun(state);
		expect(run).toMatchObject({
			status: 'live',
			mediaStartedAt: '2026-08-31T00:00:02.000Z',
			audioDurationMs: 18_000
		});
		expect(run?.sourceStream.text).toBe(
			' This is the first sentence. and this is the second sentence. and this is the third sentence.'
		);
		expect(run?.translationStream.text).toBe('这是第一句话。这是第二句话。这是第三句话。');
	});

	it('pauses one run and continues in a new run under the same thread', () => {
		let state = markActiveRunConnected(beginRun(createState()), '2026-08-31T00:00:02.000Z');
		state = markActiveRunStopping(state);
		state = endActiveCaptureRun(state, {
			outcome: 'completed',
			reason: 'user-paused',
			at: '2026-08-31T00:00:03.000Z'
		});
		state = beginRun(state, 'run-2', '2026-08-31T00:00:04.000Z');

		expect(state.thread.id).toBe('thread-1');
		expect(state.runs).toMatchObject([
			{ id: 'run-1', sequence: 1, status: 'completed', endReason: 'user-paused' },
			{ id: 'run-2', sequence: 2, status: 'starting', sourceStream: { text: '' } }
		]);
		expect(activeCaptureRun(state)?.id).toBe('run-2');
	});

	it('records startup and connected failures with different lifecycle outcomes', () => {
		const startupFailure = endActiveCaptureRun(beginRun(createState()), {
			outcome: 'failed',
			reason: 'startup-failed',
			error: { code: 'startup-failed', message: 'token expired' },
			at: '2026-08-31T00:00:02.000Z'
		});
		const connected = markActiveRunConnected(beginRun(createState()), '2026-08-31T00:00:02.000Z');
		const connectionFailure = endActiveCaptureRun(connected, {
			outcome: 'interrupted',
			reason: 'connection-lost',
			error: { code: 'connection-lost', message: 'network failed' },
			at: '2026-08-31T00:00:03.000Z'
		});

		expect(currentCaptureRun(startupFailure)).toMatchObject({
			status: 'failed',
			endReason: 'startup-failed',
			lastError: { message: 'token expired' }
		});
		expect(currentCaptureRun(connectionFailure)).toMatchObject({
			status: 'interrupted',
			endReason: 'connection-lost',
			lastError: { message: 'network failed' }
		});
	});

	it('tracks whether the active run is currently hidden without changing a closed run', () => {
		const active = beginRun(createState());
		const hidden = markActiveRunHidden(active, '2026-08-31T00:00:02.500Z');
		expect(activeCaptureRun(hidden)?.hiddenAt).toBe('2026-08-31T00:00:02.500Z');
		const visible = markActiveRunVisible(hidden);
		expect(activeCaptureRun(visible)?.hiddenAt).toBeNull();
		expect(markActiveRunVisible(visible)).toBe(visible);

		const closed = endActiveCaptureRun(visible, {
			outcome: 'completed',
			reason: 'user-paused',
			at: '2026-08-31T00:00:03.000Z'
		});
		expect(markActiveRunHidden(closed, '2026-08-31T00:00:04.000Z')).toBe(closed);
		expect(markActiveRunVisible(closed)).toBe(closed);
	});

	it('preserves and diagnoses a transcript delta delivered after product close', () => {
		let state = endActiveCaptureRun(beginRun(createState()), {
			outcome: 'completed',
			reason: 'user-paused',
			at: '2026-08-31T00:00:03.000Z'
		});
		state = appendRealtimeTranscriptEvent(
			state,
			{
				type: 'session.output_transcript.delta',
				delta: '迟到但不能丢',
				elapsed_ms: 900
			},
			'2026-08-31T00:00:04.000Z'
		);

		expect(currentCaptureRun(state)?.translationStream.text).toBe('迟到但不能丢');
		expect(currentCaptureRun(state)?.lastActivityAt).toBeNull();
		expect(state.diagnostics.deltasAfterClose).toBe(1);
	});

	it('rejects concurrent and duplicate run identities', () => {
		const state = beginRun(createState());
		expect(() => beginRun(state, 'run-2')).toThrow('another is active');

		const closed = endActiveCaptureRun(state, {
			outcome: 'completed',
			reason: 'user-paused',
			at: '2026-08-31T00:00:03.000Z'
		});
		expect(() => beginRun(closed, 'run-1')).toThrow('already exists');
	});
});
