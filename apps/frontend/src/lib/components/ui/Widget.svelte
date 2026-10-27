<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		meta = undefined,
		children
	}: {
		title: string;
		meta?: string | Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="widget" aria-label={title}>
	<header class="head">
		<h2 class="title">{title}</h2>
		{#if meta}
			<span class="meta"
				>{#if typeof meta === 'string'}{meta}{:else}{@render meta()}{/if}</span
			>
		{/if}
	</header>
	{@render children()}
</section>

<style>
	.widget {
		display: flex;
		flex-direction: column;
		--widget-r: 1.375rem;
		--widget-pad: 1rem;
		gap: var(--widget-pad);
		padding: var(--widget-pad);
		border-radius: calc(var(--widget-r) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.title {
		font-size: var(--text-headline);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
	.meta {
		color: var(--text-muted);
		font-size: var(--text-caption);
		text-box: trim-both cap alphabetic;
	}
</style>
