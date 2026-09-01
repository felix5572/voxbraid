<script lang="ts">
	import type { TranslationThread } from './types';

	interface Props {
		threads: TranslationThread[];
		currentThreadId: string | null;
		open: boolean;
		disabled: boolean;
		onClose: () => void;
		onNew: () => void;
		onSelect: (threadId: string) => void;
	}

	let { threads, currentThreadId, open, disabled, onClose, onNew, onSelect }: Props = $props();

	const TITLE_FORMATTER = new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
	const UPDATED_FORMATTER = new Intl.DateTimeFormat(undefined, {
		month: 'numeric',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});

	function threadTitle(thread: TranslationThread): string {
		const title = thread.title?.trim();
		return title || `会话 · ${TITLE_FORMATTER.format(new Date(thread.createdAt))}`;
	}

	function updatedLabel(thread: TranslationThread): string {
		return `最近更新 ${UPDATED_FORMATTER.format(new Date(thread.updatedAt))}`;
	}
</script>

{#if open}
	<button class="backdrop" aria-label="关闭会话列表" onclick={onClose}></button>
{/if}

<aside class:open aria-label="会话列表">
	<div class="sidebar-header">
		<div>
			<p>VOXBRAID</p>
			<h2>会话</h2>
		</div>
		<button class="close" aria-label="关闭会话列表" onclick={onClose}>×</button>
	</div>

	<button class="new-session" onclick={onNew} {disabled}>
		<span aria-hidden="true">＋</span>
		新建会话
	</button>

	<nav aria-label="历史会话">
		{#if threads.length > 0}
			{#each threads as thread (thread.id)}
				<button
					class="thread"
					class:current={thread.id === currentThreadId}
					data-thread-id={thread.id}
					aria-current={thread.id === currentThreadId ? 'page' : undefined}
					onclick={() => onSelect(thread.id)}
					{disabled}
				>
					<strong>{threadTitle(thread)}</strong>
					<small>{updatedLabel(thread)}</small>
				</button>
			{/each}
		{:else}
			<p class="empty">完成第一段翻译后，会话会保存在这里。</p>
		{/if}
	</nav>

	<p class="storage-note">会话保存在此设备</p>
</aside>

<style>
	aside {
		position: sticky;
		top: 0;
		z-index: 20;
		width: 276px;
		height: 100vh;
		padding: max(24px, env(safe-area-inset-top)) 16px max(18px, env(safe-area-inset-bottom));
		border-right: 1px solid #252c29;
		display: flex;
		flex-direction: column;
		gap: 18px;
		background: #0d110f;
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 8px;
	}

	.sidebar-header p {
		margin: 0 0 3px;
		color: #6d8e82;
		font-size: 10px;
		font-weight: 760;
		letter-spacing: 0.18em;
	}

	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 650;
	}

	button {
		border: 0;
		font: inherit;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.close {
		display: none;
		width: 36px;
		height: 36px;
		border-radius: 10px;
		background: transparent;
		color: #9ba59f;
		font-size: 25px;
	}

	.new-session {
		width: 100%;
		padding: 12px 13px;
		border: 1px solid #35413c;
		border-radius: 12px;
		display: flex;
		align-items: center;
		gap: 9px;
		background: #151c18;
		color: #dce8e2;
		font-weight: 670;
		text-align: left;
	}

	.new-session span {
		color: #8bd5bc;
		font-size: 20px;
		line-height: 1;
	}

	nav {
		min-height: 0;
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 5px;
		overflow-y: auto;
	}

	.thread {
		width: 100%;
		padding: 11px 12px;
		border-radius: 11px;
		display: grid;
		gap: 5px;
		background: transparent;
		color: #c2cbc6;
		text-align: left;
	}

	.thread:hover {
		background: #141a17;
	}

	.thread.current {
		background: #1a2520;
		color: #e8f2ed;
	}

	.thread strong {
		overflow: hidden;
		font-size: 13px;
		font-weight: 610;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.thread small {
		color: #68736d;
		font-size: 10px;
	}

	.empty,
	.storage-note {
		color: #606964;
		font-size: 11px;
		line-height: 1.6;
	}

	.empty {
		margin: 8px 10px;
	}

	.storage-note {
		margin: 0 8px;
	}

	.backdrop {
		display: none;
	}

	@media (max-width: 820px) {
		aside {
			position: fixed;
			left: 0;
			width: min(310px, 86vw);
			transform: translateX(-102%);
			transition: transform 180ms ease;
			box-shadow: 18px 0 55px rgba(0, 0, 0, 0.38);
		}

		aside.open {
			transform: translateX(0);
		}

		.close {
			display: inline-grid;
			place-items: center;
		}

		.backdrop {
			position: fixed;
			inset: 0;
			z-index: 19;
			display: block;
			width: 100%;
			height: 100%;
			padding: 0;
			background: rgba(0, 0, 0, 0.56);
		}
	}
</style>
