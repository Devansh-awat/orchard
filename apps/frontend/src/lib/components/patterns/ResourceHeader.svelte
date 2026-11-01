<script lang="ts">
	import type { Snippet } from 'svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';

	let {
		title,
		leading = undefined,
		badges = undefined,
		actions = undefined,
		facts = undefined
	}: {
		title: string;
		leading?: Snippet;
		badges?: Snippet;
		actions?: Snippet;
		facts?: Snippet;
	} = $props();
</script>

<section
	class="rh"
	class:rh--lead={!!leading}
	{@attach motionStagger({ index: 0, from: { y: 14 } })}
>
	{#if leading}<div class="rh-lead">{@render leading()}</div>{/if}
	<div class="rh-main">
		<div class="rh-top">
			<div class="rh-identity">
				<h1 class="rh-name" {title}>{title}</h1>
				{#if badges}{@render badges()}{/if}
			</div>
			{#if actions}<div class="rh-actions">{@render actions()}</div>{/if}
		</div>
		{#if facts}<div class="rh-facts">{@render facts()}</div>{/if}
	</div>
</section>

<style>
	.rh {
		--rh-inset: calc(var(--section-r, var(--radius-widget)) - 0.625rem);
		padding: var(--rh-inset) var(--rh-inset) 1.25rem 1.5rem;
		border-radius: calc(var(--section-r, var(--radius-widget)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.rh--lead {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		padding: var(--rh-inset);
		--rh-lead-r: calc(var(--section-r, var(--radius-widget)) - var(--rh-inset));
	}
	.rh-lead {
		display: flex;
		flex-shrink: 0;
	}
	.rh-main {
		flex: 1 1 auto;
		min-width: 0;
	}
	.rh--lead .rh-facts {
		padding-top: 0.375rem;
	}
	.rh-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3) var(--space-4);
		flex-wrap: wrap;
		min-width: 0;
	}
	.rh-identity {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		flex: 1 1 16rem;
		min-width: 0;
	}
	.rh-name {
		min-width: 0;
		max-width: 100%;
		margin: 0;
		overflow: hidden;
		font-size: var(--text-title-1);
		line-height: var(--lh-title-1);
		letter-spacing: var(--track-title);
		font-weight: 600;
		color: var(--text-default);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rh-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}
	.rh-facts {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 1.5rem;
		min-width: 0;
		padding-top: 0.75rem;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.rh-facts > :global(*) {
		max-width: 100%;
	}
	@media (max-width: 640px) {
		.rh {
			padding: var(--space-4);
		}
		.rh-actions {
			width: 100%;
			justify-content: flex-start;
		}
	}
</style>
