<script lang="ts">
	import { tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { TranslationSessionState } from '../session/translation-session';
	import { sendSidecarRequest, sidecarErrorDetails, sidecarLocalFailure } from './client';
	import { captureSidecarContext, sidecarRequestFits } from './context';
	import type {
		SidecarConversationTurn,
		SidecarInvocationView,
		SidecarInvokeRequest,
		SidecarInvokeResult
	} from './types';

	interface Props {
		session: TranslationSessionState | null;
		outputLanguage: string;
		cleanedTranscript: string;
		disabled?: boolean;
		onRequestingChange?: (requesting: boolean) => void;
	}

	let {
		session,
		outputLanguage,
		cleanedTranscript,
		disabled = false,
		onRequestingChange = () => undefined
	}: Props = $props();
	let question = $state('');
	const conversations = new SvelteMap<string, SidecarInvocationView[]>();
	let currentThreadId = $state<string | null>(null);
	let copiedInvocationId = $state<string | null>(null);
	let copyFailureInvocationId = $state<string | null>(null);
	let conversationScroller = $state<HTMLDivElement | null>(null);

	const CAPTURED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
	const hasTranscript = $derived(
		Boolean(
			session?.runs.some(
				(run) => run.sourceStream.text.length > 0 || run.translationStream.text.length > 0
			)
		)
	);
	const invocations = $derived(currentThreadId ? (conversations.get(currentThreadId) ?? []) : []);
	const requesting = $derived(
		[...conversations.values()].some((threadInvocations) =>
			threadInvocations.some((invocation) => invocation.state === 'requesting')
		)
	);

	$effect(() => {
		const nextThreadId = session?.thread.id ?? null;
		if (nextThreadId === currentThreadId) return;
		currentThreadId = nextThreadId;
		question = '';
		copiedInvocationId = null;
		copyFailureInvocationId = null;
	});

	function completedHistory(): SidecarConversationTurn[] {
		return invocations.flatMap((invocation) => {
			if (
				invocation.intent.kind !== 'ask' ||
				invocation.result?.status !== 'completed' ||
				!invocation.result.outputText
			) {
				return [];
			}
			return [{ question: invocation.intent.question, answer: invocation.result.outputText }];
		});
	}

	async function followTail(): Promise<void> {
		await tick();
		if (conversationScroller) conversationScroller.scrollTop = conversationScroller.scrollHeight;
	}

	function appendInvocation(invocation: SidecarInvocationView): void {
		conversations.set(invocation.context.threadId, [
			...(conversations.get(invocation.context.threadId) ?? []),
			invocation
		]);
		void followTail();
	}

	async function ask(): Promise<void> {
		const capturedSession = session;
		const normalizedQuestion = question.trim();
		if (disabled || requesting || !capturedSession || !normalizedQuestion) return;

		const capturedAt = new Date().toISOString();
		const context = captureSidecarContext(
			capturedSession,
			'current-thread',
			capturedAt,
			'',
			cleanedTranscript
		);
		const history = completedHistory();
		const clientRequestId = crypto.randomUUID();
		const viewIntent = {
			kind: 'ask' as const,
			trigger: 'manual' as const,
			question: normalizedQuestion,
			outputLanguage
		};
		const request: SidecarInvokeRequest = {
			clientRequestId,
			intent: {
				...viewIntent,
				history
			},
			context
		};
		const viewContext = {
			threadId: context.threadId,
			scope: context.scope,
			capturedAt: context.capturedAt,
			runCount: context.runs.length,
			sourceCharacters: context.runs.reduce((sum, run) => sum + run.sourceText.length, 0),
			translationCharacters: context.runs.reduce((sum, run) => sum + run.translationText.length, 0),
			cleanedTranscriptCharacters: context.cleanedTranscript?.length ?? 0,
			historyTurns: history.length
		};
		copiedInvocationId = null;
		copyFailureInvocationId = null;
		if (context.runs.length === 0) {
			appendInvocation({
				id: clientRequestId,
				intent: viewIntent,
				context: viewContext,
				state: 'failed',
				result: sidecarLocalFailure(clientRequestId, 'empty-context', '当前会话还没有可用字幕。')
			});
			return;
		}
		if (!sidecarRequestFits(request)) {
			appendInvocation({
				id: clientRequestId,
				intent: viewIntent,
				context: viewContext,
				state: 'failed',
				result: sidecarLocalFailure(
					clientRequestId,
					'context-too-large',
					'当前字幕、清稿与对话历史超过旁路请求 1.5 MB 上限。'
				)
			});
			return;
		}

		question = '';
		appendInvocation({
			id: clientRequestId,
			intent: viewIntent,
			context: viewContext,
			state: 'requesting',
			result: null
		});
		onRequestingChange(true);
		let result: SidecarInvokeResult;
		try {
			result = await sendSidecarRequest(request);
		} catch (error) {
			console.error('[sidecar-conversation] browser request failed', error);
			result = sidecarLocalFailure(clientRequestId, 'invalid-response', sidecarErrorDetails(error));
		}
		const threadInvocations = conversations.get(context.threadId) ?? [];
		const invocationIndex = threadInvocations.findIndex(
			(invocation) => invocation.id === clientRequestId
		);
		if (invocationIndex === -1) return;
		onRequestingChange(false);
		const completedInvocation: SidecarInvocationView = {
			...threadInvocations[invocationIndex],
			state: result.status === 'completed' ? 'completed' : 'failed',
			result
		};
		conversations.set(context.threadId, [
			...threadInvocations.slice(0, invocationIndex),
			completedInvocation,
			...threadInvocations.slice(invocationIndex + 1)
		]);
		void followTail();
	}

	async function copyResult(invocation: SidecarInvocationView): Promise<void> {
		const text = invocation.result?.outputText;
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			copiedInvocationId = invocation.id;
			copyFailureInvocationId = null;
		} catch (error) {
			console.error('[sidecar-conversation] copy failed', error);
			copyFailureInvocationId = invocation.id;
			copiedInvocationId = null;
		}
	}

	function clearConversation(): void {
		if (!currentThreadId || requesting) return;
		conversations.delete(currentThreadId);
		question = '';
		copiedInvocationId = null;
		copyFailureInvocationId = null;
	}

	function handleComposerKeydown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		void ask();
	}
