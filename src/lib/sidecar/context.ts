import type { TranslationSessionState } from '../session/translation-session';
import type { SidecarContextPayload, SidecarContextScope, SidecarInvokeRequest } from './types';
import { SIDECAR_MAX_REQUEST_BYTES } from './types';

export function serializedUtf8Bytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function sidecarRequestFits(value: SidecarInvokeRequest): boolean {
	return serializedUtf8Bytes(value) <= SIDECAR_MAX_REQUEST_BYTES;
}

export function captureSidecarContext(
	state: TranslationSessionState,
	scope: SidecarContextScope,
	capturedAt: string
): SidecarContextPayload {
	const runs = state.runs
		.filter((run) => run.sourceStream.text.length > 0 || run.translationStream.text.length > 0)
		.map((run) => ({
			runId: run.id,
			sequence: run.sequence,
			targetLanguage: run.targetLanguage,
			sourceText: run.sourceStream.text,
			translationText: run.translationStream.text
		}));

	return {
		threadId: state.thread.id,
		scope,
		capturedAt,
		runs: scope === 'latest-run' ? runs.slice(-1) : runs
	};
}
