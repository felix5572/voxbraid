<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { inlineErrorDetails } from '../error-details';
	import type { LocalSessionRepository } from '../persistence/local-session-repository';
	import type { CaptureRun } from '../session/types';
	import { activeCaptureRun, type TranslationSessionState } from '../session/translation-session';
	import type { StoredAutoSummary } from './auto-summary';
	import {
		EMPTY_CLEAN_TRANSCRIPT_CURSOR,
		cleanTranscriptCandidateFromBlock,
		cleanTranscriptContinuity,
		cleanTranscriptCursorForRun,
		CLEAN_TRANSCRIPT_TASK_VERSION,
		nextCleanTranscriptCandidate,
		nextCleanTranscriptSequence,
		type CleanTranscriptCandidate,
		type CleanTranscriptCursor,
		type CleanTranscriptFailureAttempt,
		type StoredCleanTranscriptBlock
	} from './clean-transcript';
	import { sendSidecarRequest, sidecarErrorDetails, sidecarLocalFailure } from './client';
	import { captureSidecarBlockContext, serializedUtf8Bytes, sidecarRequestFits } from './context';
	import type {
		SidecarErrorCode,
		SidecarInvokeRequest,
		SidecarInvokeResult,
		SidecarTrigger
	} from './types';

	interface ActiveCleanRequest {
		clientRequestId: string;
		sequence: number;
		runSequence: number;
		capturedAt: string;
		sourceStart: number;
		sourceEnd: number;
		translationStart: number;
		translationEnd: number;
	}

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
	let legacySummary = $state<StoredAutoSummary | null>(null);
	let blocks = $state<StoredCleanTranscriptBlock[]>([]);
	let phase = $state<'loading' | 'idle' | 'requesting' | 'failed'>('loading');
	let errorMessage = $state('');
	let persistenceMessage = $state('');
	let copyStatus = $state('');
	let loadedThreadId = $state<string | null>(null);
	let currentRequestId: string | null = null;
	let activeRequest = $state<ActiveCleanRequest | null>(null);
	let statusNowMs = $state(Date.now());
	let loadGeneration = 0;
	let observedThreadId: string | null = null;
	let observedRunId: string | null = null;
	let observedRunWasActive = false;
	const automaticBaselines = new SvelteMap<string, CleanTranscriptCursor>();
	const pendingRunEnds = new SvelteSet<string>();
	const REQUEST_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});

	const threadId = $derived(session?.thread.id ?? null);
	const hasTranscript = $derived(
		Boolean(
			session?.runs.some(
				(run) => run.sourceStream.text.length > 0 || run.translationStream.text.length > 0
			)
		)
	);
	const failedBlocks = $derived(blocks.filter((block) => block.status === 'failed'));
	const completedBlocks = $derived(blocks.filter((block) => block.status === 'completed'));
	const cleanText = $derived(
		[legacySummary?.text, ...completedBlocks.map((block) => block.text)]
			.filter((text): text is string => Boolean(text?.trim()))
			.join('\n\n')
	);
	const totalTokens = $derived(
		(legacySummary?.usage?.totalTokens ?? 0) +
			completedBlocks.reduce((total, block) => total + (block.usage?.totalTokens ?? 0), 0)
	);
	const latestModel = $derived(
		completedBlocks.at(-1)?.model ?? legacySummary?.model ?? 'gpt-5.6-terra'
	);

	function runCursor(run: CaptureRun, manual: boolean): CleanTranscriptCursor {
		if (blocks.some((block) => block.runId === run.id)) {
			return cleanTranscriptCursorForRun(blocks, run.id);
		}
		if (manual && !legacySummary) return { ...EMPTY_CLEAN_TRANSCRIPT_CURSOR };
		return automaticBaselines.get(run.id) ?? { ...EMPTY_CLEAN_TRANSCRIPT_CURSOR };
	}

	function candidateForRun(
		run: CaptureRun,
		manual: boolean,
		force: boolean,
		allowShort: boolean
	): CleanTranscriptCandidate | null {
		return nextCleanTranscriptCandidate(run, runCursor(run, manual), { force, allowShort });
	}

	async function loadTranscript(
		nextThreadId: string | null,
		nextRepository: LocalSessionRepository | null
	): Promise<void> {
		const generation = ++loadGeneration;
		currentRequestId = null;
		activeRequest = null;
		onRequestingChange(false);
		legacySummary = null;
		blocks = [];
		automaticBaselines.clear();
		pendingRunEnds.clear();
		errorMessage = '';
		persistenceMessage = '';
		copyStatus = '';
		loadedThreadId = null;
		phase = nextThreadId ? 'loading' : 'idle';
		if (!nextThreadId) return;

		let storedLegacy: StoredAutoSummary | null = null;
		let storedBlocks: StoredCleanTranscriptBlock[] = [];
		if (nextRepository) {
			try {
				[storedLegacy, storedBlocks] = await Promise.all([
					nextRepository.loadAutoSummary(nextThreadId),
					nextRepository.loadCleanTranscriptBlocks(nextThreadId)
				]);
			} catch (error) {
				console.error('[clean-transcript] restore failed', error);
				persistenceMessage = `课堂清稿记录读取失败；本页仍可继续生成。\n${inlineErrorDetails(error)}`;
			}
		}
		if (generation !== loadGeneration || session?.thread.id !== nextThreadId) return;

		legacySummary = storedLegacy;
		blocks = storedBlocks;
		for (const run of session?.runs ?? []) {
			if (storedBlocks.some((block) => block.runId === run.id)) continue;
			automaticBaselines.set(run.id, {
				sourceEnd: run.sourceStream.text.length,
				translationEnd: run.translationStream.text.length,
				sourceElapsedEndMs: run.sourceStream.lastElapsedMs,
				translationElapsedEndMs: run.translationStream.lastElapsedMs
			});
		}
		loadedThreadId = nextThreadId;
		phase = 'idle';
	}

	function localFailure(
		clientRequestId: string,
		code: SidecarErrorCode,
		message: string
	): SidecarInvokeResult {
		return sidecarLocalFailure(clientRequestId, code, message);
	}

	function timeLabel(timestamp: string): string {
		const parsed = new Date(timestamp);
		return Number.isNaN(parsed.getTime()) ? timestamp : REQUEST_TIME_FORMATTER.format(parsed);
	}

	function replaceBlock(block: StoredCleanTranscriptBlock): void {
		blocks = [...blocks.filter((candidate) => candidate.id !== block.id), block].sort(
			(left, right) => left.sequence - right.sequence
		);
	}

	function previousFailureAttempts(
		retry: StoredCleanTranscriptBlock | null
	): CleanTranscriptFailureAttempt[] {
		if (!retry) return [];
		if (retry.failureAttempts?.length) return retry.failureAttempts;
		if (retry.status !== 'failed' || !retry.error) return [];
		return [
			{
				capturedAt: retry.capturedAt,
				failedAt: retry.updatedAt,
				clientRequestId: retry.clientRequestId ?? '[旧记录未保存]',
				responseId: retry.responseId ?? null,
				model: retry.model,
				upstreamStatus: retry.upstreamStatus ?? null,
				errorCode: retry.errorCode ?? null,
				error: retry.error,
				diagnostic: retry.diagnostic ?? null
			}
		];
	}

	async function persistBlock(block: StoredCleanTranscriptBlock): Promise<void> {
		if (!repository) {
			persistenceMessage = '本地存储不可用；这份清稿只保留到页面关闭。';
			return;
		}
		try {
			await repository.saveCleanTranscriptBlock($state.snapshot(block));
		} catch (error) {
			console.error('[clean-transcript] save failed', error);
			persistenceMessage = `清稿已生成，但保存到本设备失败。\n${inlineErrorDetails(error)}`;
		}
	}

	async function requestBlock(
		candidate: CleanTranscriptCandidate,
		trigger: SidecarTrigger,
		retry: StoredCleanTranscriptBlock | null = null
	): Promise<boolean> {
		const capturedSession = session;
		if (!capturedSession || loadedThreadId !== capturedSession.thread.id) return false;

		const capturedAt = new Date().toISOString();
		const clientRequestId = crypto.randomUUID();
		const blockSequence = retry?.sequence ?? nextCleanTranscriptSequence(blocks);
		const request: SidecarInvokeRequest = {
			clientRequestId,
			intent: { kind: 'summarize', trigger, outputLanguage },
			context: captureSidecarBlockContext({
				threadId: capturedSession.thread.id,
				capturedAt,
				continuityText: cleanTranscriptContinuity(blocks, blockSequence),
				run: {
					runId: candidate.runId,
					sequence: candidate.runSequence,
					targetLanguage: candidate.targetLanguage,
					sourceText: candidate.sourceText,
					translationText: candidate.translationText
				}
			})
		};
		copyStatus = '';
		persistenceMessage = '';
		if (!sidecarRequestFits(request)) {
			const requestBytes = serializedUtf8Bytes(request);
			errorMessage = `当前清稿块为 ${requestBytes.toLocaleString()} 字节，超过 1,500,000 字节请求上限。`;
			phase = 'failed';
			return false;
		}

		currentRequestId = clientRequestId;
		activeRequest = {
			clientRequestId,
			sequence: blockSequence,
			runSequence: candidate.runSequence,
			capturedAt,
			sourceStart: candidate.sourceStart,
			sourceEnd: candidate.sourceEnd,
			translationStart: candidate.translationStart,
			translationEnd: candidate.translationEnd
		};
		phase = 'requesting';
		errorMessage = '';
		onRequestingChange(true);
		let result: SidecarInvokeResult;
		try {
			result = await sendSidecarRequest(request);
		} catch (error) {
			console.error('[clean-transcript] browser request failed', error);
			result = localFailure(clientRequestId, 'invalid-response', sidecarErrorDetails(error));
		}
		if (currentRequestId !== clientRequestId || session?.thread.id !== capturedSession.thread.id) {
			return false;
		}
		currentRequestId = null;
		activeRequest = null;
		onRequestingChange(false);

		const updatedAt = new Date().toISOString();
		const completed = result.status === 'completed' && result.outputText.trim().length > 0;
		const priorAttempts = previousFailureAttempts(retry);
		const failureAttempt: CleanTranscriptFailureAttempt | null =
			result.status === 'failed'
				? {
						capturedAt,
						failedAt: result.failedAt,
						clientRequestId,
						responseId: result.responseId,
						model: result.model,
						upstreamStatus: result.upstreamStatus,
						errorCode: result.error.code,
						error: `${result.error.code}：${result.error.message}`,
						diagnostic: result.diagnostic ?? null
					}
				: null;
		const block: StoredCleanTranscriptBlock = {
			id: retry?.id ?? crypto.randomUUID(),
			threadId: capturedSession.thread.id,
			runId: candidate.runId,
			sequence: blockSequence,
			runSequence: candidate.runSequence,
			targetLanguage: candidate.targetLanguage,
			sourceStart: candidate.sourceStart,
			sourceEnd: candidate.sourceEnd,
			translationStart: candidate.translationStart,
			translationEnd: candidate.translationEnd,
			sourceElapsedEndMs: candidate.sourceElapsedEndMs,
			translationElapsedEndMs: candidate.translationElapsedEndMs,
			status: completed ? 'completed' : 'failed',
			text: result.outputText ?? '',
			capturedAt,
			model: result.model,
			taskVersion: CLEAN_TRANSCRIPT_TASK_VERSION,
			usageStatus: result.usageStatus,
			usage: result.usage,
			clientRequestId,
			responseId: result.responseId,
			upstreamStatus: result.status === 'failed' ? result.upstreamStatus : null,
			errorCode: result.status === 'failed' ? result.error.code : null,
			diagnostic: result.status === 'failed' ? (result.diagnostic ?? null) : null,
			failureAttempts: failureAttempt ? [...priorAttempts, failureAttempt] : priorAttempts,
			error: completed
				? null
				: result.status === 'failed'
					? `${result.error.code}：${result.error.message}`
					: '模型未返回清稿。',
			updatedAt
		};
		replaceBlock(block);
		await persistBlock(block);
		if (!completed) {
			phase = 'idle';
			errorMessage = block.error ?? '当前清稿块生成失败。';
			return false;
		}
		phase = 'idle';
		return true;
	}

	function firstManualCandidate(): {
		candidate: CleanTranscriptCandidate;
		retry: StoredCleanTranscriptBlock | null;
	} | null {
		const capturedSession = session;
		if (!capturedSession) return null;
		const failed = [...failedBlocks].sort((left, right) => left.sequence - right.sequence)[0];
		if (failed) {
			const run = capturedSession.runs.find((candidate) => candidate.id === failed.runId);
			if (!run)
				throw new Error(`Run not found for failed clean transcript block: ${failed.runId}.`);
			return { candidate: cleanTranscriptCandidateFromBlock(run, failed), retry: failed };
		}
		for (const run of capturedSession.runs) {
			const candidate = candidateForRun(run, true, true, true);
			if (candidate) return { candidate, retry: null };
		}
		return null;
	}

	async function processManual(): Promise<void> {
		if (disabled || phase === 'loading' || phase === 'requesting' || !session) return;
		errorMessage = '';
		while (true) {
			const next = firstManualCandidate();
			if (!next) {
				phase = 'idle';
				return;
			}
			if (!(await requestBlock(next.candidate, 'manual', next.retry))) return;
		}
	}

	async function rebuildAll(): Promise<void> {
		const capturedSession = session;
		if (
			disabled ||
			phase === 'loading' ||
			phase === 'requesting' ||
			!capturedSession ||
			!hasTranscript
		) {
			return;
		}
		phase = 'requesting';
		activeRequest = null;
		errorMessage = '';
		persistenceMessage = '';
		copyStatus = '';
		onRequestingChange(true);
		if (repository) {
			try {
				await repository.clearCleanTranscript(capturedSession.thread.id);
			} catch (error) {
				console.error('[clean-transcript] clear failed', error);
				phase = 'failed';
				errorMessage = `无法清除旧清稿；原字幕和现有清稿均未改变。\n${inlineErrorDetails(error)}`;
				onRequestingChange(false);
				return;
			}
		}
		if (session?.thread.id !== capturedSession.thread.id) return;
		legacySummary = null;
		blocks = [];
		automaticBaselines.clear();
		pendingRunEnds.clear();
		phase = 'idle';
		onRequestingChange(false);
		await processManual();
	}

	async function copyTranscript(): Promise<void> {
		if (!cleanText) return;
		try {
			await navigator.clipboard.writeText(cleanText);
			copyStatus = '已复制';
		} catch (error) {
			console.error('[clean-transcript] copy failed', error);
			copyStatus = '复制失败，请手动选择文本';
		}
	}

	$effect(() => {
		void loadTranscript(threadId, repository);
	});

	$effect(() => {
		if (phase !== 'requesting' || !activeRequest) return;
		statusNowMs = Date.now();
		const timer = window.setInterval(() => {
			statusNowMs = Date.now();
		}, 1_000);
		return () => window.clearInterval(timer);
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
		if (
			latestRun &&
			observedThreadId === currentThreadId &&
			observedRunId === latestRun?.id &&
			observedRunWasActive &&
			!latestRunIsActive
		) {
			pendingRunEnds.add(latestRun.id);
		}
		observedThreadId = currentThreadId;
		observedRunId = latestRun?.id ?? null;
		observedRunWasActive = latestRunIsActive;

		if (!currentThreadId || loadedThreadId !== currentThreadId || disabled || phase !== 'idle') {
			return;
		}
		const finalizingRun = session?.runs.find(
			(candidate) => pendingRunEnds.has(candidate.id) && candidate.id !== activeRun?.id
		);
		const run = finalizingRun ?? activeRun;
		if (!run) return;
		const finalizing = Boolean(finalizingRun);
		const candidate = candidateForRun(run, false, finalizing, false);
		if (finalizing && !candidate) pendingRunEnds.delete(run.id);
		if (candidate) void requestBlock(candidate, 'periodic');
	});
