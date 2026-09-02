import type { SourceToken } from './revision-projection';
import {
	REVISION_MAX_GROUP_SOURCE_CHARACTERS,
	REVISION_MAX_OPEN_SOURCE_CHARACTERS
} from './revision-constants';

export interface RevisionModelGroup {
	tokenEnd: number;
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
					required: ['tokenEnd', 'revisedSourceText', 'translatedText', 'paragraphBreakBefore'],
					properties: {
						tokenEnd: { type: 'integer' },
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

export function parseRevisionModelOutput(
	value: string,
	tokens: readonly SourceToken[],
	options: { allowOversizedGroups?: boolean } = {}
): { output: RevisionModelOutput; groups: ValidatedRevisionGroup[] } {
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
	let previousTokenEnd = 0;
	let outputCharacters = 0;
	for (const [index, rawGroup] of parsed.groups.entries()) {
		if (
			!record(rawGroup) ||
			!Number.isSafeInteger(rawGroup.tokenEnd) ||
			typeof rawGroup.revisedSourceText !== 'string' ||
			!rawGroup.revisedSourceText.trim() ||
			typeof rawGroup.translatedText !== 'string' ||
			!rawGroup.translatedText.trim() ||
			typeof rawGroup.paragraphBreakBefore !== 'boolean'
		) {
			throw new TypeError(`修订对照模型第 ${index + 1} 组格式无效。`);
		}
		const tokenEnd = rawGroup.tokenEnd as number;
		if (tokenEnd <= previousTokenEnd || tokenEnd > tokens.length) {
			throw new TypeError(`修订对照模型第 ${index + 1} 组 tokenEnd 无效。`);
		}
		const first = tokens[previousTokenEnd];
		const last = tokens[tokenEnd - 1];
		const rawText = tokens
			.slice(previousTokenEnd, tokenEnd)
			.map((token) => token.text)
			.join('');
		const group: ValidatedRevisionGroup = {
			tokenStart: previousTokenEnd + 1,
			tokenEnd,
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
		previousTokenEnd = tokenEnd;
	}
	if (previousTokenEnd !== tokens.length) {
		throw new TypeError(`修订对照模型只覆盖到 token ${previousTokenEnd}，预期 ${tokens.length}。`);
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
		groups
	};
}
