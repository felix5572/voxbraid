<script lang="ts">
	import type { LocalSessionRepository } from '../persistence/local-session-repository';
	import { activeCaptureRun, type TranslationSessionState } from '../session/translation-session';
	import {
		shouldAutomaticallySummarize,
		stopsAutomaticSummaries,
		transcriptExtent,
		type StoredAutoSummary
	} from './auto-summary';
	import { sendSidecarRequest, sidecarLocalFailure } from './client';
	import { captureSidecarContext, sidecarRequestFits } from './context';
	import type { SidecarInvokeRequest, SidecarInvokeResult, SidecarTrigger } from './types';

	interface Props {
		session: TranslationSessionState | null;
		outputLanguage: string;
		repository: LocalSessionRepository | null;
		disabled?: boolean;
		onRequestingChange?: (requesting: boolean) => void;
	}

	let {
		session,
		outputLanguage,
		repository,
		disabled = false,
		onRequestingChange = () => undefined
	}: Props = $props();
	let summary = $state<StoredAutoSummary | null>(null);
	let phase = $state<'loading' | 'idle' | 'requesting' | 'failed'>('loading');
	let errorMessage = $state('');
	let persistenceMessage = $state('');
	let copyStatus = $state('');
	let loadedThreadId = $state<string | null>(null);
	let baselineSourceCharacters = $state(0);
	let lastRequestedAtMs = $state<number | null>(null);
	let currentRequestId: string | null = null;
	let loadGeneration = 0;
	let observedThreadId: string | null = null;
	let observedRunId: string | null = null;
	let observedRunWasActive = false;
	let pendingRunEndSummary = false;
	let automaticSummariesStopped = $state(false);

	const threadId = $derived(session?.thread.id ?? null);
	const extent = $derived(transcriptExtent(session));
	const hasTranscript = $derived(extent.sourceCharacters > 0 || extent.translationCharacters > 0);
	const summaryAgeLabel = $derived(
		summary
			? new Intl.DateTimeFormat(undefined, {
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit'
				}).format(new Date(summary.capturedAt))
			: ''
	);

	async function loadSummary(
		nextThreadId: string | null,
		nextRepository: LocalSessionRepository | null
	) {
		const generation = ++loadGeneration;
		currentRequestId = null;
		onRequestingChange(false);
		summary = null;
		errorMessage = '';
		persistenceMessage = '';
		copyStatus = '';
		automaticSummariesStopped = false;
		loadedThreadId = null;
		phase = nextThreadId ? 'loading' : 'idle';
		if (!nextThreadId) {
			baselineSourceCharacters = 0;
			return;
		}

		let stored: StoredAutoSummary | null = null;
		if (nextRepository) {
			try {
				stored = await nextRepository.loadAutoSummary(nextThreadId);
			} catch (error) {
				console.error('[auto-summary] restore failed', error);
				persistenceMessage = '自动总结记录读取失败；本页仍可继续生成。';
			}
		}
		if (generation !== loadGeneration || session?.thread.id !== nextThreadId) return;
		summary = stored;
		const currentExtent = transcriptExtent(session);
		baselineSourceCharacters = stored?.sourceCharacters ?? currentExtent.sourceCharacters;
		lastRequestedAtMs = stored ? Date.parse(stored.updatedAt) : null;
		loadedThreadId = nextThreadId;
		phase = 'idle';
	}

	function localFailure(clientRequestId: string, message: string): SidecarInvokeResult {
		return sidecarLocalFailure(clientRequestId, 'upstream-failed', message);
	}

	async function requestSummary(trigger: SidecarTrigger): Promise<void> {
		const capturedSession = session;
		if (
			disabled ||
			phase === 'requesting' ||
			!capturedSession ||
			loadedThreadId !== capturedSession.thread.id
		) {
			return;
		}

		const capturedAt = new Date().toISOString();
		const context = captureSidecarContext(capturedSession, 'current-thread', capturedAt);
		const capturedExtent = transcriptExtent(capturedSession);
		const clientRequestId = crypto.randomUUID();
		const request: SidecarInvokeRequest = {
			clientRequestId,
			intent: { kind: 'summarize', trigger, outputLanguage },
			context
		};
		copyStatus = '';
		persistenceMessage = '';
		if (context.runs.length === 0) {
			errorMessage = '当前会话还没有可总结的字幕。';
			phase = 'failed';
			return;
		}
		if (!sidecarRequestFits(request)) {
			automaticSummariesStopped = true;
			errorMessage =
				trigger === 'periodic'
					? '当前字幕超过完整总结请求上限；已停止本会话的自动总结。'
					: '当前会话超过完整总结的 1.5 MB 请求上限。';
			phase = 'failed';
			return;
		}

		currentRequestId = clientRequestId;
		lastRequestedAtMs = Date.now();
		phase = 'requesting';
		errorMessage = '';
		onRequestingChange(true);
		let result: SidecarInvokeResult;
		try {
			result = await sendSidecarRequest(request);
		} catch (error) {
			console.error('[auto-summary] browser request failed', error);
			result = localFailure(
				clientRequestId,
				error instanceof Error ? error.message : '自动总结请求失败。'
			);
		}
		if (currentRequestId !== clientRequestId || session?.thread.id !== capturedSession.thread.id) {
			return;
		}
		currentRequestId = null;
		onRequestingChange(false);
		if (result.status === 'failed' || !result.outputText.trim()) {
			pendingRunEndSummary = false;
			if (stopsAutomaticSummaries(result)) {
				automaticSummariesStopped = true;
			}
			phase = 'failed';
			errorMessage =
				result.status === 'failed'
					? `${result.error.code}：${result.error.message}`
					: '模型未返回总结。';
			return;
		}

		const completed: StoredAutoSummary = {
			threadId: capturedSession.thread.id,
			revision: (summary?.revision ?? 0) + 1,
			text: result.outputText,
			capturedAt,
			sourceCharacters: capturedExtent.sourceCharacters,
			translationCharacters: capturedExtent.translationCharacters,
			model: result.model,
			usageStatus: result.usageStatus,
			usage: result.usage,
			updatedAt: new Date().toISOString()
		};
		summary = completed;
		automaticSummariesStopped = false;
		baselineSourceCharacters = capturedExtent.sourceCharacters;
		phase = 'idle';
		if (!repository) {
			persistenceMessage = '本地存储不可用；这份总结只保留到页面关闭。';
			return;
		}
		try {
			await repository.saveAutoSummary(completed);
		} catch (error) {
			console.error('[auto-summary] save failed', error);
			persistenceMessage = '总结已生成，但保存到本设备失败。';
		}
	}

	async function copySummary(): Promise<void> {
		if (!summary?.text) return;
		try {
			await navigator.clipboard.writeText(summary.text);
			copyStatus = '已复制';
		} catch (error) {
			console.error('[auto-summary] copy failed', error);
			copyStatus = '复制失败，请手动选择文本';
		}
	}

	$effect(() => {
		const nextThreadId = threadId;
		const nextRepository = repository;
		void loadSummary(nextThreadId, nextRepository);
	});

	$effect(() => {
		const currentThreadId = threadId;
		const activeRun = session ? activeCaptureRun(session) : null;
		const latestRun = session?.runs.at(-1) ?? null;
		const latestRunIsActive = Boolean(
			latestRun &&
			(latestRun.status === 'starting' ||
				latestRun.status === 'live' ||
				latestRun.status === 'stopping')
		);
		let runJustEnded = false;
		if (observedThreadId === currentThreadId && observedRunId === latestRun?.id) {
			runJustEnded = observedRunWasActive && !latestRunIsActive;
		}
		if (runJustEnded) pendingRunEndSummary = true;
		observedThreadId = currentThreadId;
		observedRunId = latestRun?.id ?? null;
		observedRunWasActive = latestRunIsActive;

		if (
			!currentThreadId ||
			loadedThreadId !== currentThreadId ||
			disabled ||
			automaticSummariesStopped ||
			(!activeRun && !pendingRunEndSummary)
		) {
			return;
		}
		const finalizing = pendingRunEndSummary;
		if (
			shouldAutomaticallySummarize({
				extent,
				baselineSourceCharacters,
				requesting: phase === 'requesting',
				nowMs: Date.now(),
				lastRequestedAtMs,
				runJustEnded: finalizing
			})
		) {
			pendingRunEndSummary = false;
			void requestSummary('periodic');
		} else if (finalizing && phase !== 'requesting') {
			pendingRunEndSummary = false;
		}
	});