</script>

<section class="panel" aria-labelledby="auto-summary-title">
	<header>
		<div>
			<p class="eyebrow">CLEAN TRANSCRIPT</p>
			<h3 id="auto-summary-title">课堂清稿</h3>
		</div>
		<div class="actions">
			{#if cleanText}
				<button
					type="button"
					class="secondary"
					disabled={disabled || phase === 'loading' || phase === 'requesting' || !hasTranscript}
					onclick={() => void rebuildAll()}>重新整理全部</button
				>
			{/if}
			<button
				type="button"
				disabled={disabled || phase === 'loading' || phase === 'requesting' || !hasTranscript}
				onclick={() => void processManual()}
			>
				{failedBlocks.length > 0 ? '重试失败块' : '整理未处理内容'}
			</button>
		</div>
	</header>

	<div class="status" aria-live="polite">
		{#if phase === 'loading'}
			正在读取本地清稿…
		{:else if phase === 'requesting'}
			{#if activeRequest}
				正在整理第 {activeRequest.sequence} 块 · {timeLabel(activeRequest.capturedAt)} 发起 · 第
				{activeRequest.runSequence} 段 · 原文
				{activeRequest.sourceEnd - activeRequest.sourceStart} 字 / 译文
				{activeRequest.translationEnd - activeRequest.translationStart} 字 · 请求
				{activeRequest.clientRequestId.slice(0, 8)} · 已等待
				{Math.max(0, Math.floor((statusNowMs - Date.parse(activeRequest.capturedAt)) / 1_000))} 秒 · 等待预算检查与模型生成
			{:else}
				正在准备重新整理全部…
			{/if}
		{:else if failedBlocks.length > 0}
			有 {failedBlocks.length} 个块失败；后续内容不会覆盖它，可手动重试。
		{:else if cleanText}
			已整理 {completedBlocks.length} 个新块 · {latestModel}
		{:else}
			每约 5,000 个原文字符自动追加一块；暂停时会尝试收尾。
		{/if}
	</div>

	<div class="summary-scroll">
		{#if legacySummary}
			<div class="summary-text legacy">{legacySummary.text}</div>
		{/if}
		{#each blocks as block (block.id)}
			{#if block.status === 'completed'}
				<div class="summary-text block">{block.text}</div>
			{:else}
				<div class="failed-block" role="alert">
					<strong>第 {block.sequence} 块未整理成功</strong>
					<span class="failure-meta">
						{timeLabel(block.capturedAt)} 发起 · {timeLabel(block.updatedAt)} 失败 · 第
						{block.runSequence} 段
					</span>
					<span class="failure-meta">
						原文字符 {block.sourceStart}–{block.sourceEnd} · 译文字符
						{block.translationStart}–{block.translationEnd} · {block.model ?? '模型未确认'}
					</span>
					{#if block.diagnostic}
						<span class="failure-meta diagnostic-id">
							耗时 {block.diagnostic.durationMs ?? '未知'} ms · 页面
							{block.diagnostic.visibilityState ?? '未知'} · online
							{String(block.diagnostic.online ?? '未知')} · HTTP
							{block.diagnostic.httpStatus ?? '未收到'} · 请求
							{block.diagnostic.requestBytes ?? '未知'} bytes
						</span>
					{/if}
					{#if block.clientRequestId}
						<span class="failure-meta diagnostic-id">
							client request {block.clientRequestId}{#if block.responseId}
								· OpenAI response {block.responseId}
							{/if}
						</span>
					{/if}
					<code>{block.error}</code>
					{#if (block.failureAttempts?.length ?? 0) > 1}
						<details>
							<summary>查看之前 {block.failureAttempts!.length - 1} 次失败</summary>
							{#each block.failureAttempts!.slice(0, -1) as attempt (attempt.clientRequestId)}
								<code>
									{timeLabel(attempt.capturedAt)} · {attempt.clientRequestId} · {attempt.error}
								</code>
							{/each}
						</details>
					{/if}
					{#if block.text.trim()}<div class="partial">{block.text}</div>{/if}
				</div>
			{/if}
		{/each}
		{#if !cleanText && failedBlocks.length === 0}
			<p class="placeholder">清稿会按块稳定追加，不会随着模型生成逐字跳动。</p>
		{/if}
	</div>

	<footer>
		<div class="messages">
			{#if errorMessage}<span class="error" role="alert">{errorMessage}</span>{/if}
			{#if persistenceMessage}<span class="warning">{persistenceMessage}</span>{/if}
			{#if totalTokens > 0}<span>累计 {totalTokens} tokens</span>{/if}
		</div>
		{#if cleanText}
			<button type="button" class="copy" onclick={() => void copyTranscript()}>
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
	.messages,
	.actions {
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

	.actions {
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	button.secondary {
		background: transparent;
		color: #9aaba3;
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
		height: 300px;
		margin-top: 10px;
		padding: 14px;
		overflow: auto;
		overscroll-behavior: contain;
		border: 1px solid #26332d;
		border-radius: 10px;
		background: #0a0f0d;
	}

	.summary-text,
	.partial {
		color: #e2ebe6;
		font-size: 15px;
		line-height: 1.68;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.summary-text.block,
	.failed-block {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid #223029;
	}

	.failure-meta {
		color: #89968f;
	}

	.diagnostic-id {
		overflow-wrap: anywhere;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 10px;
	}

	.failed-block code {
		overflow-wrap: anywhere;
		color: #efaaa0;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 11px;
		line-height: 1.5;
		white-space: pre-wrap;
	}

	.failed-block {
		display: grid;
		gap: 5px;
		color: #efaaa0;
		font-size: 12px;
	}

	.partial {
		margin-top: 8px;
		color: #c9d2cd;
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
		white-space: pre-wrap;
	}

	.warning {
		color: #d7ba78;
		white-space: pre-wrap;
	}

	.copy {
		flex: none;
	}

	@media (max-width: 720px) {
		.summary-scroll {
			height: 250px;
		}
	}
</style>
