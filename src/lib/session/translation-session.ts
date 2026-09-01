import { toTranscriptDeltaFact } from '../realtime/session-adapter';
import type { TranslationServerEvent } from '../realtime/types';
import { reduceTranscriptFacts } from './transcript-facts';
import { sentenceBoundaries } from './sentence-boundary';
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

const THREAD_TITLE_MAX_CHARACTERS = 32;
const THREAD_TITLE_MIN_BOUNDARY_CHARACTERS = 8;

function sourceTitle(sourceText: string, force: boolean): string | null {
	const normalized = sourceText.replace(/\s+/gu, ' ').trim();
	if (!normalized) return null;

	const normalizedCharacters = Array.from(normalized);
	let boundaryEnd: number | null = null;
	for (const boundary of sentenceBoundaries(normalized)) {
		if (
			boundary.kind === 'ascii' &&
			Array.from(normalized.slice(0, boundary.end)).length < THREAD_TITLE_MIN_BOUNDARY_CHARACTERS
		) {
			continue;
		}
		boundaryEnd = boundary.end;
		break;
	}
	const hasBoundary = boundaryEnd !== null;
	if (!force && !hasBoundary && normalizedCharacters.length < THREAD_TITLE_MAX_CHARACTERS) {
		return null;
	}

	const candidate = boundaryEnd === null ? normalized : normalized.slice(0, boundaryEnd);
	const characters = Array.from(candidate);
	if (characters.length <= THREAD_TITLE_MAX_CHARACTERS) return candidate;
	return `${characters
		.slice(0, THREAD_TITLE_MAX_CHARACTERS - 1)
		.join('')
		.trimEnd()}…`;
}

function threadWithSourceTitle(
	thread: TranslationThread,
	sourceText: string,
	force: boolean
): TranslationThread {
	if (thread.title?.trim()) return thread;
	const title = sourceTitle(sourceText, force);
	return title ? { ...thread, title } : thread;
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
		thread:
			fact.type === 'source-delta'
				? threadWithSourceTitle(replaced.thread, result.run.sourceStream.text, false)
				: replaced.thread,
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
		thread: {
			...threadWithSourceTitle(replaced.thread, result.run.sourceStream.text, true),
			updatedAt: input.at
		},
		activeRunId: null
	};
}
