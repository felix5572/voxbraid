import type { SourceToken } from './revision-projection';
import {
	REVISION_MAX_GROUP_SOURCE_CHARACTERS,
	REVISION_MAX_OPEN_SOURCE_CHARACTERS
} from './revision-constants';

export interface RevisionModelGroup {
	lastTokenIndex: number;
	lastTokenText: string;
	revisedSourceText: string;
	translatedText: string;
	paragraphBreakBefore: boolean;
}

export interface RevisionModelOutput {
	groups: RevisionModelGroup[];
}

export interface ValidatedRevisionGroup extends RevisionModelGroup {
	tokenStart: number;
	sourceStart: number;
	sourceEnd: number;
	rawText: string;
	oversized: boolean;
}

export interface ParsedRevisionModelOutput {
	output: RevisionModelOutput;
	groups: ValidatedRevisionGroup[];
	whitespaceNormalizedGroupNumbers: number[];
}

export class OversizedRevisionGroupError extends TypeError {
	constructor(
		readonly groups: ValidatedRevisionGroup[],
		readonly oversizedGroupNumbers: number[]
	) {
		super(
			`修订对照第 ${oversizedGroupNumbers.join('、')} 组超过 ${REVISION_MAX_GROUP_SOURCE_CHARACTERS} 字符软上限。`
		);
		this.name = 'OversizedRevisionGroupError';
	}
}

export class RevisionBoundaryError extends TypeError {
	constructor(
		message: string,
		readonly returnedLastTokenIndexes: number[]
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
						'lastTokenIndex',
						'lastTokenText',
						'revisedSourceText',
						'translatedText',
						'paragraphBreakBefore'
					],
					properties: {
						lastTokenIndex: {
							type: 'integer',
							description:
								'Copy the i value of the last input token belonging to this group. Values strictly increase across groups, never restart, and the final value equals the final input token i.'
						},
						lastTokenText: {
							type: 'string',
							description:
								'Copy the t value of the token selected by lastTokenIndex exactly, including leading whitespace and punctuation.'
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

export function revisionLastTokenIndexesFromOutput(value: string): number[] | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!record(parsed) || !Array.isArray(parsed.groups) || parsed.groups.length === 0) return null;
		const indexes = parsed.groups.map((group) => (record(group) ? group.lastTokenIndex : null));
		return indexes.every((index) => Number.isSafeInteger(index)) ? (indexes as number[]) : null;
	} catch {
		return null;
	}
}

export function parseRevisionModelOutput(
	value: string,
	tokens: readonly SourceToken[],
	options: { allowOversizedGroups?: boolean } = {}
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
	if (tokens.length === 0) throw new TypeError('修订对照请求没有 token。');
	const firstSourceStart = tokens[0].start;
	const lastSourceEnd = tokens.at(-1)!.end;
	if (lastSourceEnd - firstSourceStart > REVISION_MAX_OPEN_SOURCE_CHARACTERS) {
		throw new TypeError('修订对照请求超过 raw 硬上限。');
	}

	const groups: ValidatedRevisionGroup[] = [];
	const whitespaceNormalizedGroupNumbers: number[] = [];
	const returnedLastTokenIndexes = revisionLastTokenIndexesFromOutput(value) ?? [];
	let previousLastTokenIndex = 0;
	let outputCharacters = 0;
	for (const [index, rawGroup] of parsed.groups.entries()) {
		if (
			!record(rawGroup) ||
			!Number.isSafeInteger(rawGroup.lastTokenIndex) ||
			typeof rawGroup.lastTokenText !== 'string' ||
			typeof rawGroup.revisedSourceText !== 'string' ||
			!rawGroup.revisedSourceText.trim() ||
			typeof rawGroup.translatedText !== 'string' ||
			!rawGroup.translatedText.trim() ||
			typeof rawGroup.paragraphBreakBefore !== 'boolean'
		) {
			throw new TypeError(`修订对照模型第 ${index + 1} 组格式无效。`);
		}
		const lastTokenIndex = rawGroup.lastTokenIndex as number;
		const lastTokenText = rawGroup.lastTokenText as string;
		if (lastTokenIndex <= previousLastTokenIndex || lastTokenIndex > tokens.length) {
			throw new RevisionBoundaryError(
				`修订对照模型第 ${index + 1} 组 lastTokenIndex=${lastTokenIndex} 无效；上一组结束于 ${previousLastTokenIndex}，本批最后一个 token 是 ${tokens.length}。`,
				returnedLastTokenIndexes
			);
		}
		const first = tokens[previousLastTokenIndex];
		const last = tokens[lastTokenIndex - 1];
		if (lastTokenText.trim() !== last.text.trim()) {
			const matchingIndexes = tokens
				.filter((token) => token.text.trim() === lastTokenText.trim())
				.map((token) => token.index);
			throw new RevisionBoundaryError(
				`修订对照模型第 ${index + 1} 组 lastTokenText 与 token ${lastTokenIndex} 不一致（忽略首尾空白后比较）；该文本在当前请求中的匹配位置为 ${matchingIndexes.length > 0 ? matchingIndexes.join('、') : '无'}。`,
				returnedLastTokenIndexes
			);
		}
		if (lastTokenText !== last.text) whitespaceNormalizedGroupNumbers.push(index + 1);
		const rawText = tokens
			.slice(previousLastTokenIndex, lastTokenIndex)
			.map((token) => token.text)
			.join('');
		const group: ValidatedRevisionGroup = {
			tokenStart: previousLastTokenIndex + 1,
			lastTokenIndex,
			lastTokenText,
			sourceStart: first.start,
			sourceEnd: last.end,
			rawText,
			revisedSourceText: rawGroup.revisedSourceText.trim(),
			translatedText: rawGroup.translatedText.trim(),
			paragraphBreakBefore: rawGroup.paragraphBreakBefore as boolean,
			oversized: last.end - first.start > REVISION_MAX_GROUP_SOURCE_CHARACTERS
		};
		outputCharacters += group.revisedSourceText.length + group.translatedText.length;
		if (outputCharacters > REVISION_MAX_OUTPUT_CHARACTERS) {
			throw new TypeError(`修订对照模型输出超过 ${REVISION_MAX_OUTPUT_CHARACTERS} 字符上限。`);
		}
		groups.push(group);
		previousLastTokenIndex = lastTokenIndex;
	}
	if (previousLastTokenIndex !== tokens.length) {
		throw new RevisionBoundaryError(
			`修订对照模型只覆盖到 token ${previousLastTokenIndex}，预期 ${tokens.length}。`,
			returnedLastTokenIndexes
		);
	}
	const oversizedGroupNumbers = groups
		.map((group, index) => (group.oversized ? index + 1 : 0))
		.filter(Boolean);
	if (oversizedGroupNumbers.length > 0 && !options.allowOversizedGroups) {
		throw new OversizedRevisionGroupError(groups, oversizedGroupNumbers);
	}
	return {
		output: {
			groups: groups.map(({ tokenStart, sourceStart, sourceEnd, rawText, oversized, ...group }) => {
				void tokenStart;
				void sourceStart;
				void sourceEnd;
				void rawText;
				void oversized;
				return group;
			})
		},
		groups,
		whitespaceNormalizedGroupNumbers
	};
}
