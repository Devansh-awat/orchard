<script lang="ts">
	import { CircleCheck, GitBranch, GitMerge, LoaderCircle, Pencil } from 'lucide-svelte';
	import type { SessionActivityState } from './types';

	let {
		activity,
		draft = false,
		merged = false
	}: { activity: SessionActivityState; draft?: boolean; merged?: boolean } = $props();

	const label = $derived(
		activity === 'working'
			? 'Agent working'
			: activity === 'needs_input'
				? 'Needs you'
				: merged
					? 'Merged'
					: activity === 'done'
						? 'Done'
						: draft
							? 'Unsent draft'
							: 'Idle'
	);
</script>

<span class="glyph glyph--{activity}" class:glyph--merged={merged} title={label} aria-label={label}>
	{#if activity === 'working'}
		<span class="spin" data-motion="progress"><LoaderCircle size={14} strokeWidth={2} /></span>
	{:else if activity === 'needs_input'}
		<span class="dot"></span>
	{:else if merged}
		<GitMerge size={14} strokeWidth={1.75} />
	{:else if activity === 'done'}
		<CircleCheck size={14} strokeWidth={1.75} />
	{:else if draft}
		<Pencil size={13} strokeWidth={1.75} />
	{:else}
		<GitBranch size={14} strokeWidth={1.75} />
	{/if}
</span>

<style>
	.glyph {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		height: 1rem;
		color: var(--gh-glyph-idle, var(--gh-faint));
	}

	.glyph--working {
		color: var(--gh-text);
	}

	.glyph--needs_input {
		color: var(--status-warning);
	}

	.glyph--done {
		color: var(--status-success);
	}

	.glyph--merged {
		color: var(--hue-violet);
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		background: currentColor;
		box-shadow: 0 0 0 3px color-mix(in oklab, currentColor 22%, transparent);
	}

	.spin {
		display: inline-grid;
		animation: gh-spin 0.9s linear infinite;
	}

	@keyframes gh-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
