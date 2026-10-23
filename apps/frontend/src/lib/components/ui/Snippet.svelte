<script lang="ts">
	import CopyButton from './CopyButton.svelte';

	let {
		command,
		prompt = '$',
		label = 'Copy command',
		class: className = ''
	}: {
		command: string;
		prompt?: string;
		label?: string;
		class?: string;
	} = $props();
</script>

<div class="snip {className}">
	<div class="scroll">
		<code class="cmd"
			>{#if prompt}<span class="prompt" aria-hidden="true">{prompt}</span>{/if}<span class="text"
				>{command}</span
			></code
		>
	</div>
	<span class="copy"><CopyButton value={command} {label} /></span>
</div>

<style>
	.snip {
		position: relative;
		display: flex;
		align-items: center;
		min-width: 0;
		height: 2.25rem;
		padding: 0 0.25rem 0 0.75rem;
		border-radius: var(--radius-md);
		background: var(--console-bg);
		box-shadow: inset 0 0 0 1px var(--console-edge);
	}
	.scroll {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		mask-image: linear-gradient(to right, black calc(100% - 1.5rem), transparent);
	}
	.scroll::-webkit-scrollbar {
		display: none;
	}
	.cmd {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
		padding-right: 1.5rem;
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		line-height: var(--lh-body);
		color: var(--console-text);
		white-space: pre;
	}
	.prompt {
		color: var(--text-faint);
		user-select: none;
	}
	.copy {
		display: flex;
		flex-shrink: 0;
	}
</style>
