import { describe, expect, it } from 'vitest';
import { OversizedRevisionGroupError, parseRevisionModelOutput } from './revision-output';
import { tokenizeRevisionSource } from './revision-projection';

describe('revision model output', () => {
	it('maps tokenEnd values to exact source ranges', () => {
		const text = 'First sentence. Second sentence.';
		const tokens = tokenizeRevisionSource(text, 0, text.length, 'en');
		const split = tokens.find((token) => token.text.includes('.'))?.index ?? 1;
		const parsed = parseRevisionModelOutput(
			JSON.stringify({
				groups: [
					{
						tokenEnd: split,
						revisedSourceText: 'First sentence.',
						translatedText: '第一句。',
						paragraphBreakBefore: false
					},
					{
						tokenEnd: tokens.length,
						revisedSourceText: 'Second sentence.',
						translatedText: '第二句。',
						paragraphBreakBefore: false
					}
				]
			}),
			tokens
		);
		expect(parsed.groups.map((group) => group.rawText).join('')).toBe(text);
		expect(parsed.groups.at(-1)?.sourceEnd).toBe(text.length);
	});

	it('reports an oversized-only response and can accept it on the second attempt', () => {
		const text = 'word '.repeat(120);
		const tokens = tokenizeRevisionSource(text, 0, text.length, 'en');
		const output = JSON.stringify({
			groups: [
				{
					tokenEnd: tokens.length,
					revisedSourceText: text.trim(),
					translatedText: '译文',
					paragraphBreakBefore: false
				}
			]
		});
		expect(() => parseRevisionModelOutput(output, tokens)).toThrow(OversizedRevisionGroupError);
		expect(
			parseRevisionModelOutput(output, tokens, { allowOversizedGroups: true }).groups[0]
		).toMatchObject({ oversized: true, sourceStart: 0, sourceEnd: text.length });
	});

	it('rejects missing token coverage', () => {
		const text = 'one two three';
		const tokens = tokenizeRevisionSource(text, 0, text.length, 'en');
		expect(() =>
			parseRevisionModelOutput(
				JSON.stringify({
					groups: [
						{
							tokenEnd: tokens.length - 1,
							revisedSourceText: 'one two',
							translatedText: '一二',
							paragraphBreakBefore: false
						}
					]
				}),
				tokens
			)
		).toThrow('只覆盖到');
	});
});
