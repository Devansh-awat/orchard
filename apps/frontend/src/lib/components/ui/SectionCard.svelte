<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title = undefined,
		description = undefined,
		actions = undefined,
		footer = undefined,
		flush = false,
		tone = 'default',
		class: className = '',
		children = undefined
	}: {
		title?: string;
		description?: string;
		actions?: Snippet;
		footer?: Snippet;
		flush?: boolean;
		tone?: 'default' | 'danger';
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<section class="section section--{tone} {className}">
	{#if title || actions}
		<header class="head">
			<div class="heading">
				{#if title}<h2 class="title">{title}</h2>{/if}
				{#if description}<p class="desc">{description}</p>{/if}
			</div>
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</header>
	{/if}
	{#if children}
		<div class="body" class:body--flush={flush}>{@render children()}</div>
	{/if}
	{#if footer}<footer class="foot">{@render footer()}</footer>{/if}
</section>

<style>
	.section {
		min-width: 0;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		overflow: clip;
	}
	.section--danger {
		background: color-mix(in oklab, var(--status-error) 5%, var(--bg-surface));
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--status-error) 24%, var(--border-default)),
			0 1px 2px rgb(0 0 0 / 0.04);
	}
	.section--danger .title {
		color: var(--status-error);
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.25rem 0;
	}
	.head:last-child {
		padding-bottom: 1rem;
	}
	.heading {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.125rem;
		min-width: 0;
		min-height: 1.75rem;
	}
	.title {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: var(--weight-semibold);
		color: var(--text-default);
	}
	.desc {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.actions {
		display: flex;
		align-items: center;
		min-height: 1.75rem;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.body {
		padding: 1rem 1.25rem 1.25rem;
	}
	.body--flush {
		padding: 0.75rem 0 0;
	}
	.head + .body--flush {
		padding-top: 0.75rem;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem;
		border-top: 1px solid var(--border-default);
		background: var(--bg-sunken);
	}
</style>
