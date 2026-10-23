<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		inset = true,
		label = undefined,
		children
	}: {
		inset?: boolean;
		label?: string;
		children: Snippet;
	} = $props();
</script>

<div class="list" class:list--inset={inset} role="list" aria-label={label}>
	{@render children()}
</div>

<style>
	.list {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.list--inset {
		border-radius: var(--radius-card);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		overflow: clip;
	}
</style>
