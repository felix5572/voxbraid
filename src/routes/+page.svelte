<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createCreditBalanceAnchor,
		estimateCreditBalance,
		estimateRemainingAudioHours,
		isCreditBalanceAnchor,
		type CreditBalanceAnchor
	} from '$lib/billing/credit-balance';
	import { errorDetails, inlineErrorDetails } from '$lib/error-details';
	import OperationalLogPanel from '$lib/OperationalLogPanel.svelte';
	import {
		OPERATIONAL_LOG_EVENT,
		defaultOperationalLogDedupeKey,
		emitOperationalLog,
		recordOperationalLog,
		resolveOperationalIssue,
		resolveOperationalLog,
		type OperationalLogEntry,
		type OperationalLogEventDetail
	} from '$lib/operational-log';
	import { CheckpointWriter } from '$lib/persistence/checkpoint-writer';
	import {
		requestStoragePersistence,
		type StorageDurability
	} from '$lib/persistence/storage-durability';
	import type {
		LocalSessionRepository,
		StoredThread
	} from '$lib/persistence/local-session-repository';
	import {
		RealtimeTranslationClient,
		realtimeErrorMessage,
		type RealtimeTranslationClientOptions,
		type TranslationClient
	} from '$lib/realtime/client';
	import {
		REALTIME_TRANSLATION_PRICING,
		estimateRealtimeUsage,
		formatEstimatedCostUsd
	} from '$lib/realtime/usage-estimate';
	import { ScreenWakeLock } from '$lib/screen-wake-lock';
	import SidecarPanel from '$lib/sidecar/SidecarPanel.svelte';
	import SessionSidebar from '$lib/session/SessionSidebar.svelte';
	import {
		CAPTURE_RUN_DURATION_LIMIT_MS,
		CAPTURE_RUN_DURATION_WARNING_MS,
		captureRunRemainingMs,
		formatRemainingDuration
	} from '$lib/session/capture-run-limit';
	import {
		activeCaptureRun,
		appendRealtimeTranscriptEvent,
		beginCaptureRun,
		createTranslationSession,
		currentCaptureRun,
		endActiveCaptureRun,
		markActiveRunConnected,
		markActiveRunHidden,
		markActiveRunStopping,
		markActiveRunVisible,
		type TranslationSessionState
	} from '$lib/session/translation-session';
	import { visibleTranscriptRuns, type VisibleTranscriptRun } from '$lib/session/transcript-view';
	import type { CaptureRun, TranslationThread } from '$lib/session/types';
	import type { AudioFileStreamSource } from '$lib/testing/audio-file-source';
	import type {
		AudioTestOutcome,
		AudioTestReport,
		AudioTestStatusChange
	} from '$lib/testing/audio-test-report';
	import {
		DEFAULT_REALTIME_NOISE_REDUCTION_MODE,
		DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
		REALTIME_NOISE_REDUCTION_MODES,
		REALTIME_TRANSCRIPTION_MODELS,
		TARGET_LANGUAGES,
		isTargetLanguage,
		type ConnectionStatus,
		type RealtimeNoiseReductionMode,
		type RealtimeTranscriptionModel,
		type TargetLanguage,
		type TranslationServerEvent
	} from '$lib/realtime/types';

	type TranscriptTimingSample = {
		stream: 'source' | 'translation';
		receivedAfterStartMs: number;
		elapsedMs: number | null;
		delta: string;
	};
	type ActiveAudioTest = {
		attemptStartedAt: string;
		mediaStartedAt: string | null;
		targetLanguage: string;
		fileSizeBytes: number;
		fileMimeType: string | null;
		fileDurationMs: number | null;
		runSequence: number;
		statusChanges: AudioTestStatusChange[];
		hiddenDurationsMs: number[];
		errors: string[];
	};
	type CheckpointSnapshot = {
		thread: TranslationThread;
		run: CaptureRun;
	};
	type PersistencePhase = 'restoring' | 'ready' | 'unavailable';
	type OfficialUsagePhase = 'loading' | 'ready' | 'unavailable';
	type OfficialUsageWindow = {
		days: 1 | 7 | 30;
		durationSeconds: number;
		costUsd: number;
		accountCostUsd: number;
		breakdown: OfficialCostBreakdown;
	};
	type OfficialCostBreakdown = {
		translationUsd: number;
		transcriptionUsd: number;
		sidecarUsd: number;
		otherUsd: number;
	};
	type OfficialUsagePeriod = {
		periodStart: string;
		durationSeconds: number;
		costUsd: number;
		accountCostUsd: number;
		breakdown: OfficialCostBreakdown;
	};
	type OfficialUsageSummary = {
		periodStart: string;
		periodEnd: string;
		windows: OfficialUsageWindow[];
		monthToDate: OfficialUsagePeriod;
		costMeter: {
			periodStart: string;
			accountCostUsd: number;
		};
		hardSpendLimit:
			| { status: 'not-configured' | 'unavailable' }
			| {
					status: 'configured';
					thresholdUsd: number;
					remainingUsd: number;
					enforcementStatus: string;
			  };
		updatedAt: string;
	};
	type DiagnosticEvent = {
		receivedAfterStartMs: number;
		event: TranslationServerEvent;
	};
	type DiagnosticStatus = {
		receivedAfterStartMs: number;
		status: ConnectionStatus;
	};
	type DiagnosticMediaEvent = {
		receivedAfterStartMs: number;
		type: 'initial' | 'mute' | 'unmute' | 'ended';
		enabled: boolean;
		muted: boolean;
		readyState: MediaStreamTrackState;
	};

	const STATUS_LABELS: Record<ConnectionStatus, string> = {
		idle: '待机',
		'requesting-microphone': '请求麦克风',
		'requesting-token': '创建会话',
		connecting: '正在连接',
		connected: '实时翻译中',
		'connection-degraded': '等待连接恢复',
		stopping: '正在停止',
		failed: '连接异常'
	};
	const RESTORE_TIMEOUT_MS = 5_000;
	const DIAGNOSTIC_EVENT_LIMIT = 500;
	const CAPTION_FONT_SIZE_STORAGE_KEY = 'voxbraid-caption-font-size';
	const DIAGNOSTICS_MODE_STORAGE_KEY = 'voxbraid-diagnostics-mode';
	const CREDIT_BALANCE_STORAGE_KEY = 'voxbraid-openai-credit-balance-anchor';
	const DEFAULT_CAPTION_FONT_SIZE_PX = 22;
	const MIN_CAPTION_FONT_SIZE_PX = 16;
	const MAX_CAPTION_FONT_SIZE_PX = 30;
	const RUN_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit'
	});
	const OFFICIAL_USAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit'
	});

	let status = $state<ConnectionStatus>('idle');
	let targetLanguage = $state<TargetLanguage>('zh');
	let transcriptionModel = $state<RealtimeTranscriptionModel>(DEFAULT_REALTIME_TRANSCRIPTION_MODEL);
	let noiseReduction = $state<RealtimeNoiseReductionMode>(DEFAULT_REALTIME_NOISE_REDUCTION_MODE);
	let session = $state<TranslationSessionState | null>(null);
	let error = $state('');
	let persistencePhase = $state<PersistencePhase>('restoring');
	let persistenceError = $state('');
	let backupMessage = $state('');
	let storageDurability = $state<StorageDurability | 'checking'>('checking');
	let threads = $state<TranslationThread[]>([]);
	let sessionSidebarOpen = $state(false);
	let sessionSwitching = $state(false);
	let usageNowMs = $state(Date.now());
	let officialUsage = $state<OfficialUsageSummary | null>(null);
	let officialUsagePhase = $state<OfficialUsagePhase>('loading');
	let officialUsageError = $state('');
	let officialUsageRequest = 0;
	let creditBalanceAnchor = $state<CreditBalanceAnchor | null>(null);
	let creditBalanceInput = $state('');
	let creditBalanceMessage = $state('');
	let captionFontSizePx = $state(DEFAULT_CAPTION_FONT_SIZE_PX);
	let diagnosticsMode = $state(false);
	let operationalLogs = $state<OperationalLogEntry[]>([]);
	let captureRunDurationLimitMs = $state(CAPTURE_RUN_DURATION_LIMIT_MS);
	let durationLimitNotice = $state('');
	let client: TranslationClient | null = null;
	let clientReady = $state(false);
	let repository = $state.raw<LocalSessionRepository | null>(null);
	let checkpointWriter: CheckpointWriter<CheckpointSnapshot> | null = null;
	let AudioTestPanel = $state<typeof import('$lib/testing/AudioTestPanel.svelte').default | null>(
		null
	);
	let audioFileSource: AudioFileStreamSource | null = null;
	let buildAudioTestReport:
		typeof import('$lib/testing/audio-test-report').createAudioTestReport | null = null;
	let audioTestEnabled = $state(false);
	let audioTestFile = $state<File | null>(null);
	let lastAudioTestReport = $state<AudioTestReport | null>(null);
	let activeAudioTest: ActiveAudioTest | null = null;
	let stopPromise: Promise<void> | null = null;
	let timingProbeEnabled = false;
	let timingProbeStartedAt: number | null = null;
	let timingProbeSamples: TranscriptTimingSample[] = [];
	let sourceScroller: HTMLDivElement | null = null;
	let translationScroller: HTMLDivElement | null = null;
	let sessionMenuButton: HTMLButtonElement | null = null;
	let backupInput = $state<HTMLInputElement | null>(null);
	let sourceFollowsTail = true;
	let translationFollowsTail = true;
	let followFrame: number | null = null;
	let diagnosticStartedAt = performance.now();
	let diagnosticStartedAtIso = nowIso();
	let diagnosticThreadId: string | null = null;
	let diagnosticRunId: string | null = null;
	let diagnosticRequestedTranscriptionModel: RealtimeTranscriptionModel =
		DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
	let diagnosticRequestedNoiseReduction: RealtimeNoiseReductionMode =
		DEFAULT_REALTIME_NOISE_REDUCTION_MODE;
	let diagnosticEvents: DiagnosticEvent[] = [];
	let diagnosticStatuses: DiagnosticStatus[] = [];
	let diagnosticMediaTrack: Record<string, unknown> | null = null;
	let diagnosticMediaEvents: DiagnosticMediaEvent[] = [];
	let diagnosticDroppedEvents = $state(0);
	let diagnosticOmittedAudioEvents = $state(0);
	let diagnosticSourceDeltas = $state(0);
	let diagnosticSourceCharacters = $state(0);
	let diagnosticSourceElapsedMs = $state<number | null>(null);
	let diagnosticTranslationDeltas = $state(0);
	let diagnosticTranslationCharacters = $state(0);
	let diagnosticTranslationElapsedMs = $state<number | null>(null);
	let diagnosticErrors = $state(0);
	let diagnosticReportText = $state('开始一次收音后，这里会生成当前 Run 的原始诊断报告。');
	let durationLimitStopRequested = false;
	const wakeLock = new ScreenWakeLock();

	async function clearOperationalLogs(): Promise<void> {
		try {
			await repository?.clearOperationalLogs();
			operationalLogs = [];
		} catch (clearError) {
			console.error('[operational-log] clear failed', clearError);
		}
	}

	const active = $derived(status !== 'idle' && status !== 'failed' && status !== 'stopping');
	const sessionActionsDisabled = $derived(
		active || status === 'stopping' || persistencePhase === 'restoring' || sessionSwitching
	);
	const statusLabel = $derived(
		persistencePhase === 'restoring' && status === 'idle'
			? '恢复记录'
			: import.meta.env.DEV && audioTestEnabled && status === 'requesting-microphone'
				? '准备录音'
				: STATUS_LABELS[status]
	);
	const sourceTranscriptRuns = $derived(
		session ? visibleTranscriptRuns(session.runs, 'source') : []
	);
	const translatedTranscriptRuns = $derived(
		session ? visibleTranscriptRuns(session.runs, 'translation') : []
	);
	const usageEstimate = $derived(estimateRealtimeUsage(session?.runs ?? [], usageNowMs));
	const estimatedCostLabel = $derived(formatEstimatedCostUsd(usageEstimate.estimatedCostUsd));
	const activeRunRemainingMs = $derived(
		captureRunRemainingMs(
			session ? (activeCaptureRun(session)?.mediaStartedAt ?? null) : null,
			usageNowMs,
			captureRunDurationLimitMs
		)
	);
	const activeRunRemainingLabel = $derived(
		activeRunRemainingMs === null ? '' : formatRemainingDuration(activeRunRemainingMs)
	);
	const officialUpdatedLabel = $derived(
		officialUsage ? OFFICIAL_USAGE_TIME_FORMATTER.format(new Date(officialUsage.updatedAt)) : ''
	);
	const sevenDayOfficialUsage = $derived(
		officialUsage?.windows.find((window) => window.days === 7) ?? null
	);
	const creditBalanceEstimate = $derived(
		estimateCreditBalance(creditBalanceAnchor, officialUsage?.costMeter ?? null)
	);
	const creditBalanceHours = $derived(
		creditBalanceEstimate && sevenDayOfficialUsage
			? estimateRemainingAudioHours(
					Math.max(0, creditBalanceEstimate.balanceUsd),
					sevenDayOfficialUsage.costUsd,
					sevenDayOfficialUsage.durationSeconds
				)
			: null
	);

	function nowIso(): string {
		return new Date().toISOString();
	}

	function normalizedCaptionFontSize(value: number): number {
		if (!Number.isFinite(value)) return DEFAULT_CAPTION_FONT_SIZE_PX;
		return Math.min(MAX_CAPTION_FONT_SIZE_PX, Math.max(MIN_CAPTION_FONT_SIZE_PX, value));
	}

	function formatUsd(value: number): string {
		const sign = value < 0 ? '−' : '';
		return `${sign}$${formatEstimatedCostUsd(Math.abs(value))}`;
	}

	function formatAudioHours(value: number): string {
		if (value < 1) return `约 ${Math.round(value * 60)} 分钟`;
		if (value < 10) return `约 ${value.toFixed(1)} 小时`;
		return `约 ${Math.round(value)} 小时`;
	}

	function calibrateCreditBalance(event: SubmitEvent): void {
		event.preventDefault();
		if (!officialUsage) return;
		const balanceUsd = Number(creditBalanceInput);
		if (!Number.isFinite(balanceUsd) || balanceUsd < 0) {
			creditBalanceMessage = '请输入有效的非负美元余额。';
			return;
		}
		const anchor = createCreditBalanceAnchor(balanceUsd, officialUsage.costMeter);
		creditBalanceAnchor = anchor;
		creditBalanceInput = '';
		creditBalanceMessage = '已用当前官方成本读数校准；自动充值后请重新校准。';
		try {
			localStorage.setItem(CREDIT_BALANCE_STORAGE_KEY, JSON.stringify(anchor));
		} catch (storageError) {
			creditBalanceMessage = `余额校准仅在当前页面有效；本机保存失败。\n${inlineErrorDetails(storageError)}`;
		}
	}

	function clearCreditBalanceCalibration(): void {
		creditBalanceAnchor = null;
		creditBalanceInput = '';
		creditBalanceMessage = '已清除本机余额校准。';
		try {
			localStorage.removeItem(CREDIT_BALANCE_STORAGE_KEY);
		} catch (storageError) {
			creditBalanceMessage = `本机余额校准未能清除。\n${inlineErrorDetails(storageError)}`;
		}
	}

	function updateCaptionFontSize(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		captionFontSizePx = normalizedCaptionFontSize(Number(input.value));
		try {
			localStorage.setItem(CAPTION_FONT_SIZE_STORAGE_KEY, String(captionFontSizePx));
		} catch (storageError) {
			console.warn('[caption-font-size] preference could not be saved', storageError);
		}
	}

	function updateDiagnosticsMode(enabled: boolean): void {
		diagnosticsMode = enabled;
		try {
			localStorage.setItem(DIAGNOSTICS_MODE_STORAGE_KEY, String(enabled));
		} catch (storageError) {
			console.warn('[diagnostics-mode] preference could not be saved', storageError);
		}
	}

	function resetRealtimeDiagnostics(): void {
		diagnosticStartedAt = performance.now();
		diagnosticStartedAtIso = nowIso();
		diagnosticRequestedTranscriptionModel = transcriptionModel;
		diagnosticRequestedNoiseReduction = noiseReduction;
		diagnosticThreadId = null;
		diagnosticRunId = null;
		diagnosticEvents = [];
		diagnosticStatuses = [];
		diagnosticMediaTrack = null;
		diagnosticMediaEvents = [];
		diagnosticDroppedEvents = 0;
		diagnosticOmittedAudioEvents = 0;
		diagnosticSourceDeltas = 0;
		diagnosticSourceCharacters = 0;
		diagnosticSourceElapsedMs = null;
		diagnosticTranslationDeltas = 0;
		diagnosticTranslationCharacters = 0;
		diagnosticTranslationElapsedMs = null;
		diagnosticErrors = 0;
		diagnosticReportText = '当前 Run 正在采集原始事件；停止后会自动刷新报告。';
	}

	function diagnosticOffsetMs(): number {
		return Math.max(0, Math.round(performance.now() - diagnosticStartedAt));
	}

	function recordDiagnosticStatus(nextStatus: ConnectionStatus): void {
		diagnosticStatuses.push({ receivedAfterStartMs: diagnosticOffsetMs(), status: nextStatus });
	}

	function recordDiagnosticEvent(event: TranslationServerEvent): void {
		if (event.type === 'session.output_audio.delta') {
			diagnosticOmittedAudioEvents += 1;
			return;
		}

		if (diagnosticEvents.length < DIAGNOSTIC_EVENT_LIMIT) {
			diagnosticEvents.push({
				receivedAfterStartMs: diagnosticOffsetMs(),
				event: structuredClone(event)
			});
		} else {
			diagnosticDroppedEvents += 1;
		}

		if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
			diagnosticSourceDeltas += 1;
			diagnosticSourceCharacters += event.delta.length;
			diagnosticSourceElapsedMs =
				typeof event.elapsed_ms === 'number' ? event.elapsed_ms : diagnosticSourceElapsedMs;
		}
		if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
			diagnosticTranslationDeltas += 1;
			diagnosticTranslationCharacters += event.delta.length;
			diagnosticTranslationElapsedMs =
				typeof event.elapsed_ms === 'number' ? event.elapsed_ms : diagnosticTranslationElapsedMs;
		}
		if (event.type === 'error') diagnosticErrors += 1;
	}

	function recordDiagnosticMedia(stream: MediaStream): void {
		const track = stream.getAudioTracks()[0];
		if (!track) {
			diagnosticMediaTrack = { missing: true };
			return;
		}
		diagnosticMediaTrack = {
			label: track.label,
			enabled: track.enabled,
			muted: track.muted,
			readyState: track.readyState,
			settings: track.getSettings(),
			constraints: track.getConstraints()
		};
		const recordTrackEvent = (type: DiagnosticMediaEvent['type']): void => {
			diagnosticMediaEvents.push({
				receivedAfterStartMs: diagnosticOffsetMs(),
				type,
				enabled: track.enabled,
				muted: track.muted,
				readyState: track.readyState
			});
		};
		recordTrackEvent('initial');
		track.addEventListener('mute', () => recordTrackEvent('mute'));
		track.addEventListener('unmute', () => recordTrackEvent('unmute'));
		track.addEventListener('ended', () => recordTrackEvent('ended'));
	}

	function refreshDiagnosticReport(): void {
		diagnosticReportText = JSON.stringify(
			{
				version: 1,
				startedAt: diagnosticStartedAtIso,
				generatedAt: nowIso(),
				threadId: diagnosticThreadId,
				runId: diagnosticRunId,
				requestedTranscriptionModel: diagnosticRequestedTranscriptionModel,
				requestedNoiseReduction: diagnosticRequestedNoiseReduction,
				build: __VOXBRAID_BUILD_INFO__,
				userAgent: navigator.userAgent,
				mediaTrack: diagnosticMediaTrack,
				mediaEvents: diagnosticMediaEvents,
				summary: {
					source: {
						deltas: diagnosticSourceDeltas,
						characters: diagnosticSourceCharacters,
						lastElapsedMs: diagnosticSourceElapsedMs
					},
					translation: {
						deltas: diagnosticTranslationDeltas,
						characters: diagnosticTranslationCharacters,
						lastElapsedMs: diagnosticTranslationElapsedMs
					},
					errors: diagnosticErrors,
					omittedOutputAudioEvents: diagnosticOmittedAudioEvents,
					droppedEventsAfterLimit: diagnosticDroppedEvents
				},
				statuses: diagnosticStatuses,
				events: diagnosticEvents
			},
			null,
			2
		);
	}

	async function copyDiagnosticReport(): Promise<void> {
		refreshDiagnosticReport();
		try {
			await navigator.clipboard.writeText(diagnosticReportText);
			backupMessage = 'Realtime 原始诊断报告已复制。';
		} catch (copyError) {
			console.error('[realtime-diagnostics] copy failed', copyError);
			backupMessage = `复制失败；请展开报告后手动选择文本。\n${inlineErrorDetails(copyError)}`;
		}
	}

	function runTime(run: VisibleTranscriptRun): string {
		return RUN_TIME_FORMATTER.format(new Date(run.startedAt));
	}

	function languageLabel(code: string): string {
		return TARGET_LANGUAGES.find((language) => language.code === code)?.label ?? code;
	}

	function isNonNegativeNumber(value: unknown): value is number {
		return typeof value === 'number' && Number.isFinite(value) && value >= 0;
	}

	function isOfficialCostBreakdown(value: unknown): value is OfficialCostBreakdown {
		return (
			typeof value === 'object' &&
			value !== null &&
			'translationUsd' in value &&
			isNonNegativeNumber(value.translationUsd) &&
			'transcriptionUsd' in value &&
			isNonNegativeNumber(value.transcriptionUsd) &&
			'sidecarUsd' in value &&
			isNonNegativeNumber(value.sidecarUsd) &&
			'otherUsd' in value &&
			isNonNegativeNumber(value.otherUsd)
		);
	}

	function isOfficialUsagePeriod(value: unknown): value is OfficialUsagePeriod {
		return (
			typeof value === 'object' &&
			value !== null &&
			'periodStart' in value &&
			typeof value.periodStart === 'string' &&
			'durationSeconds' in value &&
			isNonNegativeNumber(value.durationSeconds) &&
			'costUsd' in value &&
			isNonNegativeNumber(value.costUsd) &&
			'accountCostUsd' in value &&
			isNonNegativeNumber(value.accountCostUsd) &&
			'breakdown' in value &&
			isOfficialCostBreakdown(value.breakdown)
		);
	}

	function isOfficialUsageSummary(value: unknown): value is OfficialUsageSummary {
		const validWindows =
			typeof value === 'object' &&
			value !== null &&
			'windows' in value &&
			Array.isArray(value.windows)
				? value.windows.filter(
						(window): window is OfficialUsageWindow =>
							typeof window === 'object' &&
							window !== null &&
							'days' in window &&
							(window.days === 1 || window.days === 7 || window.days === 30) &&
							'durationSeconds' in window &&
							isNonNegativeNumber(window.durationSeconds) &&
							'costUsd' in window &&
							isNonNegativeNumber(window.costUsd) &&
							'accountCostUsd' in window &&
							isNonNegativeNumber(window.accountCostUsd) &&
							'breakdown' in window &&
							isOfficialCostBreakdown(window.breakdown)
					)
				: [];
		const validHardLimit =
			typeof value === 'object' &&
			value !== null &&
			'hardSpendLimit' in value &&
			typeof value.hardSpendLimit === 'object' &&
			value.hardSpendLimit !== null &&
			'status' in value.hardSpendLimit &&
			(value.hardSpendLimit.status === 'not-configured' ||
				value.hardSpendLimit.status === 'unavailable' ||
				(value.hardSpendLimit.status === 'configured' &&
					'thresholdUsd' in value.hardSpendLimit &&
					isNonNegativeNumber(value.hardSpendLimit.thresholdUsd) &&
					'remainingUsd' in value.hardSpendLimit &&
					typeof value.hardSpendLimit.remainingUsd === 'number' &&
					Number.isFinite(value.hardSpendLimit.remainingUsd) &&
					'enforcementStatus' in value.hardSpendLimit &&
					typeof value.hardSpendLimit.enforcementStatus === 'string'));
		return (
			typeof value === 'object' &&
			value !== null &&
			'periodStart' in value &&
			typeof value.periodStart === 'string' &&
			'periodEnd' in value &&
			typeof value.periodEnd === 'string' &&
			validWindows.length === 3 &&
			new Set(validWindows.map((window) => window.days)).size === 3 &&
			'monthToDate' in value &&
			isOfficialUsagePeriod(value.monthToDate) &&
			'costMeter' in value &&
			typeof value.costMeter === 'object' &&
			value.costMeter !== null &&
			'periodStart' in value.costMeter &&
			typeof value.costMeter.periodStart === 'string' &&
			'accountCostUsd' in value.costMeter &&
			isNonNegativeNumber(value.costMeter.accountCostUsd) &&
			validHardLimit &&
			'updatedAt' in value &&
			typeof value.updatedAt === 'string'
		);
	}

	async function refreshOfficialUsage(force = false): Promise<void> {
		const request = ++officialUsageRequest;
		officialUsagePhase = 'loading';
		try {
			const response = await fetch(`/api/openai/usage-summary${force ? '?refresh=1' : ''}`, {
				cache: 'no-store'
			});
			const rawBody = await response.text();
			let body: unknown = null;
			try {
				body = JSON.parse(rawBody);
			} catch (parseError) {
				throw new Error(
					`OpenAI 账目端点返回了非 JSON 响应（HTTP ${response.status}）。\n原始错误：\n${errorDetails(parseError)}\n原始响应：\n${rawBody.slice(0, 4_096)}`,
					{ cause: parseError }
				);
			}
			if (!response.ok || !isOfficialUsageSummary(body)) {
				const message =
					typeof body === 'object' &&
					body !== null &&
					'message' in body &&
					typeof body.message === 'string'
						? body.message
						: `OpenAI 账目响应未通过客户端校验。\n原始响应：\n${rawBody.slice(0, 4_096)}`;
				throw new Error(`OpenAI 账目请求失败（HTTP ${response.status}）。\n${message}`);
			}
			if (request !== officialUsageRequest) return;
			officialUsage = body;
			officialUsagePhase = 'ready';
			officialUsageError = '';
			resolveOperationalIssue('official-usage');
		} catch (usageError) {
			if (request !== officialUsageRequest) return;
			officialUsagePhase = 'unavailable';
			officialUsageError = errorDetails(usageError);
			emitOperationalLog({
				severity: 'warning',
				source: 'billing',
				code: 'official-usage-unavailable',
				summary: `OpenAI 账目查询失败：${inlineErrorDetails(usageError).slice(0, 180)}`,
				details: officialUsageError,
				dedupeKey: 'official-usage'
			});
		}
	}

	function applyStoredThread(stored: StoredThread): void {
		session = {
			thread: stored.thread,
			runs: stored.runs,
			activeRunId: null,
			diagnostics: { deltasAfterClose: 0 }
		};
		const restoredLanguage =
			stored.runs.at(-1)?.targetLanguage ?? stored.thread.defaultTargetLanguage;
		if (isTargetLanguage(restoredLanguage)) targetLanguage = restoredLanguage;
	}

	async function refreshThreadList(): Promise<void> {
		if (!repository) return;
		try {
			threads = await repository.listThreads();
		} catch (listError) {
			console.error('[persistence] thread list failed', listError);
			persistenceError = `会话列表刷新失败，请稍后重试。\n${inlineErrorDetails(listError)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'thread-list-failed',
				summary: '会话列表刷新失败。',
				details: inlineErrorDetails(listError),
				threadId: session?.thread.id ?? null
			});
		}
	}

	function markCheckpointDirty(): void {
		if (!session || !checkpointWriter) return;
		const run = currentCaptureRun(session);
		if (!run) return;
		checkpointWriter.markDirty({
			thread: $state.snapshot(session.thread),
			run: $state.snapshot(run)
		});
	}

	async function flushCheckpoint(): Promise<boolean> {
		if (!checkpointWriter) return false;
		try {
			await checkpointWriter.flush();
			persistenceError = '';
			resolveOperationalIssue('storage-checkpoint');
			return true;
		} catch (saveError) {
			console.error('[persistence] checkpoint failed', saveError);
			persistenceError = `字幕仍保留在当前页面中，系统会继续尝试保存。\n${inlineErrorDetails(saveError)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'checkpoint-failed',
				summary: '本地字幕保存失败；当前页面中的内容仍保留。',
				details: inlineErrorDetails(saveError),
				threadId: session?.thread.id ?? null,
				dedupeKey: 'storage-checkpoint'
			});
			return false;
		}
	}

	async function downloadSessionArchive(): Promise<void> {
		if (!repository || !session) return;
		markCheckpointDirty();
		if (!(await flushCheckpoint())) return;

		try {
			const exportedAt = nowIso();
			const json = await repository.exportThread(session.thread.id, exportedAt);
			const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = `voxbraid-session-${exportedAt.replaceAll(':', '-')}.json`;
			document.body.append(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 0);
			backupMessage = '当前会话已导出。';
		} catch (exportError) {
			console.error('[persistence] export failed', exportError);
			persistenceError = `会话导出失败，请稍后重试。\n${inlineErrorDetails(exportError)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'export-failed',
				summary: '会话导出失败。',
				details: inlineErrorDetails(exportError),
				threadId: session?.thread.id ?? null
			});
		}
	}

	async function downloadEvaluationBundle(): Promise<void> {
		if (!repository || !session) return;
		markCheckpointDirty();
		if (!(await flushCheckpoint())) return;

		try {
			const exportedAt = nowIso();
			refreshDiagnosticReport();
			const json = await repository.exportEvaluationBundle(session.thread.id, {
				exportedAt,
				build: __VOXBRAID_BUILD_INFO__,
				captureSettings: {
					scope: 'export-time-ui',
					transcriptionModel,
					noiseReduction,
					targetLanguage
				},
				realtimeDiagnostic:
					diagnosticThreadId === session.thread.id
						? (JSON.parse(diagnosticReportText) as unknown)
						: null,
				officialUsageSnapshot: officialUsage
			});
			const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = `voxbraid-evaluation-${exportedAt.replaceAll(':', '-')}.json`;
			document.body.append(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 0);
			backupMessage = '当前会话评估数据已导出。';
		} catch (exportError) {
			console.error('[persistence] evaluation export failed', exportError);
			persistenceError = `评估数据导出失败，请稍后重试。\n${inlineErrorDetails(exportError)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'evaluation-export-failed',
				summary: '评估数据导出失败。',
				details: inlineErrorDetails(exportError),
				threadId: session?.thread.id ?? null
			});
		}
	}

	async function importSessionArchive(file: File): Promise<void> {
		if (!repository || sessionActionsDisabled) return;
		sessionSwitching = true;
		backupMessage = '';
		try {
			if (checkpointWriter && session) {
				markCheckpointDirty();
				if (!(await flushCheckpoint())) return;
			}
			const imported = await repository.importThread(await file.text(), nowIso());
			await repository.repairAbandonedRuns(imported.threadId, nowIso());
			const stored = await repository.loadThread(imported.threadId);
			if (!stored) throw new Error(`Imported thread not found: ${imported.threadId}.`);
			applyStoredThread(stored);
			await refreshThreadList();
			persistenceError = '';
			backupMessage = ['会话已恢复。重复导入同一文件不会创建副本。', ...imported.warnings].join(
				'\n'
			);
		} catch (importError) {
			console.error('[persistence] import failed', importError);
			persistenceError = `会话文件无效或恢复失败，本地原有会话未被清除。\n${inlineErrorDetails(importError)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'import-failed',
				summary: '会话文件无效或恢复失败。',
				details: inlineErrorDetails(importError)
			});
		} finally {
			sessionSwitching = false;
			if (backupInput) backupInput.value = '';
		}
	}

	function handleBackupFile(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		const [file] = input.files ?? [];
		if (file) void importSessionArchive(file);
	}

	async function startNewThread(): Promise<void> {
		if (sessionActionsDisabled) return;
		sessionSwitching = true;
		try {
			if (checkpointWriter && session) {
				markCheckpointDirty();
				if (!(await flushCheckpoint())) return;
			}
			session = null;
			error = '';
			closeSessionSidebar();
		} finally {
			sessionSwitching = false;
		}
	}

	async function selectThread(threadId: string): Promise<void> {
		if (sessionActionsDisabled || !repository) return;
		if (session?.thread.id === threadId) {
			closeSessionSidebar();
			return;
		}

		sessionSwitching = true;
		try {
			if (checkpointWriter && session) {
				markCheckpointDirty();
				if (!(await flushCheckpoint())) return;
			}
			await repository.repairAbandonedRuns(threadId, nowIso());
			const stored = await repository.loadThread(threadId);
			if (!stored) throw new Error(`Thread not found: ${threadId}`);
			applyStoredThread(stored);
			error = '';
			persistenceError = '';
			closeSessionSidebar();
			await refreshThreadList();
		} catch (switchError) {
			console.error('[persistence] thread switch failed', switchError);
			persistenceError = `会话切换失败，请稍后重试。\n${inlineErrorDetails(switchError)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'thread-switch-failed',
				summary: '会话切换失败。',
				details: inlineErrorDetails(switchError),
				threadId
			});
		} finally {
			sessionSwitching = false;
		}
	}

	function closeSessionSidebar(): void {
		sessionSidebarOpen = false;
		requestAnimationFrame(() => {
			if (sessionMenuButton?.offsetParent !== null) sessionMenuButton?.focus();
		});
	}

	function isNearTail(element: HTMLDivElement): boolean {
		return element.scrollHeight - element.scrollTop - element.clientHeight < 64;
	}

	function updateSourceFollow(): void {
		if (sourceScroller) sourceFollowsTail = isNearTail(sourceScroller);
	}

	function updateTranslationFollow(): void {
		if (translationScroller) translationFollowsTail = isNearTail(translationScroller);
	}

	function followTranscriptTails(): void {
		if (followFrame !== null) return;
		followFrame = requestAnimationFrame(() => {
			followFrame = null;
			if (sourceScroller && sourceFollowsTail)
				sourceScroller.scrollTop = sourceScroller.scrollHeight;
			if (translationScroller && translationFollowsTail) {
				translationScroller.scrollTop = translationScroller.scrollHeight;
			}
		});
	}

	function finishAudioTest(outcome: AudioTestOutcome): void {
		const test = activeAudioTest;
		if (!test || !session || !buildAudioTestReport) return;

		lastAudioTestReport = buildAudioTestReport({
			session,
			outcome,
			attemptStartedAt: test.attemptStartedAt,
			mediaStartedAt: test.mediaStartedAt,
			finishedAt: nowIso(),
			targetLanguage: test.targetLanguage,
			fileSizeBytes: test.fileSizeBytes,
			fileMimeType: test.fileMimeType,
			fileDurationMs: test.fileDurationMs,
			runSequence: test.runSequence,
			statusChanges: test.statusChanges,
			hiddenDurationsMs: test.hiddenDurationsMs,
			errors: test.errors,
			userAgent: navigator.userAgent
		});
		activeAudioTest = null;
	}

	function downloadAudioTestReport(): void {
		if (!lastAudioTestReport) return;
		const url = URL.createObjectURL(
			new Blob([JSON.stringify(lastAudioTestReport, null, 2)], { type: 'application/json' })
		);
		const link = document.createElement('a');
		link.href = url;
		link.download = `voxbraid-audio-test-${lastAudioTestReport.result.finishedAt.replaceAll(':', '-')}.json`;
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	function endFailedRun(message: string): void {
		if (!session) return;
		const run = activeCaptureRun(session);
		if (!run) return;

		const connected = run.mediaStartedAt !== null;
		session = endActiveCaptureRun(session, {
			outcome: connected ? 'interrupted' : 'failed',
			reason: connected ? 'connection-lost' : 'startup-failed',
			error: {
				code: connected ? 'connection-lost' : 'startup-failed',
				message
			},
			at: nowIso()
		});
		markCheckpointDirty();
		void flushCheckpoint().then((saved) => {
			if (saved) void refreshThreadList();
		});
	}

	function recordTranscriptTiming(event: TranslationServerEvent): void {
		if (
			!timingProbeEnabled ||
			timingProbeStartedAt === null ||
			(event.type !== 'session.input_transcript.delta' &&
				event.type !== 'session.output_transcript.delta') ||
			typeof event.delta !== 'string'
		) {
			return;
		}

		timingProbeSamples.push({
			stream: event.type === 'session.input_transcript.delta' ? 'source' : 'translation',
			receivedAfterStartMs: Math.round(performance.now() - timingProbeStartedAt),
			elapsedMs: typeof event.elapsed_ms === 'number' ? event.elapsed_ms : null,
			delta: event.delta
		});
	}

	function publishTranscriptTiming(): void {
		if (!timingProbeEnabled || timingProbeSamples.length === 0) return;

		const samples = structuredClone(timingProbeSamples);
		(
			window as Window & { __voxbraidTranscriptTiming?: TranscriptTimingSample[] }
		).__voxbraidTranscriptTiming = samples;
		console.table(samples);
		console.info(
			'[transcript-timing-probe] 已保存到 window.__voxbraidTranscriptTiming；请复制该变量的值。'
		);
	}

	onMount(() => {
		let disposed = false;
		let restoreAllowed = true;
		let restoreTimer: number | null = null;
		let checkpointTimer: number | null = null;
		const handleOperationalLog = (event: Event) => {
			const detail = (event as CustomEvent<OperationalLogEventDetail>).detail;
			const at = nowIso();
			if (detail.action === 'record') {
				operationalLogs = recordOperationalLog(operationalLogs, detail.input, {
					id: crypto.randomUUID(),
					now: at
				});
			} else {
				operationalLogs = resolveOperationalLog(
					operationalLogs,
					detail.dedupeKey,
					detail.state,
					at
				);
			}
			const changed =
				detail.action === 'record'
					? operationalLogs.find(
							(entry) =>
								entry.dedupeKey ===
								(detail.input.dedupeKey ?? defaultOperationalLogDedupeKey(detail.input))
						)
					: operationalLogs.find((entry) => entry.dedupeKey === detail.dedupeKey);
			if (changed && repository) {
				void repository
					.saveOperationalLog($state.snapshot(changed))
					.catch((saveError: unknown) =>
						console.error('[operational-log] persistence failed', saveError)
					);
			}
		};
		window.addEventListener(OPERATIONAL_LOG_EVENT, handleOperationalLog);
		try {
			const storedCaptionFontSize = localStorage.getItem(CAPTION_FONT_SIZE_STORAGE_KEY);
			if (storedCaptionFontSize !== null) {
				captionFontSizePx = normalizedCaptionFontSize(Number(storedCaptionFontSize));
			}
			diagnosticsMode = localStorage.getItem(DIAGNOSTICS_MODE_STORAGE_KEY) === 'true';
			const storedCreditBalance = localStorage.getItem(CREDIT_BALANCE_STORAGE_KEY);
			if (storedCreditBalance) {
				const parsed: unknown = JSON.parse(storedCreditBalance);
				if (isCreditBalanceAnchor(parsed)) creditBalanceAnchor = parsed;
			}
		} catch (storageError) {
			console.warn('[display-preferences] preferences could not be loaded', storageError);
		}
		const search = new URLSearchParams(location.search);
		if (import.meta.env.DEV) {
			const testDurationLimitMs = Number(search.get('capture-run-limit-ms'));
			if (Number.isFinite(testDurationLimitMs) && testDurationLimitMs > 0) {
				captureRunDurationLimitMs = testDurationLimitMs;
			}
		}
		const usageTimer = window.setInterval(() => {
			const activeRun = session ? activeCaptureRun(session) : null;
			if (activeRun?.mediaStartedAt) {
				usageNowMs = Date.now();
				const remainingMs = captureRunRemainingMs(
					activeRun.mediaStartedAt,
					usageNowMs,
					captureRunDurationLimitMs
				);
				if (remainingMs === 0 && !durationLimitStopRequested) {
					durationLimitStopRequested = true;
					void stop('duration-limit');
				}
			}
		}, 1_000);
		void refreshOfficialUsage();
		timingProbeEnabled = import.meta.env.DEV && search.get('timing-probe') === '1';
		if (import.meta.env.DEV && search.get('audio-test') === '1') {
			audioTestEnabled = true;
			void Promise.all([
				import('$lib/testing/AudioTestPanel.svelte'),
				import('$lib/testing/audio-file-source'),
				import('$lib/testing/audio-test-report')
			])
				.then(([panelModule, sourceModule, reportModule]) => {
					AudioTestPanel = panelModule.default;
					audioFileSource = new sourceModule.AudioFileStreamSource();
					buildAudioTestReport = reportModule.createAudioTestReport;
				})
				.catch((loadError: unknown) => {
					console.error('[audio-test] tools failed to load', loadError);
					error = `录音回放测试工具加载失败。\n${inlineErrorDetails(loadError)}`;
				});
		}
		const realtimeOptions: RealtimeTranslationClientOptions = {
			onStatus: (nextStatus) => {
				const at = nowIso();
				recordDiagnosticStatus(nextStatus);
				if (import.meta.env.DEV) {
					activeAudioTest?.statusChanges.push({ status: nextStatus, at });
				}
				status = nextStatus;
				if (session && nextStatus === 'connected') {
					session = markActiveRunConnected(session, at);
					markCheckpointDirty();
					void flushCheckpoint();
				}
				if (session && nextStatus === 'stopping') {
					session = markActiveRunStopping(session);
					markCheckpointDirty();
				}
				if (nextStatus === 'connected') {
					if (import.meta.env.DEV) {
						if (activeAudioTest) activeAudioTest.mediaStartedAt ??= at;
						audioFileSource?.play();
					}
					void wakeLock.acquire();
				}
				if (nextStatus === 'stopping' || nextStatus === 'idle' || nextStatus === 'failed') {
					void wakeLock.release();
				}
			},
			onEvent: (event) => {
				recordDiagnosticEvent(event);
				recordTranscriptTiming(event);
				if (!session) return;

				const previousDeltasAfterClose = session.diagnostics.deltasAfterClose;
				session = appendRealtimeTranscriptEvent(session, event, nowIso());
				markCheckpointDirty();
				followTranscriptTails();
				if (
					import.meta.env.DEV &&
					session.diagnostics.deltasAfterClose > previousDeltasAfterClose
				) {
					console.warn('[transcript-facts] received a transcript delta after run close');
				}
			},
			onError: (message) => {
				if (import.meta.env.DEV) activeAudioTest?.errors.push(message);
				error = message;
				emitOperationalLog({
					severity: 'warning',
					source: 'realtime',
					code: 'realtime-event-error',
					summary: 'Realtime 返回了错误事件。',
					details: message,
					threadId: session?.thread.id ?? null,
					runId: session ? (activeCaptureRun(session)?.id ?? null) : null
				});
			},
			onConnectionFailure: (message) => {
				if (import.meta.env.DEV) {
					activeAudioTest?.errors.push(message);
					audioFileSource?.stop();
				}
				error = message;
				endFailedRun(message);
				emitOperationalLog({
					severity: 'error',
					source: 'realtime',
					code: 'connection-failed',
					summary: '实时连接中断，本段收音已结束。',
					details: message,
					threadId: session?.thread.id ?? null
				});
				if (import.meta.env.DEV) finishAudioTest('connection-failed');
			}
		};
		if (import.meta.env.DEV && search.get('browser-test') === '1') {
			void import('$lib/testing/browser-test-client')
				.then(({ BrowserTestRealtimeClient }) => {
					if (disposed) return;
					client = new BrowserTestRealtimeClient(realtimeOptions);
					clientReady = true;
				})
				.catch((testClientError: unknown) => {
					console.error('[browser-test] client failed to load', testClientError);
					error = `浏览器测试客户端加载失败。\n${inlineErrorDetails(testClientError)}`;
				});
		} else {
			client = new RealtimeTranslationClient(realtimeOptions, {
				getUserMedia: async (constraints) => {
					if (!import.meta.env.DEV || !audioTestEnabled) {
						const stream = await navigator.mediaDevices.getUserMedia(constraints);
						recordDiagnosticMedia(stream);
						return stream;
					}
					const file = audioTestFile;
					const test = activeAudioTest;
					if (!file || !test || !audioFileSource) {
						throw new Error('请先选择本地录音文件。');
					}
					const playback = await audioFileSource.open(file, {
						onEnded: () => void stop('audio-ended')
					});
					test.fileDurationMs = playback.durationMs;
					recordDiagnosticMedia(playback.stream);
					return playback.stream;
				}
			});
			clientReady = true;
		}

		const restorePromise =
			import.meta.env.DEV && search.get('storage-test') === 'hang'
				? new Promise<void>(() => undefined)
				: Promise.all([
						import('$lib/persistence/local-session-repository'),
						import('$lib/persistence/local-session-database')
					]).then(async ([{ LocalSessionRepository }, { LOCAL_CHECKPOINT_INTERVAL_MS }]) => {
						const localRepository = new LocalSessionRepository();
						if (disposed || !restoreAllowed) {
							localRepository.close();
							return;
						}

						repository = localRepository;
						try {
							operationalLogs = await localRepository.loadOperationalLogs();
						} catch (logLoadError) {
							console.error('[operational-log] restore failed', logLoadError);
							operationalLogs = [];
						}
						checkpointWriter = new CheckpointWriter(async (snapshot) => {
							await localRepository.saveCheckpoint({ ...snapshot, checkpointedAt: nowIso() });
						});

						threads = await localRepository.listThreads();
						const [latestThread] = threads;
						if (disposed || !restoreAllowed) {
							localRepository.close();
							return;
						}
						if (latestThread) {
							await localRepository.repairAbandonedRuns(latestThread.id, nowIso());
							if (disposed || !restoreAllowed) {
								localRepository.close();
								return;
							}
							const stored = await localRepository.loadThread(latestThread.id);
							if (stored && !disposed && restoreAllowed) {
								applyStoredThread(stored);
								threads = await localRepository.listThreads();
							}
						}

						if (disposed || !restoreAllowed) {
							localRepository.close();
							return;
						}
						persistencePhase = 'ready';
						void requestStoragePersistence()
							.then((result) => {
								if (!disposed) storageDurability = result;
							})
							.catch((storageError: unknown) => {
								console.warn('[persistence] persistent storage request failed', storageError);
								emitOperationalLog({
									severity: 'warning',
									source: 'storage',
									code: 'persistent-storage-denied',
									summary: '浏览器未授予持久存储，记录仍会尽力保存在本设备。',
									details: inlineErrorDetails(storageError)
								});
								if (!disposed) storageDurability = 'best-effort';
							});
						checkpointTimer = window.setInterval(
							() => void flushCheckpoint(),
							LOCAL_CHECKPOINT_INTERVAL_MS
						);
					});
		const restoreDeadline = new Promise<never>((_, reject) => {
			restoreTimer = window.setTimeout(() => {
				restoreAllowed = false;
				reject(new Error(`Local session restore timed out after ${RESTORE_TIMEOUT_MS} ms.`));
			}, RESTORE_TIMEOUT_MS);
		});
		void Promise.race([restorePromise, restoreDeadline])
			.catch((restoreError: unknown) => {
				if (disposed) return;
				restoreAllowed = false;
				console.error('[persistence] restore failed', restoreError);
				repository?.close();
				repository = null;
				checkpointWriter = null;
				persistencePhase = 'unavailable';
				storageDurability = 'best-effort';
				persistenceError = `本地历史记录不可用；实时翻译仍可继续。\n${inlineErrorDetails(restoreError)}`;
				emitOperationalLog({
					severity: 'error',
					source: 'storage',
					code: 'restore-failed',
					summary: '本地历史记录恢复失败；实时翻译仍可继续。',
					details: inlineErrorDetails(restoreError)
				});
			})
			.finally(() => {
				if (restoreTimer !== null) clearTimeout(restoreTimer);
			});

		const handleVisibility = () => {
			if (document.visibilityState === 'hidden' && session) {
				session = markActiveRunHidden(session, nowIso());
				markCheckpointDirty();
				void flushCheckpoint();
			}
			if (document.visibilityState === 'visible') {
				const hiddenAt = session ? activeCaptureRun(session)?.hiddenAt : null;
				const hiddenDurationMs = hiddenAt ? Math.max(0, Date.now() - Date.parse(hiddenAt)) : null;
				if (import.meta.env.DEV && hiddenDurationMs !== null) {
					activeAudioTest?.hiddenDurationsMs.push(hiddenDurationMs);
				}
				if (hiddenAt && import.meta.env.DEV) {
					console.info(`[visibility] page was hidden for ${hiddenDurationMs} ms`);
				}
				if (session) session = markActiveRunVisible(session);
				markCheckpointDirty();
				if (status === 'connected') void wakeLock.acquire();
			}
		};
		const handlePageHide = () => {
			markCheckpointDirty();
			void flushCheckpoint();
		};
		document.addEventListener('visibilitychange', handleVisibility);
		window.addEventListener('pagehide', handlePageHide);

		return () => {
			disposed = true;
			officialUsageRequest += 1;
			restoreAllowed = false;
			document.removeEventListener('visibilitychange', handleVisibility);
			window.removeEventListener('pagehide', handlePageHide);
			window.removeEventListener(OPERATIONAL_LOG_EVENT, handleOperationalLog);
			if (checkpointTimer !== null) clearInterval(checkpointTimer);
			clearInterval(usageTimer);
			if (followFrame !== null) cancelAnimationFrame(followFrame);
			if (import.meta.env.DEV) audioFileSource?.stop();
			void client?.stop();
			void wakeLock.release();
			markCheckpointDirty();
			const finalCheckpoint = flushCheckpoint();
			void finalCheckpoint.finally(() => repository?.close());
		};
	});

	async function start(): Promise<void> {
		if (!client) return;
		if (import.meta.env.DEV && audioTestEnabled && !audioTestFile) {
			error = '请先选择本地录音文件。';
			return;
		}
		error = '';
		durationLimitNotice = '';
		durationLimitStopRequested = false;
		resetRealtimeDiagnostics();
		const at = nowIso();
		const baseSession =
			session ??
			createTranslationSession({
				threadId: crypto.randomUUID(),
				defaultTargetLanguage: targetLanguage,
				at
			});
		session = beginCaptureRun(baseSession, {
			runId: crypto.randomUUID(),
			targetLanguage,
			clientPlatform: navigator.userAgent,
			at
		});
		diagnosticThreadId = session.thread.id;
		diagnosticRunId = activeCaptureRun(session)?.id ?? null;
		markCheckpointDirty();
		await flushCheckpoint();
		await refreshThreadList();
		if (import.meta.env.DEV && audioTestEnabled && audioTestFile) {
			const run = activeCaptureRun(session);
			if (!run) throw new Error('Audio test run was not created.');
			lastAudioTestReport = null;
			activeAudioTest = {
				attemptStartedAt: at,
				mediaStartedAt: null,
				targetLanguage,
				fileSizeBytes: audioTestFile.size,
				fileMimeType: audioTestFile.type || null,
				fileDurationMs: null,
				runSequence: run.sequence,
				statusChanges: [],
				hiddenDurationsMs: [],
				errors: []
			};
		}
		if (timingProbeEnabled) {
			timingProbeSamples = [];
			timingProbeStartedAt = performance.now();
		}
		try {
			await client.start(targetLanguage, transcriptionModel, noiseReduction);
		} catch (startError) {
			console.error('[realtime-client] start failed', startError);
			const message = realtimeErrorMessage(startError);
			if (import.meta.env.DEV) {
				activeAudioTest?.errors.push(message);
				audioFileSource?.stop();
			}
			error = message;
			emitOperationalLog({
				severity: 'error',
				source: 'realtime',
				code: 'start-failed',
				summary: '实时翻译启动失败。',
				details: message,
				threadId: session?.thread.id ?? null,
				runId: session ? (activeCaptureRun(session)?.id ?? null) : null
			});
			endFailedRun(message);
			if (import.meta.env.DEV) finishAudioTest('startup-failed');
		}
	}

	function stop(outcome: AudioTestOutcome = 'user-stopped'): Promise<void> {
		if (stopPromise) return stopPromise;
		const promise = performStop(outcome);
		stopPromise = promise;
		void promise.finally(() => {
			if (stopPromise === promise) stopPromise = null;
		});
		return promise;
	}

	async function performStop(outcome: AudioTestOutcome): Promise<void> {
		if (import.meta.env.DEV) audioFileSource?.stop();
		await client?.stop();
		if (session) {
			session = endActiveCaptureRun(session, {
				outcome: 'completed',
				reason: outcome === 'duration-limit' ? 'duration-limit' : 'user-paused',
				at: nowIso()
			});
			markCheckpointDirty();
			await flushCheckpoint();
			await refreshThreadList();
		}
		if (outcome === 'duration-limit') {
			durationLimitNotice = '已达到单次连续收音 2 小时安全上限，翻译已自动停止并保存。';
		}
		publishTranscriptTiming();
		timingProbeStartedAt = null;
		refreshDiagnosticReport();
		if (import.meta.env.DEV) finishAudioTest(outcome);
	}
</script>

<svelte:head>
	<title>VoxBraid · 实时双语字幕</title>
	<meta name="description" content="使用 OpenAI Realtime Translation 将环境音转为实时双语字幕。" />
</svelte:head>

<div class="app-shell">
	<SessionSidebar
		{threads}
		currentThreadId={session?.thread.id ?? null}
		open={sessionSidebarOpen}
		disabled={sessionActionsDisabled}
		{storageDurability}
		onClose={closeSessionSidebar}
		onNew={() => void startNewThread()}
		onSelect={(threadId) => void selectThread(threadId)}
	/>

	<main>
		<header>
			<div class="header-leading">
				<button
					bind:this={sessionMenuButton}
					class="session-menu"
					aria-label="打开会话列表"
					aria-controls="session-sidebar"
					aria-expanded={sessionSidebarOpen}
					onclick={() => (sessionSidebarOpen = true)}
				>
					<span></span><span></span><span></span>
				</button>
				<div class="brand">
					<div class="mark" aria-hidden="true"><span></span><span></span><span></span></div>
					<div>
						<p class="eyebrow">VOXBRAID</p>
						<h1>环境音实时翻译</h1>
					</div>
				</div>
			</div>
			<div
				class:live={status === 'connected'}
				class:error-state={status === 'failed'}
				class="status"
			>
				<span></span>{statusLabel}
			</div>
		</header>

		<section class="controls" aria-label="翻译控制">
			<label>
				<span>目标语言</span>
				<select
					aria-label="目标语言"
					bind:value={targetLanguage}
					disabled={active || persistencePhase === 'restoring'}
				>
					{#each TARGET_LANGUAGES as language (language.code)}
						<option value={language.code}>{language.label}</option>
					{/each}
				</select>
			</label>

			<div class="usage-summary">
				<div
					class="usage-estimate"
					title={`翻译与源文转写合计按 $${REALTIME_TRANSLATION_PRICING.usdPerMinute}/分钟估算；实际费用以 OpenAI Platform 为准。`}
				>
					<span>本会话估算</span>
					<strong>
						<span data-duration-seconds={usageEstimate.durationSeconds}
							>{usageEstimate.durationSeconds} 秒</span
						>
						<i aria-hidden="true">·</i>
						<span data-estimated-cost-usd={usageEstimate.estimatedCostUsd}
							>约 ${estimatedCostLabel}</span
						>
					</strong>
					{#if activeRunRemainingMs !== null}
						<small class:limit-warning={activeRunRemainingMs <= CAPTURE_RUN_DURATION_WARNING_MS}>
							安全保护剩余 {activeRunRemainingLabel}
						</small>
					{/if}
				</div>

				<div
					class="official-usage"
					title={officialUsagePhase === 'ready'
						? `OpenAI 组织账目；更新于 ${officialUpdatedLabel}，Costs API 数据可能有延迟。`
						: 'OpenAI 组织账目；查询失败不影响实时翻译。'}
				>
					<div class="official-usage-heading">
						<span>OpenAI 账目</span>
						<button
							class="usage-refresh"
							type="button"
							disabled={officialUsagePhase === 'loading'}
							onclick={() => void refreshOfficialUsage(true)}
							aria-label="刷新 OpenAI 账目">刷新</button
						>
					</div>
					{#if officialUsagePhase === 'ready' && officialUsage}
						<div class="credit-balance-summary">
							<em>预计余额</em>
							{#if creditBalanceEstimate}
								<strong
									class:balance-warning={creditBalanceEstimate.balanceUsd <= 2}
									data-estimated-credit-balance-usd={creditBalanceEstimate.balanceUsd}
								>
									{formatUsd(creditBalanceEstimate.balanceUsd)}
									{#if creditBalanceHours !== null}
										<i aria-hidden="true">·</i>{formatAudioHours(creditBalanceHours)}
									{/if}
								</strong>
							{:else}
								<strong class="muted">未校准</strong>
							{/if}
						</div>
						<div class="official-usage-windows">
							<div class="official-usage-window month-to-date">
								<em>本月</em>
								<strong>
									<span>{officialUsage.monthToDate.durationSeconds} 秒</span>
									<i aria-hidden="true">·</i>
									<span>{formatUsd(officialUsage.monthToDate.costUsd)}</span>
								</strong>
							</div>
							{#each officialUsage.windows as window (window.days)}
								<div class="official-usage-window" data-official-window-days={window.days}>
									<em>近 {window.days} 天</em>
									<strong>
										<span data-official-duration-seconds={window.durationSeconds}
											>{window.durationSeconds} 秒</span
										>
										<i aria-hidden="true">·</i>
										<span data-official-cost-usd={window.costUsd}>{formatUsd(window.costUsd)}</span>
									</strong>
								</div>
							{/each}
						</div>
						<details class="usage-ledger-details">
							<summary>余额与明细</summary>
							<div class="usage-ledger-popover">
								<div class="ledger-breakdown">
									<strong>本月 VoxBraid {formatUsd(officialUsage.monthToDate.costUsd)}</strong>
									<span
										>实时翻译 {formatUsd(officialUsage.monthToDate.breakdown.translationUsd)}</span
									>
									<span
										>源文转写 {formatUsd(
											officialUsage.monthToDate.breakdown.transcriptionUsd
										)}</span
									>
									<span
										>修订 / 清稿 / 问答 {formatUsd(
											officialUsage.monthToDate.breakdown.sidecarUsd
										)}</span
									>
									{#if officialUsage.monthToDate.breakdown.otherUsd > 0}
										<span
											>账户其他消费 {formatUsd(officialUsage.monthToDate.breakdown.otherUsd)}</span
										>
									{/if}
								</div>

								<div class="ledger-limit">
									{#if officialUsage.hardSpendLimit.status === 'configured'}
										<strong
											>本月硬上限剩余 {formatUsd(officialUsage.hardSpendLimit.remainingUsd)}</strong
										>
										<span
											>上限 {formatUsd(officialUsage.hardSpendLimit.thresholdUsd)} · {officialUsage
												.hardSpendLimit.enforcementStatus}</span
										>
									{:else if officialUsage.hardSpendLimit.status === 'not-configured'}
										<strong>未设置组织硬消费上限</strong>
										<span>它与预付余额、自动充值上限是不同约束。</span>
									{:else}
										<strong>硬消费上限暂不可读取</strong>
									{/if}
								</div>

								<form class="balance-calibration" onsubmit={calibrateCreditBalance}>
									<label>
										<span>Billing 当前可用余额（美元）</span>
										<input
											type="number"
											min="0"
											step="0.01"
											placeholder="例如 10.00"
											bind:value={creditBalanceInput}
										/>
									</label>
									<div class="balance-actions">
										<button type="submit">校准预计余额</button>
										{#if creditBalanceAnchor}
											<button
												type="button"
												class="secondary"
												onclick={clearCreditBalanceCalibration}>清除</button
											>
										{/if}
									</div>
								</form>
								<p class="balance-note">
									预付余额没有受支持的查询
									API。这里把你校准的余额减去之后出现的全账户官方成本；自动充值后需重新校准。
								</p>
								{#if creditBalanceEstimate}
									<p class="balance-note">
										校准后已记录消费 {formatUsd(
											creditBalanceEstimate.spentSinceAnchorUsd
										)}；录制时长按近 7 天实际 VoxBraid 每音频小时成本估算，最低按基础实时链路
										$3.06/小时。
									</p>
								{/if}
								{#if creditBalanceMessage}<p class="balance-message">{creditBalanceMessage}</p>{/if}
								<a
									href="https://platform.openai.com/settings/organization/billing/overview"
									target="_blank"
									rel="noreferrer">打开 OpenAI Billing 核对余额</a
								>
							</div>
						</details>
					{:else if officialUsagePhase === 'loading'}
						<strong class="muted">正在更新</strong>
					{:else}
						<details class="usage-error">
							<summary class="muted">暂不可用 · 查看错误</summary>
							<code>{officialUsageError || '未取得错误详情。'}</code>
						</details>
					{/if}
				</div>
			</div>

			{#if active}
				<button class="stop" onclick={() => void stop('user-stopped')}>
					<span class="stop-icon"></span>停止翻译
				</button>
			{:else}
				<div class="control-actions">
					<button
						class="start"
						onclick={start}
						disabled={!clientReady ||
							persistencePhase === 'restoring' ||
							status === 'stopping' ||
							(import.meta.env.DEV && audioTestEnabled && !audioTestFile)}
					>
						<span class="mic" aria-hidden="true"></span>
						{import.meta.env.DEV && audioTestEnabled ? '开始录音回放' : '开始翻译'}
					</button>
				</div>
			{/if}
		</section>

		{#if import.meta.env.DEV && audioTestEnabled && AudioTestPanel}
			<AudioTestPanel
				{active}
				bind:file={audioTestFile}
				report={lastAudioTestReport}
				onDownload={downloadAudioTestReport}
			/>
		{/if}

		{#if error}
			<div class="error" role="alert">
				<strong>{status === 'failed' ? '连接没有建立' : '实时链路报告错误'}</strong>
				<span>{error}</span>
			</div>
		{/if}

		{#if persistenceError}
			<div class="warning" role="status">
				<strong>本地记录未保存</strong>
				<span>{persistenceError}</span>
			</div>
		{:else if backupMessage}
			<div class="backup-message" role="status">{backupMessage}</div>
		{/if}

		{#if durationLimitNotice}
			<div class="backup-message" role="status">{durationLimitNotice}</div>
		{/if}

		<section
			class="captions"
			aria-live="polite"
			style={`--caption-font-size: ${captionFontSizePx}px;`}
		>
			<article>
				<div class="caption-label">
					<div class="caption-label-copy"><span>原文</span><small>自动识别语言</small></div>
					<details class="caption-font-control">
						<summary>字号 {captionFontSizePx}</summary>
						<div class="caption-font-popover">
							<span aria-hidden="true">小</span>
							<input
								type="range"
								aria-label="字幕字号"
								min={MIN_CAPTION_FONT_SIZE_PX}
								max={MAX_CAPTION_FONT_SIZE_PX}
								step="1"
								value={captionFontSizePx}
								oninput={updateCaptionFontSize}
							/>
							<span aria-hidden="true">大</span>
						</div>
					</details>
				</div>
				<div class="caption-scroll" bind:this={sourceScroller} onscroll={updateSourceFollow}>
					{#if sourceTranscriptRuns.length > 0}
						{#each sourceTranscriptRuns as run (run.runId)}
							{#if sourceTranscriptRuns.length > 1 || run.sequence > 1}
								<div class="run-separator">第 {run.sequence} 段 · {runTime(run)}</div>
							{/if}
							<p>{run.text}</p>
						{/each}
					{:else}
						<p class="placeholder">
							{active ? '正在听取环境声音…' : '开始后，原文字幕会显示在这里。'}
						</p>
					{/if}
				</div>
			</article>

			<div class="divider" aria-hidden="true"></div>

			<article class="translated">
				<div class="caption-label">
					<div class="caption-label-copy">
						<span>译文</span>
						<small>{TARGET_LANGUAGES.find((item) => item.code === targetLanguage)?.label}</small>
					</div>
				</div>
				<div
					class="caption-scroll"
					bind:this={translationScroller}
					onscroll={updateTranslationFollow}
				>
					{#if translatedTranscriptRuns.length > 0}
						{#each translatedTranscriptRuns as run (run.runId)}
							{#if translatedTranscriptRuns.length > 1 || run.sequence > 1}
								<div class="run-separator">
									第 {run.sequence} 段 · {runTime(run)} · {languageLabel(run.targetLanguage)}
								</div>
							{/if}
							<p>{run.text}</p>
						{/each}
					{:else}
						<p class="placeholder">
							{active ? '翻译准备中…' : '目标语言字幕会同步显示在这里。'}
						</p>
					{/if}
				</div>
			</article>
		</section>

		<SidecarPanel
			{session}
			{repository}
			{diagnosticsMode}
			outputLanguage={`${languageLabel(targetLanguage)} (${targetLanguage})`}
			disabled={persistencePhase === 'restoring' || sessionSwitching}
			onDiagnosticsModeChange={updateDiagnosticsMode}
		/>

		<footer>
			<div class="footer-copy">
				<span>
					{import.meta.env.DEV && audioTestEnabled
						? '本地录音通过 WebRTC 直达 OpenAI'
						: '音频从此设备通过 WebRTC 直达 OpenAI'}
				</span>
				<span>当前不播放译音 · 不保存录音</span>
			</div>
			{#if persistencePhase === 'ready'}
				<div class="backup-actions">
					<button
						class="export"
						disabled={sessionActionsDisabled || !session}
						onclick={() => void downloadSessionArchive()}>导出恢复备份</button
					>
					<button
						class="export"
						disabled={sessionActionsDisabled || !session}
						onclick={() => void downloadEvaluationBundle()}>导出评估数据</button
					>
					<button
						class="export"
						disabled={sessionActionsDisabled}
						onclick={() => backupInput?.click()}>恢复备份</button
					>
					<input
						bind:this={backupInput}
						class="backup-input"
						type="file"
						accept="application/json,.json"
						onchange={handleBackupFile}
					/>
				</div>
			{/if}
		</footer>

		<section class="debug-diagnostics" aria-labelledby="debug-diagnostics-title">
			<div class="debug-heading">
				<div class="debug-title">
					<p class="eyebrow">DEBUG</p>
					<h2 id="debug-diagnostics-title">Realtime 诊断</h2>
					<p
						class="build-info"
						title={`${__VOXBRAID_BUILD_INFO__.commitSha}${__VOXBRAID_BUILD_INFO__.dirty ? ' dirty' : ''} · ${__VOXBRAID_BUILD_INFO__.commitMessage}`}
					>
						<code>
							{__VOXBRAID_BUILD_INFO__.commitSha}{__VOXBRAID_BUILD_INFO__.dirty ? ' dirty' : ''}
						</code>
						<span>{__VOXBRAID_BUILD_INFO__.commitMessage}</span>
					</p>
				</div>
				<div class="debug-actions">
					<label class="debug-model">
						<span>输入降噪</span>
						<select
							aria-label="输入降噪"
							bind:value={noiseReduction}
							disabled={active || status === 'stopping'}
						>
							{#each REALTIME_NOISE_REDUCTION_MODES as mode (mode.code)}
								<option value={mode.code}>{mode.label}</option>
							{/each}
						</select>
					</label>
					<label class="debug-model">
						<span>原文模型</span>
						<select
							aria-label="原文模型"
							bind:value={transcriptionModel}
							disabled={active || status === 'stopping'}
						>
							{#each REALTIME_TRANSCRIPTION_MODELS as model (model.code)}
								<option value={model.code}>{model.label} · {model.code} · {model.releasedAt}</option
								>
							{/each}
						</select>
					</label>
					<button class="export" onclick={refreshDiagnosticReport}>刷新原始报告</button>
					<button class="export" onclick={() => void copyDiagnosticReport()}>复制报告</button>
				</div>
			</div>
			<div class="debug-metrics">
				<span>
					原文 <strong>{diagnosticSourceDeltas}</strong> delta ·
					<strong>{diagnosticSourceCharacters}</strong> 字符 · elapsed
					<strong>{diagnosticSourceElapsedMs ?? '—'}</strong> ms
				</span>
				<span>
					译文 <strong>{diagnosticTranslationDeltas}</strong> delta ·
					<strong>{diagnosticTranslationCharacters}</strong> 字符 · elapsed
					<strong>{diagnosticTranslationElapsedMs ?? '—'}</strong> ms
				</span>
				<span>错误 <strong>{diagnosticErrors}</strong></span>
				{#if diagnosticDroppedEvents > 0}
					<span class="debug-note">
						报告截断 · 另有 {diagnosticDroppedEvents} 条未收录
					</span>
				{/if}
			</div>
			<details>
				<summary>设备配置、状态时间线与原始事件</summary>
				<pre>{diagnosticReportText}</pre>
			</details>
		</section>

		<OperationalLogPanel
			entries={operationalLogs}
			{diagnosticsMode}
			onClear={() => void clearOperationalLogs()}
		/>
	</main>
</div>

<style>
	.app-shell {
		min-height: 100vh;
		display: grid;
		grid-template-columns: 248px minmax(0, 1fr);
	}

	main {
		min-width: 0;
		width: min(1120px, 100%);
		min-height: 100vh;
		margin: 0 auto;
		padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right))
			max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
		display: grid;
		gap: 16px;
	}

	header,
	.controls,
	footer,
	.header-leading,
	.brand,
	.caption-label {
		display: flex;
		align-items: center;
	}

	header,
	.controls,
	footer {
		justify-content: space-between;
	}

	.backup-actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 8px;
	}

	.backup-input {
		display: none;
	}

	.backup-message {
		padding: 10px 14px;
		border: 1px solid #315142;
		border-radius: 12px;
		background: #122019;
		color: #a8d8c1;
		font-size: 13px;
	}

	.debug-diagnostics {
		padding: 16px;
		border: 1px solid #29332e;
		border-radius: 14px;
		background: #0c100e;
		color: #87918c;
		font-size: 12px;
	}
	.debug-heading,
	.debug-actions,
	.debug-metrics {
		display: flex;
		align-items: center;
	}
	.debug-heading {
		justify-content: space-between;
		gap: 16px;
	}
	.debug-heading h2 {
		margin: 2px 0 0;
		color: #d2d9d5;
		font-size: 15px;
	}
	.debug-title {
		min-width: 0;
	}
	.build-info {
		max-width: 440px;
		margin: 5px 0 0;
		display: flex;
		gap: 7px;
		color: #727c77;
		white-space: nowrap;
	}
	.build-info code {
		color: #9da8a2;
		font-size: 11px;
	}
	.build-info span {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.debug-actions,
	.debug-metrics {
		gap: 8px 16px;
		flex-wrap: wrap;
	}
	.debug-actions button {
		width: auto;
	}
	.debug-model {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.debug-model span {
		white-space: nowrap;
	}
	.debug-model select {
		min-width: 170px;
		padding: 8px 10px;
		border: 1px solid #34413b;
		border-radius: 9px;
		background: #111713;
		color: #d2d9d5;
	}
	.debug-metrics {
		margin-top: 14px;
	}
	.debug-metrics strong {
		color: #bdebd8;
	}
	.debug-note {
		display: block;
		margin-top: 6px;
		color: #87918c;
	}
	.debug-diagnostics details {
		margin-top: 14px;
	}
	.debug-diagnostics summary {
		cursor: pointer;
		color: #aab4af;
	}
	.debug-diagnostics pre {
		max-height: 420px;
		margin: 12px 0 0;
		padding: 12px;
		overflow: auto;
		border-radius: 10px;
		background: #070a08;
		color: #a9b4ae;
		font:
			11px/1.55 ui-monospace,
			SFMono-Regular,
			Menlo,
			Consolas,
			monospace;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.brand {
		gap: 14px;
	}

	.header-leading {
		gap: 12px;
	}

	.session-menu {
		display: none;
		min-width: 0;
		width: 42px;
		height: 42px;
		padding: 0;
		border: 1px solid #303936;
		border-radius: 12px;
		flex-direction: column;
		gap: 4px;
		background: #111613;
	}

	.session-menu span {
		width: 17px;
		height: 2px;
		border-radius: 2px;
		background: #aeb9b3;
	}

	.mark {
		width: 44px;
		height: 44px;
		border: 1px solid #39433f;
		border-radius: 13px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		background: #101512;
	}

	.mark span {
		width: 3px;
		border-radius: 4px;
		background: #8dd6bd;
	}

	.mark span:nth-child(1) {
		height: 13px;
	}
	.mark span:nth-child(2) {
		height: 25px;
	}
	.mark span:nth-child(3) {
		height: 18px;
	}

	.eyebrow {
		margin: 0 0 3px;
		color: #86b8a7;
		font-size: 11px;
		font-weight: 750;
		letter-spacing: 0.18em;
	}

	h1 {
		margin: 0;
		font-size: clamp(20px, 3vw, 28px);
		font-weight: 630;
		letter-spacing: -0.025em;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 9px 13px;
		border: 1px solid #303633;
		border-radius: 999px;
		background: rgba(17, 21, 19, 0.82);
		color: #abb3af;
		font-size: 13px;
	}

	.status > span {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #68706c;
	}

	.status.live {
		color: #bde9da;
		border-color: #315f50;
	}
	.status.live > span {
		background: #69ddb5;
		box-shadow: 0 0 0 5px rgba(105, 221, 181, 0.1);
	}
	.status.error-state {
		color: #efb0a7;
		border-color: #633c37;
	}
	.status.error-state > span {
		background: #e77869;
	}

	.controls {
		gap: 16px;
		padding: 14px 16px;
		border: 1px solid #252c29;
		border-radius: 14px;
		background: rgba(14, 18, 16, 0.74);
	}

	label {
		display: flex;
		align-items: center;
		gap: 12px;
		color: #929c97;
		font-size: 13px;
	}
	select {
		min-width: 150px;
		padding: 9px 36px 9px 12px;
		border: 1px solid #343d39;
		border-radius: 11px;
		background: #111613;
		color: #eef3ef;
	}

	button {
		min-width: 160px;
		padding: 10px 16px;
		border: 0;
		border-radius: 12px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		font-weight: 680;
		cursor: pointer;
		transition:
			transform 120ms ease,
			filter 120ms ease;
	}

	button:hover {
		filter: brightness(1.06);
	}
	button:active {
		transform: translateY(1px);
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.start {
		background: #8bd5bc;
		color: #07130e;
	}
	.stop {
		background: #e7dad6;
		color: #281411;
	}
	.control-actions {
		display: flex;
		gap: 10px;
	}
	.usage-summary {
		min-width: 210px;
		display: grid;
		gap: 7px;
	}
	.usage-estimate,
	.official-usage {
		display: grid;
		gap: 2px;
		color: #727c77;
		font-size: 11px;
		text-align: center;
	}
	.usage-estimate strong,
	.official-usage strong {
		color: #c3cec8;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		font-weight: 620;
	}
	.usage-estimate small {
		color: #73817a;
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}
	.usage-estimate small.limit-warning {
		color: #e3bd79;
		font-weight: 650;
	}
	.usage-estimate i,
	.official-usage i {
		padding: 0 4px;
		color: #59625d;
		font-style: normal;
	}
	.official-usage strong.muted {
		color: #78827d;
		font-weight: 520;
	}
	.official-usage {
		position: relative;
	}
	.official-usage-heading {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
	}
	.official-usage-windows {
		display: grid;
		gap: 1px;
	}
	.credit-balance-summary {
		display: grid;
		grid-template-columns: 58px 1fr;
		align-items: baseline;
		gap: 5px;
		white-space: nowrap;
	}
	.credit-balance-summary em {
		color: #85aa9d;
		font-style: normal;
		text-align: right;
	}
	.credit-balance-summary strong {
		color: #bde9da;
		text-align: left;
	}
	.credit-balance-summary strong.balance-warning {
		color: #e3bd79;
	}
	.official-usage-window {
		display: grid;
		grid-template-columns: 58px 1fr;
		align-items: baseline;
		gap: 5px;
		white-space: nowrap;
	}
	.official-usage-window em {
		color: #727c77;
		font-style: normal;
		text-align: right;
	}
	.usage-refresh {
		min-width: 0;
		padding: 2px 3px;
		border: 0;
		background: transparent;
		color: #65706a;
		font-size: 10px;
	}
	.usage-ledger-details {
		position: relative;
		margin-top: 2px;
	}
	.usage-ledger-details > summary {
		cursor: pointer;
		color: #73817a;
		font-size: 10px;
		list-style: none;
	}
	.usage-ledger-details > summary::-webkit-details-marker {
		display: none;
	}
	.usage-ledger-details[open] > summary {
		color: #9dc8b7;
	}
	.usage-ledger-popover {
		position: absolute;
		z-index: 20;
		top: calc(100% + 8px);
		right: 0;
		width: min(360px, calc(100vw - 40px));
		padding: 14px;
		border: 1px solid #35453e;
		border-radius: 13px;
		display: grid;
		gap: 12px;
		background: #101613;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
		color: #94a099;
		text-align: left;
	}
	.ledger-breakdown,
	.ledger-limit {
		display: grid;
		gap: 4px;
	}
	.ledger-breakdown strong,
	.ledger-limit strong {
		color: #d0dad5;
		font-size: 12px;
	}
	.balance-calibration {
		display: grid;
		gap: 8px;
	}
	.balance-calibration label {
		display: grid;
		gap: 6px;
		font-size: 11px;
	}
	.balance-calibration input {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid #34413b;
		border-radius: 9px;
		background: #0b100d;
		color: #e7eeea;
		font: inherit;
	}
	.balance-actions {
		display: flex;
		gap: 7px;
	}
	.balance-actions button {
		min-width: 0;
		width: auto;
		padding: 7px 10px;
		border: 1px solid #3f6657;
		border-radius: 8px;
		background: #173126;
		color: #bde9da;
		font-size: 11px;
	}
	.balance-actions button.secondary {
		border-color: #3a423e;
		background: #171c19;
		color: #9ba59f;
	}
	.balance-note,
	.balance-message {
		margin: 0;
		font-size: 10px;
		line-height: 1.5;
	}
	.balance-message {
		color: #d4b986;
		white-space: pre-wrap;
	}
	.usage-ledger-popover a {
		color: #91cdb7;
		font-size: 11px;
	}
	.mic {
		width: 10px;
		height: 15px;
		border: 2px solid currentColor;
		border-radius: 7px;
	}
	.stop-icon {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		background: currentColor;
	}

	.error {
		padding: 14px 16px;
		border: 1px solid #633d38;
		border-radius: 13px;
		display: grid;
		gap: 4px;
		background: rgba(83, 36, 31, 0.28);
		color: #f0bbb3;
		font-size: 14px;
	}

	.error strong {
		color: #f6ddd8;
	}
	.warning {
		padding: 14px 16px;
		border: 1px solid #655c38;
		border-radius: 13px;
		display: grid;
		gap: 4px;
		background: rgba(86, 72, 28, 0.24);
		color: #d8ce98;
		font-size: 14px;
	}
	.warning strong {
		color: #f0e8bc;
	}
	.error span,
	.warning span {
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.export {
		min-width: 0;
		padding: 6px 10px;
		border: 1px solid #343d39;
		background: #111613;
		color: #aeb8b3;
		font-size: 12px;
	}

	.captions {
		height: clamp(620px, calc(100dvh - 150px), 900px);
		min-height: 620px;
		border: 1px solid #202724;
		border-radius: 16px;
		display: grid;
		grid-template-rows: 1fr auto 1fr;
		overflow: hidden;
		background: rgba(10, 13, 12, 0.77);
		box-shadow: 0 22px 70px rgba(0, 0, 0, 0.24);
	}

	article {
		padding: clamp(20px, 2.35vw, 30px);
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.caption-label {
		position: relative;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
	}
	.caption-label-copy {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.caption-label span {
		color: #87c5b0;
		font-size: 12px;
		font-weight: 750;
		letter-spacing: 0.12em;
	}
	.caption-label small {
		color: #68726d;
		font-size: 12px;
	}
	.caption-font-control {
		position: relative;
		flex: none;
	}
	.caption-font-control summary {
		min-width: 68px;
		padding: 5px 9px;
		border: 1px solid #303a35;
		border-radius: 9px;
		background: #111613;
		color: #9ba8a2;
		font-size: 12px;
		line-height: 1;
		text-align: center;
		cursor: pointer;
		list-style: none;
	}
	.caption-font-control summary::-webkit-details-marker {
		display: none;
	}
	.caption-font-control[open] summary {
		border-color: #6aa995;
		color: #bce6d7;
	}
	.caption-font-popover {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 4;
		width: min(240px, calc(100vw - 64px));
		padding: 12px;
		border: 1px solid #303a35;
		border-radius: 12px;
		display: grid;
		grid-template-columns: auto minmax(120px, 1fr) auto;
		align-items: center;
		gap: 9px;
		background: #111613;
		box-shadow: 0 12px 34px rgba(0, 0, 0, 0.42);
		color: #7d8983;
		font-size: 11px;
	}
	.caption-font-popover input {
		width: 100%;
		accent-color: #83d4ba;
	}
	.caption-scroll {
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
	}
	article p {
		margin: 0;
		font-size: var(--caption-font-size, 22px);
		font-weight: 530;
		line-height: 1.45;
		letter-spacing: -0.016em;
		white-space: pre-wrap;
		word-break: break-word;
	}
	article p + .run-separator,
	.run-separator + p {
		margin-top: 14px;
	}
	.run-separator {
		padding-top: 14px;
		border-top: 1px solid #252d29;
		color: #68726d;
		font-size: 11px;
		letter-spacing: 0.04em;
	}

	article.translated p {
		color: #cfeee3;
	}
	article p.placeholder {
		color: #4f5753;
		font-weight: 450;
	}
	.divider {
		height: 1px;
		margin: 0 clamp(20px, 2.35vw, 30px);
		background: #252d29;
	}
	footer {
		gap: 20px;
		color: #59615d;
		font-size: 11px;
	}
	.footer-copy {
		display: flex;
		gap: 18px;
	}

	@media (max-width: 820px) {
		.app-shell {
			display: block;
		}
		.session-menu {
			display: inline-flex;
		}
	}

	@media (max-width: 640px) {
		main {
			padding-inline: 16px;
		}
		header {
			align-items: flex-start;
		}
		.mark {
			width: 42px;
			height: 42px;
		}
		.status {
			padding: 7px 10px;
		}
		.controls {
			align-items: stretch;
			flex-direction: column;
		}
		.usage-summary {
			min-width: 0;
			gap: 6px;
		}
		.usage-estimate,
		.official-usage-heading {
			grid-template-columns: auto auto;
			align-items: baseline;
			justify-content: space-between;
			text-align: left;
		}
		.official-usage {
			text-align: left;
		}
		.credit-balance-summary,
		.official-usage-window {
			grid-template-columns: 62px 1fr;
		}
		.credit-balance-summary em,
		.official-usage-window em {
			text-align: left;
		}
		.usage-refresh {
			width: auto;
		}
		.usage-ledger-details > summary {
			text-align: left;
		}
		.usage-ledger-popover {
			position: static;
			width: 100%;
			margin-top: 8px;
		}
		.control-actions {
			width: 100%;
			flex-direction: column;
		}
		label {
			justify-content: space-between;
		}
		button {
			width: 100%;
		}
		.captions {
			height: clamp(560px, calc(100dvh - 180px), 780px);
			min-height: 560px;
		}
		footer {
			align-items: flex-start;
			gap: 10px;
		}
		.footer-copy {
			flex-direction: column;
			gap: 5px;
		}
		.backup-actions {
			justify-content: flex-start;
		}
		.export {
			width: auto;
		}
	}
</style>
