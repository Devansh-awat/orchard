<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronRight } from 'lucide-svelte';
	import { springCollapse, springRotate } from '$lib/utils/motion.svelte';

	let {
		title,
		note = undefined,
		open = $bindable(false),
		children
	}: {
		title: string;
		note?: string;
		open?: boolean;
		children: Snippet;
	} = $props();

	const uid = $props.id();
</script>

<div class="disclosure">
	<button
		type="button"
		class="summary"
		aria-expanded={open}
		aria-controls="{uid}-body"
		onclick={() => (open = !open)}
	>
		<span class="chevron" {@attach springRotate(() => open, { rest: 0, on: 90 })}>
			<ChevronRight size={15} />
		</span>
		<span class="title">{title}</span>
		{#if note}<span class="note">{note}</span>{/if}
	</button>
	<div id="{uid}-body" {@attach springCollapse(() => !open)}>
		<div class="body">{@render children()}</div>
	</div>
</div>

<style>
	.disclosure {
		display: flex;
		flex-direction: column;
	}
	.summary {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		width: 100%;
		min-height: 2rem;
		margin: 0 -0.5rem;
		padding: 0 0.5rem;
		border: none;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: none;
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.summary:hover {
		background: color-mix(in oklab, var(--neutral-10) 5%, transparent);
	}
	.summary:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.chevron {
		display: inline-flex;
		color: var(--text-muted);
	}
	.note {
		margin-left: auto;
		font-size: var(--text-caption);
		font-weight: var(--weight-regular);
		color: var(--text-muted);
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding-top: 0.75rem;
	}
</style>
