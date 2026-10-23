<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="label" role="none">{@render children()}</div>

<style>
	.label {
		padding: 0.75rem 0.5rem 0.5rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
		user-select: none;
	}
	.label:first-child {
		padding-top: 0.5rem;
	}
</style>
