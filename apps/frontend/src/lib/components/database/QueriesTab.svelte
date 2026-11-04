<script lang="ts" module>
	export interface QueryStat {
		id: string;
		query: string;
		calls: number;
		total_ms: number;
		mean_ms: number;
		max_ms: number;
		rows: number;
		blks_hit: number;
		blks_read: number;
	}

	export interface QueryStatsPayload {
		installed: boolean;
		reason?: 'extension_missing' | string;
		queries: QueryStat[];
	}
</script>

<script lang="ts">
	import { Timer } from 'lucide-svelte';
	import {
		Button,
		EmptyState,
		Modal,
		SectionTitle,
		SegmentedControl,
		Skeleton,
		Table
	} from '$lib/components/ui';
	import CodeBlock from '$lib/components/ui/CodeBlock.svelte';
	import type { TableColumn, TableSort } from '$lib/components/ui/Table.svelte';
	import ObserveQueryControls from './ObserveQueryControls.svelte';
	import type { DatabaseDetail } from './types';

	let {
		database,
		stats,
		loading,
		refreshing,
		resetting,
		enabling,
		querySearch = $bindable(''),
		onRefresh,
		onReset,
		onEnable,
		header = true
	}: {
		database: DatabaseDetail;
		stats: QueryStatsPayload | null;
		loading: boolean;
		refreshing: boolean;
		resetting: boolean;
		enabling: boolean;
		querySearch: string;
		onRefresh: () => void;
		onReset: () => void;
		onEnable: () => void;
		header?: boolean;
	} = $props();

	let sort = $state<TableSort | null>({ id: 'total_ms', dir: 'desc' });
	let picked = $state<QueryStat | null>(null);
	let reading = $state(false);

	const compact = new Intl.NumberFormat(undefined, {
		notation: 'compact',
		maximumFractionDigits: 1
	});

	function cacheHit(q: QueryStat): number | null {
		const total = Number(q.blks_hit) + Number(q.blks_read);
		return total > 0 ? (Number(q.blks_hit) / total) * 100 : null;
	}

	function ms(v: number): string {
		const n = Number(v) || 0;
		if (n >= 60_000) return `${(n / 60_000).toFixed(1)} min`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(2)} s`;
		if (n >= 10) return `${Math.round(n)} ms`;
		if (n >= 1) return `${n.toFixed(1)} ms`;
		return `${n.toFixed(2)} ms`;
	}

	function percent(v: number | null): string {
		if (v == null) return '–';
		if (v >= 99.95) return '100%';
		return `${v.toFixed(1)}%`;
	}

	const queries = $derived(stats?.queries ?? []);
	const grandTotal = $derived(queries.reduce((a, q) => a + (Number(q.total_ms) || 0), 0));

	const visible = $derived.by(() => {
		const term = querySearch.trim().toLowerCase();
		return term ? queries.filter((q) => q.query.toLowerCase().includes(term)) : queries;
	});

	const columns: TableColumn<QueryStat>[] = [
		{ id: 'query', label: 'Query', width: 'minmax(12rem, 1fr)' },
		{ id: 'calls', label: 'Calls', numeric: true, sortable: true },
		{ id: 'total_ms', label: 'Total', numeric: true, sortable: true },
		{ id: 'mean_ms', label: 'Mean', numeric: true, sortable: true },
		{ id: 'max_ms', label: 'Max', numeric: true, sortable: true },
		{ id: 'rows', label: 'Rows', numeric: true, sortable: true },
		{ id: 'cache', label: 'Cache hit', numeric: true, sortable: true, sortValue: cacheHit }
	];

	const LENSES = [
		{ value: 'total_ms', label: 'Most time' },
		{ value: 'calls', label: 'Most frequent' },
		{ value: 'mean_ms', label: 'Slowest' }
	];

	const lens = $derived(
		sort?.dir === 'desc' && LENSES.some((l) => l.value === sort?.id) ? sort.id : ''
	);
	const tableLabel = $derived.by(() => {
		const l = LENSES.find((x) => x.value === lens);
		return l ? `Queries ranked by ${l.label.toLowerCase()}` : 'Queries';
	});

	function open(q: QueryStat) {
		picked = q;
		reading = true;
	}
</script>

{#snippet cell(q: QueryStat, col: TableColumn<QueryStat>)}
	{#if col.id === 'query'}
		<span class="sql" title={q.query}>{q.query}</span>
	{:else if col.id === 'calls'}
		{compact.format(Number(q.calls) || 0)}
	{:else if col.id === 'total_ms'}
		<span class="total">
			{ms(q.total_ms)}
			{#if grandTotal > 0}
				<span class="share">{Math.round((Number(q.total_ms) / grandTotal) * 100)}%</span>
			{/if}
		</span>
	{:else if col.id === 'mean_ms'}
		{ms(q.mean_ms)}
	{:else if col.id === 'max_ms'}
		{ms(q.max_ms)}
	{:else if col.id === 'rows'}
		{compact.format(Number(q.rows) || 0)}
	{:else}
		{@const hit = cacheHit(q)}
		<span class:faint={hit == null}>{percent(hit)}</span>
	{/if}
{/snippet}

{#snippet noMatches()}
	<EmptyState
		title={querySearch ? 'No queries match' : 'No queries recorded yet'}
		description={querySearch
			? undefined
			: 'Queries show up here once something connects and runs them.'}
	>
		{#if querySearch}
			<Button variant="secondary" size="sm" onclick={() => (querySearch = '')}>Clear filter</Button>
		{/if}
	</EmptyState>
{/snippet}

{#snippet controls()}
	<ObserveQueryControls bind:querySearch {refreshing} {resetting} {onRefresh} {onReset} />
{/snippet}

<div class="queries">
	{#if database.mode !== 'cnpg'}
		<EmptyState
			title="Query statistics need a dedicated database"
			description="Create a dedicated database to see how long each query takes."
		>
			{#snippet icon()}<Timer size={18} />{/snippet}
		</EmptyState>
	{:else if loading && !stats}
		<div class="loading" aria-busy="true">
			{#each [0, 1, 2, 3, 4] as i (i)}
				<Skeleton height="2.75rem" />
			{/each}
		</div>
	{:else if !stats || !stats.installed}
		<EmptyState
			title="Query statistics are off"
			description="Enabling pg_stat_statements records how long every query takes and restarts the database once."
		>
			{#snippet icon()}<Timer size={18} />{/snippet}
			<Button variant="primary" size="sm" loading={enabling} onclick={onEnable}>Enable</Button>
		</EmptyState>
	{:else}
		{#if header}
			<SectionTitle title="Query performance" size="md" count={visible.length} actions={controls} />
		{/if}
		<div class="lenses">
			<SegmentedControl
				label="Rank queries by"
				size="sm"
				shape="capsule"
				options={LENSES}
				bind:value={() => lens, (v) => (sort = { id: v, dir: 'desc' })}
			/>
		</div>
		<Table
			label={tableLabel}
			{columns}
			rows={visible}
			{cell}
			bind:sort
			rowKey={(q) => q.id}
			rowLabel={(q) => `Show the full query: ${q.query.slice(0, 80)}`}
			onRowClick={open}
			empty={noMatches}
		/>
	{/if}
</div>

<Modal bind:open={reading} title="Query" size="lg">
	{#if picked}
		<CodeBlock code={picked.query} language="sql" wrap maxHeight="24rem" />
	{/if}
</Modal>

<style>
	.queries {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
	}
	.lenses {
		display: flex;
	}
	.loading {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.sql {
		display: block;
		min-width: 0;
		overflow-x: clip;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.total {
		display: inline-flex;
		align-items: baseline;
		gap: 0.375rem;
	}
	.share {
		min-width: 2.25rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		text-align: end;
	}
	.faint {
		color: var(--text-faint);
	}
</style>
