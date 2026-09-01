const SENTENCE_END = /(?:[。！？]["'”’）)\]]*|[.!?]["'”’）)\]]*(?=\s|$))/gu;
const COMMON_ABBREVIATION =
	/(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Inc|Ltd|No|vs|etc|e\.g|i\.e|approx)\.$/iu;
const INITIALISM = /(?:\b[A-Za-z]\.){2,}$/u;

export interface SentenceBoundary {
	end: number;
	kind: 'ascii' | 'cjk';
}

export function sentenceBoundaries(value: string): SentenceBoundary[] {
	const boundaries: SentenceBoundary[] = [];
	let start = 0;
	for (const match of value.matchAll(SENTENCE_END)) {
		const end = (match.index ?? 0) + match[0].length;
		const candidate = value.slice(start, end);
		if (COMMON_ABBREVIATION.test(candidate) || INITIALISM.test(candidate)) continue;
		boundaries.push({
			end,
			kind: /^[.!?]/u.test(match[0]) ? 'ascii' : 'cjk'
		});
		start = end;
	}
	return boundaries;
}
