import { toTranscriptDeltaFact } from '../realtime/session-adapter';
import type { TranslationServerEvent } from '../realtime/types';
import { reduceTranscriptFacts } from './transcript-facts';
import type { CaptureRun, CaptureRunEndReason, RunError, TranslationThread } from './types';

export interface TranslationSessionDiagnostics {
	deltasAfterClose: number;
}

export interface TranslationSessionState {
	thread: TranslationThread;
	runs: CaptureRun[];
	activeRunId: string | null;
	diagnostics: TranslationSessionDiagnostics;
}

export interface CreateTranslationSessionInput {
	threadId: string;
	defaultTargetLanguage: string;
	at: string;
}

export interface BeginCaptureRunInput {
	runId: string;
	targetLanguage: string;
	clientPlatform: string | null;
	at: string;
}

export interface EndCaptureRunInput {
	outcome: 'completed' | 'interrupted' | 'failed';
	reason: CaptureRunEndReason;
	error?: RunError | null;
	at: string;
}

export function createTranslationSession(
	input: CreateTranslationSessionInput
): TranslationSessionState {
	return {
		thread: {
			id: input.threadId,
			ownerId: null,
			title: null,
			defaultTargetLanguage: input.defaultTargetLanguage,
			status: 'active',
			createdAt: input.at,
			updatedAt: input.at
		},
		runs: [],
		activeRunId: null,
		diagnostics: { deltasAfterClose: 0 }
	};
}

export function activeCaptureRun(state: TranslationSessionState): CaptureRun | null {
	if (!state.activeRunId) return null;
	return state.runs.find((run) => run.id === state.activeRunId) ?? null;
}

export function currentCaptureRun(state: TranslationSessionState): CaptureRun | null {
	return activeCaptureRun(state) ?? state.runs.at(-1) ?? null;
}

function nextRunSequence(state: TranslationSessionState): number {
	return Math.max(0, ...state.runs.map((run) => run.sequence)) + 1;
}

function replaceRun(
	state: TranslationSessionState,
	runId: string,
	replace: (run: CaptureRun) => CaptureRun
): TranslationSessionState {
	const index = state.runs.findIndex((run) => run.id === runId);
	if (index === -1) return state;

	const runs = [...state.runs];
	runs[index] = replace(runs[index]);
	return { ...state, runs };
}

export function beginCaptureRun(
	state: TranslationSessionState,
	input: BeginCaptureRunInput
): TranslationSessionState {
	if (activeCaptureRun(state))
		throw new Error('Cannot begin a capture run while another is active.');
	if (state.runs.some((run) => run.id === input.runId)) {
		throw new Error(`Capture run ID already exists: ${input.runId}`);
	}

	const run: CaptureRun = {
		id: input.runId,
		threadId: state.thread.id,
		sequence: nextRunSequence(state),
		status: 'starting',
		targetLanguage: input.targetLanguage,
		createdAt: input.at,
		mediaStartedAt: null,
		endedAt: null,
		lastActivityAt: null,
		hiddenAt: null,
		audioDurationMs: 0,
		endTimeEstimated: false,
		endReason: null,
		recoveredFromRunId: null,
		clientPlatform: input.clientPlatform,
		lastError: null,
		sourceStream: { text: '', lastElapsedMs: null, updatedAt: null },
		translationStream: { text: '', lastElapsedMs: null, updatedAt: null },
		currentSegmentRevision: null
	};

	return {
		...state,
		thread: { ...state.thread, updatedAt: input.at },
		runs: [...state.runs, run],
		activeRunId: run.id
	};
}

export function markActiveRunConnected(
	state: TranslationSessionState,
	at: string
): TranslationSessionState {
	const run = activeCaptureRun(state);
	if (!run || (run.status !== 'starting' && run.status !== 'live')) return state;

	return replaceRun(state, run.id, (current) => ({
		...current,
		status: 'live',
		mediaStartedAt: current.mediaStartedAt ?? at
	}));
}

export function markActiveRunStopping(state: TranslationSessionState): TranslationSessionState {
	const run = activeCaptureRun(state);
	if (!run || (run.status !== 'starting' && run.status !== 'live')) return state;
	return replaceRun(state, run.id, (current) => ({ ...current, status: 'stopping' }));
}

export function markActiveRunHidden(
	state: TranslationSessionState,
	at: string
): TranslationSessionState {
	const run = activeCaptureRun(state);
	if (!run) return state;
	return replaceRun(state, run.id, (current) => ({ ...current, hiddenAt: at }));
}

export function markActiveRunVisible(state: TranslationSessionState): TranslationSessionState {
	const run = activeCaptureRun(state);
	if (!run || run.hiddenAt === null) return state;
	return replaceRun(state, run.id, (current) => ({ ...current, hiddenAt: null }));
}

export function appendRealtimeTranscriptEvent(
	state: TranslationSessionState,
	event: TranslationServerEvent,
	at: string
): TranslationSessionState {
	const fact = toTranscriptDeltaFact(event, at);
	if (!fact) return state;

	const target = currentCaptureRun(state);
	if (!target) return state;

	const result = reduceTranscriptFacts(target, fact);
	const replaced = replaceRun(state, target.id, () => result.run);
	return {
		...replaced,
		diagnostics: {
			deltasAfterClose: replaced.diagnostics.deltasAfterClose + result.diagnostics.deltasAfterClose
		}
	};
}

export function endActiveCaptureRun(
	state: TranslationSessionState,
	input: EndCaptureRunInput
): TranslationSessionState {
	const run = activeCaptureRun(state);
	if (!run) return state;

	const result = reduceTranscriptFacts(run, {
		type: 'run-closed',
		outcome: input.outcome,
		reason: input.reason,
		error: input.error,
		at: input.at
	});
	const replaced = replaceRun(state, run.id, () => result.run);
	return {
		...replaced,
		thread: { ...replaced.thread, updatedAt: input.at },
		activeRunId: null
	};
}
