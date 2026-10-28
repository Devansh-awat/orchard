<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="group">{@render children()}</div>

<style>
	.group {
		display: flex;
		flex-direction: column;
	}
	.group > :global(* + *) {
		margin-top: var(--space-2);
		padding-top: var(--space-2);
		border-top: 0.5px solid var(--rule);
	}
</style>
