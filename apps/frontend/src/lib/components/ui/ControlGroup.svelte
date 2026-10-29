<script lang="ts">
	import type { Snippet } from 'svelte';

	let { label, parts }: { label: string; parts: Snippet[] } = $props();
</script>

<div class="ui-control-group" role="group" aria-label={label}>
	{#each parts as part, i (i)}
		{#if i > 0}<span class="sep" aria-hidden="true"></span>{/if}
		<span class="part">{@render part()}</span>
	{/each}
</div>

<style>
	.ui-control-group {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		height: 2rem;
		padding: 0.125rem;
		border-radius: 999px;
		background: var(--bg-active);
	}
	.part {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		min-width: 0;
	}
	.sep {
		flex-shrink: 0;
		width: 1px;
		height: 1rem;
		margin-inline: 0.25rem;
		background: var(--border-strong);
	}
	.ui-control-group :global(:is(.button, .trigger)) {
		border-radius: 999px;
		corner-shape: round;
	}
</style>
