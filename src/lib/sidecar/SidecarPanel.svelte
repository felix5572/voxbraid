<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { LocalSessionRepository } from '../persistence/local-session-repository';
	import { canStartProjection, type ProjectionLane } from '../projection/projection-lanes';
	import TranslationPairPanel from '../projection/TranslationPairPanel.svelte';
	import type { TranslationSessionState } from '../session/translation-session';
	import AutoSummaryPanel from './AutoSummaryPanel.svelte';
	import ConversationPanel from './ConversationPanel.svelte';

	interface Props {
		session: TranslationSessionState | null;
		outputLanguage: string;
		repository: LocalSessionRepository | null;
		disabled?: boolean;
		diagnosticsMode?: boolean;
		onDiagnosticsModeChange?: (enabled: boolean) => void;
	}

	let {
		session,
		outputLanguage,
		repository,
		disabled = false,
		diagnosticsMode = false,
		onDiagnosticsModeChange = () => undefined
	}: Props = $props();
	let summaryRequesting = $state(false);
	let conversationRequesting = $state(false);
	let pairRequesting = $state(false);
	const cleanedTranscripts = new SvelteMap<string, string>();
	let cleanContextThreadId = $state<string | null>(null);
	const currentCleanedTranscript = $derived(
		session ? (cleanedTranscripts.get(session.thread.id) ?? '') : ''
	);
	const cleanContextReady = $derived(
		Boolean(session && cleanContextThreadId === session.thread.id)
	);
	const inFlightLanes = $derived.by(() => {
		const lanes = new SvelteSet<ProjectionLane>();
		if (conversationRequesting) lanes.add('interactive');
		if (summaryRequesting) lanes.add('background-clean');
		if (pairRequesting) lanes.add('background-pairs');
		return lanes;
	});

	function handleCleanTranscriptChange(threadId: string, text: string): void {
		cleanedTranscripts.set(threadId, text);
	}

	function handleCleanContextLoaded(threadId: string | null): void {
		cleanContextThreadId = threadId;
	}
</script>

<section class="workspace" aria-labelledby="sidecar-title">
	<header class="workspace-heading">
		<div class="workspace-title">
			<p class="eyebrow">SIDECAR</p>
			<h2 id="sidecar-title">字幕旁路</h2>
		</div>
		<div class="workspace-tools">
			<p>清稿持续整理当前会话；对话每轮读取完整字幕、当前清稿与此前问答。</p>
			<button
				type="button"
				class:active={diagnosticsMode}
				aria-pressed={diagnosticsMode}
				onclick={() => onDiagnosticsModeChange(!diagnosticsMode)}
			>
				诊断模式 {diagnosticsMode ? '开' : '关'}
			</button>
		</div>
	</header>

	<div class="workspace-stack">
		<TranslationPairPanel
			{session}
			{repository}
			{diagnosticsMode}
			disabled={disabled || !canStartProjection('background-pairs', inFlightLanes)}
			onRequestingChange={(value) => (pairRequesting = value)}
		/>
		<AutoSummaryPanel
			{session}
			{outputLanguage}
			{repository}
			{diagnosticsMode}
			disabled={disabled || !canStartProjection('background-clean', inFlightLanes)}
			onRequestingChange={(value) => (summaryRequesting = value)}
			onCleanTranscriptChange={handleCleanTranscriptChange}
			onCleanContextLoaded={handleCleanContextLoaded}
		/>
		<ConversationPanel
			{session}
			{outputLanguage}
			{repository}
			cleanedTranscript={currentCleanedTranscript}
			{diagnosticsMode}
			disabled={disabled || !canStartProjection('interactive', inFlightLanes) || !cleanContextReady}
			onRequestingChange={(value) => (conversationRequesting = value)}
		/>
	</div>
</section>

<style>
	.workspace {
		padding: 20px;
		border: 1px solid #29322e;
		border-radius: 16px;
		background: #0b100e;
	}

	.workspace-heading,
	.workspace-title {
		display: flex;
	}

	.workspace-heading {
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 14px;
	}

	.workspace-title {
		flex-direction: column;
	}

	.eyebrow {
		margin: 0 0 3px;
		color: #72b39e;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.15em;
	}

	h2 {
		margin: 0;
		font-size: 20px;
	}

	.workspace-tools > p {
		margin: 0;
		color: #7f8a84;
		font-size: 12px;
	}

	.workspace-tools {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
	}

	.workspace-tools button {
		flex: none;
		padding: 6px 9px;
		border: 1px solid #35413c;
		border-radius: 8px;
		background: transparent;
		color: #8f9c96;
		font: inherit;
		font-size: 11px;
		cursor: pointer;
	}

	.workspace-tools button.active {
		border-color: #5e8d7b;
		background: #13221b;
		color: #bde7d6;
	}

	.workspace-stack {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 14px;
	}

	@media (max-width: 720px) {
		.workspace {
			padding: 14px;
		}

		.workspace-heading {
			align-items: flex-start;
			flex-direction: column;
			gap: 5px;
		}

		.workspace-tools {
			width: 100%;
			align-items: flex-start;
			justify-content: space-between;
		}
	}
</style>
