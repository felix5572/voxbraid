import { describe, expect, it } from 'vitest';
import {
	OversizedRevisionGroupError,
	parseRevisionModelOutput,
	RevisionBoundaryError
} from './revision-output';
import { tokenizeRevisionSource } from './revision-projection';

describe('revision model output', () => {
	it('maps self-verifying group boundaries to exact source ranges', () => {
		const text = 'First sentence. Second sentence.';
		const tokens = tokenizeRevisionSource(text, 0, text.length, 'en');
		const split = tokens.find((token) => token.text.includes('.'))?.index ?? 1;
		const parsed = parseRevisionModelOutput(
			JSON.stringify({
				groups: [
					{
						lastTokenIndex: split,
						lastTokenText: tokens[split - 1].text,
						revisedSourceText: 'First sentence.',
						translatedText: '第一句。',
						paragraphBreakBefore: false
					},
					{
						lastTokenIndex: tokens.length,
						lastTokenText: tokens.at(-1)?.text,
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
					lastTokenIndex: tokens.length,
					lastTokenText: tokens.at(-1)?.text,
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
							lastTokenIndex: tokens.length - 1,
							lastTokenText: tokens.at(-2)?.text,
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

	it('reports a non-increasing boundary sequence for targeted correction', () => {
		const text = 'one two three four';
		const tokens = tokenizeRevisionSource(text, 0, text.length, 'en');
		const indexes = [2, tokens.length, 3, tokens.length];
		expect(() =>
			parseRevisionModelOutput(
				JSON.stringify({
					groups: indexes.map((lastTokenIndex) => ({
						lastTokenIndex,
						lastTokenText: tokens[Math.min(lastTokenIndex, tokens.length) - 1].text,
						revisedSourceText: 'revised',
						translatedText: '译文',
						paragraphBreakBefore: false
					}))
				}),
				tokens
			)
		).toThrow(RevisionBoundaryError);
		try {
			parseRevisionModelOutput(
				JSON.stringify({
					groups: indexes.map((lastTokenIndex) => ({
						lastTokenIndex,
						lastTokenText: tokens[Math.min(lastTokenIndex, tokens.length) - 1].text,
						revisedSourceText: 'revised',
						translatedText: '译文',
						paragraphBreakBefore: false
					}))
				}),
				tokens
			);
		} catch (error) {
			expect((error as RevisionBoundaryError).returnedLastTokenIndexes).toEqual(indexes);
		}
	});

	it('rejects a boundary whose copied token text does not match its index', () => {
		const text = 'one two three';
		const tokens = tokenizeRevisionSource(text, 0, text.length, 'en');
		expect(() =>
			parseRevisionModelOutput(
				JSON.stringify({
					groups: [
						{
							lastTokenIndex: tokens.length,
							lastTokenText: tokens[0].text,
							revisedSourceText: text,
							translatedText: '一二三',
							paragraphBreakBefore: false
						}
					]
				}),
				tokens
			)
		).toThrow('lastTokenText');
	});

	it('accepts and reports a copied boundary token that differs only in surrounding whitespace', () => {
		const text = 'one two';
		const tokens = tokenizeRevisionSource(text, 0, text.length, 'en');
		expect(tokens.at(-1)?.text).toBe(' two');
		const parsed = parseRevisionModelOutput(
			JSON.stringify({
				groups: [
					{
						lastTokenIndex: tokens.length,
						lastTokenText: 'two',
						revisedSourceText: 'one two',
						translatedText: '一二',
						paragraphBreakBefore: false
					}
				]
			}),
			tokens
		);
		expect(parsed.whitespaceNormalizedGroupNumbers).toEqual([1]);
		expect(parsed.groups[0].sourceEnd).toBe(text.length);
	});
});
