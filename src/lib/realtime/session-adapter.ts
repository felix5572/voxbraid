import type { TranscriptFactEvent } from '../session/transcript-facts';
import type { TranslationServerEvent } from './types';

export type TranscriptDeltaFactEvent = Extract<
	TranscriptFactEvent,
	{ type: 'source-delta' | 'translation-delta' }
>;

export function toTranscriptDeltaFact(
	event: TranslationServerEvent,
	at: string
): TranscriptDeltaFactEvent | null {
	if (
		(event.type !== 'session.input_transcript.delta' &&
			event.type !== 'session.output_transcript.delta') ||
		typeof event.delta !== 'string' ||
		!event.delta
	) {
		return null;
	}

	return {
		type: event.type === 'session.input_transcript.delta' ? 'source-delta' : 'translation-delta',
		delta: event.delta,
		elapsedMs: typeof event.elapsed_ms === 'number' ? event.elapsed_ms : null,
		at
	};
}
