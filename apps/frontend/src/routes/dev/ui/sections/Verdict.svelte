<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		kind,
		note = undefined,
		align = 'center',
		compact = false,
		children
	}: {
		kind: 'do' | 'dont';
		note?: string;
		align?: 'center' | 'stretch';
		compact?: boolean;
		children: Snippet;
	} = $props();
</script>

<figure class="verdict">
	<div class="stage" class:stage--stretch={align === 'stretch'} class:stage--compact={compact}>
		{@render children()}
	</div>
	<figcaption class="cap">
		<span class="tag" class:tag--dont={kind === 'dont'}>{kind === 'do' ? 'Do' : "Don't"}</span>
		{#if note}<span class="note">{note}</span>{/if}
	</figcaption>
</figure>

<style>
	.verdict {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
		margin: 0;
	}
	.stage {
		position: relative;
		display: grid;
		place-items: center;
		min-height: 9rem;
		padding: 1.5rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 1px var(--rule);
	}
	.stage--compact {
		min-height: 0;
		padding: 1rem 1.25rem;
	}
	.stage--stretch {
		place-items: stretch;
		align-content: center;
	}
	.cap {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.tag {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		height: 1.25rem;
		padding: 0 0.375rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-active);
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		line-height: 1;
		text-box: trim-both cap alphabetic;
	}
	.tag--dont {
		background: var(--red-2);
		color: var(--red-9);
	}
	.note {
		min-width: 0;
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
</style>
