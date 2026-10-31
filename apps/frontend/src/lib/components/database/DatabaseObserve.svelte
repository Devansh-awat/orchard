<script lang="ts">
	import { untrack } from 'svelte';
	import { Activity, TriangleAlert } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import {
		Alert,
		Button,
		Disclosure,
		EmptyState,
		Skeleton,
		Swap,
		UnderlineTabs
	} from '$lib/components/ui';
	import MetricPanel from '$lib/components/patterns/MetricPanel.svelte';
	import { provideChartAxis } from '$lib/components/ui/chart-axis.svelte';
	import type {
		ChartDisplay,
		ChartPoint,
		ChartSeries,
		ChartThreshold
	} from '$lib/components/ui/time-chart';
	import { MetricsState } from '$lib/components/deployment/observe/metrics.svelte';
	import ObserveRange from './ObserveRange.svelte';
	import ObserveQueryControls from './ObserveQueryControls.svelte';
	import QueriesTab, { type QueryStatsPayload } from './QueriesTab.svelte';
	import type { DatabaseDetail } from './types';

	type View = 'metrics' | 'queries';

	let {
		database,
		active = true,
		view = $bindable<View>('metrics'),
		defaultCpuMilli = null,
		defaultMemoryBytes = null,
		maxConnections = null,
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
		active?: boolean;
		view?: View;
		defaultCpuMilli?: number | null;
		defaultMemoryBytes?: number | null;
		maxConnections?: number | null;
		stats: QueryStatsPayload | null;
		loading: boolean;
		refreshing: boolean;
		resetting: boolean;
		enabling: boolean;
		querySearch: string;
		onRefresh: () => void;
		onReset: () => void;
		onEnable: () => void;
	} = $props();

	const MIB = 1024 * 1024;
	const SERIES = [
		'cpu',
		'mem',
		'rx',
		'tx',
		'connections',
		'tps',
		'cacheHit',
		'lag',
		'size',
		'deadlocks',
		'disk',
		'diskCapacity'
	] as const;
	type SeriesId = (typeof SERIES)[number];
	type Section = 'activity' | 'storage' | 'resources' | 'health';
	type Panel = {
		id: string;
		title: string;
		info: string;
		series: ChartSeries[];
		format: (v: number) => string;
		headline?: { value: string; tone?: 'neutral' | 'warning' | 'error' };
		thresholds?: ChartThreshold[];
		empty: string;
		modes: ChartDisplay[];
		sum?: boolean;
	};

	const EMPTY = () =>
		Object.fromEntries(SERIES.map((k) => [k, [] as ChartPoint[]])) as Record<
			SeriesId,
			ChartPoint[]
		>;

	provideChartAxis();

	const metrics = new MetricsState();
	let data = $state(EMPTY());
	let loaded = $state(false);
	let error = $state<string | null>(null);
	let modes = $state<Record<string, ChartDisplay>>({});
	let open = $state<Record<Section, boolean>>({
		activity: true,
		storage: true,
		resources: true,
		health: true
	});
	let seq = 0;

	const shared = $derived(database.mode === 'shared');
	const hasQueries = $derived(database.mode === 'cnpg');
	const VIEWS = $derived<{ id: View; label: string }[]>([
		{ id: 'metrics', label: 'Metrics' },
		...(hasQueries ? [{ id: 'queries' as const, label: 'Queries' }] : [])
	]);
	const current = $derived<View>(VIEWS.some((v) => v.id === view) ? view : 'metrics');

	const instances = $derived(Math.max(1, database.replicas ?? database.pods?.length ?? 1));
	const cpuEach = $derived(database.cpuRequestMilli ?? defaultCpuMilli ?? null);
	const memEach = $derived.by(() => {
		const bytes = database.memoryRequestBytes ?? defaultMemoryBytes ?? null;
		return bytes ? Number(bytes) / MIB : null;
	});
	const cpuLimit = $derived(cpuEach ? cpuEach * instances : null);
	const memLimit = $derived(memEach ? memEach * instances : null);

	const cpu = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} cores` : `${Math.round(v)}m`);
	const mib = (v: number) => (v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${Math.round(v)} MB`);
	const net = (v: number) =>
		v >= 1024
			? `${(v / 1024).toFixed(2)} MB/s`
			: `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)} KB/s`;
	const count = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
	const perSecond = (v: number) =>
		v >= 1000
			? `${(v / 1000).toFixed(1)}k/s`
			: `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}/s`;
	const percent = (v: number) => `${v >= 99.95 ? 100 : Number.isInteger(v) ? v : v.toFixed(1)}%`;
	const seconds = (v: number) =>
		v < 1
			? `${Math.round(v * 1000)} ms`
			: v < 60
				? `${v.toFixed(1)} s`
				: `${Math.floor(v / 60)}m ${Math.round(v % 60)}s`;

	function latest(points: ChartPoint[]) {
		return points.length ? points[points.length - 1].y : null;
	}

	function tone(ratio: number, warn: number, stop: number) {
		return ratio >= stop
			? ('error' as const)
			: ratio >= warn
				? ('warning' as const)
				: ('neutral' as const);
	}

	function zones(limit: number | null, format: (v: number) => string): ChartThreshold[] {
		if (!limit) return [];
		return [
			{ value: limit * 0.8, tone: 'warning', label: `80% of the ${format(limit)} limit` },
			{ value: limit, tone: 'error', label: `${format(limit)} limit` }
		];
	}

	function usage(points: ChartPoint[], limit: number | null, format: (v: number) => string) {
		const v = latest(points);
		if (v == null) return undefined;
		if (!limit) return { value: format(v) };
		const ratio = v / limit;
		return {
			value: `${format(v)} · ${Math.round(ratio * 100)}% of limit`,
			tone: tone(ratio, 0.8, 1)
		};
	}

	function now(points: ChartPoint[], format: (v: number) => string) {
		const v = latest(points);
		return v == null ? undefined : { value: format(v) };
	}

	function line(id: string, label: string, points: ChartPoint[]): ChartSeries[] {
		return [{ id, label, points, tone: 'neutral' }];
	}

	const together = $derived(instances > 1 ? `all ${instances} instances together` : 'the database');
	const diskCap = $derived(latest(data.diskCapacity));

	const activity = $derived.by<Panel[]>(() => {
		const out: Panel[] = [];
		if (data.connections.length) {
			const v = latest(data.connections);
			out.push({
				id: 'connections',
				title: 'Connections',
				info: maxConnections
					? 'Open connections against max_connections. At the limit new connections are refused.'
					: 'Open connections to the database.',
				series: line('connections', 'Open', data.connections),
				format: count,
				headline:
					v != null && maxConnections
						? {
								value: `${count(v)} of ${maxConnections}`,
								tone: tone(v / maxConnections, 0.8, 1)
							}
						: now(data.connections, count),
				thresholds: maxConnections
					? [
							{ value: maxConnections * 0.8, tone: 'warning', label: '80% of max_connections' },
							{ value: maxConnections, tone: 'error', label: `max_connections (${maxConnections})` }
						]
					: [],
				empty: 'No connection samples in this range',
				modes: ['lines', 'areas']
			});
		}
		if (data.tps.length) {
			out.push({
				id: 'tps',
				title: 'Transactions',
				info: 'Commits and rollbacks per second.',
				series: line('tps', 'Per second', data.tps),
				format: perSecond,
				headline: now(data.tps, perSecond),
				empty: 'No transactions in this range',
				modes: ['areas', 'lines']
			});
		}
		if (data.cacheHit.length) {
			out.push({
				id: 'cacheHit',
				title: 'Cache hit',
				info: 'Share of reads served from memory instead of disk.',
				series: line('cacheHit', 'Hit ratio', data.cacheHit),
				format: percent,
				headline: now(data.cacheHit, percent),
				empty: 'No cache samples in this range',
				modes: ['lines', 'areas']
			});
		}
		return out;
	});

	const storage = $derived.by<Panel[]>(() => {
		const out: Panel[] = [];
		if (instances > 1 && data.lag.length) {
			out.push({
				id: 'lag',
				title: 'Replication lag',
				info: 'How far the furthest standby is behind the primary.',
				series: line('lag', 'Lag', data.lag),
				format: seconds,
				headline: now(data.lag, seconds),
				empty: 'No replication samples in this range',
				modes: ['lines', 'areas']
			});
		}
		if (data.size.length) {
			out.push({
				id: 'size',
				title: 'Database size',
				info: 'Tables and indexes in this database.',
				series: line('size', 'Size', data.size),
				format: mib,
				headline: now(data.size, mib),
				empty: 'No size samples in this range',
				modes: ['lines', 'areas']
			});
		}
		if (data.disk.length) {
			const v = latest(data.disk);
			out.push({
				id: 'disk',
				title: 'Disk used',
				info: diskCap
					? 'Space used on the data volume, including WAL. At 92% the database turns read-only.'
					: 'Space used on the data volume, including WAL.',
				series: line('disk', 'Used', data.disk),
				format: mib,
				headline:
					v != null && diskCap
						? {
								value: `${mib(v)} of ${mib(diskCap)} · ${Math.round((v / diskCap) * 100)}%`,
								tone: tone(v / diskCap, 0.8, 0.92)
							}
						: now(data.disk, mib),
				thresholds: diskCap
					? [
							{ value: diskCap * 0.8, tone: 'warning', label: '80% full' },
							{ value: diskCap * 0.92, tone: 'error', label: 'Read-only at 92%' }
						]
					: [],
				empty: 'No disk samples in this range',
				modes: ['lines', 'areas']
			});
		}
		return out;
	});

	const resources = $derived<Panel[]>([
		{
			id: 'cpu',
			title: 'CPU',
			info: cpuLimit
				? `CPU used by ${together}, against the limit. At the limit Postgres is throttled.`
				: `CPU used by ${together}.`,
			series: line('cpu', 'Used', data.cpu),
			format: cpu,
			headline: usage(data.cpu, cpuLimit, cpu),
			thresholds: zones(cpuLimit, cpu),
			empty: 'No CPU samples in this range',
			modes: ['lines', 'areas']
		},
		{
			id: 'mem',
			title: 'Memory',
			info: memLimit
				? `Memory in use by ${together}, against the limit. At the limit Postgres runs out of memory and restarts.`
				: `Memory in use by ${together}.`,
			series: line('mem', 'Used', data.mem),
			format: mib,
			headline: usage(data.mem, memLimit, mib),
			thresholds: zones(memLimit, mib),
			empty: 'No memory samples in this range',
			modes: ['lines', 'areas']
		},
		{
			id: 'rx',
			title: 'Network in',
			info:
				instances > 1
					? 'Bytes per second received, including replication between instances.'
					: 'Bytes per second received.',
			series: line('rx', 'Received', data.rx),
			format: net,
			headline: now(data.rx, net),
			empty: 'No network samples in this range',
			modes: ['areas', 'lines']
		},
		{
			id: 'tx',
			title: 'Network out',
			info:
				instances > 1
					? 'Bytes per second sent, including replication between instances.'
					: 'Bytes per second sent.',
			series: line('tx', 'Sent', data.tx),
			format: net,
			headline: now(data.tx, net),
			empty: 'No network samples in this range',
			modes: ['areas', 'lines']
		}
	]);

	const health = $derived<Panel[]>(
		data.deadlocks.some((p) => p.y > 0)
			? [
					{
						id: 'deadlocks',
						title: 'Deadlocks',
						info: 'Transactions Postgres cancelled because they were waiting on each other.',
						series: line('deadlocks', 'Deadlocks', data.deadlocks),
						format: count,
						headline: {
							value: `${count(data.deadlocks.reduce((a, p) => a + p.y, 0))} in this range`,
							tone: 'error'
						},
						empty: 'No deadlocks in this range',
						modes: ['bars'],
						sum: true
					}
				]
			: []
	);

	const sections = $derived(
		(
			[
				{ id: 'activity', title: 'Activity', panels: activity },
				{ id: 'storage', title: 'Replication & storage', panels: storage },
				{ id: 'resources', title: 'Resources', panels: resources },
				{ id: 'health', title: 'Health', panels: health }
			] as { id: Section; title: string; panels: Panel[] }[]
		).filter((s) => s.panels.length)
	);

	async function load() {
		const id = database.id;
		if (!id || shared) return;
		const mine = ++seq;
		const { from, to, step } = metrics;
		try {
			const res = await apiFetch(
				`/apiv1/databases/${encodeURIComponent(id)}/metrics?start=${from}&end=${to}&step=${step}`
			);
			if (mine !== seq) return;
			if (!res.ok) {
				const detail = await res.json().catch(() => null);
				throw new Error(
					res.status === 503
						? 'The metrics store is unreachable'
						: (detail?.message ?? `HTTP ${res.status}`)
				);
			}
			const body = await res.json();
			if (mine !== seq) return;
			data = { ...EMPTY(), ...(body?.data ?? {}) };
			error = null;
			loaded = true;
		} catch (err) {
			if (mine !== seq) return;
			error = (err as Error).message;
		}
	}

	$effect(() => {
		void metrics.from;
		void metrics.to;
		if (!active || current !== 'metrics' || !database.id) return;
		untrack(load);
	});

	$effect(() => {
		if (!metrics.live || !active || current !== 'metrics') return;
		const timer = setInterval(() => {
			if (metrics.hover === null && !document.hidden) metrics.tick();
		}, 15_000);
		return () => clearInterval(timer);
	});
