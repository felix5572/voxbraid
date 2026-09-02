<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { inlineErrorDetails } from '../error-details';
	import type { LocalSessionRepository } from '../persistence/local-session-repository';
	import type { CaptureRun } from '../session/types';
	import { activeCaptureRun, type TranslationSessionState } from '../session/translation-session';
	import { sendSidecarRequest, sidecarLocalFailure } from '../sidecar/client';
	import type {
		SidecarInvokeRequest,
		SidecarInvokeResult,
		SidecarTranslationPairContinuity,
		SidecarTrigger
	} from '../sidecar/types';
	import {
		isCurrentProvisionalBatch,
		type StoredTranslationPairBatch,
		type StoredTranslationPairSegment,
		type TranslationPairFailureAttempt
	} from './translation-pair-records';
	import {
		EMPTY_TRANSLATION_PAIR_CURSOR,
		nextProvisionalTranslationPairCandidate,
		TRANSLATION_PAIR_CONTINUITY_CHARACTERS,
		TRANSLATION_PAIR_POLICY,
		translationPairCandidateFromRange,
		type TranslationPairCandidate,
		type TranslationPairCursor
	} from './source-atoms';
	import { ProjectionWorker } from './projection-worker';
	import { parseTranslationPairModelOutput } from './translation-pair-output';

	interface Props {
		session: TranslationSessionState | null;
		repository: LocalSessionRepository | null;
		disabled?: boolean;
		onRequestingChange?: (requesting: boolean) => void;
	}

	interface ActiveRequest {
		clientRequestId: string;
		runSequence: number;
		batchSequence: number;
		capturedAt: string;
		sourceStart: number;
		sourceEnd: number;
	}

	let {
		session,
		repository,
		disabled = false,
		onRequestingChange = () => undefined
	}: Props = $props();
	let batches = $state<StoredTranslationPairBatch[]>([]);
	let segments = $state<StoredTranslationPairSegment[]>([]);
	let phase = $state<'loading' | 'idle' | 'requesting' | 'paused'>('loading');
	let loadedThreadId = $state<string | null>(null);
	let activeRequest = $state<ActiveRequest | null>(null);
	const worker = new ProjectionWorker();
	let statusNowMs = $state(Date.now());
	let errorMessage = $state('');
	let persistenceMessage = $state('');
	let consecutiveInfrastructureFailures = $state(0);
	let scroller: HTMLDivElement;
	let following = $state(true);
	const automaticBaselines = new SvelteMap<string, number>();
	const pendingSince = new SvelteMap<string, number>();
	const threadId = $derived(session?.thread.id ?? null);
	const failedBatches = $derived(batches.filter((batch) => batch.status === 'failed'));
	const completedSegments = $derived(
		segments.filter((segment) =>
			batches.some((batch) => batch.id === segment.batchId && batch.status === 'completed')
		)
	);

	function batchesForRun(runId: string): StoredTranslationPairBatch[] {
		return batches
			.filter((batch) => batch.runId === runId)
			.sort((left, right) => left.sequence - right.sequence);
	}

	function cursorForRun(run: CaptureRun, manual: boolean): TranslationPairCursor {
		const latest = batchesForRun(run.id).at(-1);
		if (latest) {
			return {
				sourceEnd: latest.sourceEnd,
				sourceElapsedEndMs: latest.sourceElapsedEndMs
			};
		}
		if (manual) return { ...EMPTY_TRANSLATION_PAIR_CURSOR };
		return {
			sourceEnd: automaticBaselines.get(run.id) ?? 0,
			sourceElapsedEndMs: 0
		};
	}

	function nextBatchSequence(runId: string): number {
		return (
			batchesForRun(runId).reduce((maximum, batch) => Math.max(maximum, batch.sequence), 0) + 1
		);
	}

	function continuityBefore(
		runSequence: number,
		sourceStart: number
	): SidecarTranslationPairContinuity[] {
		const previous = completedSegments
			.filter(
				(segment) =>
					segment.runSequence < runSequence ||
					(segment.runSequence === runSequence && segment.sourceEnd <= sourceStart)
			)
			.sort(
				(left, right) =>
					left.runSequence - right.runSequence || left.sourceStart - right.sourceStart
			)
			.slice(-2)
			.map((segment) => ({
				sourceText: segment.sourceText,
				translatedText: segment.translatedText
			}));
		let remaining = TRANSLATION_PAIR_CONTINUITY_CHARACTERS;
		const result: SidecarTranslationPairContinuity[] = [];
		for (const item of previous.reverse()) {
			if (remaining <= 1) break;
			const half = Math.max(1, Math.floor(remaining / 2));
			const sourceText = item.sourceText.slice(-half);
			const translatedText = item.translatedText.slice(-(remaining - sourceText.length));
			if (!sourceText || !translatedText) continue;
			result.unshift({ sourceText, translatedText });
			remaining -= sourceText.length + translatedText.length;
		}
		return result;
	}

	function failureAttempts(
		batch: StoredTranslationPairBatch | null
	): TranslationPairFailureAttempt[] {
		if (!batch) return [];
		if (batch.failureAttempts.length > 0) return batch.failureAttempts;
		if (batch.status !== 'failed' || !batch.error) return [];
		return [
			{
				capturedAt: batch.capturedAt,
				failedAt: batch.updatedAt,
				clientRequestId: batch.clientRequestId,
				responseId: batch.responseId,
				model: batch.model,
				upstreamStatus: batch.upstreamStatus,
				errorCode: batch.errorCode,
				error: batch.error,
				diagnostic: batch.diagnostic
			}
		];
	}

	function infrastructureFailure(result: SidecarInvokeResult): boolean {
		return (
			result.status === 'failed' &&
			(result.error.code === 'browser-network-failed' ||
				result.error.code === 'request-timeout' ||
				result.error.code === 'upstream-failed')
		);
	}

	function replaceProjection(
		batch: StoredTranslationPairBatch,
		nextSegments: StoredTranslationPairSegment[]
	): void {
		batches = [...batches.filter((item) => item.id !== batch.id), batch].sort(
			(left, right) => left.runSequence - right.runSequence || left.sequence - right.sequence
		);
		segments = [...segments.filter((item) => item.batchId !== batch.id), ...nextSegments].sort(
			(left, right) =>
				left.runSequence - right.runSequence ||
				left.sourceStart - right.sourceStart ||
				left.sequence - right.sequence
		);
	}

	async function persistProjection(
		capturedRepository: LocalSessionRepository | null,
		batch: StoredTranslationPairBatch,
		nextSegments: StoredTranslationPairSegment[],
		facts: { thread: TranslationSessionState['thread']; run: CaptureRun; checkpointedAt: string }
	): Promise<void> {
		if (!capturedRepository) {
			persistenceMessage = '本地存储不可用；本页关闭后句段对照会丢失。';
			return;
		}
		try {
			await capturedRepository.saveTranslationPairBatch({
				batch: $state.snapshot(batch),
				segments: $state.snapshot(nextSegments),
				facts: $state.snapshot(facts)
			});
		} catch (error) {
			console.error('[translation-pairs] save failed', error);
			persistenceMessage = `句段对照已生成，但保存到本设备失败。\n${inlineErrorDetails(error)}`;
		}
	}

	function buildSegments(
		batchId: string,
		revision: number,
		candidate: TranslationPairCandidate,
		outputText: string,
		createdAt: string
	): StoredTranslationPairSegment[] {
		const output = parseTranslationPairModelOutput(
			outputText,
			candidate.atoms.map((atom) => atom.id)
		);
		const atomsById = new Map(candidate.atoms.map((atom) => [atom.id, atom]));
		return output.groups.map((group, index) => {
			const first = atomsById.get(group.atomIds[0]);
			const last = atomsById.get(group.atomIds.at(-1)!);
			if (!first || !last) throw new Error('Validated pair output lost a source atom.');
			return {
				id: `${batchId}:${revision}:${index + 1}`,
				batchId,
				batchRevision: revision,
				threadId: session?.thread.id ?? '',
				runId: candidate.runId,
				runSequence: candidate.runSequence,
				sequence: index + 1,
				sourceStart: first.sourceStart,
				sourceEnd: last.sourceEnd,
				sourceText: candidate.sourceText.slice(
					first.sourceStart - candidate.sourceStart,
					last.sourceEnd - candidate.sourceStart
				),
				translatedText: group.translatedText,
				paragraphBreakBefore: group.paragraphBreakBefore,
				createdAt
			};
		});
	}

	async function requestCandidate(
		candidate: TranslationPairCandidate,
		retry: StoredTranslationPairBatch | null = null,
		trigger: SidecarTrigger = 'periodic'
	): Promise<boolean> {
		const capturedSession = session;
		const capturedRepository = repository;
		if (!capturedSession || loadedThreadId !== capturedSession.thread.id) return false;
		const capturedThreadId = capturedSession.thread.id;
		const capturedAt = new Date().toISOString();
		const capturedRun = capturedSession.runs.find((run) => run.id === candidate.runId);
		if (!capturedRun) return false;
		const capturedFacts = $state.snapshot({
			thread: capturedSession.thread,
			run: capturedRun,
			checkpointedAt: capturedAt
		});
		const clientRequestId = crypto.randomUUID();
		const batchId = retry?.id ?? crypto.randomUUID();
		const batchSequence = retry?.sequence ?? nextBatchSequence(candidate.runId);
		const revision = (retry?.revision ?? 0) + 1;
		const capturedRetrySegments = retry
			? $state.snapshot(segments.filter((segment) => segment.batchId === retry.id))
			: [];
		const request: SidecarInvokeRequest = {
			clientRequestId,
			intent: {
				kind: 'translate-pairs',
				trigger,
				targetLanguage: candidate.targetLanguage,
				atoms: candidate.atoms.map((atom) => ({ id: atom.id, text: atom.text })),
				continuity: continuityBefore(candidate.runSequence, candidate.sourceStart)
			},
			context: {
				threadId: capturedThreadId,
				scope: 'latest-run',
				capturedAt,
				continuityText: '',
				cleanedTranscript: '',
				runs: [
					{
						runId: candidate.runId,
						sequence: candidate.runSequence,
						targetLanguage: candidate.targetLanguage,
						sourceText: candidate.sourceText,
						translationText: ''
					}
				]
			}
		};
		worker.beginRequest(clientRequestId, capturedThreadId);
		activeRequest = {
			clientRequestId,
			runSequence: candidate.runSequence,
			batchSequence,
			capturedAt,
			sourceStart: candidate.sourceStart,
			sourceEnd: candidate.sourceEnd
		};
		phase = 'requesting';
		errorMessage = '';
		onRequestingChange(true);
		let result: SidecarInvokeResult;
		try {
			result = await sendSidecarRequest(request);
		} catch (error) {
			console.error('[translation-pairs] browser request failed', error);
			result = sidecarLocalFailure(clientRequestId, 'invalid-response', inlineErrorDetails(error));
		}
		const updatedAt = new Date().toISOString();
		let nextSegments: StoredTranslationPairSegment[] = [];
		let localValidationError: string | null = null;
		if (result.status === 'completed') {
			try {
				nextSegments = buildSegments(
					batchId,
					revision,
					candidate,
					result.outputText,
					updatedAt
				).map((segment) => ({ ...segment, threadId: capturedThreadId }));
			} catch (error) {
				localValidationError = inlineErrorDetails(error);
				result = sidecarLocalFailure(
					clientRequestId,
					'invalid-response',
					`浏览器无法验证句段对照响应。\n${localValidationError}`
				);
			}
		}
		const completed = result.status === 'completed' && nextSegments.length > 0;
		const previousAttempts = failureAttempts(retry);
		const nextAttempt: TranslationPairFailureAttempt | null =
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
		if (!completed && retry?.status === 'completed') {
			const retained: StoredTranslationPairBatch = {
				...retry,
				errorCode: result.status === 'failed' ? result.error.code : 'invalid-response',
				error:
					result.status === 'failed'
						? `${result.error.code}：${result.error.message}`
						: 'invalid-response：模型未返回句段。',
				diagnostic: result.status === 'failed' ? (result.diagnostic ?? null) : null,
				failureAttempts: nextAttempt ? [...previousAttempts, nextAttempt] : previousAttempts,
				updatedAt
			};
			const retainedSegments = capturedRetrySegments;
			await persistProjection(capturedRepository, retained, retainedSegments, capturedFacts);
			const stillCurrent =
				loadedThreadId === capturedThreadId &&
				worker.ownsRequest(clientRequestId, capturedThreadId);
			if (stillCurrent) {
				replaceProjection(retained, retainedSegments);
				errorMessage = retained.error ?? '暂定句段更新失败；已保留上一版。';
			}
			if (worker.finishRequest(clientRequestId)) {
				activeRequest = null;
				onRequestingChange(false);
			}
			if (infrastructureFailure(result)) consecutiveInfrastructureFailures += 1;
			else consecutiveInfrastructureFailures = 0;
			phase = consecutiveInfrastructureFailures >= 3 ? 'paused' : 'idle';
			return false;
		}
		const batch: StoredTranslationPairBatch = {
			id: batchId,
			threadId: capturedThreadId,
			runId: candidate.runId,
			runSequence: candidate.runSequence,
			sequence: batchSequence,
			revision,
			projectionState: candidate.projectionState,
			targetLanguage: candidate.targetLanguage,
			sourceStart: candidate.sourceStart,
			sourceEnd: candidate.sourceEnd,
			sourceElapsedEndMs: candidate.sourceElapsedEndMs,
			status: completed ? 'completed' : 'failed',
			capturedAt,
			completedAt: completed && result.status === 'completed' ? result.completedAt : null,
			model: result.model,
			taskVersion: 1,
			clientRequestId,
			responseId: result.responseId,
			usageStatus: result.usageStatus,
			usage: result.usage,
			upstreamStatus: result.status === 'failed' ? result.upstreamStatus : null,
			errorCode: result.status === 'failed' ? result.error.code : null,
			error:
				result.status === 'failed'
					? `${result.error.code}：${result.error.message}`
					: completed
						? null
						: `invalid-response：${localValidationError ?? '模型未返回句段。'}`,
			diagnostic: result.status === 'failed' ? (result.diagnostic ?? null) : null,
			failureAttempts: nextAttempt ? [...previousAttempts, nextAttempt] : previousAttempts,
			updatedAt
		};
		await persistProjection(capturedRepository, batch, nextSegments, capturedFacts);
		const stillCurrent =
			loadedThreadId === capturedThreadId && worker.ownsRequest(clientRequestId, capturedThreadId);
		if (stillCurrent) replaceProjection(batch, nextSegments);
		if (worker.finishRequest(clientRequestId)) {
			activeRequest = null;
			onRequestingChange(false);
		}
		if (!completed) {
			if (infrastructureFailure(result)) consecutiveInfrastructureFailures += 1;
			else consecutiveInfrastructureFailures = 0;
			if (consecutiveInfrastructureFailures >= 3) phase = 'paused';
			else phase = 'idle';
			if (stillCurrent) errorMessage = batch.error ?? '当前句段对照生成失败。';
			return false;
		}
		consecutiveInfrastructureFailures = 0;
		phase = 'idle';
		return true;
	}

	function candidateForRun(run: CaptureRun, manual: boolean): TranslationPairCandidate | null {
		const cursor = cursorForRun(run, manual);
		const sourceRemaining = run.sourceStream.text.length - cursor.sourceEnd;
		if (sourceRemaining <= 0) {
			pendingSince.delete(run.id);
			return null;
		}
		if (!pendingSince.has(run.id)) pendingSince.set(run.id, statusNowMs);
		const active = run.status === 'starting' || run.status === 'live' || run.status === 'stopping';
		return TRANSLATION_PAIR_POLICY.nextCandidate(run, cursor, {
			nowMs: statusNowMs,
			pendingSinceMs: pendingSince.get(run.id) ?? statusNowMs,
			finalizing: manual || !active
		});
	}

	function automaticWorkForRun(run: CaptureRun): {
		candidate: TranslationPairCandidate;
		retry: StoredTranslationPairBatch | null;
	} | null {
		const latest = batchesForRun(run.id).at(-1);
		if (
			latest?.status === 'completed' &&
			latest.projectionState === 'provisional' &&
			run.sourceStream.text.length > latest.sourceEnd
		) {
			if (!pendingSince.has(run.id)) pendingSince.set(run.id, statusNowMs);
			const active =
				run.status === 'starting' || run.status === 'live' || run.status === 'stopping';
			const candidate = nextProvisionalTranslationPairCandidate(
				run,
				{
					sourceStart: latest.sourceStart,
					sourceEnd: latest.sourceEnd,
					runSequence: latest.runSequence,
					targetLanguage: latest.targetLanguage
				},
				{
					nowMs: statusNowMs,
					pendingSinceMs: pendingSince.get(run.id) ?? statusNowMs,
					finalizing: !active
				}
			);
			if (candidate) return { candidate, retry: latest };
		}
		const candidate = candidateForRun(run, false);
		return candidate ? { candidate, retry: null } : null;
	}

	function nextManual(): {
		candidate: TranslationPairCandidate;
		retry: StoredTranslationPairBatch | null;
	} | null {
		if (!session) return null;
		const failed = [...failedBatches].sort(
			(left, right) => left.runSequence - right.runSequence || left.sequence - right.sequence
		)[0];
		if (failed) {
			const run = session.runs.find((item) => item.id === failed.runId);
			if (!run) throw new Error(`Run not found for pair batch ${failed.id}.`);
			return {
				retry: failed,
				candidate: translationPairCandidateFromRange(run, {
					sourceStart: failed.sourceStart,
					sourceEnd: failed.sourceEnd,
					sourceElapsedEndMs: failed.sourceElapsedEndMs,
					runSequence: failed.runSequence,
					targetLanguage: failed.targetLanguage
				})
			};
		}
		for (const run of session.runs) {
			const candidate = candidateForRun(run, true);
			if (candidate) return { candidate, retry: null };
		}
		return null;
	}

	async function processManual(): Promise<void> {
		if (disabled || phase === 'loading' || phase === 'requesting' || !session) return;
		phase = 'idle';
		consecutiveInfrastructureFailures = 0;
		errorMessage = '';
		while (true) {
			const next = nextManual();
			if (!next) return;
			if (!(await requestCandidate(next.candidate, next.retry, 'manual'))) return;
		}
	}

	async function loadProjection(
		nextThreadId: string | null,
		nextRepository: LocalSessionRepository | null
	): Promise<void> {
		const generation = worker.beginLoad();
		batches = [];
		segments = [];
		automaticBaselines.clear();
		pendingSince.clear();
		errorMessage = '';
		persistenceMessage = '';
		loadedThreadId = null;
		phase = worker.requesting ? 'requesting' : nextThreadId ? 'loading' : 'idle';
		if (!nextThreadId) return;
		if (nextRepository) {
			try {
				const stored = await nextRepository.loadTranslationPairProjection(nextThreadId);
				if (!worker.ownsLoad(generation) || session?.thread.id !== nextThreadId) return;
				batches = stored.batches;
				segments = stored.segments;
			} catch (error) {
				console.error('[translation-pairs] restore failed', error);
				persistenceMessage = `句段对照记录读取失败；本页仍可继续生成。\n${inlineErrorDetails(error)}`;
			}
		}
		if (!worker.ownsLoad(generation) || session?.thread.id !== nextThreadId) return;
		for (const run of session?.runs ?? []) {
			if (batches.some((batch) => batch.runId === run.id)) continue;
			automaticBaselines.set(run.id, run.sourceStream.text.length);
		}
		loadedThreadId = nextThreadId;
		phase = worker.requesting ? 'requesting' : 'idle';
	}

	function updateFollow(): void {
		following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
	}

	function resumeFollowing(): void {
		following = true;
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	function requestTime(timestamp: string): string {
		const parsed = new Date(timestamp);
		return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleTimeString();
	}

	function waitingStatus(): string {
		const run = session ? (activeCaptureRun(session) ?? session.runs.at(-1)) : null;
		if (!run) return '等待原文字幕。';
		const cursor = cursorForRun(run, false);
		const pendingAt = pendingSince.get(run.id) ?? null;
		const progress = TRANSLATION_PAIR_POLICY.progress(run, cursor, {
			nowMs: statusNowMs,
			pendingSinceMs: pendingAt,
			finalizing: false
		});
		const reason =
			progress.waitingFor === 'nothing'
				? '等待新原文'
				: progress.waitingFor === 'sentence-ending'
					? '等待句末'
					: progress.waitingFor === 'quiet-window'
						? '等待短暂停顿'
						: '准备下一批';
		return `第 ${run.sequence} 段 · 已处理到 ${cursor.sourceEnd} 字 · 待处理 ${progress.sourceRemaining} 字 · ${reason}`;
	}

	$effect(() => {
		const nextThreadId = threadId;
		const nextRepository = repository;
		untrack(() => void loadProjection(nextThreadId, nextRepository));
	});

	$effect(() => {
		if (!threadId) return;
		statusNowMs = Date.now();
		const timer = window.setInterval(() => (statusNowMs = Date.now()), 1_000);
		return () => window.clearInterval(timer);
	});

	$effect(() => {
		const currentThreadId = threadId;
		const activeRun = session ? activeCaptureRun(session) : null;
		if (
			!currentThreadId ||
			loadedThreadId !== currentThreadId ||
			disabled ||
			phase !== 'idle' ||
			document.visibilityState !== 'visible' ||
			!navigator.onLine
		) {
			return;
		}
		let work: ReturnType<typeof automaticWorkForRun> = null;
		for (const run of session?.runs ?? []) {
			if (run.id === activeRun?.id) continue;
			work = automaticWorkForRun(run);
			if (work) break;
		}
		work ??= activeRun ? automaticWorkForRun(activeRun) : null;
		if (work) void requestCandidate(work.candidate, work.retry, 'periodic');
	});

	$effect(() => {
		const latestSegmentId = completedSegments.at(-1)?.id;
		if (!latestSegmentId) return;
		void tick().then(() => {
			if (following && scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	});
</script>

<section class="panel" aria-labelledby="translation-pairs-title">
	<header>
		<div>
			<p class="eyebrow">ALIGNED TRANSLATION</p>
			<h3 id="translation-pairs-title">句段对照</h3>
		</div>
		<button
			type="button"
			disabled={disabled || phase === 'loading' || phase === 'requesting' || !session}
			onclick={() => void processManual()}
		>
			{failedBatches.length > 0
				? '重试失败句段'
				: phase === 'paused'
					? '恢复自动生成'
					: '生成未处理内容'}
		</button>
	</header>

	<div class="status" aria-live="polite">
		{#if phase === 'loading'}
			正在读取本地句段对照…
		{:else if phase === 'requesting' && activeRequest}
			正在生成第 {activeRequest.runSequence} 段 / 第 {activeRequest.batchSequence} 批 ·
			{requestTime(activeRequest.capturedAt)} 发起 · 原文 {activeRequest.sourceStart}–{activeRequest.sourceEnd}
			· 已等待 {Math.max(
				0,
				Math.floor((statusNowMs - Date.parse(activeRequest.capturedAt)) / 1_000)
			)} 秒
		{:else if phase === 'paused'}
			连续 {consecutiveInfrastructureFailures} 次基础设施失败，自动生成已暂停。
		{:else}
			{waitingStatus()}
		{/if}
	</div>

	<div class="column-head" aria-hidden="true"><span>原文事实</span><span>独立译文</span></div>
	<div class="pairs-scroll" bind:this={scroller} onscroll={updateFollow}>
		{#if completedSegments.length === 0 && failedBatches.length === 0}
			<p class="placeholder">完整句段会整批稳定追加，不会逐词左右跳动。</p>
		{/if}
		{#each batches as batch (batch.id)}
			{#if batch.status === 'failed'}
				<div class="failed" role="alert">
					<strong>第 {batch.runSequence} 段 / 第 {batch.sequence} 批生成失败</strong>
					<span>原文 {batch.sourceStart}–{batch.sourceEnd} · request {batch.clientRequestId}</span>
					{#if batch.diagnostic}
						<span>
							耗时 {batch.diagnostic.durationMs ?? '未知'} ms · 页面 {batch.diagnostic
								.visibilityState ?? '未知'}
							· online {String(batch.diagnostic.online ?? '未知')} · HTTP {batch.diagnostic
								.httpStatus ?? '未收到'}
						</span>
					{/if}
					<code>{batch.error}</code>
				</div>
			{:else}
				{#each segments.filter((segment) => segment.batchId === batch.id) as segment (segment.id)}
					<div class:paragraph-break={segment.paragraphBreakBefore} class="pair-row">
						<div class="source">{segment.sourceText.trim()}</div>
						<div class="translation">{segment.translatedText}</div>
						{#if isCurrentProvisionalBatch(batch, batches)}<span class="provisional">暂定</span
							>{/if}
					</div>
				{/each}
			{/if}
		{/each}
	</div>

	<footer>
		<div>
			{#if errorMessage}<span class="error" role="alert">{errorMessage}</span>{/if}
			{#if persistenceMessage}<span class="warning">{persistenceMessage}</span>{/if}
		</div>
		{#if !following}<button type="button" class="secondary" onclick={resumeFollowing}
				>回到最新</button
			>{/if}
	</footer>
</section>

<style>
	.panel {
		padding: 16px;
		border: 1px solid #29322e;
		border-radius: 14px;
		background: #090d0c;
	}

	header,
	footer,
	.column-head,
	.pair-row {
		display: flex;
	}

	header,
	footer {
		align-items: center;
		justify-content: space-between;
		gap: 14px;
	}

	.eyebrow {
		margin: 0 0 2px;
		color: #72b39e;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.15em;
	}

	h3 {
		margin: 0;
		font-size: 17px;
	}

	button {
		padding: 8px 11px;
		border: 1px solid #415149;
		border-radius: 9px;
		background: #122019;
		color: #d9eee6;
		font: inherit;
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.status {
		min-height: 18px;
		margin: 12px 0 8px;
		color: #a6b2ad;
		font-size: 11px;
	}

	.column-head {
		padding: 7px 10px;
		border-block: 1px solid #202a26;
		color: #799086;
		font-size: 10px;
		font-weight: 700;
	}

	.column-head span,
	.pair-row > div {
		width: 50%;
	}

	.pairs-scroll {
		height: clamp(230px, 34vh, 430px);
		overflow: auto;
		scrollbar-gutter: stable;
	}

	.pair-row {
		position: relative;
		border-bottom: 1px solid #18211d;
	}

	.pair-row.paragraph-break {
		margin-top: 10px;
		border-top: 1px solid #34443d;
	}

	.pair-row > div {
		box-sizing: border-box;
		padding: 12px 14px 14px 10px;
		font-size: 15px;
		line-height: 1.55;
	}

	.pair-row .source {
		color: #e8eeeb;
	}

	.pair-row .translation {
		border-left: 1px solid #1e2924;
		color: #bfe8d9;
	}

	.provisional {
		position: absolute;
		right: 7px;
		bottom: 3px;
		color: #cda96a;
		font-size: 9px;
	}

	.failed {
		display: grid;
		gap: 5px;
		margin: 9px 0;
		padding: 10px;
		border: 1px solid #714943;
		border-radius: 9px;
		color: #e7b0a8;
		font-size: 11px;
	}

	.failed code,
	.error,
	.warning {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.placeholder {
		margin: 0;
		padding: 24px 10px;
		color: #6f7c76;
		font-size: 12px;
	}

	footer {
		align-items: flex-start;
		min-height: 26px;
		padding-top: 9px;
		font-size: 11px;
	}

	footer > div {
		display: grid;
		gap: 4px;
	}

	.error {
		color: #e8a198;
	}

	.warning {
		color: #d8b779;
	}

	.secondary {
		background: transparent;
	}

	@media (max-width: 720px) {
		.column-head {
			display: none;
		}

		.pair-row {
			flex-direction: column;
		}

		.pair-row > div {
			width: 100%;
		}

		.pair-row .translation {
			padding-top: 0;
			border-left: 0;
		}
	}
</style>
