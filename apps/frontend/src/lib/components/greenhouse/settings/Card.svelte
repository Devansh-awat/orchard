<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title = undefined,
		children
	}: {
		title?: string;
		children: Snippet;
	} = $props();
</script>

<section class="group">
	{#if title}<h4 class="heading">{title}</h4>{/if}
	<div class="panel">
		{@render children()}
	</div>
</section>

<style>
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.group:not(:first-child) {
		margin-top: 1.5rem;
	}

	.heading {
		margin: 0;
		padding: 0 0.25rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		font-weight: 600;
		color: var(--text-faint);
	}

	.panel {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		box-shadow: var(--elev-1);
	}
</style>
