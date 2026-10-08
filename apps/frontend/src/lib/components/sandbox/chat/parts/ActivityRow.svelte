<script lang="ts">
	import { ChevronRight, CircleX } from 'lucide-svelte';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import type { ChatSessionStore } from '../session-store.svelte';
	import { fmtWorked, liveStep, summarize, type AgentBlock } from '../turns';
	import Entry from './Entry.svelte';

	let {
		block,
		store,
		live = false,
		status = null
	}: {
		block: AgentBlock;
		store: ChatSessionStore;
		live?: boolean;
		status?: string | null;
	} = $props();

	let open = $state(false);

	const summary = $derived(summarize(block));
	const expandable = $derived(block.steps.length > 0);
	const label = $derived.by(() => {
		if (live) return status ?? liveStep(block);
		const verb = summary.thoughtOnly ? 'Thought' : 'Worked';
		return summary.duration !== null ? `${verb} for ${fmtWorked(summary.duration)}` : verb;
	});
	const steps = $derived(
		summary.steps > 0 ? `${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'}` : ''
	);
	const lastStep = $derived(block.steps[block.steps.length - 1]?.entry ?? null);
</script>

<div class="act">
	<button
		type="button"
		class="act-row"
		class:act-row--live={live}
		data-align="content"
		aria-expanded={expandable ? open : undefined}
		disabled={!expandable}
		title={expandable ? (open ? 'Hide steps' : 'Show steps') : undefined}
		onclick={() => (open = !open)}
	>
		<span class="act-label">{label}</span>
		{#if steps}
			<span class="act-sep" aria-hidden="true">·</span>
			<span class="act-meta">{steps}</span>
		{/if}
		{#if summary.add > 0 || summary.del > 0}
			<span class="act-sep" aria-hidden="true">·</span>
			<span class="act-diff">
				{#if summary.add > 0}<span class="diff-add">+{summary.add}</span>{/if}
				{#if summary.del > 0}<span class="diff-del">−{summary.del}</span>{/if}
			</span>
		{/if}
		{#if summary.failed > 0}
			<span class="act-sep" aria-hidden="true">·</span>
			<span class="act-failed">
				<span class="act-failed-glyph" aria-hidden="true"
					><CircleX size={16} strokeWidth={1.75} /></span
				>
				{summary.failed} failed
			</span>
		{/if}
		{#if expandable}
			<span class="act-chev" {@attach springRotate(() => open, { rest: 0, on: 90 })}>
				<ChevronRight size={16} strokeWidth={1.75} />
			</span>
		{/if}
	</button>
	{#if open}
		<div class="act-steps" transition:slide>
			{#each block.steps as step (step.entry.key)}
				<Entry
					entry={step.entry}
					{store}
					index={step.index}
					live={live &&
						step.entry === lastStep &&
						step.entry.kind === 'thinking' &&
						!step.entry.done}
				/>
			{/each}
		</div>
	{/if}
</div>

<style>
	.act {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.act-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		max-width: 100%;
		width: fit-content;
		height: 1.75rem;
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

	.act-row:disabled {
		cursor: default;
	}

	.act-row:hover:not(:disabled) {
		color: var(--text-default);
	}

	.act-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.act-sep {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.act-meta,
	.act-diff,
	.act-failed {
		flex-shrink: 0;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.act-diff {
		display: inline-flex;
		gap: var(--space-1);
	}

	.diff-add {
		color: var(--status-success);
	}

	.diff-del {
		color: var(--status-error);
	}

	.act-failed {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-weight: 600;
		color: var(--text-default);
	}

	.act-failed-glyph {
		display: inline-flex;
		color: var(--status-error);
	}

	.act-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.act-steps {
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: var(--space-1) 0 var(--space-1) var(--space-4);
	}
</style>
