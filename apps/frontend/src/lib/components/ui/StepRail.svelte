<script lang="ts">
	import { Check, SkipForward } from 'lucide-svelte';
	import { springPop, motion } from '$lib/utils/motion.svelte';
	import type { RailStep } from './steprail';

	let {
		steps,
		current
	}: {
		steps: RailStep[];
		current: string;
	} = $props();

	const currentIndex = $derived(Math.max(0, steps.findIndex((s) => s.id === current)));
	const settled = $derived(steps.filter((s) => s.done || s.skipped).length);
	const progress = $derived(steps.length <= 1 ? 1 : settled / steps.length);

	let fillEl = $state<HTMLElement | undefined>();

	$effect(() => {
		const value = progress;
		if (!fillEl) return;
		motion(fillEl, { transform: `scaleX(${value})` }, 'smooth');
	});
</script>

<div class="rail" role="list" aria-label="Setup progress">
	<div class="rail-track" aria-hidden="true">
		<div class="rail-fill" bind:this={fillEl}></div>
	</div>

	{#each steps as step, i (step.id)}
		{@const state = step.done ? 'done' : step.skipped ? 'skipped' : i === currentIndex ? 'active' : 'idle'}
		<div class="rail-step" role="listitem" data-state={state}>
			<div class="rail-dot" {@attach springPop(() => step.done)}>
				{#if step.done}
					<Check size={12} strokeWidth={3} />
				{:else if step.skipped}
					<SkipForward size={11} />
				{:else}
					<span class="rail-num">{i + 1}</span>
				{/if}
			</div>
			<span class="rail-label">{step.label}</span>
		</div>
	{/each}
</div>

<style>
	.rail {
		position: relative;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0 0.5rem;
	}

	.rail-track {
		position: absolute;
		top: 0.8125rem;
		left: 2.5rem;
		right: 2.5rem;
		height: 2px;
		border-radius: 999px;
		background: var(--border-default);
		overflow: hidden;
	}

	.rail-fill {
		height: 100%;
		width: 100%;
		transform-origin: left center;
		background: var(--status-success);
		transform: scaleX(0);
	}

	.rail-step {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.rail-dot {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.625rem;
		height: 1.625rem;
		border-radius: 999px;
		border: 1.5px solid var(--border-default);
		background: var(--bg-surface);
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.rail-num {
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1;
	}

	.rail-label {
		font-size: 0.75rem;
		color: var(--text-faint);
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.rail-step[data-state='active'] .rail-dot {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-subtle);
	}

	.rail-step[data-state='active'] .rail-label {
		color: var(--text-fg);
		font-weight: 500;
	}

	.rail-step[data-state='done'] .rail-dot {
		border-color: var(--status-success);
		background: var(--status-success);
		color: var(--bg-surface);
	}

	.rail-step[data-state='done'] .rail-label {
		color: var(--text-muted);
	}

	.rail-step[data-state='skipped'] .rail-dot {
		border-style: dashed;
	}
</style>
