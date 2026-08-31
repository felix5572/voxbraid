import type { CaptureRun, CaptureRunEndReason, TranscriptStreamSnapshot } from './types';

export type TranscriptFactEvent =
	| {
			type: 'source-delta' | 'translation-delta';
			delta: string;
			elapsedMs: number | null;
			at: string;
	  }
	| {
			type: 'run-closed';
			outcome: 'completed' | 'interrupted';
			reason: CaptureRunEndReason;
			at: string;
	  };

export interface TranscriptFactDiagnostics {
	deltasAfterClose: number;
}

export interface TranscriptFactResult {
	run: CaptureRun;
	diagnostics: TranscriptFactDiagnostics;
}

function emptyDiagnostics(): TranscriptFactDiagnostics {
	return { deltasAfterClose: 0 };
}

function normalizedElapsed(value: number | null): number | null {
	return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function latestElapsed(current: number | null, next: number | null): number | null {
	if (next === null) return current;
	return current === null ? next : Math.max(current, next);
}

function appendDelta(
	stream: TranscriptStreamSnapshot,
	delta: string,
	elapsedMs: number | null,
	at: string
): TranscriptStreamSnapshot {
	return {
		text: stream.text + delta,
		lastElapsedMs: latestElapsed(stream.lastElapsedMs, elapsedMs),
		updatedAt: at
	};
}

function isClosed(run: CaptureRun): boolean {
	return run.status === 'completed' || run.status === 'interrupted' || run.status === 'failed';
}

export function reduceTranscriptFacts(
	run: CaptureRun,
	event: TranscriptFactEvent
): TranscriptFactResult {
	if (event.type === 'run-closed') {
		if (isClosed(run)) return { run, diagnostics: emptyDiagnostics() };

		return {
			run: {
				...run,
				status: event.outcome,
				endedAt: event.at,
				endReason: event.reason
			},
			diagnostics: emptyDiagnostics()
		};
	}

	if (!event.delta) return { run, diagnostics: emptyDiagnostics() };

	const elapsedMs = normalizedElapsed(event.elapsedMs);
	const stream = event.type === 'source-delta' ? 'sourceStream' : 'translationStream';
	const diagnostics = emptyDiagnostics();
	const closed = isClosed(run);
	if (closed) diagnostics.deltasAfterClose = 1;

	return {
		run: {
			...run,
			[stream]: appendDelta(run[stream], event.delta, elapsedMs, event.at),
			// A late server delta belongs to media sent before close. Preserve its text and
			// observed duration without making the run appear active after endedAt.
			lastActivityAt: closed ? run.lastActivityAt : event.at,
			audioDurationMs:
				elapsedMs === null ? run.audioDurationMs : Math.max(run.audioDurationMs, elapsedMs)
		},
		diagnostics
	};
}
