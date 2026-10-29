<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children, hint = undefined }: { children: Snippet; hint?: Snippet | string } = $props();
</script>

<div class="actions">
	{#if hint}
		<span class="hint"
			>{#if typeof hint === 'string'}{hint}{:else}{@render hint()}{/if}</span
		>
	{/if}
	{@render children()}
</div>

<style>
	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		padding-top: var(--space-2);
	}
	.hint {
		margin-right: auto;
		color: var(--text-faint);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}
</style>
