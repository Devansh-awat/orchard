<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Bot } from 'lucide-svelte';
	import type { AgentEntry } from '../session-store.svelte';
	import { isRunning } from '../steps';
	import StepRow from './StepRow.svelte';

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

	const running = $derived(isRunning(entry.status));
	const failed = $derived(entry.status === 'error');
</script>

{#snippet bot()}<Bot size={16} strokeWidth={1.75} />{/snippet}

{#snippet description()}
	<span class="agent-desc">{entry.description}</span>
{/snippet}

{#if nested}
	<StepRow title={entry.agentType} nested icon={bot} trailing={description} />
{:else}
	<StepRow
		title={`${entry.agentType} agent`}
		{running}
		{failed}
		expanded={entry.expanded}
		ontoggle={() => ontoggle(entry)}
		icon={bot}
		trailing={description}
	>
		<div class="agent-body">
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
	</StepRow>
{/if}

<style>
	.agent-desc {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
	}

	.agent-body {
		display: flex;
		flex-direction: column;
		max-height: 24rem;
		overflow-y: auto;
	}

	.agent-empty {
		margin: 0;
		font-size: calc(var(--gh-reading, var(--text-body)) - 0.0625rem);
		line-height: calc(var(--gh-lh-reading, 1.5rem) - 0.25rem);
		color: var(--text-faint);
	}
</style>
