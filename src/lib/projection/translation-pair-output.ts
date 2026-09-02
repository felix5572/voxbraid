export interface TranslationPairModelGroup {
	atomIds: string[];
	translatedText: string;
	paragraphBreakBefore: boolean;
}

export interface TranslationPairModelOutput {
	groups: TranslationPairModelGroup[];
}

export const TRANSLATION_PAIR_MAX_OUTPUT_CHARACTERS = 16_000;

export const TRANSLATION_PAIR_OUTPUT_SCHEMA = Object.freeze({
	type: 'json_schema',
	name: 'translation_pair_batch',
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
					required: ['atomIds', 'translatedText', 'paragraphBreakBefore'],
					properties: {
						atomIds: {
							type: 'array',
							items: { type: 'string' }
						},
						translatedText: { type: 'string' },
						paragraphBreakBefore: { type: 'boolean' }
					}
				}
			}
		}
	}
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTranslationPairModelOutput(
	value: string,
	expectedAtomIds: readonly string[]
): TranslationPairModelOutput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new TypeError(
			`句段对照模型没有返回合法 JSON：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
			{ cause: error }
		);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
		throw new TypeError('句段对照模型输出缺少非空 groups 数组。');
	}

	const groups: TranslationPairModelGroup[] = [];
	const flattenedAtomIds: string[] = [];
	let outputCharacters = 0;
	for (const [index, group] of parsed.groups.entries()) {
		if (
			!isRecord(group) ||
			!Array.isArray(group.atomIds) ||
			group.atomIds.length === 0 ||
			!group.atomIds.every((id) => typeof id === 'string') ||
			typeof group.translatedText !== 'string' ||
			!group.translatedText.trim() ||
			typeof group.paragraphBreakBefore !== 'boolean'
		) {
			throw new TypeError(`句段对照模型第 ${index + 1} 组格式无效。`);
		}
		const atomIds = [...group.atomIds] as string[];
		outputCharacters += group.translatedText.length;
		if (outputCharacters > TRANSLATION_PAIR_MAX_OUTPUT_CHARACTERS) {
			throw new TypeError(
				`句段对照模型译文超过 ${TRANSLATION_PAIR_MAX_OUTPUT_CHARACTERS} 字符上限。`
			);
		}
		flattenedAtomIds.push(...atomIds);
		groups.push({
			atomIds,
			translatedText: group.translatedText.trim(),
			paragraphBreakBefore: group.paragraphBreakBefore
		});
	}

	if (
		flattenedAtomIds.length !== expectedAtomIds.length ||
		flattenedAtomIds.some((id, index) => id !== expectedAtomIds[index])
	) {
		throw new TypeError(
			`句段对照模型返回的 atom 顺序或覆盖范围无效；预期 ${JSON.stringify(expectedAtomIds)}，实际 ${JSON.stringify(flattenedAtomIds)}。`
		);
	}
	return { groups };
}
