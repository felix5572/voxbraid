import { describe, expect, it } from 'vitest';
import {
	beginCaptureRun,
	createTranslationSession,
	endActiveCaptureRun
} from '../session/translation-session';
import { createAudioTestReport } from './audio-test-report';

describe('createAudioTestReport', () => {
	it('reports lifecycle metrics without copying transcript text or the recording name', () => {
		let session = createTranslationSession({
			threadId: 'private-thread-id',
			defaultTargetLanguage: 'zh',
			at: '2026-08-31T00:00:00.000Z'
		});
		session = beginCaptureRun(session, {
			runId: 'older-private-run-id',
			targetLanguage: 'zh',
			clientPlatform: 'test',
			at: '2026-08-31T00:00:00.500Z'
		});
		session.runs[0].sourceStream.text = 'older private transcript';
		session = endActiveCaptureRun(session, {
			outcome: 'completed',
			reason: 'user-paused',
			at: '2026-08-31T00:00:00.750Z'
		});
		session = beginCaptureRun(session, {
			runId: 'private-run-id',
			targetLanguage: 'zh',
			clientPlatform: 'test',
			at: '2026-08-31T00:00:01.000Z'
		});
		session.runs[1].sourceStream.text = 'private source transcript';
		session.runs[1].translationStream.text = '私密译文';

		const report = createAudioTestReport({
			session,
			outcome: 'audio-ended',
			attemptStartedAt: '2026-08-31T00:00:01.000Z',
			mediaStartedAt: '2026-08-31T00:00:02.000Z',
			finishedAt: '2026-08-31T00:15:01.000Z',
			targetLanguage: 'zh',
			fileSizeBytes: 123,
			fileMimeType: 'audio/wav',
			fileDurationMs: 60_000,
			runSequence: 2,
			statusChanges: [{ status: 'connected', at: '2026-08-31T00:00:02.000Z' }],
			hiddenDurationsMs: [1_000],
			errors: [],
			userAgent: 'test browser'
		});

		expect(report.result.wallDurationMs).toBe(900_000);
		expect(report.runs).toMatchObject([{ sourceCharacters: 25, translationCharacters: 4 }]);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain('private source transcript');
		expect(serialized).not.toContain('私密译文');
		expect(serialized).not.toContain('private-thread-id');
		expect(serialized).not.toContain('private-run-id');
		expect(serialized).not.toContain('older private transcript');
	});
});
