<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="actions">{@render children()}</div>

<style>
	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		padding-top: var(--space-2);
	}
</style>
