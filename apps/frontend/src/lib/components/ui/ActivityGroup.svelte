<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label = undefined,
		class: klass = '',
		children
	}: {
		label?: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<section class="ui-agroup {klass}" aria-label={label}>
	{#if label}<h3 class="ui-agroup-label">{label}</h3>{/if}
	<div class="ui-agroup-list" role="list">{@render children()}</div>
</section>

<style>
	.ui-agroup {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.ui-agroup-label {
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		color: var(--text-muted);
		text-box: trim-both cap alphabetic;
	}
	.ui-agroup-list {
		display: flex;
		flex-direction: column;
	}
</style>
