<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Bot, ChevronRight, CircleX, LoaderCircle } from 'lucide-svelte';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import type { AgentEntry } from '../session-store.svelte';

	let {
		entry,
		nested = false,
		ontoggle,
		children
	}: {
		entry: AgentEntry;
		nested?: boolean;
		ontoggle: (entry: AgentEntry) => void;
		children: Snippet;
	} = $props();

	const running = $derived(entry.status === 'running' || entry.status === 'pending');
	const failed = $derived(entry.status === 'error');
</script>

{#if nested}
	<div class="step step--static">
		<span class="step-glyph" aria-hidden="true"><Bot size={16} strokeWidth={1.75} /></span>
		<span class="step-verb">{entry.agentType}</span>
		<span class="step-desc">{entry.description}</span>
	</div>
{:else}
	<div class="agent">
		<button
			type="button"
			class="step"
			data-align="step"
			aria-expanded={entry.expanded}
			onclick={() => ontoggle(entry)}
		>
			<span class="step-glyph" class:step-glyph--failed={failed} aria-hidden="true">
				{#if running}
					<span class="spin" data-motion="progress"
						><LoaderCircle size={16} strokeWidth={1.75} /></span
					>
				{:else if failed}
					<CircleX size={16} strokeWidth={1.75} />
				{:else}
					<Bot size={16} strokeWidth={1.75} />
				{/if}
			</span>
			<span class="step-verb">{entry.agentType} agent</span>
			<span class="step-desc">{entry.description}</span>
			{#if failed}<span class="step-failed">Failed</span>{/if}
			<span class="step-chev" {@attach springRotate(() => entry.expanded, { rest: 0, on: 90 })}>
				<ChevronRight size={16} strokeWidth={1.75} />
			</span>
		</button>
		{#if entry.expanded}
			<div class="agent-body" transition:slide>
				{#if entry.loading}
					<p class="agent-empty">Loading the sub-agent transcript</p>
				{:else if !entry.childID}
					<p class="agent-empty">No transcript yet.</p>
				{:else if entry.entries.length === 0}
					<p class="agent-empty">The sub-agent has not produced output yet.</p>
				{:else}
					{@render children()}
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.agent {
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

	.step--static {
		cursor: default;
	}

	.step-glyph {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		color: var(--text-faint);
	}

	.step-glyph--failed {
		color: var(--status-error);
	}

	.spin {
		display: inline-flex;
		animation: spin 1s linear infinite;
	}

	.step-verb {
		flex-shrink: 0;
	}

	.step-desc {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
	}

	.step-failed {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--text-default);
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

	.agent-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		max-height: 24rem;
		margin: 0 0 var(--space-2) var(--space-6);
		overflow-y: auto;
	}

	.agent-empty {
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-faint);
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
