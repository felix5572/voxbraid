import type { TranslationServerEvent } from './types';

const MAX_TRANSCRIPT_CHARACTERS = 16_000;

export interface TranscriptState {
	source: string;
	translation: string;
}

export const EMPTY_TRANSCRIPT: TranscriptState = {
	source: '',
	translation: ''
};

function appendCapped(current: string, delta: string): string {
	const combined = current + delta;
	return combined.length > MAX_TRANSCRIPT_CHARACTERS
		? combined.slice(-MAX_TRANSCRIPT_CHARACTERS)
		: combined;
}

export function parseServerEvent(value: string): TranslationServerEvent | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return null;
		if (typeof parsed.type !== 'string') return null;
		return parsed as TranslationServerEvent;
	} catch {
		return null;
	}
}

export function reduceTranscript(
	state: TranscriptState,
	event: TranslationServerEvent
): TranscriptState {
	if (
		(event.type !== 'session.input_transcript.delta' &&
			event.type !== 'session.output_transcript.delta') ||
		typeof event.delta !== 'string'
	) {
		return state;
	}

	if (event.type === 'session.input_transcript.delta') {
		return {
			...state,
			source: appendCapped(state.source, event.delta)
		};
	}

	return {
		...state,
		translation: appendCapped(state.translation, event.delta)
	};
}
