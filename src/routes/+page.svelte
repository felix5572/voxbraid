<script lang="ts">
	import { onMount } from 'svelte';
	import { CheckpointWriter } from '$lib/persistence/checkpoint-writer';
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
	import SessionSidebar from '$lib/session/SessionSidebar.svelte';
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
		TARGET_LANGUAGES,
		isTargetLanguage,
		type ConnectionStatus,
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
	type OfficialUsageSummary = {
		periodStart: string;
		periodEnd: string;
		durationSeconds: number;
		costUsd: number;
		updatedAt: string;
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
	const VISIBLE_TAIL_CHARACTERS = 2_000;
	const RESTORE_TIMEOUT_MS = 5_000;
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
	let session = $state<TranslationSessionState | null>(null);
	let error = $state('');
	let persistencePhase = $state<PersistencePhase>('restoring');
	let persistenceError = $state('');
	let threads = $state<TranslationThread[]>([]);
	let sessionSidebarOpen = $state(false);
	let sessionSwitching = $state(false);
	let usageNowMs = $state(Date.now());
	let officialUsage = $state<OfficialUsageSummary | null>(null);
	let officialUsagePhase = $state<OfficialUsagePhase>('loading');
	let officialUsageRequest = 0;
	let client: TranslationClient | null = null;
	let clientReady = $state(false);
	let repository: LocalSessionRepository | null = null;
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
	let sourceFollowsTail = true;
	let translationFollowsTail = true;
	let followFrame: number | null = null;
	const wakeLock = new ScreenWakeLock();

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
		session ? visibleTranscriptRuns(session.runs, 'source', VISIBLE_TAIL_CHARACTERS) : []
	);
	const translatedTranscriptRuns = $derived(
		session ? visibleTranscriptRuns(session.runs, 'translation', VISIBLE_TAIL_CHARACTERS) : []
	);
	const usageEstimate = $derived(estimateRealtimeUsage(session?.runs ?? [], usageNowMs));
	const estimatedCostLabel = $derived(formatEstimatedCostUsd(usageEstimate.estimatedCostUsd));
	const officialCostLabel = $derived(
		officialUsage ? formatEstimatedCostUsd(officialUsage.costUsd) : ''
	);
	const officialUpdatedLabel = $derived(
		officialUsage ? OFFICIAL_USAGE_TIME_FORMATTER.format(new Date(officialUsage.updatedAt)) : ''
	);

	function nowIso(): string {
		return new Date().toISOString();
	}

	function runTime(run: VisibleTranscriptRun): string {
		return RUN_TIME_FORMATTER.format(new Date(run.startedAt));
	}

	function languageLabel(code: string): string {
		return TARGET_LANGUAGES.find((language) => language.code === code)?.label ?? code;
	}

	function isOfficialUsageSummary(value: unknown): value is OfficialUsageSummary {
		return (
			typeof value === 'object' &&
			value !== null &&
			'periodStart' in value &&
			typeof value.periodStart === 'string' &&
			'periodEnd' in value &&
			typeof value.periodEnd === 'string' &&
			'durationSeconds' in value &&
			typeof value.durationSeconds === 'number' &&
			Number.isFinite(value.durationSeconds) &&
			'costUsd' in value &&
			typeof value.costUsd === 'number' &&
			Number.isFinite(value.costUsd) &&
			'updatedAt' in value &&
			typeof value.updatedAt === 'string'
		);
	}

	async function refreshOfficialUsage(): Promise<void> {
		const request = ++officialUsageRequest;
		officialUsagePhase = 'loading';
		try {
			const response = await fetch('/api/openai/usage-summary', { cache: 'no-store' });
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok || !isOfficialUsageSummary(body)) {
				throw new Error(`Official usage request failed with HTTP ${response.status}.`);
			}
			if (request !== officialUsageRequest) return;
			officialUsage = body;
			officialUsagePhase = 'ready';
		} catch {
			if (request !== officialUsageRequest) return;
			officialUsagePhase = 'unavailable';
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
			persistenceError = '会话列表刷新失败，请稍后重试。';
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
			return true;
		} catch (saveError) {
			console.error('[persistence] checkpoint failed', saveError);
			persistenceError = '字幕仍保留在当前页面中，系统会继续尝试保存。';
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
		} catch (exportError) {
			console.error('[persistence] export failed', exportError);
			persistenceError = '会话导出失败，请稍后重试。';
		}
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
			persistenceError = '会话切换失败，请稍后重试。';
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
		const usageTimer = window.setInterval(() => {
			const activeRun = session ? activeCaptureRun(session) : null;
			if (activeRun?.mediaStartedAt) {
				usageNowMs = Date.now();
			}
		}, 1_000);
		void refreshOfficialUsage();
		const search = new URLSearchParams(location.search);
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
					error = '录音回放测试工具加载失败。';
				});
		}
		const realtimeOptions: RealtimeTranslationClientOptions = {
			onStatus: (nextStatus) => {
				const at = nowIso();
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
			},
			onConnectionFailure: (message) => {
				if (import.meta.env.DEV) {
					activeAudioTest?.errors.push(message);
					audioFileSource?.stop();
				}
				error = message;
				endFailedRun(message);
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
					error = '浏览器测试客户端加载失败。';
				});
		} else {
			client = new RealtimeTranslationClient(realtimeOptions, {
				getUserMedia: async (constraints) => {
					if (!import.meta.env.DEV || !audioTestEnabled) {
						return navigator.mediaDevices.getUserMedia(constraints);
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
				persistenceError = '本地历史记录不可用；实时翻译仍可继续。';
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
			await client.start(targetLanguage);
		} catch (startError) {
			console.error('[realtime-client] start failed', startError);
			const message = realtimeErrorMessage(startError);
			if (import.meta.env.DEV) {
				activeAudioTest?.errors.push(message);
				audioFileSource?.stop();
			}
			error = message;
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
				reason: 'user-paused',
				at: nowIso()
			});
			markCheckpointDirty();
			await flushCheckpoint();
			await refreshThreadList();
		}
		publishTranscriptTiming();
		timingProbeStartedAt = null;
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
				<select bind:value={targetLanguage} disabled={active || persistencePhase === 'restoring'}>
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
				</div>

				<div
					class="official-usage"
					title={officialUsagePhase === 'ready'
						? `OpenAI 组织本月累计消费；更新于 ${officialUpdatedLabel}，账单数据可能有延迟。`
						: 'OpenAI 组织本月累计消费；不影响实时翻译。'}
				>
					<span>本月官方消费</span>
					{#if officialUsagePhase === 'ready' && officialUsage}
						<strong>
							<span data-official-duration-seconds={officialUsage.durationSeconds}
								>{officialUsage.durationSeconds} 秒</span
							>
							<i aria-hidden="true">·</i>
							<span data-official-cost-usd={officialUsage.costUsd}>${officialCostLabel}</span>
						</strong>
					{:else if officialUsagePhase === 'loading'}
						<strong class="muted">正在更新</strong>
					{:else}
						<strong class="muted">暂不可用</strong>
					{/if}
					<button
						class="usage-refresh"
						type="button"
						disabled={officialUsagePhase === 'loading'}
						onclick={() => void refreshOfficialUsage()}
						aria-label="刷新本月官方消费">刷新</button
					>
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
				<strong>连接没有建立</strong>
				<span>{error}</span>
			</div>
		{/if}

		{#if persistenceError}
			<div class="warning" role="status">
				<strong>本地记录未保存</strong>
				<span>{persistenceError}</span>
			</div>
		{/if}

		<section class="captions" aria-live="polite">
			<article>
				<div class="caption-label"><span>原文</span><small>自动识别语言</small></div>
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
					<span>译文</span>
					<small>{TARGET_LANGUAGES.find((item) => item.code === targetLanguage)?.label}</small>
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

		<footer>
			<div class="footer-copy">
				<span>
					{import.meta.env.DEV && audioTestEnabled
						? '本地录音通过 WebRTC 直达 OpenAI'
						: '音频从此设备通过 WebRTC 直达 OpenAI'}
				</span>
				<span>当前不播放译音 · 不保存录音</span>
			</div>
			{#if import.meta.env.DEV && session && persistencePhase === 'ready'}
				<button class="export" onclick={() => void downloadSessionArchive()}>导出会话 JSON</button>
			{/if}
		</footer>
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
		min-width: 164px;
		display: grid;
		gap: 7px;
	}
	.usage-estimate,
	.official-usage {
		position: relative;
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
	.usage-refresh {
		position: absolute;
		right: -1px;
		top: -2px;
		min-width: 0;
		padding: 2px 3px;
		border: 0;
		background: transparent;
		color: #65706a;
		font-size: 10px;
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
	.export {
		min-width: 0;
		padding: 6px 10px;
		border: 1px solid #343d39;
		background: #111613;
		color: #aeb8b3;
		font-size: 12px;
	}

	.captions {
		height: clamp(500px, calc(100dvh - 224px), 760px);
		min-height: 500px;
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
		gap: 10px;
		margin-bottom: 12px;
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
	.caption-scroll {
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
	}
	article p {
		margin: 0;
		font-size: clamp(22px, 2.15vw, 30px);
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
		.official-usage {
			grid-template-columns: auto auto;
			align-items: baseline;
			justify-content: space-between;
			text-align: left;
		}
		.official-usage {
			padding-right: 40px;
		}
		.usage-refresh {
			right: 0;
			top: 50%;
			width: auto;
			transform: translateY(-50%);
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
			height: clamp(520px, calc(100dvh - 238px), 760px);
			min-height: 520px;
		}
		footer {
			align-items: flex-start;
			gap: 10px;
		}
		.footer-copy {
			flex-direction: column;
			gap: 5px;
		}
		.export {
			width: auto;
		}
	}
</style>
