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
	}

	let { session, outputLanguage, repository, disabled = false }: Props = $props();
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
		<div>
			<p class="eyebrow">SIDECAR</p>
			<h2 id="sidecar-title">字幕旁路</h2>
		</div>
		<p>清稿持续整理当前会话；对话每轮读取完整字幕、当前清稿与此前问答。</p>
	</header>

	<div class="workspace-stack">
		<TranslationPairPanel
			{session}
			{repository}
			disabled={disabled || !canStartProjection('background-pairs', inFlightLanes)}
			onRequestingChange={(value) => (pairRequesting = value)}
		/>
		<AutoSummaryPanel
			{session}
			{outputLanguage}
			{repository}
			disabled={disabled || !canStartProjection('background-clean', inFlightLanes)}
			onRequestingChange={(value) => (summaryRequesting = value)}
			onCleanTranscriptChange={handleCleanTranscriptChange}
			onCleanContextLoaded={handleCleanContextLoaded}
		/>
		<ConversationPanel
			{session}
			{outputLanguage}
			cleanedTranscript={currentCleanedTranscript}
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
	.workspace-heading > div {
		display: flex;
	}

	.workspace-heading {
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 14px;
	}

	.workspace-heading > div {
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

	.workspace-heading > p {
		margin: 0;
		color: #7f8a84;
		font-size: 12px;
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
	}
</style>
