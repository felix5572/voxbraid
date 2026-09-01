<script lang="ts">
	import type { LocalSessionRepository } from '../persistence/local-session-repository';
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
</script>

<section class="workspace" aria-labelledby="sidecar-title">
	<header class="workspace-heading">
		<div>
			<p class="eyebrow">SIDECAR</p>
			<h2 id="sidecar-title">字幕旁路</h2>
		</div>
		<p>清稿持续整理当前会话；对话每轮读取当时的完整字幕。</p>
	</header>

	<div class="workspace-stack">
		<AutoSummaryPanel
			{session}
			{outputLanguage}
			{repository}
			disabled={disabled || conversationRequesting}
			onRequestingChange={(value) => (summaryRequesting = value)}
		/>
		<ConversationPanel
			{session}
			{outputLanguage}
			disabled={disabled || summaryRequesting}
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
