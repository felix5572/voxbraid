import { sentenceBoundaries } from './sentence-boundary';
import type { SegmentAlignment } from './types';

export interface TranscriptBlockProjection {
	sequence: number;
	sourceText: string;
	translatedText: string;
	alignment: SegmentAlignment;
}

export function splitTranscriptBlocks(value: string): string[] {
	if (!value) return [];

	const blocks: string[] = [];
	let start = 0;
	for (const { end } of sentenceBoundaries(value)) {
		blocks.push(value.slice(start, end));
		start = end;
	}
	if (start < value.length) blocks.push(value.slice(start));
	return blocks;
}

export function projectTranscriptBlocks(
	sourceText: string,
	translationText: string
): TranscriptBlockProjection[] {
	const sourceBlocks = splitTranscriptBlocks(sourceText)
		.map((block) => block.trim())
		.filter(Boolean);
	const translationBlocks = splitTranscriptBlocks(translationText)
		.map((block) => block.trim())
		.filter(Boolean);
	const count = Math.max(sourceBlocks.length, translationBlocks.length);

	return Array.from({ length: count }, (_, index) => {
		const source = sourceBlocks[index] ?? '';
		const translation = translationBlocks[index] ?? '';
		return {
			sequence: index + 1,
			sourceText: source,
			translatedText: translation,
			alignment: source && translation ? 'approximate' : 'unpaired'
		};
	});
}
