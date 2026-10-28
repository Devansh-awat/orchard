<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		subtitle = undefined,
		media = undefined
	}: { title: string; subtitle?: string; media?: Snippet } = $props();
</script>

<div class="header" role="none">
	{#if media}<span class="media">{@render media()}</span>{/if}
	<span class="text">
		<span class="title">{title}</span>
		{#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
	</span>
</div>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
		padding: 0.5rem 0.5rem 0.625rem;
	}
	.media {
		display: inline-flex;
		flex-shrink: 0;
		width: 2rem;
		height: 2rem;
		overflow: hidden;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.media > :global(*) {
		width: 100%;
		height: 100%;
	}
	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.title,
	.subtitle {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.subtitle {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
</style>
