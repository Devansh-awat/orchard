<script lang="ts">
	import { Brain, ChevronRight } from 'lucide-svelte';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import type { ThinkingEntry } from '../session-store.svelte';
	import { firstLine } from '../format';

	let {
		entry,
		live = false,
		nested = false
	}: { entry: ThinkingEntry; live?: boolean; nested?: boolean } = $props();

	const open = $derived(entry.expanded);
	const preview = $derived(open ? '' : firstLine(entry.text));
</script>

<div class="think">
	<button
		type="button"
		class="step"
		data-align={nested ? undefined : 'step'}
		aria-expanded={open}
		title={open ? undefined : entry.text}
		onclick={() => (entry.expanded = !open)}
	>
		<span class="step-glyph" aria-hidden="true"><Brain size={16} strokeWidth={1.75} /></span>
		<span class="step-verb">{live ? 'Thinking' : 'Thought'}</span>
		{#if preview}<span class="step-preview">{preview}</span>{/if}
		<span class="step-chev" {@attach springRotate(() => open, { rest: 0, on: 90 })}>
			<ChevronRight size={16} strokeWidth={1.75} />
		</span>
	</button>
	{#if open}
		<p
			class="think-body"
			transition:slide
			{@attach (el) => {
				void entry.text;
				if (live) el.scrollTop = el.scrollHeight;
			}}
		>
			{entry.text}
		</p>
	{/if}
</div>

<style>
	.think {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.step {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		max-width: 100%;
		width: fit-content;
		min-height: 1.75rem;
		padding: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
		transition: color var(--dur-fast);
	}

	.step:hover {
		color: var(--text-default);
	}

	.step-glyph {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		color: var(--text-faint);
	}

	.step-verb {
		flex-shrink: 0;
	}

	.step-preview {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
	}

	.step-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
		opacity: 0;
		transition: opacity var(--dur-fast);
	}

	.step:hover .step-chev,
	.step:focus-visible .step-chev,
	.step[aria-expanded='true'] .step-chev {
		opacity: 1;
	}

	.think-body {
		margin: 0 0 var(--space-2) var(--space-6);
		max-height: 15rem;
		overflow-y: auto;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
