import { describe, expect, it } from 'vitest';
import {
	OversizedRevisionGroupError,
	parseRevisionModelOutput,
	RevisionBoundaryError
} from './revision-output';
import { sourceClauseAtoms } from './revision-projection';

describe('revision model output', () => {
	it('maps consecutive atom ranges to exact source ranges', () => {
		const text = 'First clause, second clause. Third sentence.';
		const atoms = sourceClauseAtoms(text, 0, text.length, 'en');
		const parsed = parseRevisionModelOutput(
			JSON.stringify({
				groups: [
					{
						firstAtom: 1,
						lastAtom: 2,
						revisedSourceText: 'First clause, second clause.',
						translatedText: '第一句。',
						paragraphBreakBefore: false
					},
					{
						firstAtom: 3,
						lastAtom: 3,
						revisedSourceText: 'Third sentence.',
						translatedText: '第三句。',
						paragraphBreakBefore: false
					}
				]
			}),
			atoms
		);

		expect(parsed.groups.map((group) => group.rawText).join('')).toBe(text);
		expect(parsed.groups.map((group) => group.endingBoundary)).toEqual(['sentence', 'sentence']);
		expect(parsed.groups.at(-1)?.sourceEnd).toBe(text.length);
	});

	it('reports an oversized-only response and can accept it on the second attempt', () => {
		const text = `${'one clause, '.repeat(24)}done.`;
		const atoms = sourceClauseAtoms(text, 0, text.length, 'en');
		const output = JSON.stringify({
			groups: [
				{
					firstAtom: 1,
					lastAtom: atoms.length,
					revisedSourceText: text.trim(),
					translatedText: '译文',
					paragraphBreakBefore: false
				}
			]
		});

		expect(() => parseRevisionModelOutput(output, atoms)).toThrow(OversizedRevisionGroupError);
		expect(
			parseRevisionModelOutput(output, atoms, { allowOversizedGroups: true }).groups[0]
		).toMatchObject({ oversized: true, sourceStart: 0, sourceEnd: text.length });
	});

	it('rejects missing atom coverage', () => {
		const text = 'one, two; three.';
		const atoms = sourceClauseAtoms(text, 0, text.length, 'en');
		expect(() =>
			parseRevisionModelOutput(
				JSON.stringify({
					groups: [
						{
							firstAtom: 1,
							lastAtom: atoms.length - 1,
							revisedSourceText: 'one, two;',
							translatedText: '一二',
							paragraphBreakBefore: false
						}
					]
				}),
				atoms
			)
		).toThrow('只覆盖到');
	});

	it('reports invalid atom ranges for one targeted correction', () => {
		const text = 'one, two; three.';
		const atoms = sourceClauseAtoms(text, 0, text.length, 'en');
		const ranges = [
			{ firstAtom: 1, lastAtom: 2 },
			{ firstAtom: 2, lastAtom: atoms.length }
		];
		const output = JSON.stringify({
			groups: ranges.map((range) => ({
				...range,
				revisedSourceText: 'revised',
				translatedText: '译文',
				paragraphBreakBefore: false
			}))
		});

		expect(() => parseRevisionModelOutput(output, atoms)).toThrow(RevisionBoundaryError);
		try {
			parseRevisionModelOutput(output, atoms);
		} catch (error) {
			expect((error as RevisionBoundaryError).returnedAtomRanges).toEqual(ranges);
		}
	});

	it('allows any number of short sentences to merge while the row stays readable', () => {
		const text = 'Okay. Right. So let us start.';
		const atoms = sourceClauseAtoms(text, 0, text.length, 'en');
		const parsed = parseRevisionModelOutput(
			JSON.stringify({
				groups: [
					{
						firstAtom: 1,
						lastAtom: atoms.length,
						revisedSourceText: text,
						translatedText: '好的。对。那我们开始吧。',
						paragraphBreakBefore: false
					}
				]
			}),
			atoms
		);

		expect(parsed.groups).toHaveLength(1);
		expect(parsed.groups[0].oversized).toBe(false);
	});
});
