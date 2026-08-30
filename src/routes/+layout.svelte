<script lang="ts">
	let { children } = $props();
</script>

{@render children()}

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(html) {
		color-scheme: dark;
		background: #07090d;
		font-family:
			Inter,
			ui-sans-serif,
			system-ui,
			-apple-system,
			BlinkMacSystemFont,
			'SF Pro Display',
			'PingFang SC',
			'Microsoft YaHei',
			sans-serif;
	}

	:global(body) {
		margin: 0;
		min-width: 320px;
		min-height: 100vh;
		background:
			radial-gradient(circle at 15% 0%, rgba(55, 94, 85, 0.2), transparent 36rem), #07090d;
		color: #f3f5f2;
	}

	:global(button),
	:global(select) {
		font: inherit;
	}
</style>
