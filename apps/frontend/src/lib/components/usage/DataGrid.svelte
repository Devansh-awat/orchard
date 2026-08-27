<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { ArrowUpDown, ArrowUp, ArrowDown, Search, X } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { EmptyState } from '$lib/components/ui';
	import type { GridColumn } from './types';

	let {
		columns,
		rows,
		row,
		rowKey,
		search,
		searchPlaceholder = 'Filter',
		initialSort,
		emptyTitle = 'Nothing to show',
		emptyDescription = undefined,
		expanded = undefined,
		detail = undefined
	}: {
		columns: GridColumn<T>[];
		rows: T[];
		row: Snippet<[T, number]>;
		rowKey: (item: T) => string;
		search?: (item: T) => string;
		searchPlaceholder?: string;
		initialSort?: { id: string; dir: 'asc' | 'desc' };
		emptyTitle?: string;
		emptyDescription?: string;
		expanded?: (item: T) => boolean;
		detail?: Snippet<[T]>;
	} = $props();

	let query = $state('');
	let sortId = $state(initialSort?.id ?? '');
	let sortDir = $state<'asc' | 'desc'>(initialSort?.dir ?? 'desc');

	const template = $derived(columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' '));

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q || !search) return rows;
		return rows.filter((r) => search(r).toLowerCase().includes(q));
	});

	const sorted = $derived.by(() => {
		const col = columns.find((c) => c.id === sortId);
		if (!col?.sort) return filtered;
		const dir = sortDir === 'asc' ? 1 : -1;
		return [...filtered].sort((a, b) => {
			const av = col.sort!(a);
			const bv = col.sort!(b);
			if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
			return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
		});
	});

	function toggleSort(col: GridColumn<T>) {
		if (!col.sort) return;
		if (sortId === col.id) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
			return;
		}
		sortId = col.id;
		// Numbers are far more useful largest-first, names A to Z.
		sortDir = typeof col.sort(rows[0] ?? ({} as T)) === 'number' ? 'desc' : 'asc';
	}
</script>

<div class="dg">
	{#if search}
		<div class="dg-toolbar">
			<div class="dg-search">
				<Search class="dg-search-icon h-3.5 w-3.5" />
				<input
					class="dg-search-input"
					type="text"
					placeholder={searchPlaceholder}
					bind:value={query}
					aria-label={searchPlaceholder}
				/>
				{#if query}
					<button
						type="button"
						class="dg-search-clear"
						onclick={() => (query = '')}
						aria-label="Clear filter"
					>
						<X class="h-3 w-3" />
					</button>
				{/if}
			</div>
			{#if query}
				<span class="dg-count">{sorted.length} of {rows.length}</span>
			{/if}
		</div>
	{/if}

	{#if sorted.length === 0}
		<EmptyState
			title={query ? `Nothing matches "${query}"` : emptyTitle}
			description={query ? 'Try a shorter search.' : emptyDescription}
		/>
	{:else}
		<div class="dg-head" style="grid-template-columns: {template}">
			{#each columns as col (col.id)}
				{#if col.sort}
					<button
						type="button"
						class="dg-head-cell dg-head-cell--sortable"
						class:dg-cell--end={col.align === 'end'}
						class:dg-head-cell--active={sortId === col.id}
						onclick={() => toggleSort(col)}
						aria-label="Sort by {col.label}"
					>
						{col.label}
						{#if sortId !== col.id}
							<ArrowUpDown class="dg-sort-icon h-3 w-3" />
						{:else if sortDir === 'asc'}
							<ArrowUp class="dg-sort-icon h-3 w-3" />
						{:else}
							<ArrowDown class="dg-sort-icon h-3 w-3" />
						{/if}
					</button>
				{:else}
					<span class="dg-head-cell" class:dg-cell--end={col.align === 'end'}>{col.label}</span>
				{/if}
			{/each}
		</div>

		<div class="dg-body">
			{#each sorted as item, i (rowKey(item))}
				{@const isOpen = expanded?.(item) ?? false}
				<div class="dg-group" class:dg-group--open={isOpen}>
					<div
						class="dg-row"
						style="grid-template-columns: {template}"
						{@attach motionStagger({ index: i, from: { y: 4, opacity: 0 } })}
					>
						{@render row(item, i)}
					</div>
					{#if isOpen && detail}
						<div class="dg-detail">{@render detail(item)}</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.dg {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.dg-toolbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.dg-search {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
		max-width: 20rem;
		min-width: 0;
	}
	.dg-search :global(.dg-search-icon) {
		position: absolute;
		left: 0.5rem;
		color: var(--text-faint);
		pointer-events: none;
	}
	.dg-search-input {
		width: 100%;
		padding: 0.375rem 1.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
	}
	.dg-search-input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.dg-search-clear {
		position: absolute;
		right: 0.375rem;
		display: inline-flex;
		align-items: center;
		padding: 0.125rem;
		border: none;
		background: none;
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		cursor: pointer;
	}
	.dg-search-clear:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}
	.dg-count {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.dg-head {
		display: grid;
		gap: 0.75rem;
		padding: 0 0.625rem 0.375rem;
		border-bottom: 1px solid var(--border-default);
	}
	.dg-head-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--text-faint);
		text-align: left;
		background: none;
		border: none;
		padding: 0;
	}
	.dg-head-cell--sortable {
		cursor: pointer;
	}
	.dg-head-cell--sortable:hover {
		color: var(--text-muted);
	}
	.dg-head-cell--active {
		color: var(--text-default);
	}
	.dg-head-cell :global(.dg-sort-icon) {
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.dg-head-cell--sortable:hover :global(.dg-sort-icon),
	.dg-head-cell--active :global(.dg-sort-icon) {
		opacity: 1;
	}
	.dg-cell--end {
		justify-content: flex-end;
		text-align: right;
	}
	.dg-body {
		display: flex;
		flex-direction: column;
	}
	.dg-row {
		display: grid;
		gap: 0.75rem;
		align-items: center;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
	}
	.dg-row:hover {
		background-color: var(--bg-hover);
	}
	.dg-group--open {
		background-color: var(--bg-sunken);
		border-radius: var(--radius-md);
	}
	.dg-group--open .dg-row:hover {
		background-color: transparent;
	}
	.dg-detail {
		padding: 0.25rem 0.625rem 0.75rem;
	}
</style>
