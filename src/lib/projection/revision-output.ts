import type { SourceClauseAtom } from './revision-projection';
import { REVISION_MAX_OPEN_SOURCE_CHARACTERS } from './revision-constants';

export interface RevisionModelGroup {
	firstAtom: number;
	lastAtom: number;
	revisedSourceText: string;
	translatedText: string;
	paragraphBreakBefore: boolean;
}

export interface RevisionModelOutput {
	groups: RevisionModelGroup[];
}

export interface ValidatedRevisionGroup extends RevisionModelGroup {
	sourceStart: number;
	sourceEnd: number;
	rawText: string;
	endingBoundary: SourceClauseAtom['boundary'];
}

export interface ParsedRevisionModelOutput {
	output: RevisionModelOutput;
	groups: ValidatedRevisionGroup[];
}

export class RevisionBoundaryError extends TypeError {
	constructor(
		message: string,
		readonly returnedAtomRanges: Array<{ firstAtom: number; lastAtom: number }>
	) {
		super(message);
		this.name = 'RevisionBoundaryError';
	}
}

export const REVISION_MAX_OUTPUT_CHARACTERS = 32_000;

export const REVISION_OUTPUT_SCHEMA = Object.freeze({
	type: 'json_schema',
	name: 'revision_pair_batch',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		required: ['groups'],
		properties: {
			groups: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: [
						'firstAtom',
						'lastAtom',
						'revisedSourceText',
						'translatedText',
						'paragraphBreakBefore'
					],
					properties: {
						firstAtom: {
							type: 'integer',
							description:
								'Copy the i value of the first currentAtoms item belonging to this group. The first group starts at 1 and every later group starts exactly one after the prior lastAtom.'
						},
						lastAtom: {
							type: 'integer',
							description:
								'Copy the i value of the last currentAtoms item belonging to this group. It is at least firstAtom and the final group ends at the final input atom.'
						},
						revisedSourceText: { type: 'string' },
						translatedText: { type: 'string' },
						paragraphBreakBefore: { type: 'boolean' }
					}
				}
			}
		}
	}
});

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function revisionAtomRangesFromOutput(
	value: string
): Array<{ firstAtom: number; lastAtom: number }> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!record(parsed) || !Array.isArray(parsed.groups) || parsed.groups.length === 0) return null;
		const ranges = parsed.groups.map((group) =>
			record(group) && Number.isSafeInteger(group.firstAtom) && Number.isSafeInteger(group.lastAtom)
				? { firstAtom: group.firstAtom as number, lastAtom: group.lastAtom as number }
				: null
		);
		return ranges.every((range) => range !== null)
			? (ranges as Array<{ firstAtom: number; lastAtom: number }>)
			: null;
	} catch {
		return null;
	}
}

export function parseRevisionModelOutput(
	value: string,
	atoms: readonly SourceClauseAtom[]
): ParsedRevisionModelOutput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new TypeError(
			`修订对照模型没有返回合法 JSON：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
			{ cause: error }
		);
	}
	if (!record(parsed) || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
		throw new TypeError('修订对照模型输出缺少非空 groups 数组。');
	}
	if (atoms.length === 0) throw new TypeError('修订对照请求没有原子。');
	const firstSourceStart = atoms[0].start;
	const lastSourceEnd = atoms.at(-1)!.end;
	if (lastSourceEnd - firstSourceStart > REVISION_MAX_OPEN_SOURCE_CHARACTERS) {
		throw new TypeError('修订对照请求超过 raw 硬上限。');
	}

	const groups: ValidatedRevisionGroup[] = [];
	const returnedAtomRanges = revisionAtomRangesFromOutput(value) ?? [];
	let expectedFirstAtom = 1;
	let outputCharacters = 0;
	for (const [index, rawGroup] of parsed.groups.entries()) {
		if (
			!record(rawGroup) ||
			!Number.isSafeInteger(rawGroup.firstAtom) ||
			!Number.isSafeInteger(rawGroup.lastAtom) ||
			typeof rawGroup.revisedSourceText !== 'string' ||
			!rawGroup.revisedSourceText.trim() ||
			typeof rawGroup.translatedText !== 'string' ||
			!rawGroup.translatedText.trim() ||
			typeof rawGroup.paragraphBreakBefore !== 'boolean'
		) {
			throw new TypeError(`修订对照模型第 ${index + 1} 组格式无效。`);
		}
		const firstAtom = rawGroup.firstAtom as number;
		const lastAtom = rawGroup.lastAtom as number;
		if (firstAtom !== expectedFirstAtom || lastAtom < firstAtom || lastAtom > atoms.length) {
			throw new RevisionBoundaryError(
				`修订对照模型第 ${index + 1} 组原子范围 ${firstAtom}–${lastAtom} 无效；预期从原子 ${expectedFirstAtom} 开始，本批最后一个原子是 ${atoms.length}。`,
				returnedAtomRanges
			);
		}
		const groupAtoms = atoms.slice(firstAtom - 1, lastAtom);
		const first = groupAtoms[0];
		const last = groupAtoms.at(-1)!;
		const rawText = groupAtoms.map((atom) => atom.text).join('');
		const group: ValidatedRevisionGroup = {
			firstAtom,
			lastAtom,
			sourceStart: first.start,
			sourceEnd: last.end,
			rawText,
			revisedSourceText: rawGroup.revisedSourceText.trim(),
			translatedText: rawGroup.translatedText.trim(),
			paragraphBreakBefore: rawGroup.paragraphBreakBefore as boolean,
			endingBoundary: last.boundary
		};
		outputCharacters += group.revisedSourceText.length + group.translatedText.length;
		if (outputCharacters > REVISION_MAX_OUTPUT_CHARACTERS) {
			throw new TypeError(`修订对照模型输出超过 ${REVISION_MAX_OUTPUT_CHARACTERS} 字符上限。`);
		}
		groups.push(group);
		expectedFirstAtom = lastAtom + 1;
	}
	if (expectedFirstAtom !== atoms.length + 1) {
		throw new RevisionBoundaryError(
			`修订对照模型只覆盖到原子 ${expectedFirstAtom - 1}，预期 ${atoms.length}。`,
			returnedAtomRanges
		);
	}
	return {
		output: {
			groups: groups.map(({ sourceStart, sourceEnd, rawText, endingBoundary, ...group }) => {
				void sourceStart;
				void sourceEnd;
				void rawText;
				void endingBoundary;
				return group;
			})
		},
		groups
	};
}
