<script lang="ts">
	import type { Snippet } from 'svelte';

	let { label = undefined, children }: { label?: string; children: Snippet } = $props();
</script>

<div class="settings" role="group" aria-label={label}>
	{@render children()}
</div>

<style>
	.settings {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		min-width: 0;
		margin-block: calc(var(--space-3) * -1);
	}
	.settings > :global(*) {
		min-height: 3.5rem;
		padding-block: var(--space-3);
	}
	.settings > :global(* + *) {
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.settings > .settings {
		min-height: 0;
		margin-block: 0;
		padding-block: 0;
	}
</style>
