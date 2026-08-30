import { describe, expect, it } from 'vitest';
import { EMPTY_TRANSCRIPT, parseServerEvent, reduceTranscript } from './transcript';

describe('parseServerEvent', () => {
	it('accepts events with a string type', () => {
		expect(parseServerEvent('{"type":"session.created"}')).toEqual({
			type: 'session.created'
		});
	});

	it('rejects malformed and untyped messages', () => {
		expect(parseServerEvent('not json')).toBeNull();
		expect(parseServerEvent('{"delta":"hello"}')).toBeNull();
	});
});

describe('reduceTranscript', () => {
	it('appends source deltas exactly without adding spaces', () => {
		const first = reduceTranscript(EMPTY_TRANSCRIPT, {
			type: 'session.input_transcript.delta',
			delta: 'hello',
			elapsed_ms: 200
		});
		const second = reduceTranscript(first, {
			type: 'session.input_transcript.delta',
			delta: ' world',
			elapsed_ms: 400
		});

		expect(second.source).toBe('hello world');
	});

	it('keeps source and translated streams independent', () => {
		const state = reduceTranscript(EMPTY_TRANSCRIPT, {
			type: 'session.output_transcript.delta',
			delta: '你好'
		});

		expect(state.source).toBe('');
		expect(state.translation).toBe('你好');
	});

	it('keeps only the newest 16,000 characters', () => {
		const state = reduceTranscript(EMPTY_TRANSCRIPT, {
			type: 'session.output_transcript.delta',
			delta: `discard${'保'.repeat(16_000)}`
		});

		expect(state.translation).toHaveLength(16_000);
		expect(state.translation).toBe('保'.repeat(16_000));
	});
});
