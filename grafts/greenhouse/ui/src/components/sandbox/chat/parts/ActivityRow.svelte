<script lang="ts">
	import { untrack } from 'svelte';
	import { ChevronRight, CircleX, ListCollapse } from 'lucide-svelte';
	import { greenhousePrefs } from '../../../greenhouse/prefs.svelte';
	import { springRotate } from '@orchard/graft-ui/utils/motion.svelte';
	import { fade, slide } from '../../../../lib/utils/transitions';
	import type { ChatSessionStore } from '../session-store.svelte';
	import { liveWindow, summarize, workedLabel, type AgentBlock } from '../turns';
	import Entry from './Entry.svelte';

	const LIVE_WINDOW = 12;

	let {
		block,
		store,
		live = false
	}: {
		block: AgentBlock;
		store: ChatSessionStore;
		live?: boolean;
	} = $props();

	let toggled = $state<boolean | null>(null);
	let everything = $state(false);
	let seen: boolean | undefined;
	$effect(() => {
		const next = greenhousePrefs.values.expandTools;
		if (seen !== undefined && seen !== next) untrack(() => (toggled = null));
		seen = next;
	});

	const open = $derived(live ? toggled !== false : (toggled ?? greenhousePrefs.values.expandTools));
	const steps = $derived(
		greenhousePrefs.values.showReasoning
			? block.steps
			: block.steps.filter((step) => step.entry.kind !== 'thinking')
	);
	const visible = $derived(
		live && !everything ? liveWindow(steps, LIVE_WINDOW) : { hidden: 0, shown: steps }
	);
	const summary = $derived(summarize(block));
	const expandable = $derived(steps.length > 0);
	const count = $derived(
		summary.steps > 0 ? `${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'}` : ''
	);
	const lastStep = $derived(block.steps[block.steps.length - 1]?.entry ?? null);
</script>

<div class="act" class:act--live={live}>
	{#if expandable}
		<button
			type="button"
			class="act-row"
			data-align="content"
			aria-expanded={open}
			title={open ? 'Hide steps' : 'Show steps'}
			onclick={() => (toggled = !open)}
			in:fade
		>
			<span class="act-label">{live ? 'Working' : workedLabel(summary)}</span>
			{#if count}
				<span class="act-sep" aria-hidden="true">·</span>
				<span class="act-meta">{count}</span>
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
			<span class="act-chev" {@attach springRotate(() => open, { rest: 0, on: 90 })}>
				<ChevronRight size={16} strokeWidth={1.75} />
			</span>
		</button>
	{/if}
	{#if expandable && open}
		<div class="act-steps" transition:slide>
			{#if visible.hidden > 0}
				<button
					type="button"
					class="act-more"
					data-align="step"
					onclick={() => (everything = true)}
				>
					<span class="act-more-glyph" aria-hidden="true"
						><ListCollapse size={16} strokeWidth={1.75} /></span
					>
					Show {visible.hidden} earlier {visible.hidden === 1 ? 'step' : 'steps'}
				</button>
			{/if}
			{#each visible.shown as step (step.entry.key)}
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
		height: 2rem;
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

	.act-row:hover {
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
	}

	.act-more {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		width: fit-content;
		min-height: 2rem;
		padding: 0;
		border: none;
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-faint);
		cursor: pointer;
		transition: color var(--dur-fast);
	}

	.act-more:hover {
		color: var(--text-default);
	}

	.act-more-glyph {
		display: inline-flex;
		width: 1rem;
		height: 1rem;
	}
</style>