</script>

<section class="panel" aria-labelledby="auto-summary-title">
	<header>
		<div>
			<p class="eyebrow">AUTO SUMMARY</p>
			<h3 id="auto-summary-title">自动总结</h3>
		</div>
		<button
			type="button"
			disabled={disabled || phase === 'loading' || phase === 'requesting' || !hasTranscript}
			onclick={() => void requestSummary('manual')}>立即更新</button
		>
	</header>

	<div class="status" aria-live="polite">
		{#if phase === 'loading'}
			正在读取本地总结…
		{:else if phase === 'requesting'}
			正在基于当前完整字幕生成新总结；旧内容仍可阅读。
		{:else if automaticSummariesStopped}
			当前字幕已超过完整总结预算；本会话不再自动请求。
		{:else if summary}
			总结截至 {summaryAgeLabel} · 第 {summary.revision} 版 · {summary.model}
		{:else}
			累计新增约 3,000 个原文字符后自动生成；暂停时会尝试收尾。
		{/if}
	</div>

	<div class="summary-scroll">
		{#if summary}
			<div class="summary-text">{summary.text}</div>
		{:else}
			<p class="placeholder">总结会在这里稳定替换，不会随着模型生成逐字跳动。</p>
		{/if}
	</div>

	<footer>
		<div class="messages">
			{#if errorMessage}<span class="error" role="alert">{errorMessage}</span>{/if}
			{#if persistenceMessage}<span class="warning">{persistenceMessage}</span>{/if}
			{#if summary?.usage}
				<span>本版 {summary.usage.totalTokens} tokens</span>
			{/if}
		</div>
		{#if summary}
			<button type="button" class="copy" onclick={() => void copySummary()}>
				{copyStatus || '复制'}
			</button>
		{/if}
	</footer>
</section>

<style>
	.panel {
		min-width: 0;
		padding: 18px;
		border: 1px solid #293831;
		border-radius: 14px;
		background: #0d1310;
	}

	header,
	footer,
	.messages {
		display: flex;
	}

	header,
	footer {
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.eyebrow {
		margin: 0 0 3px;
		color: #72b39e;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.14em;
	}

	h3 {
		margin: 0;
		font-size: 18px;
	}

	button {
		padding: 8px 11px;
		border: 1px solid #3d5149;
		border-radius: 9px;
		background: #17231e;
		color: #cfe7dd;
		font: inherit;
		font-size: 12px;
		font-weight: 750;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		border-color: #6f9e8c;
		background: #1d3028;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.status {
		min-height: 18px;
		margin-top: 12px;
		color: #8f9a94;
		font-size: 12px;
	}

	.summary-scroll {
		height: 260px;
		margin-top: 10px;
		padding: 14px;
		overflow: auto;
		overscroll-behavior: contain;
		border: 1px solid #26332d;
		border-radius: 10px;
		background: #0a0f0d;
	}

	.summary-text {
		color: #e2ebe6;
		font-size: 15px;
		line-height: 1.68;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.placeholder {
		margin: 0;
		color: #69746e;
		font-size: 13px;
		line-height: 1.6;
	}

	footer {
		min-height: 28px;
		margin-top: 10px;
	}

	.messages {
		min-width: 0;
		flex-wrap: wrap;
		gap: 5px 10px;
		color: #85918b;
		font-size: 11px;
	}

	.error {
		color: #efaaa0;
	}

	.warning {
		color: #d7ba78;
	}

	.copy {
		flex: none;
	}

	@media (max-width: 720px) {
		.summary-scroll {
			height: 220px;
		}
	}
</style>
