import type { ConnectionStatus } from '../realtime/types';
import type { TranslationSessionState } from '../session/translation-session';

export type AudioTestOutcome =
	'audio-ended' | 'user-stopped' | 'duration-limit' | 'startup-failed' | 'connection-failed';

export interface AudioTestStatusChange {
	status: ConnectionStatus;
	at: string;
}

export interface CreateAudioTestReportInput {
	session: TranslationSessionState;
	outcome: AudioTestOutcome;
	attemptStartedAt: string;
	mediaStartedAt: string | null;
	finishedAt: string;
	targetLanguage: string;
	fileSizeBytes: number;
	fileMimeType: string | null;
	fileDurationMs: number | null;
	runSequence: number;
	statusChanges: AudioTestStatusChange[];
	hiddenDurationsMs: number[];
	errors: string[];
	userAgent: string;
}

export interface AudioTestReport {
	schemaVersion: 1;
	mode: 'local-audio-webrtc';
	configuration: {
		targetLanguage: string;
		fileSizeBytes: number;
		fileMimeType: string | null;
		fileDurationMs: number | null;
	};
	result: {
		outcome: AudioTestOutcome;
		attemptStartedAt: string;
		mediaStartedAt: string | null;
		finishedAt: string;
		wallDurationMs: number;
		deltasAfterClose: number;
	};
	runs: Array<{
		sequence: number;
		status: string;
		endReason: string | null;
		audioDurationMs: number;
		sourceCharacters: number;
		translationCharacters: number;
	}>;
	statusChanges: AudioTestStatusChange[];
	hiddenDurationsMs: number[];
	errors: string[];
	userAgent: string;
}

export function createAudioTestReport(input: CreateAudioTestReportInput): AudioTestReport {
	return {
		schemaVersion: 1,
		mode: 'local-audio-webrtc',
		configuration: {
			targetLanguage: input.targetLanguage,
			fileSizeBytes: input.fileSizeBytes,
			fileMimeType: input.fileMimeType,
			fileDurationMs: input.fileDurationMs
		},
		result: {
			outcome: input.outcome,
			attemptStartedAt: input.attemptStartedAt,
			mediaStartedAt: input.mediaStartedAt,
			finishedAt: input.finishedAt,
			wallDurationMs: Math.max(
				0,
				Date.parse(input.finishedAt) - Date.parse(input.attemptStartedAt)
			),
			deltasAfterClose: input.session.diagnostics.deltasAfterClose
		},
		runs: input.session.runs
			.filter((run) => run.sequence === input.runSequence)
			.map((run) => ({
				sequence: run.sequence,
				status: run.status,
				endReason: run.endReason,
				audioDurationMs: run.audioDurationMs,
				sourceCharacters: run.sourceStream.text.length,
				translationCharacters: run.translationStream.text.length
			})),
		statusChanges: structuredClone(input.statusChanges),
		hiddenDurationsMs: [...input.hiddenDurationsMs],
		errors: [...input.errors],
		userAgent: input.userAgent
	};
}
