import { sentenceBoundaries } from './sentence-boundary';

export type ClauseBoundaryKind = 'clause' | 'sentence';

export interface ClauseBoundary {
	end: number;
	kind: ClauseBoundaryKind;
}

const CLOSERS = new Set(['"', "'", '”', '’', '）', ')', ']']);
const CJK_CLAUSE_END = new Set(['，', '；', '：']);
const ASCII_CLAUSE_END = new Set([',', ';', ':']);

function punctuationEnd(value: string, index: number): number {
	let end = index + 1;
	while (end < value.length && CLOSERS.has(value[end])) end += 1;
	return end;
}

function followedByBoundarySpace(value: string, end: number): boolean {
	return end === value.length || /\s/u.test(value[end]);
}

export function clauseBoundaries(value: string): ClauseBoundary[] {
	const byEnd = new Map<number, ClauseBoundaryKind>();
	for (const boundary of sentenceBoundaries(value)) byEnd.set(boundary.end, 'sentence');

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (CJK_CLAUSE_END.has(character)) {
			const end = punctuationEnd(value, index);
			if (!byEnd.has(end)) byEnd.set(end, 'clause');
			continue;
		}
		if (ASCII_CLAUSE_END.has(character)) {
			const end = punctuationEnd(value, index);
			if (!followedByBoundarySpace(value, end)) continue;
			if (character === ',' && /\d/u.test(value[index - 1] ?? '') && /\d/u.test(value[end] ?? '')) {
				continue;
			}
			if (!byEnd.has(end)) byEnd.set(end, 'clause');
			continue;
		}
		if (character === '—') {
			const leftSeparated = index === 0 || /\s/u.test(value[index - 1]);
			const rightSeparated = index + 1 === value.length || /\s/u.test(value[index + 1]);
			if (leftSeparated && rightSeparated) byEnd.set(index + 1, 'clause');
		}
	}

	return [...byEnd].sort(([left], [right]) => left - right).map(([end, kind]) => ({ end, kind }));
}
