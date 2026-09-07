<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, ArrowRight, TriangleAlert } from 'lucide-svelte';
	import { SectionCard, Skeleton } from '$lib/components/ui';
	import { apiFetch } from '$lib/stores';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';

	type Item = {
		id: string;
		title: string;
		detail: string;
		done: boolean;
		severity: 'normal' | 'warning';
		href?: string;
	};

	let items = $state<Item[]>([]);
	let loading = $state(true);

	const outstanding = $derived(items.filter((i) => !i.done));
	const settled = $derived(items.length - outstanding.length);

	onMount(async () => {
		try {
			const response = await apiFetch('/apiv1/setup/checklist');
			if (response.ok) items = await response.json();
		} finally {
			loading = false;
		}
	});
</script>

{#if loading}
	<Skeleton class="h-40 w-full" />
{:else if items.length > 0}
	<SectionCard
		title="Finish setting up this instance"
		description="{settled} of {items.length} done. None of these stop Orchard working, but each one turns something on."
	>
		<ul class="list">
			{#each items as item, i (item.id)}
				<svelte:element
					this={item.href && !item.done ? 'a' : 'li'}
					role={item.href && !item.done ? 'link' : 'listitem'}
					href={item.href && !item.done ? item.href : undefined}
					class="row"
					class:row-done={item.done}
					class:row-link={!!item.href && !item.done}
					{@attach motionStagger({ index: i })}
					{@attach springHover()}
				>
					<span class="mark" class:mark-done={item.done} class:mark-warn={!item.done && item.severity === 'warning'}>
						{#if item.done}
							<Check size={12} strokeWidth={3} />
						{:else if item.severity === 'warning'}
							<TriangleAlert size={12} />
						{/if}
					</span>
					<span class="body">
						<span class="title">{item.title}</span>
						<span class="detail">{item.detail}</span>
					</span>
					{#if item.href && !item.done}
						<ArrowRight size={14} class="go" />
					{/if}
				</svelte:element>
			{/each}
		</ul>
	</SectionCard>
{/if}

<style>
	.list {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: 0.625rem;
		background: var(--bg-surface);
		color: inherit;
		text-decoration: none;
	}

	.row-link:hover {
		border-color: var(--accent);
	}

	.row-done {
		opacity: 0.55;
	}

	.mark {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		margin-top: 0.125rem;
		border-radius: 999px;
		border: 1.5px solid var(--border-default);
		color: var(--bg-surface);
		flex-shrink: 0;
	}

	.mark-done {
		background: var(--status-success);
		border-color: var(--status-success);
	}

	.mark-warn {
		background: var(--status-warning);
		border-color: var(--status-warning);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		flex: 1;
	}

	.title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-fg);
	}

	.detail {
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--text-muted);
	}
</style>
