<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';

	let {
		columns,
		rows,
		row,
		rowKey = (_item: T, i: number) => i,
		rowHref = undefined,
		onRowClick = undefined,
		empty = undefined,
		stagger = true
	}: {
		columns: { id: string; label?: string; width?: string; align?: 'start' | 'end' }[];
		rows: T[];
		row: Snippet<[T, number]>;
		rowKey?: (item: T, i: number) => unknown;
		rowHref?: (item: T) => string;
		onRowClick?: (item: T) => void;
		empty?: Snippet;
		stagger?: boolean;
	} = $props();

	const template = $derived(columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' '));
	const hasLabels = $derived(columns.some((c) => c.label));
</script>

<div class="ui-table">
	{#if rows.length === 0}
		{#if empty}
			{@render empty()}
		{/if}
	{:else}
		{#if hasLabels}
			<div class="ui-table-head" style="grid-template-columns: {template}">
				{#each columns as col (col.id)}
					<span class="ui-table-head-cell" class:ui-table-cell--end={col.align === 'end'}>
						{col.label ?? ''}
					</span>
				{/each}
			</div>
		{/if}
		{#each rows as item, i (rowKey(item, i))}
			{#if rowHref}
				<a
					href={rowHref(item)}
					class="ui-table-row"
					style="grid-template-columns: {template}"
					{@attach motionStagger(stagger ? { index: i } : { index: 0 })}
				>
					{@render row(item, i)}
				</a>
			{:else if onRowClick}
				<button
					type="button"
					class="ui-table-row"
					style="grid-template-columns: {template}"
					onclick={() => onRowClick(item)}
					{@attach motionStagger(stagger ? { index: i } : { index: 0 })}
				>
					{@render row(item, i)}
				</button>
			{:else}
				<div
					class="ui-table-row ui-table-row--static"
					style="grid-template-columns: {template}"
					{@attach motionStagger(stagger ? { index: i } : { index: 0 })}
				>
					{@render row(item, i)}
				</div>
			{/if}
		{/each}
	{/if}
</div>

<style>
	.ui-table {
		display: flex;
		flex-direction: column;
	}

	.ui-table-head {
		display: grid;
		gap: 1rem;
		align-items: center;
		padding: 0.375rem 0.75rem;
	}

	.ui-table-head-cell {
		font-size: 0.65625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.ui-table-cell--end {
		text-align: end;
	}

	.ui-table-row {
		display: grid;
		gap: 1rem;
		align-items: center;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		color: inherit;
		font: inherit;
		text-align: start;
		text-decoration: none;
		background: none;
		border: none;
		min-width: 0;
		transition: background-color 120ms ease;
	}

	a.ui-table-row,
	button.ui-table-row {
		cursor: pointer;
	}

	a.ui-table-row:hover,
	button.ui-table-row:hover {
		background-color: var(--bg-hover);
	}
</style>
