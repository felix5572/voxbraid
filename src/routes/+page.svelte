<script lang="ts">
	import { onMount } from 'svelte';
	import { RealtimeTranslationClient, realtimeErrorMessage } from '$lib/realtime/client';
	import { ScreenWakeLock } from '$lib/screen-wake-lock';
	import { EMPTY_TRANSCRIPT, reduceTranscript } from '$lib/realtime/transcript';
	import {
		TARGET_LANGUAGES,
		type ConnectionStatus,
		type TargetLanguage
	} from '$lib/realtime/types';

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

	let status = $state<ConnectionStatus>('idle');
	let targetLanguage = $state<TargetLanguage>('zh');
	let transcript = $state({ ...EMPTY_TRANSCRIPT });
	let error = $state('');
	let client: RealtimeTranslationClient | null = null;
	const wakeLock = new ScreenWakeLock();

	const active = $derived(status !== 'idle' && status !== 'failed' && status !== 'stopping');

	onMount(() => {
		client = new RealtimeTranslationClient({
			onStatus: (nextStatus) => {
				status = nextStatus;
				if (nextStatus === 'connected') void wakeLock.acquire();
				if (nextStatus === 'stopping' || nextStatus === 'idle' || nextStatus === 'failed') {
					void wakeLock.release();
				}
			},
			onEvent: (event) => (transcript = reduceTranscript(transcript, event)),
			onError: (message) => (error = message)
		});

		const handleVisibility = () => {
			if (document.visibilityState === 'visible' && status === 'connected') void wakeLock.acquire();
		};
		document.addEventListener('visibilitychange', handleVisibility);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibility);
			void client?.stop();
			void wakeLock.release();
		};
	});

	async function start(): Promise<void> {
		if (!client) return;
		error = '';
		transcript = { ...EMPTY_TRANSCRIPT };
		try {
			await client.start(targetLanguage);
		} catch (startError) {
			console.error('[realtime-client] start failed', startError);
			error = realtimeErrorMessage(startError);
		}
	}

	async function stop(): Promise<void> {
		await client?.stop();
	}
</script>

<svelte:head>
	<title>VoxBraid · 实时双语字幕</title>
	<meta name="description" content="使用 OpenAI Realtime Translation 将环境音转为实时双语字幕。" />
</svelte:head>

<main>
	<header>
		<div class="brand">
			<div class="mark" aria-hidden="true"><span></span><span></span><span></span></div>
			<div>
				<p class="eyebrow">VOXBRAID</p>
				<h1>环境音实时翻译</h1>
			</div>
		</div>
		<div class:live={status === 'connected'} class:error-state={status === 'failed'} class="status">
			<span></span>{STATUS_LABELS[status]}
		</div>
	</header>

	<section class="controls" aria-label="翻译控制">
		<label>
			<span>目标语言</span>
			<select bind:value={targetLanguage} disabled={active}>
				{#each TARGET_LANGUAGES as language (language.code)}
					<option value={language.code}>{language.label}</option>
				{/each}
			</select>
		</label>

		{#if active}
			<button class="stop" onclick={stop}><span class="stop-icon"></span>停止翻译</button>
		{:else}
			<button class="start" onclick={start} disabled={status === 'stopping'}>
				<span class="mic" aria-hidden="true"></span>开始翻译
			</button>
		{/if}
	</section>

	{#if error}
		<div class="error" role="alert">
			<strong>连接没有建立</strong>
			<span>{error}</span>
		</div>
	{/if}

	<section class="captions" aria-live="polite">
		<article>
			<div class="caption-label"><span>原文</span><small>自动识别语言</small></div>
			<p class:placeholder={!transcript.source}>
				{transcript.source || (active ? '正在听取环境声音…' : '开始后，原文字幕会显示在这里。')}
			</p>
		</article>

		<div class="divider" aria-hidden="true"></div>

		<article class="translated">
			<div class="caption-label">
				<span>译文</span>
				<small>{TARGET_LANGUAGES.find((item) => item.code === targetLanguage)?.label}</small>
			</div>
			<p class:placeholder={!transcript.translation}>
				{transcript.translation || (active ? '翻译准备中…' : '目标语言字幕会同步显示在这里。')}
			</p>
		</article>
	</section>

	<footer>
		<span>音频从此设备通过 WebRTC 直达 OpenAI</span>
		<span>当前不播放译音 · 不保存录音</span>
	</footer>
</main>

<style>
	main {
		width: min(1120px, 100%);
		min-height: 100vh;
		margin: 0 auto;
		padding: max(28px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
			max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
		display: grid;
		grid-template-rows: auto auto auto 1fr auto;
		gap: 24px;
	}

	header,
	.controls,
	footer,
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

	.mark {
		width: 48px;
		height: 48px;
		border: 1px solid #39433f;
		border-radius: 15px;
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
		padding: 18px;
		border: 1px solid #252c29;
		border-radius: 18px;
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
		padding: 11px 38px 11px 13px;
		border: 1px solid #343d39;
		border-radius: 11px;
		background: #111613;
		color: #eef3ef;
	}

	button {
		min-width: 160px;
		padding: 12px 18px;
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

	.captions {
		min-height: 430px;
		border: 1px solid #242b28;
		border-radius: 22px;
		display: grid;
		grid-template-rows: 1fr auto 1fr;
		overflow: hidden;
		background: rgba(10, 13, 12, 0.77);
		box-shadow: 0 22px 70px rgba(0, 0, 0, 0.24);
	}

	article {
		padding: clamp(24px, 5vw, 54px);
	}
	.caption-label {
		gap: 10px;
		margin-bottom: 20px;
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
	article p {
		margin: 0;
		font-size: clamp(25px, 4.4vw, 48px);
		font-weight: 570;
		line-height: 1.42;
		letter-spacing: -0.022em;
		white-space: pre-wrap;
		word-break: break-word;
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
		margin: 0 clamp(24px, 5vw, 54px);
		background: #252d29;
	}
	footer {
		gap: 20px;
		color: #59615d;
		font-size: 11px;
	}

	@media (max-width: 640px) {
		main {
			padding-inline: 16px;
			gap: 16px;
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
		label {
			justify-content: space-between;
		}
		button {
			width: 100%;
		}
		.captions {
			min-height: 490px;
		}
		footer {
			align-items: flex-start;
			flex-direction: column;
			gap: 5px;
		}
	}
</style>
