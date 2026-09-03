<script lang="ts">
	import type { OperationalLogEntry } from './operational-log';

	interface Props {
		entries: OperationalLogEntry[];
		diagnosticsMode?: boolean;
		onClear?: () => void;
	}

	let { entries, diagnosticsMode = false, onClear = () => undefined }: Props = $props();
	let copyStatus = $state('');
	let panelOpen = $state(false);
	const activeErrors = $derived(
		entries.filter((entry) => entry.severity === 'error' && entry.state === 'active').length
	);
	const activeWarnings = $derived(
		entries.filter((entry) => entry.severity === 'warning' && entry.state === 'active').length
	);

	function time(value: string): string {
		return new Intl.DateTimeFormat(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).format(new Date(value));
	}

	function stateLabel(entry: OperationalLogEntry): string {
		if (entry.state === 'recovered') return '已恢复';
		if (entry.state === 'corrected') return '已纠正';
		return entry.severity === 'error' ? '错误' : '警告';
	}

	function text(): string {
		return entries
			.map((entry) =>
				[
					`${entry.lastOccurredAt} ${entry.severity.toUpperCase()} ${entry.source} ${entry.code}`,
					entry.summary,
					entry.count > 1 ? `重复 ${entry.count} 次` : null,
					entry.requestId ? `request ${entry.requestId}` : null,
					entry.details
				]
					.filter(Boolean)
					.join('\n')
			)
			.join('\n\n');
	}

	async function copyAll(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text());
			copyStatus = '已复制';
		} catch {
			copyStatus = '复制失败';
		}
	}
</script>

<section class="operational-log" aria-labelledby="operational-log-title">
	<details bind:open={panelOpen}>
		<summary>
			<span>
				<span class="eyebrow">WARN / ERROR</span>
				<strong id="operational-log-title">运行问题</strong>
			</span>
			<span class="counts">错误 {activeErrors} · 警告 {activeWarnings}</span>
		</summary>
		<div class="toolbar">
			<span>{entries.length > 0 ? `保留最近 ${entries.length} 条` : '目前没有运行问题'}</span>
			<div>
				{#if copyStatus}<span>{copyStatus}</span>{/if}
				<button type="button" disabled={entries.length === 0} onclick={() => void copyAll()}
					>复制全部</button
				>
				<button type="button" disabled={entries.length === 0} onclick={onClear}>清空记录</button>
			</div>
		</div>
		<div class="entries">
			{#each entries as entry (entry.id)}
				<details class:error={entry.severity === 'error'} class:resolved={entry.state !== 'active'}>
					<summary>
						<span class="severity">{stateLabel(entry)}</span>
						<time datetime={entry.lastOccurredAt}>{time(entry.lastOccurredAt)}</time>
						<span class="source">{entry.source}</span>
						<span class="message">{entry.summary}</span>
						{#if entry.count > 1}<span class="repeat">×{entry.count}</span>{/if}
					</summary>
					<div class="details">
						<code>{entry.code}</code>
						{#if entry.requestId}<code>request {entry.requestId}</code>{/if}
						{#if diagnosticsMode && entry.runId}<code>run {entry.runId}</code>{/if}
						{#if entry.details}<pre>{entry.details}</pre>{/if}
					</div>
				</details>
			{/each}
		</div>
	</details>
</section>

<style>
	.operational-log {
		border: 1px solid #303630;
		border-radius: 14px;
		background: #0b0f0d;
		font-size: 12px;
	}
	.operational-log > details > summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 13px 15px;
		cursor: pointer;
	}
	.operational-log > details > summary > span:first-child {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.eyebrow {
		color: #8f9c96;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.12em;
	}
	.counts,
	.toolbar,
	time,
	.source,
	.repeat {
		color: #7f8a84;
	}
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 0 15px 10px;
	}
	.toolbar > div {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	button {
		padding: 5px 8px;
		border: 1px solid #35413c;
		border-radius: 7px;
		background: transparent;
		color: #9aa69f;
		font: inherit;
		cursor: pointer;
	}
	button:disabled {
		cursor: default;
		opacity: 0.45;
	}
	.entries {
		display: grid;
		max-height: 360px;
		overflow: auto;
		border-top: 1px solid #252b27;
	}
	.entries > details {
		border-bottom: 1px solid #202622;
	}
	.entries > details > summary {
		display: grid;
		grid-template-columns: auto auto auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 9px 15px;
		cursor: pointer;
	}
	.severity {
		color: #c49b65;
		font-weight: 750;
	}
	.error .severity {
		color: #d98585;
	}
	.resolved {
		opacity: 0.68;
	}
	.message {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.details {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 0 15px 12px 36px;
	}
	.details code {
		color: #95a59d;
	}
	.details pre {
		width: 100%;
		margin: 0;
		color: #aab4af;
		white-space: pre-wrap;
		word-break: break-word;
	}
	@media (max-width: 720px) {
		.entries > details > summary {
			grid-template-columns: auto auto minmax(0, 1fr) auto;
		}
		.source {
			display: none;
		}
		.toolbar {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