</script>

<section class="panel" aria-labelledby="conversation-title">
	<header>
		<div>
			<p class="eyebrow">CONVERSATION</p>
			<h3 id="conversation-title">自由对话</h3>
		</div>
		<div class="header-actions">
			<span>每轮读取完整字幕、当前清稿与此前问答</span>
			{#if invocations.length > 0}
				<button type="button" class="clear" disabled={requesting} onclick={clearConversation}
					>清空对话</button
				>
			{/if}
		</div>
	</header>

	<div class="conversation-scroll" bind:this={conversationScroller} aria-live="polite">
		{#if invocations.length > 0}
			{#each invocations as invocation (invocation.id)}
				<article class="turn">
					<div class="question">
						<strong>你</strong>
						<p>{invocation.intent.kind === 'ask' ? invocation.intent.question : ''}</p>
					</div>
					<div class:failed={invocation.state === 'failed'} class="answer">
						<strong>VoxBraid</strong>
						{#if invocation.state === 'requesting'}
							<p class="pending">正在读取当前字幕与清稿、计算预算并回答…</p>
						{:else if invocation.result?.status === 'failed'}
							<p class="error" role="alert">
								{invocation.result.error.code}：{invocation.result.error.message}
							</p>
						{:else if invocation.result?.outputText}
							<div class="answer-text">{invocation.result.outputText}</div>
						{/if}
					</div>
					<footer class="turn-meta">
						<div>
							<span>{invocation.context.runCount} 段</span>
							<span>原文 {invocation.context.sourceCharacters} 字</span>
							<span>译文 {invocation.context.translationCharacters} 字</span>
							<span>清稿 {invocation.context.cleanedTranscriptCharacters} 字</span>
							<span>历史 {invocation.context.historyTurns} 轮</span>
							{#if invocation.result?.model}<span>{invocation.result.model}</span>{/if}
							{#if invocation.result?.usage}<span>{invocation.result.usage.totalTokens} tokens</span
								>{/if}
							<span
								>捕获于 {CAPTURED_AT_FORMATTER.format(
									new Date(invocation.context.capturedAt)
								)}</span
							>
						</div>
						{#if invocation.result?.outputText}
							<button type="button" class="copy" onclick={() => void copyResult(invocation)}>
								{copyFailureInvocationId === invocation.id
									? '复制失败，请手动选择'
									: copiedInvocationId === invocation.id
										? '已复制'
										: '复制回答'}
							</button>
						{/if}
					</footer>
				</article>
			{/each}
		{:else}
			<p class="placeholder">针对当前会话提问；每轮会读取完整字幕、现有清稿与此前成功问答。</p>
		{/if}
	</div>

	<div class="composer">
		<textarea
			bind:value={question}
			maxlength="4000"
			rows="2"
			placeholder="针对字幕或清稿提一个问题…"
			aria-label="字幕问题"
			disabled={disabled || requesting}
			onkeydown={handleComposerKeydown}></textarea>
		<button
			type="button"
			disabled={disabled || requesting || !hasTranscript || !question.trim()}
			onclick={() => void ask()}>提问</button
		>
	</div>
	<p class="composer-hint">Ctrl/⌘ + Enter 发送 · 对话仅保留在当前页面</p>
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
	header > div,
	.header-actions,
	.composer,
	.turn-meta,
	.turn-meta > div {
		display: flex;
	}

	header,
	.turn-meta {
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	header > div {
		flex-direction: column;
	}

	.header-actions {
		align-items: center;
		flex-direction: row;
		gap: 10px;
	}

	.header-actions > span,
	.turn-meta,
	.composer-hint {
		color: #85918b;
		font-size: 11px;
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

	.conversation-scroll {
		height: 300px;
		margin-top: 12px;
		padding: 14px;
		overflow: auto;
		overscroll-behavior: contain;
		border: 1px solid #26332d;
		border-radius: 10px;
		background: #0a0f0d;
	}

	.turn + .turn {
		margin-top: 20px;
		padding-top: 18px;
		border-top: 1px solid #2b3731;
	}

	.question,
	.answer {
		font-size: 14px;
		line-height: 1.6;
	}

	.question strong,
	.answer strong {
		color: #72b39e;
		font-size: 11px;
	}

	.question p,
	.answer p {
		margin: 4px 0 0;
	}

	.answer {
		margin-top: 12px;
	}

	.answer-text {
		margin-top: 4px;
		color: #e2ebe6;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.pending,
	.placeholder {
		color: #7f8b85;
	}

	.placeholder {
		margin: 0;
		font-size: 13px;
		line-height: 1.6;
	}

	.error {
		color: #efaaa0;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.turn-meta {
		min-height: 28px;
		margin-top: 10px;
	}

	.turn-meta > div {
		flex-wrap: wrap;
		gap: 5px 10px;
	}

	.composer {
		gap: 8px;
		margin-top: 10px;
	}

	.composer-hint {
		margin: 5px 0 0;
	}

	textarea,
	button {
		font: inherit;
	}

	textarea {
		min-width: 0;
		flex: 1;
		padding: 9px 11px;
		resize: vertical;
		border: 1px solid #35413c;
		border-radius: 9px;
		background: #111714;
		color: #e5ece8;
		line-height: 1.45;
	}

	button {
		padding: 8px 12px;
		border: 1px solid #3d5149;
		border-radius: 9px;
		background: #17231e;
		color: #cfe7dd;
		font-weight: 750;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		border-color: #6f9e8c;
		background: #1d3028;
	}

	button:disabled,
	textarea:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.copy {
		flex: none;
		font-size: 12px;
	}

	.clear {
		padding: 5px 8px;
		font-size: 11px;
	}

	@media (max-width: 720px) {
		header {
			align-items: flex-start;
		}

		.header-actions {
			align-items: flex-start;
			flex-direction: column;
			gap: 5px;
		}

		.conversation-scroll {
			height: 260px;
		}

		.turn-meta {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
