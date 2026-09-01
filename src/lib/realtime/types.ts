export const TARGET_LANGUAGES = [
	{ code: 'zh', label: '中文' },
	{ code: 'en', label: 'English' },
	{ code: 'ja', label: '日本語' },
	{ code: 'es', label: 'Español' }
] as const;

export const REALTIME_TRANSCRIPTION_MODELS = [
	{ code: 'gpt-live-transcribe', label: 'GPT-Live-Transcribe', releasedAt: '2026-07-28' },
	{ code: 'gpt-realtime-whisper', label: 'GPT-Realtime-Whisper', releasedAt: '2026-05-07' }
] as const;

export const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';

export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]['code'];
export type RealtimeTranscriptionModel = (typeof REALTIME_TRANSCRIPTION_MODELS)[number]['code'];

export type ConnectionStatus =
	| 'idle'
	| 'requesting-microphone'
	| 'requesting-token'
	| 'connecting'
	| 'connected'
	| 'connection-degraded'
	| 'stopping'
	| 'failed';

export interface TranslationTokenResponse {
	clientSecret: string;
	expiresAt: number;
}

export interface RealtimeErrorEvent {
	type: 'error';
	event_id?: string;
	error: {
		message: string;
		code?: string | null;
		type?: string;
		param?: string | null;
		event_id?: string | null;
	};
}

export interface TranscriptDeltaEvent {
	type: 'session.input_transcript.delta' | 'session.output_transcript.delta';
	delta: string;
	elapsed_ms?: number | null;
}

export type TranslationServerEvent =
	| RealtimeErrorEvent
	| TranscriptDeltaEvent
	| { type: 'session.created'; session?: { id?: string } }
	| { type: 'session.updated' }
	| { type: 'session.closed' }
	| { type: string; [key: string]: unknown };

export function isTargetLanguage(value: unknown): value is TargetLanguage {
	return TARGET_LANGUAGES.some((language) => language.code === value);
}

export function isRealtimeTranscriptionModel(value: unknown): value is RealtimeTranscriptionModel {
	return REALTIME_TRANSCRIPTION_MODELS.some((model) => model.code === value);
}
