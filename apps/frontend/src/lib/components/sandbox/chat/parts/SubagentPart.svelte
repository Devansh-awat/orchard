<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Bot, ChevronRight, Loader2 } from 'lucide-svelte';
	import { StatusBadge, statusMeta } from '$lib/components/ui';
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
	const state = $derived(
		running
			? statusMeta('progress', 'Running', true)
			: entry.status === 'error'
				? statusMeta('error', 'Failed')
				: statusMeta('success', 'Done')
	);
</script>

{#if nested}
	<div class="agent-row agent-row--static">
		<Bot class="h-3.5 w-3.5 shrink-0 text-faint" />
		<span class="agent-type">{entry.agentType}</span>
		<span class="agent-desc">{entry.description}</span>
	</div>
{:else}
	<div class="agent" class:agent--open={entry.expanded}>
		<button
			type="button"
			class="agent-row"
			aria-expanded={entry.expanded}
			onclick={() => ontoggle(entry)}
		>
			<span class="agent-icon">
				{#if running}
					<Loader2 class="h-3.5 w-3.5 animate-spin" data-motion="progress" />
				{:else}
					<Bot class="h-3.5 w-3.5" />
				{/if}
			</span>
			<span class="agent-type">{entry.agentType}</span>
			<span class="agent-desc">{entry.description}</span>
			<StatusBadge meta={state} variant="plain" />
			<span class="agent-chev" {@attach springRotate(() => entry.expanded, { rest: 0, on: 90 })}>
				<ChevronRight class="h-3 w-3" />
			</span>
		</button>
		{#if entry.expanded}
			<div class="agent-body" transition:slide>
				{#if entry.loading}
					<p class="agent-empty">
						<Loader2 class="h-3.5 w-3.5 animate-spin" data-motion="progress" /> Loading sub-agent
					</p>
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
		margin: 0.125rem 0 0.125rem -0.5rem;
		border-radius: var(--radius-md);
		transition: background-color var(--dur-fast);
	}

	.agent--open {
		background: var(--fill-quiet);
	}

	.agent-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		width: 100%;
		padding: 0.3125rem 0.5rem;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.agent-row:hover {
		background: var(--bg-hover);
	}

	.agent-row--static {
		cursor: default;
		padding-left: 0;
	}

	.agent-row--static:hover {
		background: none;
	}

	.agent-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.agent-type {
		flex-shrink: 0;
		font-weight: 500;
		color: var(--text-default);
	}

	.agent-desc {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.agent-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.agent-body {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.25rem 0.75rem 0.625rem 2rem;
		max-height: 24rem;
		overflow-y: auto;
	}

	.agent-empty {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
</style>
