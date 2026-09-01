<script lang="ts">
	import type { TranslationSessionState } from '../session/translation-session';
	import { captureSidecarContext, sidecarRequestFits } from './context';
	import {
		isSidecarInvokeResult,
		type SidecarContextScope,
		type SidecarIntent,
		type SidecarInvocationView,
		type SidecarInvokeRequest,
		type SidecarInvokeResult,
		type SidecarTaskKind
	} from './types';

	interface Props {
		session: TranslationSessionState | null;
		outputLanguage: string;
		disabled?: boolean;
	}

	let { session, outputLanguage, disabled = false }: Props = $props();
	let scope = $state<SidecarContextScope>('latest-run');
	let question = $state('');
	let invocation = $state<SidecarInvocationView | null>(null);
	let copyStatus = $state('');

	const CAPTURED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
		month: 'numeric',
		day: 'numeric',
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

	function taskLabel(kind: SidecarTaskKind): string {
		if (kind === 'summarize') return '会话总结';
		if (kind === 'retranslate') return '重新翻译';
		return '字幕问答';
	}

	function scopeLabel(value: SidecarContextScope): string {
		return value === 'latest-run' ? '最近一段' : '当前会话';
	}

	function intentFor(kind: SidecarTaskKind): SidecarIntent | null {
		if (kind === 'ask') {
			const normalizedQuestion = question.trim();
			if (!normalizedQuestion) return null;
			return {
				kind,
				trigger: 'manual',
				question: normalizedQuestion,
				outputLanguage
			};
		}
		if (kind === 'summarize') {
			return { kind, trigger: 'manual', outputLanguage };
		}
		return { kind, trigger: 'manual', targetLanguage: outputLanguage };
	}

	function localFailure(
		clientRequestId: string,
		code: 'invalid-request' | 'empty-context' | 'context-too-large' | 'upstream-failed',
		message: string
	): SidecarInvokeResult {
		return {
			status: 'failed',
			clientRequestId,
			responseId: null,
			model: null,
			outputText: null,
			upstreamStatus: null,
			usageStatus: 'unavailable',
			usage: null,
			error: { code, message },
			failedAt: new Date().toISOString()
		};
	}

	async function invoke(kind: SidecarTaskKind): Promise<void> {
		if (disabled || requesting || !session) return;
		const intent = intentFor(kind);
		if (!intent) {
			const id = crypto.randomUUID();
			invocation = {
				id,
				intent: { kind: 'ask', trigger: 'manual', question: '', outputLanguage },
				context: {
					threadId: session.thread.id,
					scope,
					capturedAt: new Date().toISOString(),
					runCount: 0,
					sourceCharacters: 0,
					translationCharacters: 0
				},
				state: 'failed',
				result: localFailure(id, 'invalid-request', '请先输入想问的问题。')
			};
			return;
		}

		const capturedAt = new Date().toISOString();
		const context = captureSidecarContext(session, scope, capturedAt);
		const clientRequestId = crypto.randomUUID();
		const request: SidecarInvokeRequest = { clientRequestId, intent, context };
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
				intent,
				context: viewContext,
				state: 'failed',
				result: localFailure(clientRequestId, 'empty-context', '所选范围还没有可用字幕。')
			};
			return;
		}
		if (!sidecarRequestFits(request)) {
			invocation = {
				id: clientRequestId,
				intent,
				context: viewContext,
				state: 'failed',
				result: localFailure(
					clientRequestId,
					'context-too-large',
					'所选字幕超过旁路请求 1.5 MB 上限，请改用最近一段。'
				)
			};
			return;
		}

		invocation = {
			id: clientRequestId,
			intent,
			context: viewContext,
			state: 'requesting',
			result: null
		};
		try {
			const response = await fetch('/api/sidecar/invoke', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request)
			});
			const body: unknown = await response.json().catch(() => null);
			if (!isSidecarInvokeResult(body) || body.clientRequestId !== clientRequestId) {
				throw new Error(`旁路端点返回了无法识别的响应（HTTP ${response.status}）。`);
			}
			if (invocation?.id !== clientRequestId) return;
			invocation = {
				...invocation,
				state: body.status === 'completed' ? 'completed' : 'failed',
				result: body
			};
		} catch (error) {
			console.error('[sidecar] browser request failed', error);
			if (invocation?.id !== clientRequestId) return;
			invocation = {
				...invocation,
				state: 'failed',
				result: localFailure(
					clientRequestId,
					'upstream-failed',
					error instanceof Error ? error.message : '旁路请求失败。'
				)
			};
		}
	}

	async function copyResult(): Promise<void> {
		const text = invocation?.result?.outputText;
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			copyStatus = '已复制';
		} catch (error) {
			console.error('[sidecar] copy failed', error);
			copyStatus = '复制失败，请手动选择文本';
		}
	}
</script>

