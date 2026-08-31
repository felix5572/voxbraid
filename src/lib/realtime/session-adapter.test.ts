import { describe, expect, it } from 'vitest';
import { toTranscriptDeltaFact } from './session-adapter';

describe('toTranscriptDeltaFact', () => {
	it('maps source and translation deltas without interpreting their timing', () => {
		expect(
			toTranscriptDeltaFact(
				{
					type: 'session.input_transcript.delta',
					delta: ' hello',
					elapsed_ms: 200
				},
				'2026-08-31T00:00:02.000Z'
			)
		).toEqual({
			type: 'source-delta',
			delta: ' hello',
			elapsedMs: 200,
			at: '2026-08-31T00:00:02.000Z'
		});

		expect(
			toTranscriptDeltaFact(
				{
					type: 'session.output_transcript.delta',
					delta: '你好',
					elapsed_ms: null
				},
				'2026-08-31T00:00:03.000Z'
			)
		).toEqual({
			type: 'translation-delta',
			delta: '你好',
			elapsedMs: null,
			at: '2026-08-31T00:00:03.000Z'
		});
	});

	it('ignores non-transcript events and empty deltas', () => {
		expect(
			toTranscriptDeltaFact({ type: 'session.closed' }, '2026-08-31T00:00:02.000Z')
		).toBeNull();
		expect(
			toTranscriptDeltaFact(
				{ type: 'session.input_transcript.delta', delta: '' },
				'2026-08-31T00:00:02.000Z'
			)
		).toBeNull();
	});

	it('normalizes a non-numeric protocol timestamp to missing', () => {
		expect(
			toTranscriptDeltaFact(
				{
					type: 'session.output_transcript.delta',
					delta: '译文',
					elapsed_ms: 'unexpected' as unknown as number
				},
				'2026-08-31T00:00:02.000Z'
			)
		).toMatchObject({ elapsedMs: null });
	});
});