</script>

<div class="db-observe">
	{#if shared}
		<EmptyState
			title="Metrics need a dedicated database"
			description="Shared databases run alongside others, so their CPU and memory aren't measured on their own."
		>
			{#snippet icon()}<Activity size={18} />{/snippet}
		</EmptyState>
	{:else}
		<div class="toolbar" class:toolbar--tabs={VIEWS.length > 1}>
			{#if VIEWS.length > 1}
				<div class="views">
					<UnderlineTabs
						label="Observe"
						tabs={VIEWS}
						bind:value={() => current, (v) => (view = v as View)}
					/>
				</div>
			{/if}
			<div class="controls">
				{#if current === 'metrics'}
					<ObserveRange {metrics} />
				{:else if stats?.installed}
					<ObserveQueryControls bind:querySearch {refreshing} {resetting} {onRefresh} {onReset} />
				{/if}
			</div>
		</div>

		<Swap key={current}>
			{#if current === 'metrics'}
				<div class="board">
					{#if !loaded && error}
						<EmptyState title="Metrics aren't available" description={error}>
							{#snippet icon()}<TriangleAlert size={18} />{/snippet}
							<Button variant="secondary" onclick={load}>Retry</Button>
						</EmptyState>
					{:else if !loaded}
						<div class="panels">
							{#each [0, 1, 2, 3] as i (i)}
								<Skeleton
									height="17rem"
									rounded="calc(var(--radius-widget) * var(--corner-scale))"
								/>
							{/each}
						</div>
					{:else}
						{#if error}
							<Alert tone="warning" title="Metrics aren't updating">
								{error}
								{#snippet actions()}
									<Button size="sm" variant="ghost" onclick={load}>Retry</Button>
								{/snippet}
							</Alert>
						{/if}
						{#each sections as section (section.id)}
							<Disclosure title={section.title} size="lg" bind:open={open[section.id]}>
								<div class="panels" class:panels--three={section.panels.length === 3}>
									{#each section.panels as p (p.id)}
										<MetricPanel
											title={p.title}
											info={p.info}
											series={p.series}
											from={metrics.from}
											to={metrics.to}
											format={p.format}
											bind:hover={metrics.hover}
											bind:mode={
												() => modes[p.id] ?? p.modes[0], (m) => (modes[p.id] = m as ChartDisplay)
											}
											modes={p.modes}
											headline={p.headline}
											thresholds={p.thresholds ?? []}
											sum={p.sum ?? false}
											empty={p.empty}
											onZoom={(a, b) => metrics.zoom(a, b)}
										/>
									{/each}
								</div>
							</Disclosure>
						{/each}
					{/if}
				</div>
			{:else}
				<QueriesTab
					{database}
					{stats}
					{loading}
					{refreshing}
					{resetting}
					{enabling}
					bind:querySearch
					{onRefresh}
					{onReset}
					{onEnable}
					header={false}
				/>
			{/if}
		</Swap>
	{/if}
</div>

<style>
	.db-observe {
		container: db-observe / inline-size;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		min-height: 2rem;
	}
	.toolbar--tabs {
		box-shadow: inset 0 -1px 0 var(--border-default);
	}
	.views {
		min-width: 0;
	}
	.views :global(.ui-tabs-track) {
		padding-block: 0;
		border-bottom: none;
	}
	.views :global(.ui-tab) {
		padding-block: 0.75rem;
		margin-bottom: 0;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
	}
	.board {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		min-width: 0;
	}
	.panels {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	.panels > :global(:last-child:nth-child(odd)) {
		grid-column: 1 / -1;
	}
	@container db-observe (min-width: 64rem) {
		.panels--three {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.panels--three > :global(:last-child:nth-child(odd)) {
			grid-column: auto;
		}
	}
	@container db-observe (max-width: 46rem) {
		.panels {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
