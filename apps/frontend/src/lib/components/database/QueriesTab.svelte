<script lang="ts">
	import { RefreshCw, RotateCcw, ArrowDown, ArrowUp, Timer } from 'lucide-svelte';
	import { SectionCard, Button, Input, EmptyState, Skeleton } from '$lib/components/ui';
	import type { DatabaseDetail } from './types';

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

	type SortField = 'total_ms' | 'calls' | 'mean_ms' | 'max_ms' | 'rows' | 'cache';

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
		onEnable
	}: {
		database: DatabaseDetail;
		stats: { installed: boolean; queries: QueryStat[] } | null;
		loading: boolean;
		refreshing: boolean;
		resetting: boolean;
		enabling: boolean;
		querySearch: string;
		onRefresh: () => void;
		onReset: () => void;
		onEnable: () => void;
	} = $props();

	let sortField = $state<SortField>('total_ms');
	let sortAsc = $state(false);
	let expandedId = $state<string | null>(null);

	function cacheHit(q: QueryStat): number | null {
		const total = q.blks_hit + q.blks_read;
		if (total <= 0) return null;
		return (q.blks_hit / total) * 100;
	}

	function sortValue(q: QueryStat): number {
		if (sortField === 'cache') return cacheHit(q) ?? -1;
		return Number(q[sortField]) || 0;
	}

	const visible = $derived.by(() => {
		const list = stats?.queries ?? [];
		const q = querySearch.trim().toLowerCase();
		const filtered = q ? list.filter((s) => s.query.toLowerCase().includes(q)) : list;
		return [...filtered].sort((a, b) =>
			sortAsc ? sortValue(a) - sortValue(b) : sortValue(b) - sortValue(a)
		);
	});

	function toggleSort(field: SortField) {
		if (sortField === field) sortAsc = !sortAsc;
		else {
			sortField = field;
			sortAsc = false;
		}
	}

	function fmtMs(ms: number): string {
		const n = Number(ms) || 0;
		if (n >= 60_000) return `${(n / 60_000).toFixed(1)} min`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(2)} s`;
		if (n >= 1) return `${n.toFixed(1)} ms`;
		return `${n.toFixed(2)} ms`;
	}

	function fmtCount(n: number): string {
		const v = Number(n) || 0;
		if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
		if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
		return String(v);
	}

	const HEADERS: { id: SortField; label: string }[] = [
		{ id: 'calls', label: 'Calls' },
		{ id: 'total_ms', label: 'Total' },
		{ id: 'mean_ms', label: 'Avg' },
		{ id: 'max_ms', label: 'Max' },
		{ id: 'rows', label: 'Rows' },
		{ id: 'cache', label: 'Cache' }
	];

	const maxTotal = $derived(
		(stats?.queries ?? []).reduce((m, q) => Math.max(m, Number(q.total_ms) || 0), 0)
	);
</script>

<SectionCard title="Query statistics">
	{#snippet actions()}
		{#if stats?.installed}
			<Input
				type="search"
				placeholder="Filter queries"
				class="text-sm"
				style="max-width: 16rem;"
				bind:value={querySearch}
			/>
			<Button
				variant="ghost"
				size="sm"
				onclick={onReset}
				loading={resetting}
				aria-label="Reset statistics"
				title="Reset statistics"
			>
				{#if !resetting}<RotateCcw class="h-3.5 w-3.5" />{/if}
				Reset
			</Button>
			<Button
				variant="secondary"
				size="sm"
				onclick={onRefresh}
				loading={refreshing}
				aria-label="Refresh"
			>
				{#if !refreshing}<RefreshCw class="h-3.5 w-3.5" />{/if}
			</Button>
		{/if}
	{/snippet}

	{#if database.mode !== 'cnpg'}
		<EmptyState
			title="Query statistics require a dedicated database"
			description="Recreate this database as a CNPG cluster to track per-query performance."
		/>
	{:else if loading && !stats}
		<div class="qs-skeletons">
			<Skeleton height="2rem" />
			<Skeleton height="2rem" />
			<Skeleton height="2rem" />
		</div>
	{:else if stats && !stats.installed}
		<EmptyState
			title="Enable query statistics"
			description="Postgres tracks per-query timing with the pg_stat_statements extension. Enabling it restarts the database once."
		>
			{#snippet icon()}<Timer class="h-5 w-5" />{/snippet}
			<Button variant="primary" size="sm" onclick={onEnable} loading={enabling}>
				Enable pg_stat_statements
			</Button>
		</EmptyState>
	{:else if visible.length === 0}
		<EmptyState
			title={querySearch ? 'No queries match your filter' : 'No query activity yet'}
			description={querySearch
				? 'Try a different search.'
				: 'Statistics appear as soon as your app starts querying this database.'}
		/>
	{:else}
		<div class="qs-table" role="table">
			<div class="qs-head" role="row">
				<span class="qs-head-cell qs-head-cell--query">Query</span>
				{#each HEADERS as h (h.id)}
					<button
						type="button"
						class="qs-head-cell qs-head-cell--sort"
						onclick={() => toggleSort(h.id)}
					>
						{h.label}
						{#if sortField === h.id}
							{#if sortAsc}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
						{/if}
					</button>
				{/each}
			</div>
			{#each visible as q (q.id)}
				{@const hit = cacheHit(q)}
				<div class="qs-rowwrap">
					<button
						type="button"
						class="qs-row"
						class:qs-row--open={expandedId === q.id}
						onclick={() => (expandedId = expandedId === q.id ? null : q.id)}
					>
						<span class="qs-cell qs-cell--query">
							<span class="qs-query-text">{q.query}</span>
							<span
								class="qs-heat"
								style={`width: ${maxTotal > 0 ? Math.max(2, (Number(q.total_ms) / maxTotal) * 100) : 0}%`}
							></span>
						</span>
						<span class="qs-cell">{fmtCount(q.calls)}</span>
						<span class="qs-cell qs-cell--strong">{fmtMs(q.total_ms)}</span>
						<span class="qs-cell">{fmtMs(q.mean_ms)}</span>
						<span class="qs-cell">{fmtMs(q.max_ms)}</span>
						<span class="qs-cell">{fmtCount(q.rows)}</span>
						<span class="qs-cell" class:qs-cell--warn={hit !== null && hit < 90}>
							{hit === null ? '--' : `${hit.toFixed(hit >= 99.95 ? 1 : 1)}%`}
						</span>
					</button>
					{#if expandedId === q.id}
						<pre class="qs-full">{q.query}</pre>
					{/if}
				</div>
			{/each}
		</div>
		<p class="qs-foot">
			Top {visible.length} normalized queries by total execution time since the last reset. Literals are
			replaced with placeholders before anything is recorded.
		</p>
	{/if}
</SectionCard>

<style>
	.qs-skeletons {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.qs-table {
		display: flex;
		flex-direction: column;
		margin: 0 -0.5rem;
	}
	.qs-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 4.5rem 5.5rem 5rem 5rem 4.5rem 4.5rem;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem 0.375rem;
		border-bottom: 1px solid var(--border-default);
	}
	.qs-head-cell {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.125rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		background: none;
		border: none;
		padding: 0;
		white-space: nowrap;
	}
	.qs-head-cell--query {
		justify-content: flex-start;
	}
	.qs-head-cell--sort {
		cursor: pointer;
	}
	.qs-head-cell--sort:hover {
		color: var(--text-default);
	}
	.qs-rowwrap {
		border-bottom: 1px solid color-mix(in srgb, var(--border-default) 55%, transparent);
	}
	.qs-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 4.5rem 5.5rem 5rem 5rem 4.5rem 4.5rem;
		gap: 0.5rem;
		align-items: center;
		width: 100%;
		padding: 0.4375rem 0.5rem;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		transition: background-color 120ms;
	}
	.qs-row:hover {
		background-color: color-mix(in srgb, var(--text-default) 4%, transparent);
	}
	.qs-row--open {
		background-color: color-mix(in srgb, var(--text-default) 4%, transparent);
	}
	.qs-cell {
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		text-align: right;
		white-space: nowrap;
	}
	.qs-cell--strong {
		color: var(--text-default);
		font-weight: 600;
	}
	.qs-cell--warn {
		color: var(--status-warning);
	}
	.qs-cell--query {
		position: relative;
		text-align: left;
		min-width: 0;
		padding-bottom: 0.25rem;
	}
	.qs-query-text {
		display: block;
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.qs-heat {
		position: absolute;
		bottom: 0;
		left: 0;
		height: 2px;
		border-radius: 999px;
		background-color: color-mix(in srgb, var(--accent) 55%, transparent);
	}
	.qs-full {
		margin: 0 0 0.5rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.5rem;
		background-color: var(--bg-sunken);
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		color: var(--text-default);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.qs-foot {
		font-size: 0.6875rem;
		color: var(--text-faint);
		margin: 0.75rem 0 0;
	}
</style>
