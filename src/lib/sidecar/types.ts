export type SidecarTaskKind = 'ask' | 'summarize' | 'retranslate' | 'revise-pairs';
export type SidecarTrigger = 'manual' | 'periodic' | 'finalizing';
export type SidecarContextScope = 'latest-run' | 'current-thread';

export interface SidecarConversationTurn {
	question: string;
	answer: string;
}

export interface SidecarRevisionAtom {
	i: number;
	start: number;
	end: number;
	t: string;
	boundary: 'sentence' | 'clause' | 'open' | 'forced';
}

export interface SidecarInvalidAtomRange {
	firstAtom: number;
	lastAtom: number;
}

export interface SidecarRevisionContextSegment {
	revisedSourceText: string;
	translatedText: string;
}

export interface SidecarRevisionDraftSegment {
	sourceStart: number;
	sourceEnd: number;
	rawText: string;
	revisedSourceText: string;
	translatedText: string;
	paragraphBreakBefore: boolean;
}

export type SidecarIntent =
	| {
			kind: 'ask';
			trigger: 'manual';
			question: string;
			history?: SidecarConversationTurn[];
			outputLanguage: string;
	  }
	| {
			kind: 'summarize';
			trigger: SidecarTrigger;
			outputLanguage: string;
	  }
	| {
			kind: 'retranslate';
			trigger: 'manual';
			targetLanguage: string;
	  }
	| {
			kind: 'revise-pairs';
			trigger: SidecarTrigger;
			targetLanguage: string;
			atoms: SidecarRevisionAtom[];
			continuity: SidecarRevisionContextSegment[];
			previousDraft: SidecarRevisionDraftSegment[];
			oversizedGroupNumbers: number[];
			previousInvalidAtomRanges: SidecarInvalidAtomRange[];
	  };

export interface SidecarTranscriptRunInput {
	runId: string;
	sequence: number;
	targetLanguage: string;
	sourceText: string;
	translationText: string;
}

export interface SidecarContextPayload {
	threadId: string;
	scope: SidecarContextScope;
	capturedAt: string;
	continuityText?: string;
	cleanedTranscript?: string;
	runs: SidecarTranscriptRunInput[];
}

export interface SidecarInvokeRequest {
	clientRequestId: string;
	intent: SidecarIntent;
	context: SidecarContextPayload;
}

export interface ModelUsage {
	inputTokens: number;
	cachedInputTokens: number | null;
	outputTokens: number;
	reasoningTokens: number | null;
	totalTokens: number;
}

export type ModelUsageStatus = 'recorded' | 'unavailable';

export interface SidecarFailureDiagnostic {
	durationMs: number | null;
	visibilityState: string | null;
	online: boolean | null;
	requestBytes: number | null;
	httpStatus: number | null;
}

export type SidecarErrorCode =
	| 'invalid-request'
	| 'empty-context'
	| 'context-too-large'
	| 'browser-network-failed'
	| 'invalid-response'
	| 'invalid-revision-boundary'
	| 'budget-check-failed'
	| 'request-timeout'
	| 'upstream-failed'
	| 'upstream-incomplete';

export type SidecarInvokeResult =
	| {
			status: 'completed';
			clientRequestId: string;
			responseId: string;
			model: string;
			outputText: string;
			usageStatus: ModelUsageStatus;
			usage: ModelUsage | null;
			completedAt: string;
	  }
	| {
			status: 'failed';
			clientRequestId: string;
			responseId: string | null;
			model: string | null;
			outputText: string | null;
			upstreamStatus: 'failed' | 'incomplete' | 'cancelled' | null;
			usageStatus: ModelUsageStatus;
			usage: ModelUsage | null;
			diagnostic?: SidecarFailureDiagnostic | null;
			error: { code: SidecarErrorCode; message: string };
			failedAt: string;
	  };

export interface SidecarInvocationView {
	id: string;
	intent: SidecarIntent;
	context: {
		threadId: string;
		scope: SidecarContextScope;
		capturedAt: string;
		runCount: number;
		sourceCharacters: number;
		translationCharacters: number;
		cleanedTranscriptCharacters: number;
		historyTurns: number;
	};
	state: 'requesting' | 'completed' | 'failed';
	result: SidecarInvokeResult | null;
}

export const SIDECAR_MAX_REQUEST_BYTES = 1_500_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isModelUsage(value: unknown): value is ModelUsage {
	return (
		isRecord(value) &&
		typeof value.inputTokens === 'number' &&
		Number.isFinite(value.inputTokens) &&
		isNullableNumber(value.cachedInputTokens) &&
		typeof value.outputTokens === 'number' &&
		Number.isFinite(value.outputTokens) &&
		isNullableNumber(value.reasoningTokens) &&
		typeof value.totalTokens === 'number' &&
		Number.isFinite(value.totalTokens)
	);
}

function isSidecarFailureDiagnostic(value: unknown): value is SidecarFailureDiagnostic {
	return (
		isRecord(value) &&
		isNullableNumber(value.durationMs) &&
		(value.visibilityState === null || typeof value.visibilityState === 'string') &&
		(value.online === null || typeof value.online === 'boolean') &&
		isNullableNumber(value.requestBytes) &&
		isNullableNumber(value.httpStatus)
	);
}

export function isSidecarInvokeResult(value: unknown): value is SidecarInvokeResult {
	if (!isRecord(value) || (value.status !== 'completed' && value.status !== 'failed')) return false;
	if (
		typeof value.clientRequestId !== 'string' ||
		(value.usageStatus !== 'recorded' && value.usageStatus !== 'unavailable') ||
		(value.usageStatus === 'recorded' ? !isModelUsage(value.usage) : value.usage !== null)
	) {
		return false;
	}

	if (value.status === 'completed') {
		return (
			typeof value.responseId === 'string' &&
			typeof value.model === 'string' &&
			typeof value.outputText === 'string' &&
			typeof value.completedAt === 'string'
		);
	}

	return (
		(value.responseId === null || typeof value.responseId === 'string') &&
		(value.model === null || typeof value.model === 'string') &&
		(value.outputText === null || typeof value.outputText === 'string') &&
		(value.upstreamStatus === null ||
			value.upstreamStatus === 'failed' ||
			value.upstreamStatus === 'incomplete' ||
			value.upstreamStatus === 'cancelled') &&
		(value.diagnostic === undefined ||
			value.diagnostic === null ||
			isSidecarFailureDiagnostic(value.diagnostic)) &&
		isRecord(value.error) &&
		typeof value.error.code === 'string' &&
		typeof value.error.message === 'string' &&
		typeof value.failedAt === 'string'
	);
}
