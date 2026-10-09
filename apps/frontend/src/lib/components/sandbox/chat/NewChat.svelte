<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { Check, LoaderCircle, MessagesSquare, NotebookText } from 'lucide-svelte';
	import { toasts } from '$lib/stores';
	import type { ContextChat, ContextPlan } from './context-attach';

	const LIMIT = 4;

	let {
		branch = null,
		chats = [],
		plans = [],
		attached = [],
		onchat,
		onplan
	}: {
		branch?: string | null;
		chats?: ContextChat[];
		plans?: ContextPlan[];
		attached?: string[];
		onchat: (chat: ContextChat) => Promise<string[]>;
		onplan: (plan: ContextPlan) => Promise<string[]>;
	} = $props();

	const links = new SvelteMap<string, string[]>();
	const working = new SvelteSet<string>();
	let allChats = $state(false);
	let allPlans = $state(false);

	const shownChats = $derived(allChats ? chats : chats.slice(0, LIMIT));
	const shownPlans = $derived(allPlans ? plans : plans.slice(0, LIMIT));

	function isAdded(id: string) {
		return links.get(id)?.some((a) => attached.includes(a)) ?? false;
	}

	async function attach(id: string, run: () => Promise<string[]>, what: string) {
		if (working.has(id) || isAdded(id)) return;
		working.add(id);
		try {
			links.set(id, await run());
		} catch (error) {
			toasts.add({
				title: `Could not add the ${what}`,
				description: error instanceof Error ? error.message : undefined,
				color: 'error'
			});
		} finally {
			working.delete(id);
		}
	}
</script>

{#snippet chip(
	id: string,
	label: string,
	hint: string | undefined,
	kind: 'chat' | 'plan',
	run: () => Promise<string[]>
)}
	{@const done = isAdded(id)}
	{@const busy = working.has(id)}
	<button
		type="button"
		class="chip"
		class:chip--done={done}
		disabled={done}
		aria-busy={busy}
		title={hint ? `${label} · ${hint}` : label}
		onclick={() => attach(id, run, kind === 'chat' ? 'chat transcript' : 'plan')}
	>
		<span class="chip-glyph" aria-hidden="true">
			{#if busy}
				<span class="chip-spin" data-motion="progress"
					><LoaderCircle size={14} strokeWidth={1.75} /></span
				>
			{:else if done}
				<Check size={14} strokeWidth={1.75} />
			{:else if kind === 'chat'}
				<MessagesSquare size={14} strokeWidth={1.75} />
			{:else}
				<NotebookText size={14} strokeWidth={1.75} />
			{/if}
		</span>
		<span class="chip-label">{label}</span>
		{#if done}<span class="chip-state">Added</span>{/if}
	</button>
{/snippet}

<div class="new" data-align="content">
	<p class="new-title">
		{#if branch}New chat in <code class="new-branch">{branch}</code>.{:else}New chat.{/if}
	</p>
	{#if chats.length > 0}
		<div class="new-group">
			<p class="new-label" id="new-chat-transcripts">Add chat transcripts:</p>
			<div class="new-chips" role="group" aria-labelledby="new-chat-transcripts">
				{#each shownChats as chat (chat.id)}
					{@render chip(chat.id, chat.title, chat.hint, 'chat', () => onchat(chat))}
				{/each}
				{#if !allChats && chats.length > LIMIT}
					<button type="button" class="chip chip--more" onclick={() => (allChats = true)}>
						+{chats.length - LIMIT} more
					</button>
				{/if}
			</div>
		</div>
	{/if}
	{#if plans.length > 0}
		<div class="new-group">
			<p class="new-label" id="new-chat-plans">Add plans:</p>
			<div class="new-chips" role="group" aria-labelledby="new-chat-plans">
				{#each shownPlans as plan (plan.path)}
					{@render chip(plan.path, plan.label, plan.name, 'plan', () => onplan(plan))}
				{/each}
				{#if !allPlans && plans.length > LIMIT}
					<button type="button" class="chip chip--more" onclick={() => (allPlans = true)}>
						+{plans.length - LIMIT} more
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.new {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	.new-title {
		margin: 0;
		font-size: var(--gh-reading, var(--text-body));
		line-height: var(--gh-lh-reading, 1.5rem);
		font-weight: 600;
		color: var(--text-default);
	}

	.new-branch {
		padding: 0.125rem var(--space-2);
		border-radius: var(--radius-xs);
		background: var(--fill-soft);
		font-family: var(--gh-mono, var(--font-mono, monospace));
		font-size: 0.9em;
		font-weight: 400;
	}

	.new-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}

	.new-label {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.new-chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		min-width: 0;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		max-width: 16rem;
		height: 1.75rem;
		padding: 0 var(--space-3) 0 var(--space-2);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			border-color var(--dur-fast),
			color var(--dur-fast);
	}

	.chip:hover:not(:disabled) {
		background: var(--bg-hover);
		border-color: var(--border-strong);
	}

	.chip:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.chip--done {
		background: var(--fill-quiet);
		color: var(--text-muted);
		cursor: default;
	}

	.chip--more {
		padding: 0 var(--space-3);
		color: var(--text-muted);
	}

	.chip-glyph {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.chip--done .chip-glyph {
		color: var(--status-success);
	}

	.chip-spin {
		display: inline-flex;
		animation: chip-spin 1s linear infinite;
	}

	.chip-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip-state {
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-faint);
	}

	@keyframes chip-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
