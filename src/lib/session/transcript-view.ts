import type { CaptureRun } from './types';

export type TranscriptViewStream = 'source' | 'translation';

export interface VisibleTranscriptRun {
	runId: string;
	sequence: number;
	targetLanguage: string;
	startedAt: string;
	text: string;
	truncated: boolean;
}

function streamText(run: CaptureRun, stream: TranscriptViewStream): string {
	return stream === 'source' ? run.sourceStream.text : run.translationStream.text;
}

function visibleTail(value: string, maxCharacters: number): { text: string; truncated: boolean } {
	if (value.length <= maxCharacters) return { text: value.trim(), truncated: false };

	let start = value.length - maxCharacters;
	const firstCodeUnit = value.charCodeAt(start);
	if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) start += 1;
	return { text: `…${value.slice(start).trimStart()}`, truncated: true };
}

export function visibleTranscriptRuns(
	runs: CaptureRun[],
	stream: TranscriptViewStream,
	maxCharacters?: number
): VisibleTranscriptRun[] {
	if (maxCharacters === undefined) {
		return runs.flatMap((run) => {
			const text = streamText(run, stream).trim();
			return text
				? [
						{
							runId: run.id,
							sequence: run.sequence,
							targetLanguage: run.targetLanguage,
							startedAt: run.mediaStartedAt ?? run.createdAt,
							text,
							truncated: false
						}
					]
				: [];
		});
	}

	if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
		throw new RangeError('maxCharacters must be a positive integer.');
	}

	const visible: VisibleTranscriptRun[] = [];
	let remaining = maxCharacters;
	for (let index = runs.length - 1; index >= 0 && remaining > 0; index -= 1) {
		const run = runs[index];
		const fullText = streamText(run, stream);
		if (!fullText.trim()) continue;

		const tail = visibleTail(fullText, remaining);
		visible.unshift({
			runId: run.id,
			sequence: run.sequence,
			targetLanguage: run.targetLanguage,
			startedAt: run.mediaStartedAt ?? run.createdAt,
			text: tail.text,
			truncated: tail.truncated
		});
		remaining -= Math.min(fullText.length, remaining);
	}
	return visible;
}
