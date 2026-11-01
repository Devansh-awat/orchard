<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title = undefined,
		meta = undefined,
		fill = false,
		class: className = '',
		children
	}: {
		title?: string;
		meta?: string | Snippet;
		fill?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<section class="widget {className}" class:widget--fill={fill} aria-label={title}>
	{#if title || meta}
		<header class="head" class:head--controls={!!meta && typeof meta !== 'string'}>
			{#if title}<h2 class="title">{title}</h2>{/if}
			{#if meta}
				<span class="meta"
					>{#if typeof meta === 'string'}{meta}{:else}{@render meta()}{/if}</span
				>
			{/if}
		</header>
	{/if}
	{#if fill}
		<div class="fill">{@render children()}</div>
	{:else}
		{@render children()}
	{/if}
</section>

<style>
	.widget {
		position: relative;
		display: flex;
		flex-direction: column;
		--widget-r: var(--radius-widget);
		--widget-pad: 1rem;
		--widget-control-h: 1.75rem;
		--widget-corner-inset: calc(var(--widget-r) - var(--widget-control-h) / 2);
		--widget-title-gap: 0.75rem;
		gap: var(--widget-pad);
		min-width: 0;
		padding: var(--widget-pad);
		border-radius: calc(var(--widget-r) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.widget--fill {
		min-height: 0;
	}
	.fill {
		flex: 1 1 auto;
		min-height: 0;
		margin: -0.25rem calc(var(--widget-pad) * -1) calc(var(--widget-pad) * -1);
		padding: 0.25rem var(--widget-pad) var(--widget-pad);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: calc(var(--widget-title-gap) - var(--widget-pad));
		font-size: var(--text-headline);
	}
	.head--controls {
		min-height: var(--widget-control-h);
		margin-top: calc(var(--widget-corner-inset) - var(--widget-pad));
		margin-bottom: calc(var(--widget-title-gap) - var(--widget-pad));
	}
	.head--controls .meta:has(:global(button, a)) {
		margin-right: calc(var(--widget-corner-inset) - var(--widget-pad));
	}
	.head--controls .meta :global(.button) {
		border-radius: 999px;
		corner-shape: round;
	}
	.title {
		font-size: var(--text-headline);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-muted);
		font-size: var(--text-caption);
		text-box: trim-both cap alphabetic;
	}
</style>
