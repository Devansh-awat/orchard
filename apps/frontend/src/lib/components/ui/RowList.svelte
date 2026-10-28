<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { Plus, Trash2 } from 'lucide-svelte';
	import { presence } from '$lib/utils/transitions';
	import Button from './Button.svelte';

	let {
		items,
		key,
		columns,
		row,
		label,
		addLabel = 'Add',
		onadd = undefined,
		onremove = undefined,
		removeLabel = () => 'Remove',
		minRows = 0
	}: {
		items: T[];
		key: (item: T) => string | number;
		columns: { label: string; width?: `${number}rem` | `${number}fr` | `minmax(${string})` }[];
		row: Snippet<[T, number]>;
		label: string;
		addLabel?: string;
		onadd?: () => void;
		onremove?: (index: number) => void;
		removeLabel?: (item: T, index: number) => string;
		minRows?: number;
	} = $props();

	const template = $derived(
		[...columns.map((c) => c.width ?? 'minmax(0, 1fr)'), ...(onremove ? ['1.75rem'] : [])].join(' ')
	);
</script>

<div class="rowlist">
	<div class="list" role="table" aria-label={label} style:--cols={template}>
		<div class="row head" role="row">
			{#each columns as column (column.label)}
				<span class="heading" role="columnheader">{column.label}</span>
			{/each}
			{#if onremove}<span role="columnheader" aria-label="Remove"></span>{/if}
		</div>
		{#each items as item, i (key(item))}
			<div class="row" role="row" in:presence out:presence>
				{@render row(item, i)}
				{#if onremove}
					{#if items.length > minRows}
						<Button
							variant="ghost"
							size="sm"
							icon={Trash2}
							label={removeLabel(item, i)}
							onclick={() => onremove(i)}
						/>
					{:else}
						<span></span>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
	{#if onadd}
		<div class="add">
			<Button variant="ghost" size="sm" icon={Plus} onclick={onadd}>{addLabel}</Button>
		</div>
	{/if}
</div>

<style>
	.rowlist {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}
	.row {
		display: grid;
		grid-template-columns: var(--cols);
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}
	.head {
		margin-bottom: calc(var(--space-1) * -1);
	}
	.heading {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: var(--weight-medium);
		color: var(--text-muted);
	}
	.add {
		margin: var(--space-2) 0 0 calc(var(--space-2) * -1);
	}
</style>
