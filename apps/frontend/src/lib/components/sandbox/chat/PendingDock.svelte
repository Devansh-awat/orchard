<script lang="ts">
	import { slide } from '$lib/utils/transitions';
	import { planHandoff } from './pending';
	import type { ChatSessionStore } from './session-store.svelte';
	import PermissionCard from './parts/PermissionCard.svelte';
	import PlanCard from './parts/PlanCard.svelte';
	import QuestionCard from './parts/QuestionCard.svelte';

	let { store, readonly = false }: { store: ChatSessionStore; readonly?: boolean } = $props();

	const items = $derived(store.requests);
	const directory = $derived(store.agentDirectory());
	const focusId = $derived(items.find((item) => item.state === 'open')?.request.id ?? null);
	const locked = $derived(readonly || !store.canAnswer());
</script>

{#if items.length > 0}
	<div class="pending" aria-live="polite" transition:slide>
		{#each items as item (item.request.id)}
			{@const request = item.request}
			{@const focus = request.id === focusId}
			<div class="pending-item" transition:slide>
				{#if request.kind === 'permission'}
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
		margin: calc(-1 * var(--space-1)) calc(-1 * var(--space-4)) 0;
		padding: var(--space-1) var(--space-4);
	}

	.pending-item {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
</style>
