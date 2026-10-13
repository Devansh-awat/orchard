<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Avatar } from '@orchard/graft-ui';
	import { slide } from '../../../lib/utils/transitions';
	import { planHandoff, waitingOn, type AgentRequest, type RequestAuthor } from './pending';
	import type { ChatSessionStore, UserEntry } from './session-store.svelte';
	import PermissionCard from './parts/PermissionCard.svelte';
	import PlanCard from './parts/PlanCard.svelte';
	import QuestionCard from './parts/QuestionCard.svelte';

	let { store, readonly = false }: { store: ChatSessionStore; readonly?: boolean } = $props();

	const expanded = new SvelteSet<string>();

	const items = $derived(store.requests);
	const directory = $derived(store.agentDirectory());
	const locked = $derived(readonly || !store.canAnswer());
	const selfId = $derived(store.self?.id ?? null);

	function lastPrompt(root: string): UserEntry | null {
		const entries = store.threads.get(root)?.entries ?? [];
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.kind === 'user') return entry;
		}
		return null;
	}

	function ownerOf(request: AgentRequest): RequestAuthor | null {
		if (expanded.has(request.id)) return null;
		const prompt = lastPrompt(store.rootOf(request.sessionID));
		return waitingOn(prompt, (id) => store.authorOf(id), selfId);
	}

	const waits = $derived(new Map(items.map((item) => [item.request.id, ownerOf(item.request)])));

	const focusId = $derived(
		items.find((item) => item.state === 'open' && !waits.get(item.request.id))?.request.id ?? null
	);

	function verb(request: AgentRequest): string {
		if (request.kind === 'permission') return 'to approve';
		return planHandoff(request) ? 'to review the plan' : 'to answer';
	}
</script>

{#if items.length > 0}
	<div class="pending" aria-live="polite" transition:slide>
		{#each items as item (item.request.id)}
			{@const request = item.request}
			{@const focus = request.id === focusId}
			{@const owner = waits.get(request.id) ?? null}
			<div class="pending-item" transition:slide>
				{#if owner}
					<div class="waiting" data-align="content">
						<span class="waiting-avatar" aria-hidden="true">
							<Avatar
								user={{ id: owner.id, name: owner.name, imageUrl: owner.avatarUrl ?? null }}
								alt=""
								size={16}
								style="width: 1rem; height: 1rem; border-radius: 999px; object-fit: cover;"
							/>
						</span>
						<span class="waiting-text">
							Waiting on <span class="waiting-name">{owner.name}</span>
							{verb(request)}
						</span>
						<button type="button" class="waiting-open" onclick={() => expanded.add(request.id)}>
							{locked ? 'Show' : 'Answer anyway'}
						</button>
					</div>
				{:else if request.kind === 'permission'}
					<PermissionCard
						{store}
						{request}
						{directory}
						auto={item.state === 'auto'}
						readonly={locked}
						focusOnMount={focus}
					/>
				{:else}
					{@const handoff = planHandoff(request)}
					{#if handoff}
						<PlanCard
							{store}
							{request}
							{handoff}
							{directory}
							summary={store.lastAnswer(store.rootOf(request.sessionID))}
							readonly={locked}
							focusOnMount={focus}
						/>
					{:else}
						<QuestionCard {store} {request} readonly={locked} focusOnMount={focus} />
					{/if}
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.pending {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-height: 55vh;
		overflow-y: auto;
		margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) calc(-1 * var(--space-1));
		padding: var(--space-2) var(--space-2) var(--space-1);
	}

	.pending-item {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.waiting {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		min-height: 2rem;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.waiting-avatar {
		display: inline-flex;
		flex: none;
	}

	.waiting-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.waiting-name {
		font-weight: 600;
		color: var(--text-default);
	}

	.waiting-open {
		flex: none;
		padding: var(--space-1) var(--space-2);
		margin-right: calc(-1 * var(--space-2));
		border-radius: var(--radius-sm);
		color: var(--text-default);
		font-weight: 600;
		transition: background-color var(--dur-fast) ease;
	}

	.waiting-open:hover {
		background: var(--bg-hover);
	}

	.waiting-open:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}
</style>
