<script lang="ts">
	import { Brain, ChevronRight } from 'lucide-svelte';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import type { ThinkingEntry } from '../session-store.svelte';
	import { firstLine } from '../format';

	let { entry, live = false }: { entry: ThinkingEntry; live?: boolean } = $props();

	const open = $derived(live || entry.expanded);
	const preview = $derived(open ? '' : firstLine(entry.text));
</script>

<div class="think" class:think--live={live}>
	<button
		type="button"
		class="think-row"
		aria-expanded={open}
		title={open ? undefined : entry.text}
		onclick={() => (entry.expanded = !open)}
	>
		<Brain class="h-3.5 w-3.5 shrink-0" />
		<span class="think-label">{live ? 'Thinking' : 'Thought'}</span>
		{#if preview}<span class="think-preview">{preview}</span>{/if}
		<span class="think-chev" {@attach springRotate(() => open, { rest: 0, on: 90 })}>
			<ChevronRight class="h-3 w-3" />
		</span>
	</button>
	{#if open}
		<pre
			class="think-body"
			transition:slide
			{@attach (el) => {
				void entry.text;
				if (live) el.scrollTop = el.scrollHeight;
			}}>{entry.text}</pre>
	{/if}
</div>

<style>
	.think {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.think-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		width: fit-content;
		max-width: 100%;
		padding: 0.1875rem 0.5rem 0.1875rem 0.375rem;
		margin-left: -0.375rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
		text-align: left;
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.think-row:hover {
		background: var(--bg-hover);
		color: var(--text-muted);
	}

	.think-label {
		flex-shrink: 0;
		font-weight: 500;
	}

	.think--live .think-label {
		color: var(--text-muted);
	}

	.think-preview {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-style: italic;
	}

	.think-chev {
		display: inline-flex;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity var(--dur-fast);
	}

	.think-row:hover .think-chev,
	.think-row:focus-visible .think-chev,
	.think-row[aria-expanded='true'] .think-chev {
		opacity: 1;
	}

	.think-body {
		margin: 0.125rem 0 0.375rem 1.5rem;
		padding: 0;
		max-height: 12.5em;
		overflow-y: auto;
		font-family: var(--font-sans);
		font-size: var(--text-footnote);
		line-height: 1.6;
		font-style: italic;
		color: var(--text-faint);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.think--live .think-body {
		color: var(--text-muted);
	}
</style>
