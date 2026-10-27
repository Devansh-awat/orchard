<script lang="ts">
	import { Check, X } from 'lucide-svelte';
	import { springPop } from '$lib/utils/motion.svelte';
	import { formatStepDuration, railStatus, type RailStep } from './steprail';

	let {
		steps,
		current = undefined,
		label = 'Build steps'
	}: {
		steps: RailStep[];
		current?: string;
		label?: string;
	} = $props();

	const STATE_LABEL = {
		queued: 'Queued',
		running: 'Running',
		done: 'Done',
		failed: 'Failed',
		skipped: 'Skipped'
	} as const;

	const states = $derived(steps.map((s) => railStatus(s, current)));
</script>

<ol class="rail" aria-label={label}>
	{#each steps as step, i (step.id)}
		{@const state = states[i]}
		{@const settled = state === 'done' || state === 'skipped'}
		<li class="step" data-state={state} class:step--settled={settled}>
			<span class="track" aria-hidden="true">
				<span
					class="seg seg--in"
					class:seg--none={i === 0}
					class:seg--lit={i > 0 && (states[i - 1] === 'done' || states[i - 1] === 'skipped')}
				></span>
				<span class="node" {@attach springPop(() => state === 'done' || state === 'failed')}>
					<span class="mark mark--done"><Check size={10} strokeWidth={3.25} /></span>
					<span class="mark mark--failed"><X size={10} strokeWidth={3.25} /></span>
					<span class="mark mark--live" data-motion="progress"></span>
				</span>
				<span class="seg seg--out" class:seg--none={i === steps.length - 1} class:seg--lit={settled}
				></span>
			</span>
			<span class="body">
				<span class="head"><span class="label">{step.label}</span></span>
				{#if step.detail}<span class="detail">{step.detail}</span>{/if}
			</span>
			<span class="meta">
				<span class="sr">{STATE_LABEL[state]}</span>
				{#if state === 'skipped'}
					<span class="dur dur--quiet">Skipped</span>
				{:else if state === 'queued'}
					<span class="dur dur--quiet">Queued</span>
				{:else if step.durationMs != null}
					<span class="dur">{formatStepDuration(step.durationMs)}</span>
				{/if}
			</span>
		</li>
	{/each}
</ol>

<style>
	.rail {
		--node: 1rem;
		--pad: 0.5rem;
		--line: 1.5px;
		--gap: 0.25rem;
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.step {
		display: grid;
		grid-template-columns: var(--node) minmax(0, 1fr) auto;
		column-gap: 0.75rem;
		align-items: start;
		padding: var(--pad) 0;
	}
	.track {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		align-self: stretch;
		margin-block: calc(var(--pad) * -1);
	}
	.seg {
		position: relative;
		width: var(--line);
		background: var(--border-default);
		overflow: hidden;
	}
	.seg::after {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--status-success-solid);
		transform: scaleY(0);
		transform-origin: top;
		transition: transform var(--spring-glide-duration) var(--spring-glide);
	}
	.seg--lit::after {
		transform: scaleY(1);
	}
	.seg--none {
		visibility: hidden;
	}
	.seg--in {
		flex-shrink: 0;
		height: calc(var(--pad) - var(--gap));
		margin-bottom: var(--gap);
	}
	.seg--out {
		flex: 1;
		min-height: var(--gap);
		margin-top: var(--gap);
	}
	.node {
		position: relative;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: var(--node);
		height: var(--node);
		border-radius: 50%;
		background: var(--bg-surface);
		box-shadow: inset 0 0 0 1.5px var(--border-strong);
		color: var(--text-on-accent);
	}
	.mark {
		grid-area: 1 / 1;
		display: flex;
		opacity: 0;
		transform: scale(0.4);
		transition:
			opacity var(--fade-in) var(--curve-out),
			transform var(--spring-pop-duration) var(--spring-pop);
	}
	.mark--live {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background: var(--status-progress-solid);
	}
	.mark--live::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: inherit;
		animation: rail-ripple 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
	@keyframes rail-ripple {
		from {
			transform: scale(1);
			opacity: 0.55;
		}
		to {
			transform: scale(2.8);
			opacity: 0;
		}
	}
	.step[data-state='done'] .node {
		background: var(--status-success-solid);
		box-shadow:
			inset 0 1px 0 color-mix(in oklab, white 20%, transparent),
			0 1px 2px color-mix(in oklab, var(--green-10) 20%, transparent);
	}
	.step[data-state='failed'] .node {
		background: var(--status-error-solid);
		box-shadow:
			inset 0 1px 0 color-mix(in oklab, white 20%, transparent),
			0 1px 2px color-mix(in oklab, var(--red-10) 20%, transparent);
	}
	.step[data-state='running'] .node {
		background: var(--status-progress-bg);
		box-shadow: inset 0 0 0 1.5px var(--status-progress-solid);
	}
	.step[data-state='skipped'] .node {
		background: none;
		box-shadow: none;
		outline: 1.5px dashed var(--border-strong);
		outline-offset: -1.5px;
	}
	.step[data-state='done'] .mark--done,
	.step[data-state='failed'] .mark--failed,
	.step[data-state='running'] .mark--live {
		opacity: 1;
		transform: none;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: center;
		min-width: 0;
		height: var(--node);
	}
	.label {
		display: block;
		min-width: 0;
		overflow: hidden;
		padding-block: 0.3em;
		margin-block: -0.3em;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
	}
	.detail {
		display: block;
		min-width: 0;
		overflow: hidden;
		padding-block: 0.3em;
		margin-block: -0.3em;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
	}
	.step[data-state='queued'] .label,
	.step[data-state='skipped'] .label {
		color: var(--text-faint);
		font-weight: var(--weight-regular);
	}
	.step[data-state='failed'] .label {
		color: var(--status-error);
	}
	.step[data-state='failed'] .detail {
		color: var(--status-error);
		opacity: 0.85;
	}
	.meta {
		display: flex;
		align-items: center;
		height: var(--node);
	}
	.dur {
		display: block;
		font-size: var(--text-callout);
		line-height: 1;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		text-box: trim-both cap alphabetic;
	}
	.step[data-state='running'] .dur {
		color: var(--text-default);
	}
	.dur--quiet {
		color: var(--text-faint);
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
