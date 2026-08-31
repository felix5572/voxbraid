import type { TranslationServerEvent } from './types';

export function parseServerEvent(value: string): TranslationServerEvent | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return null;
		if (typeof parsed.type !== 'string') return null;
		return parsed as TranslationServerEvent;
	} catch {
		return null;
	}
}
