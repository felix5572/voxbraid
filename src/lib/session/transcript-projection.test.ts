import { describe, expect, it } from 'vitest';
import timingProbe from './fixtures/realtime-timing-probe.json';
import { projectTranscriptBlocks, splitTranscriptBlocks } from './transcript-projection';

describe('projectTranscriptBlocks', () => {
	it('zips independently split streams into approximate reading blocks', () => {
		const segments = projectTranscriptBlocks(
			'First sentence. Second sentence. Third sentence.',
			'第一句话。第二句话。第三句话。'
		);

		expect(segments).toEqual([
			{
				sequence: 1,
				sourceText: 'First sentence.',
				translatedText: '第一句话。',
				alignment: 'approximate'
			},
			{
				sequence: 2,
				sourceText: 'Second sentence.',
				translatedText: '第二句话。',
				alignment: 'approximate'
			},
			{
				sequence: 3,
				sourceText: 'Third sentence.',
				translatedText: '第三句话。',
				alignment: 'approximate'
			}
		]);
	});

	it('marks an unmatched tail as unpaired without dropping it', () => {
		const segments = projectTranscriptBlocks('One. Two.', '一。');

		expect(segments).toMatchObject([
			{ sourceText: 'One.', translatedText: '一。', alignment: 'approximate' },
			{ sourceText: 'Two.', translatedText: '', alignment: 'unpaired' }
		]);
	});

	it('keeps an unpunctuated stream as one lossless block', () => {
		expect(projectTranscriptBlocks('abcdefghij', '甲乙丙丁戊')).toMatchObject([
			{ sourceText: 'abcdefghij', translatedText: '甲乙丙丁戊', alignment: 'approximate' }
		]);
	});

	it('does not treat a decimal point as a sentence boundary', () => {
		expect(splitTranscriptBlocks('The value is 3.14 percent.')).toEqual([
			'The value is 3.14 percent.'
		]);
	});

	it.each([
		'Mr. Smith said the meeting is over.',
		'The U.S. economy grew last year.',
		'Use a tool, e.g. a hammer, to fix it.'
	])('does not split a common English abbreviation in %s', (value) => {
		expect(splitTranscriptBlocks(value)).toEqual([value]);
	});

	it('projects the real trace without depending on elapsed timestamps', () => {
		const source = timingProbe
			.filter((sample) => sample.stream === 'source')
			.map((sample) => sample.delta)
			.join('');
		const translation = timingProbe
			.filter((sample) => sample.stream === 'translation')
			.map((sample) => sample.delta)
			.join('');

		const segments = projectTranscriptBlocks(source, translation);

		expect(segments).toHaveLength(3);
		expect(segments.every((segment) => segment.alignment === 'approximate')).toBe(true);
		expect(segments.map((segment) => segment.sourceText).join(' ')).toBe(source.trim());
		expect(segments.map((segment) => segment.translatedText).join('')).toBe(translation);
	});
});
