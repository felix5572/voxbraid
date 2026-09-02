import { describe, expect, it } from 'vitest';
import { parseTranslationPairModelOutput } from './translation-pair-output';

describe('translation pair model output', () => {
	it('accepts consecutive groups covering every atom exactly once', () => {
		expect(
			parseTranslationPairModelOutput(
				JSON.stringify({
					groups: [
						{
							atomIds: ['a', 'b'],
							translatedText: ' 第一段。 ',
							paragraphBreakBefore: false
						},
						{
							atomIds: ['c'],
							translatedText: '第二段。',
							paragraphBreakBefore: true
						}
					]
				}),
				['a', 'b', 'c']
			)
		).toEqual({
			groups: [
				{
					atomIds: ['a', 'b'],
					translatedText: '第一段。',
					paragraphBreakBefore: false
				},
				{
					atomIds: ['c'],
					translatedText: '第二段。',
					paragraphBreakBefore: true
				}
			]
		});
	});

	it.each([
		['unknown atom', ['a', 'x']],
		['duplicate atom', ['a', 'a']],
		['missing atom', ['a']],
		['reordered atom', ['b', 'a']]
	])('rejects %s coverage', (_name, atomIds) => {
		expect(() =>
			parseTranslationPairModelOutput(
				JSON.stringify({
					groups: [{ atomIds, translatedText: '译文', paragraphBreakBefore: false }]
				}),
				['a', 'b']
			)
		).toThrow('atom 顺序或覆盖范围无效');
	});

	it('rejects empty translations and malformed JSON', () => {
		expect(() =>
			parseTranslationPairModelOutput(
				JSON.stringify({
					groups: [{ atomIds: ['a'], translatedText: ' ', paragraphBreakBefore: false }]
				}),
				['a']
			)
		).toThrow('格式无效');
		expect(() => parseTranslationPairModelOutput('{', ['a'])).toThrow('合法 JSON');
	});
});
