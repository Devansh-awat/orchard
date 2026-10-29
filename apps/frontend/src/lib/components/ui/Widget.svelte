<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		meta = undefined,
		fill = false,
		class: className = '',
		children
	}: {
		title: string;
		meta?: string | Snippet;
		fill?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<section class="widget {className}" class:widget--fill={fill} aria-label={title}>
	<header class="head" class:head--controls={!!meta && typeof meta !== 'string'}>
		<h2 class="title">{title}</h2>
		{#if meta}
			<span class="meta"
				>{#if typeof meta === 'string'}{meta}{:else}{@render meta()}{/if}</span
			>
		{/if}
	</header>
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
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.head--controls {
		align-items: center;
		min-height: 1.75rem;
		margin: -0.25rem 0 0;
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
