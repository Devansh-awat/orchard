<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, ArrowRight, TriangleAlert } from 'lucide-svelte';
	import { Skeleton } from '$lib/components/ui';
	import {
		instanceChecklist,
		instanceChecklistOutstanding,
		instanceChecklistWarnings
	} from '$lib/stores';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';

	let loading = $state(true);

	const total = $derived($instanceChecklist.length);
	const settled = $derived(total - $instanceChecklistOutstanding.length);
	const warnings = $derived($instanceChecklistWarnings.length);

	const heading = $derived(
		$instanceChecklistOutstanding.length === 0
			? 'This instance is fully set up'
			: `${$instanceChecklistOutstanding.length} of ${total} things left to set up`
	);

	onMount(async () => {
		await instanceChecklist.load(true);
		loading = false;
	});
</script>

{#if loading}
	<Skeleton class="h-44 w-full" />
{:else if total > 0}
	<section class="check" {@attach motionStagger({ index: 0 })}>
		<header class="check-head">
			<div>
				<h2 class="check-title">{heading}</h2>
				<p class="check-sub">
					{#if $instanceChecklistOutstanding.length === 0}
						Nothing here needs your attention.
					{:else}
						None of these stop Orchard working. Each one turns something on.
					{/if}
				</p>
			</div>
			<span class="check-count" class:check-count--warn={warnings > 0}>{settled}/{total}</span>
		</header>

		<ul class="check-list">
			{#each $instanceChecklist as item, i (item.id)}
				{@const actionable = !!item.href && !item.done}
				<svelte:element
					this={actionable ? 'a' : 'li'}
					role={actionable ? 'link' : 'listitem'}
					href={actionable ? item.href : undefined}
					class="row"
					class:row-done={item.done}
					class:row-link={actionable}
					{@attach motionStagger({ index: i + 1 })}
					{@attach springHover()}
				>
					<span
						class="mark"
						class:mark-done={item.done}
						class:mark-warn={!item.done && item.severity === 'warning'}
					>
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
					{#if actionable}
						<ArrowRight size={14} class="go" />
					{/if}
				</svelte:element>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.check {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xl);
		background-color: var(--bg-raised);
	}

	.check-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.check-title {
		font-size: var(--text-headline);
		font-weight: 650;
		color: var(--text-fg);
	}

	.check-sub {
		margin-top: 0.15rem;
		font-size: var(--text-footnote);
		line-height: 1.45;
		color: var(--text-muted);
	}

	.check-count {
		flex-shrink: 0;
		font-size: var(--text-caption);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--bg-sunken);
		color: var(--text-muted);
	}

	.check-count--warn {
		background-color: var(--status-warning-bg);
		color: var(--status-warning);
	}

	.check-list {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--bg-surface);
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
		border-radius: var(--radius-pill);
		border: 1.5px solid var(--border-default);
		color: var(--bg-surface);
		flex-shrink: 0;
	}

	.mark-done {
		background-color: var(--status-success);
		border-color: var(--status-success);
	}

	.mark-warn {
		background-color: var(--status-warning);
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
		font-size: var(--text-callout);
		font-weight: 500;
		color: var(--text-fg);
	}

	.detail {
		font-size: var(--text-caption);
		line-height: 1.4;
		color: var(--text-muted);
	}
</style>
