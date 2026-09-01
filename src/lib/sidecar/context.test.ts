import { describe, expect, it } from 'vitest';
import { createTranslationSession, beginCaptureRun } from '../session/translation-session';
import { captureSidecarContext, serializedUtf8Bytes, sidecarRequestFits } from './context';
import type { SidecarInvokeRequest } from './types';

function stateWithRuns() {
	const base = createTranslationSession({
		threadId: 'thread-1',
		defaultTargetLanguage: 'zh',
		at: '2026-09-01T10:00:00.000Z'
	});
	const first = beginCaptureRun(base, {
		runId: 'run-1',
		targetLanguage: 'zh',
		clientPlatform: 'test',
		at: '2026-09-01T10:01:00.000Z'
	});
	first.runs[0].sourceStream.text = 'First source.';
	first.runs[0].translationStream.text = '第一段。';
	first.activeRunId = null;
	const second = beginCaptureRun(first, {
		runId: 'run-2',
		targetLanguage: 'ja',
		clientPlatform: 'test',
		at: '2026-09-01T10:02:00.000Z'
	});
	second.runs[1].sourceStream.text = 'Second source.';
	second.runs[1].translationStream.text = '第二段。';
	return second;
}

describe('captureSidecarContext', () => {
	it('captures only the latest non-empty run when requested', () => {
		const context = captureSidecarContext(
			stateWithRuns(),
			'latest-run',
			'2026-09-01T10:03:00.000Z'
		);

		expect(context.runs).toEqual([
			expect.objectContaining({ runId: 'run-2', sourceText: 'Second source.' })
		]);
	});

	it('captures all non-empty runs without retaining the domain objects', () => {
		const state = stateWithRuns();
		const context = captureSidecarContext(state, 'current-thread', '2026-09-01T10:03:00.000Z');
		state.runs[0].sourceStream.text = 'mutated';

		expect(context.runs.map((run) => run.sourceText)).toEqual(['First source.', 'Second source.']);
	});
});

describe('sidecar request size', () => {
	it('measures UTF-8 bytes and rejects requests over the product boundary', () => {
		expect(serializedUtf8Bytes('你')).toBe(5);
		const request: SidecarInvokeRequest = {
			clientRequestId: 'request-1',
			intent: {
				kind: 'summarize',
				trigger: 'manual',
				outputLanguage: 'zh'
			},
			context: {
				threadId: 'thread-1',
				scope: 'latest-run',
				capturedAt: '2026-09-01T10:03:00.000Z',
				runs: [
					{
						runId: 'run-1',
						sequence: 1,
						targetLanguage: 'zh',
						sourceText: 'x'.repeat(1_500_000),
						translationText: ''
					}
				]
			}
		};

		expect(sidecarRequestFits(request)).toBe(false);
	});
});
