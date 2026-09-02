import { describe, expect, it } from 'vitest';
import { clauseBoundaries } from './clause-boundary';

describe('clause boundaries', () => {
	it('classifies clause and sentence punctuation', () => {
		const value = 'First clause, second: done. 中文，继续；结束！';
		expect(
			clauseBoundaries(value).map((boundary) => [value.slice(0, boundary.end), boundary.kind])
		).toEqual([
			['First clause,', 'clause'],
			['First clause, second:', 'clause'],
			['First clause, second: done.', 'sentence'],
			['First clause, second: done. 中文，', 'clause'],
			['First clause, second: done. 中文，继续；', 'clause'],
			['First clause, second: done. 中文，继续；结束！', 'sentence']
		]);
	});

	it('does not split numeric punctuation, abbreviations, URLs, or enumeration marks', () => {
		const value = 'The U.S. value is 3.14 and 3,000; see https://example.com/a:b、c.';
		const slices = clauseBoundaries(value).map((boundary) => value.slice(0, boundary.end));
		expect(slices).toEqual([
			'The U.S. value is 3.14 and 3,000;',
			'The U.S. value is 3.14 and 3,000; see https://example.com/a:b、c.'
		]);
	});

	it('uses only a separated em dash as a clause boundary', () => {
		const value = 'one — two, three—four.';
		expect(clauseBoundaries(value).map((boundary) => boundary.end)).toEqual([
			'one —'.length,
			'one — two,'.length,
			value.length
		]);
	});
});