<section class="sidecar" aria-labelledby="sidecar-title">
	<div class="sidecar-heading">
		<div>
			<p class="eyebrow">SIDECAR</p>
			<h2 id="sidecar-title">字幕旁路</h2>
			<p>基于已收到的字幕做一次独立总结、重译或提问。</p>
		</div>
		<label>
			<span>上下文</span>
			<select bind:value={scope} disabled={disabled || requesting} aria-label="旁路上下文范围">
				<option value="latest-run">最近一段</option>
				<option value="current-thread">当前会话</option>
			</select>
		</label>
	</div>

	<div class="sidecar-actions">
		<button
			type="button"
			disabled={disabled || requesting || !hasTranscript}
			onclick={() => void invoke('summarize')}>总结</button
		>
		<button
			type="button"
			disabled={disabled || requesting || !hasTranscript}
			onclick={() => void invoke('retranslate')}>重新翻译</button
		>
		<div class="ask-row">
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
				onclick={() => void invoke('ask')}>提问</button
			>
		</div>
	</div>

	{#if invocation}
		<article class:failed={invocation.state === 'failed'} class="sidecar-result">
			<header>
				<div>
					<strong>{taskLabel(invocation.intent.kind)}</strong>
					<span>
						{scopeLabel(invocation.context.scope)} · {invocation.context.runCount} 段 ·
						{CAPTURED_AT_FORMATTER.format(new Date(invocation.context.capturedAt))}
					</span>
				</div>
				{#if invocation.result?.outputText}
					<button type="button" class="copy" onclick={() => void copyResult()}>复制结果</button>
				{/if}
			</header>

			{#if invocation.state === 'requesting'}
				<p class="pending" role="status">正在计算输入并调用模型…</p>
			{:else if invocation.result}
				{#if invocation.result.status === 'failed'}
					<p class="result-error" role="alert">
						<strong>{invocation.result.error.code}</strong>
						{invocation.result.error.message}
					</p>
				{/if}
				{#if invocation.result.outputText}
					<div class="result-text">{invocation.result.outputText}</div>
				{/if}
				<footer>
					<span>模型 {invocation.result.model ?? '未建立'}</span>
					{#if invocation.result.usage}
						<span>
							input {invocation.result.usage.inputTokens} · output
							{invocation.result.usage.outputTokens} · total
							{invocation.result.usage.totalTokens}
						</span>
					{:else}
						<span>usage unavailable</span>
					{/if}
					{#if copyStatus}<span>{copyStatus}</span>{/if}
				</footer>
			{/if}
		</article>
	{/if}
</section>

<style>
	.sidecar {
		padding: 22px 24px;
		border: 1px solid #29322e;
		border-radius: 16px;
		background: #0d1210;
	}

	.sidecar-heading,
	.sidecar-heading > label,
	.sidecar-actions,
	.ask-row,
	.sidecar-result header,
	.sidecar-result header > div,
	.sidecar-result footer {
		display: flex;
	}

	.sidecar-heading,
	.sidecar-result header {
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.eyebrow {
		margin: 0 0 4px;
		color: #72b39e;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.16em;
	}

	h2 {
		margin: 0;
		font-size: 20px;
	}

	.sidecar-heading > div > p:last-child {
		margin: 6px 0 0;
		color: #87928c;
		font-size: 13px;
	}

	.sidecar-heading > label {
		align-items: center;
		gap: 8px;
		color: #8e9993;
		font-size: 12px;
	}

	select,
	textarea,
	button {
		font: inherit;
	}

	select,
	textarea {
		border: 1px solid #35413c;
		border-radius: 10px;
		background: #111714;
		color: #e5ece8;
	}

	select {
		padding: 8px 30px 8px 10px;
	}

	.sidecar-actions {
		align-items: stretch;
		gap: 10px;
		margin-top: 18px;
	}

	button {
		border: 1px solid #3d5149;
		border-radius: 10px;
		background: #17231e;
		color: #cfe7dd;
		font-weight: 700;
		cursor: pointer;
	}

	.sidecar-actions > button,
	.ask-row > button {
		padding: 10px 16px;
	}

	button:hover:not(:disabled) {
		border-color: #6f9e8c;
		background: #1d3028;
	}

	button:disabled,
	textarea:disabled,
	select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ask-row {
		min-width: 0;
		flex: 1;
		gap: 8px;
	}

	textarea {
		min-width: 180px;
		flex: 1;
		padding: 9px 11px;
		resize: vertical;
		line-height: 1.45;
	}

	.sidecar-result {
		margin-top: 18px;
		padding: 16px;
		border: 1px solid #31443c;
		border-radius: 12px;
		background: #101914;
	}

	.sidecar-result.failed {
		border-color: #60413d;
	}

	.sidecar-result header > div {
		min-width: 0;
		flex-direction: column;
		gap: 3px;
	}

	.sidecar-result header span,
	.sidecar-result footer,
	.pending {
		color: #89958f;
		font-size: 12px;
	}

	.copy {
		flex: none;
		padding: 7px 10px;
		font-size: 12px;
	}

	.pending {
		margin: 16px 0 2px;
	}

	.result-error {
		margin: 14px 0 0;
		color: #efaaa0;
		font-size: 13px;
	}

	.result-error strong {
		margin-right: 8px;
	}

	.result-text {
		margin-top: 14px;
		color: #e3ebe7;
		font-size: 15px;
		line-height: 1.68;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.sidecar-result footer {
		flex-wrap: wrap;
		gap: 6px 14px;
		margin-top: 14px;
	}

	@media (max-width: 720px) {
		.sidecar {
			padding: 18px;
		}

		.sidecar-heading,
		.sidecar-actions {
			flex-direction: column;
		}

		.sidecar-heading > label {
			align-self: stretch;
			justify-content: space-between;
		}

		.ask-row {
			width: 100%;
		}
	}
</style>
