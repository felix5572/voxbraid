<script lang="ts">
	import type { TranslationSessionState } from '../session/translation-session';
	import { sendSidecarRequest, sidecarErrorDetails, sidecarLocalFailure } from './client';
	import { captureSidecarContext, sidecarRequestFits } from './context';
	import type { SidecarInvocationView, SidecarInvokeRequest, SidecarInvokeResult } from './types';

	interface Props {
		session: TranslationSessionState | null;
		outputLanguage: string;
		disabled?: boolean;
		onRequestingChange?: (requesting: boolean) => void;
	}

	let {
		session,
		outputLanguage,
		disabled = false,
		onRequestingChange = () => undefined
	}: Props = $props();
	let question = $state('');
	let invocation = $state<SidecarInvocationView | null>(null);
	let copyStatus = $state('');

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
	const requesting = $derived(invocation?.state === 'requesting');

	async function ask(): Promise<void> {
		const capturedSession = session;
		const normalizedQuestion = question.trim();
		if (disabled || requesting || !capturedSession || !normalizedQuestion) return;

		const capturedAt = new Date().toISOString();
		const context = captureSidecarContext(capturedSession, 'current-thread', capturedAt);
		const clientRequestId = crypto.randomUUID();
		const request: SidecarInvokeRequest = {
			clientRequestId,
			intent: {
				kind: 'ask',
				trigger: 'manual',
				question: normalizedQuestion,
				outputLanguage
			},
			context
		};
		const viewContext = {
			threadId: context.threadId,
			scope: context.scope,
			capturedAt: context.capturedAt,
			runCount: context.runs.length,
			sourceCharacters: context.runs.reduce((sum, run) => sum + run.sourceText.length, 0),
			translationCharacters: context.runs.reduce((sum, run) => sum + run.translationText.length, 0)
		};
		copyStatus = '';
		if (context.runs.length === 0) {
			invocation = {
				id: clientRequestId,
				intent: request.intent,
				context: viewContext,
				state: 'failed',
				result: sidecarLocalFailure(clientRequestId, 'empty-context', '当前会话还没有可用字幕。')
			};
			return;
		}
		if (!sidecarRequestFits(request)) {
			invocation = {
				id: clientRequestId,
				intent: request.intent,
				context: viewContext,
				state: 'failed',
				result: sidecarLocalFailure(
					clientRequestId,
					'context-too-large',
					'当前会话超过旁路请求 1.5 MB 上限。'
				)
			};
			return;
		}

		invocation = {
			id: clientRequestId,
			intent: request.intent,
			context: viewContext,
			state: 'requesting',
			result: null
		};
		onRequestingChange(true);
		let result: SidecarInvokeResult;
		try {
			result = await sendSidecarRequest(request);
		} catch (error) {
			console.error('[sidecar-conversation] browser request failed', error);
			result = sidecarLocalFailure(clientRequestId, 'invalid-response', sidecarErrorDetails(error));
		}
		if (invocation?.id !== clientRequestId) return;
		onRequestingChange(false);
		invocation = {
			...invocation,
			state: result.status === 'completed' ? 'completed' : 'failed',
			result
		};
	}

	async function copyResult(): Promise<void> {
		const text = invocation?.result?.outputText;
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			copyStatus = '已复制';
		} catch (error) {
			console.error('[sidecar-conversation] copy failed', error);
			copyStatus = '复制失败，请手动选择文本';
		}
	}
</script>

<section class="panel" aria-labelledby="conversation-title">
	<header>
		<div>
			<p class="eyebrow">CONVERSATION</p>
			<h3 id="conversation-title">自由对话</h3>
		</div>
		<span>每轮读取当前完整会话</span>
	</header>

	<div class="conversation-scroll">
		{#if invocation}
			<div class="question">
				<strong>你</strong>
				<p>{invocation.intent.kind === 'ask' ? invocation.intent.question : ''}</p>
			</div>
			<div class:failed={invocation.state === 'failed'} class="answer">
				<strong>VoxBraid</strong>
				{#if invocation.state === 'requesting'}
					<p class="pending">正在计算预算并回答…</p>
				{:else if invocation.result?.status === 'failed'}
					<p class="error" role="alert">
						{invocation.result.error.code}：{invocation.result.error.message}
					</p>
				{:else if invocation.result?.outputText}
					<div class="answer-text">{invocation.result.outputText}</div>
				{/if}
			</div>
		{:else}
			<p class="placeholder">针对当前会话提问。第一版每轮重新灌入完整字幕，不锁定旧上下文。</p>
		{/if}
	</div>

	<div class="composer">
		<textarea
			bind:value={question}
			maxlength="4000"
			rows="2"
			placeholder="针对字幕提一个问题…"
			aria-label="字幕问题"
			disabled={disabled || requesting}></textarea>
		<button
			type="button"
			disabled={disabled || requesting || !hasTranscript || !question.trim()}
			onclick={() => void ask()}>提问</button
		>
	</div>

	<footer>
		<div>
			{#if invocation?.result?.model}<span>{invocation.result.model}</span>{/if}
			{#if invocation?.result?.usage}<span>{invocation.result.usage.totalTokens} tokens</span>{/if}
			{#if invocation}<span
					>捕获于 {CAPTURED_AT_FORMATTER.format(new Date(invocation.context.capturedAt))}</span
				>{/if}
		</div>
		{#if invocation?.result?.outputText}
			<button type="button" class="copy" onclick={() => void copyResult()}>
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
	header > div,
	.composer,
	footer,
	footer > div {
		display: flex;
	}

	header,
	footer {
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	header > div {
		flex-direction: column;
	}

	header > span,
	footer {
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
		height: 260px;
		margin-top: 12px;
		padding: 14px;
		overflow: auto;
		overscroll-behavior: contain;
		border: 1px solid #26332d;
		border-radius: 10px;
		background: #0a0f0d;
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
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid #25302b;
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

	.composer {
		gap: 8px;
		margin-top: 10px;
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

	footer {
		min-height: 28px;
		margin-top: 8px;
	}

	footer > div {
		flex-wrap: wrap;
		gap: 5px 10px;
	}

	.copy {
		flex: none;
		font-size: 12px;
	}

	@media (max-width: 720px) {
		header {
			align-items: flex-start;
		}

		.conversation-scroll {
			height: 220px;
		}
	}
</style>
