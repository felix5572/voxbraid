import type { SegmentAlignment } from './types';

const SENTENCE_END = /(?:[。！？]["'”’）)\]]*|[.!?]["'”’）)\]]*(?=\s|$))/gu;
const COMMON_ABBREVIATION =
	/(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Inc|Ltd|No|vs|etc|e\.g|i\.e|approx)\.$/iu;
const INITIALISM = /(?:\b[A-Za-z]\.){2,}$/u;

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
	for (const match of value.matchAll(SENTENCE_END)) {
		const end = (match.index ?? 0) + match[0].length;
		const candidate = value.slice(start, end);
		if (COMMON_ABBREVIATION.test(candidate) || INITIALISM.test(candidate)) continue;
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
