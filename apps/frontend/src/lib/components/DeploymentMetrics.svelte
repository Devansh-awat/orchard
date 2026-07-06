<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { apiFetch } from '$lib/stores';
	import {
		Activity,
		Cpu,
		MemoryStick,
		ArrowDown,
		ArrowUp,
		Maximize2,
		X,
		Pause,
		Play,
		CalendarRange
	} from 'lucide-svelte';

	type Props = { kind: 'deployment' | 'database'; id: string | null; active?: boolean };
	const { kind, id: entityId, active = true }: Props = $props();

	type QuickRange = {
		id: '5m' | '15m' | '30m' | '1h' | '6h' | '24h' | '7d';
		label: string;
		ms: number;
	};
	const QUICK_RANGES: QuickRange[] = [
		{ id: '5m', label: '5m', ms: 5 * 60 * 1000 },
		{ id: '15m', label: '15m', ms: 15 * 60 * 1000 },
		{ id: '30m', label: '30m', ms: 30 * 60 * 1000 },
		{ id: '1h', label: '1h', ms: 60 * 60 * 1000 },
		{ id: '6h', label: '6h', ms: 6 * 60 * 60 * 1000 },
		{ id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
		{ id: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 }
	];

	function chooseStep(ms: number): number {
		// Upstream scrapes every 15s, so 15s is the finest meaningful step
		// for short windows. Coarsen for longer windows to keep point
		// counts manageable.
		if (ms <= 30 * 60 * 1000) return 15_000; // ≤30m: 15s
		if (ms <= 60 * 60 * 1000) return 30_000; // ≤1h: 30s
		if (ms <= 6 * 60 * 60 * 1000) return 60_000; // ≤6h: 1m
		if (ms <= 24 * 60 * 60 * 1000) return 5 * 60_000; // ≤24h: 5m
		return 30 * 60_000; // 7d+: 30m
	}

	let windowMs = $state<number>(60 * 60 * 1000);
	let paused = $state(false);
	let customStart = $state<number | null>(null);
	let customEnd = $state<number | null>(null);
	let now = $state(Date.now());
	let expandedCardId = $state<'cpu' | 'mem' | 'rx' | 'tx' | null>(null);
	let crosshairX = $state<number | null>(null);
	let Line: any = $state(null);
	let chartReady = $state(false);
	let showCustom = $state(false);
	let customStartInput = $state('');
	let customEndInput = $state('');
	let customError = $state<string | null>(null);

	const windowEnd = $derived(customEnd ?? now);
	const windowStart = $derived(customStart ?? windowEnd - windowMs);
	const effectiveWindowMs = $derived(windowEnd - windowStart);
	const step = $derived(chooseStep(effectiveWindowMs));
	const isCustom = $derived(customStart != null && customEnd != null);
	const isLive = $derived(!paused && !isCustom);

	type Series = { x: number; y: number }[];
	type MetricCard = {
		id: 'cpu' | 'mem' | 'rx' | 'tx';
		label: string;
		color: string;
		icon: any;
		formatter: (v: number) => string;
	};

	const CARDS: MetricCard[] = [
		{
			id: 'cpu',
			label: 'CPU usage',
			color: '#7c5cff',
			icon: Cpu,
			formatter: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} cores` : `${v.toFixed(0)}m`)
		},
		{
			id: 'mem',
			label: 'Memory',
			color: '#22c0a8',
			icon: MemoryStick,
			formatter: (v) => (v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${v.toFixed(0)} MB`)
		},
		{
			id: 'rx',
			label: 'Network in',
			color: '#3aa8ff',
			icon: ArrowDown,
			formatter: (v) => (v >= 1024 ? `${(v / 1024).toFixed(2)} MB/s` : `${v.toFixed(0)} KB/s`)
		},
		{
			id: 'tx',
			label: 'Network out',
			color: '#ff7e6b',
			icon: ArrowUp,
			formatter: (v) => (v >= 1024 ? `${(v / 1024).toFixed(2)} MB/s` : `${v.toFixed(0)} KB/s`)
		}
	];

	const expandedCard = $derived(
		expandedCardId ? (CARDS.find((c) => c.id === expandedCardId) ?? null) : null
	);

	let series = $state<Record<MetricCard['id'], Series>>({ cpu: [], mem: [], rx: [], tx: [] });
	let initialLoading = $state(false);
	let fetchError = $state<string | null>(null);
	let fetchSeq = 0;
	let inFlight = false;

	function hasData(): boolean {
		return (
			series.cpu.length > 0 || series.mem.length > 0 || series.rx.length > 0 || series.tx.length > 0
		);
	}

	async function loadSeries(start: number, end: number, stepMs: number, id: string) {
		if (!id || inFlight) return;
		inFlight = true;
		const seq = ++fetchSeq;
		// Show the skeleton only on the first load — silently refresh after.
		if (!hasData()) initialLoading = true;
		try {
			const res = await apiFetch(
				`/apiv1/${kind === 'database' ? 'databases' : 'deployments'}/${encodeURIComponent(id)}/metrics?start=${start}&end=${end}&step=${stepMs}`
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			if (seq !== fetchSeq) return;
			series = body?.data ?? { cpu: [], mem: [], rx: [], tx: [] };
			fetchError = null;
		} catch (err) {
			if (seq !== fetchSeq) return;
			fetchError = (err as Error).message;
		} finally {
			inFlight = false;
			if (seq === fetchSeq) initialLoading = false;
		}
	}

	// Fire whenever window/step/deployment changes. `untrack` prevents the
	// series write inside loadSeries from re-triggering this effect. The
	// `inFlight` guard above coalesces overlapping ticks (live mode) so we
	// don't pile up requests when the network is slow.
	$effect(() => {
		const start = windowStart;
		const end = windowEnd;
		const s = step;
		const id = entityId;
		if (!id || !active) return;
		untrack(() => {
			// A stale crosshair timestamp from a wider range falls outside
			// a narrower one and the plugin silently skips drawing it.
			if (crosshairX != null && (crosshairX < start || crosshairX > end)) {
				crosshairX = null;
			}
			loadSeries(start, end, s, id);
		});
	});

	function summarize(s: Series) {
		if (!s.length) return { current: 0, avg: 0, max: 0, p95: 0 };
		const ys = s.map((p) => p.y);
		const sorted = [...ys].sort((a, b) => a - b);
		return {
			current: ys[ys.length - 1],
			avg: ys.reduce((a, b) => a + b, 0) / ys.length,
			max: sorted[sorted.length - 1],
			p95: sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]
		};
	}

	const summaries = $derived({
		cpu: summarize(series.cpu),
		mem: summarize(series.mem),
		rx: summarize(series.rx),
		tx: summarize(series.tx)
	});

	// Cached diagonal-hatch CanvasPattern, regenerated when the stroke
	// color changes (light/dark theme switches).
	let hatchPattern: CanvasPattern | null = null;
	let hatchStroke: string | null = null;
	function getHatchPattern(ctx: CanvasRenderingContext2D, stroke: string): CanvasPattern | null {
		if (hatchPattern && hatchStroke === stroke) return hatchPattern;
		const tile = document.createElement('canvas');
		tile.width = 8;
		tile.height = 8;
		const tctx = tile.getContext('2d');
		if (!tctx) return null;
		tctx.strokeStyle = stroke;
		tctx.lineWidth = 1;
		tctx.beginPath();
		tctx.moveTo(-1, 9);
		tctx.lineTo(9, -1);
		tctx.moveTo(-1, 17);
		tctx.lineTo(17, -1);
		tctx.moveTo(-9, 1);
		tctx.lineTo(1, -9);
		tctx.stroke();
		hatchPattern = ctx.createPattern(tile, 'repeat');
		hatchStroke = stroke;
		return hatchPattern;
	}

	// Hatch any region of the visible x-axis that falls outside the
	// available data extent — i.e. before VM started collecting, or after
	// the most recent sample. Communicates "no data here" without lying
	// with a flat zero line.
	const pendingPlugin = {
		id: 'pendingRegions',
		beforeDatasetsDraw(chart: any, _args: any, options: any) {
			if (!options) return;
			const xs = chart.scales?.x;
			const area = chart.chartArea;
			if (!xs || !area) return;
			const { top, bottom } = area;
			const xMin = xs.min as number;
			const xMax = xs.max as number;
			const dataMin = options.dataMin as number | null | undefined;
			const dataMax = options.dataMax as number | null | undefined;
			const pattern = getHatchPattern(chart.ctx, options.stroke ?? 'rgba(120,120,128,0.35)');
			if (!pattern) return;
			chart.ctx.save();
			chart.ctx.fillStyle = pattern;
			// No data at all → hatch the whole area.
			if (dataMin == null || dataMax == null) {
				chart.ctx.fillRect(area.left, top, area.right - area.left, bottom - top);
			} else {
				if (dataMin > xMin) {
					const left = xs.getPixelForValue(xMin);
					const right = xs.getPixelForValue(dataMin);
					if (right > left) chart.ctx.fillRect(left, top, right - left, bottom - top);
				}
				if (dataMax < xMax) {
					const left = xs.getPixelForValue(dataMax);
					const right = xs.getPixelForValue(xMax);
					if (right > left) chart.ctx.fillRect(left, top, right - left, bottom - top);
				}
			}
			chart.ctx.restore();
		}
	};

	// Track every Chart instance so a hover on one redraws the crosshair
	// on all of them.
	const chartInstances: Set<any> = new Set();

	const crosshairPlugin = {
		id: 'crosshair',
		afterDraw(chart: any) {
			if (crosshairX == null) return;
			const xs = chart.scales?.x;
			const area = chart.chartArea;
			if (!xs || !area) return;
			if (crosshairX < xs.min || crosshairX > xs.max) return;
			const px = xs.getPixelForValue(crosshairX);
			const ctx = chart.ctx;
			ctx.save();
			ctx.strokeStyle = 'rgba(120, 120, 128, 0.6)';
			ctx.lineWidth = 1;
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.moveTo(px, area.top);
			ctx.lineTo(px, area.bottom);
			ctx.stroke();
			ctx.restore();
		}
	};

	const trackPlugin = {
		id: 'track-instance',
		afterInit(chart: any) {
			chartInstances.add(chart);
		},
		beforeDestroy(chart: any) {
			chartInstances.delete(chart);
		}
	};

	function redrawAll() {
		for (const c of chartInstances) {
			try {
				c.render();
			} catch {
				/* no-op */
			}
		}
	}

	function findChartFor(canvas: HTMLCanvasElement) {
		for (const c of chartInstances) {
			if (c.canvas === canvas) return c;
		}
		return null;
	}

	if (browser) {
		Promise.all([import('chart.js'), import('svelte5-chartjs')])
			.then(([{ Chart, LinearScale, PointElement, LineElement, Filler, Decimation }, mod]) => {
				Chart.register(
					LinearScale,
					PointElement,
					LineElement,
					Filler,
					Decimation,
					crosshairPlugin,
					trackPlugin,
					pendingPlugin
				);
				Line = mod.Line;
				chartReady = true;
			})
			.catch(() => {});
	}

	let tickHandle: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (!isLive || !active) return;
		// 15s matches the upstream scrape interval — no point refetching faster.
		tickHandle = setInterval(() => {
			now = Date.now();
		}, 15_000);
		return () => {
			if (tickHandle) {
				clearInterval(tickHandle);
				tickHandle = null;
			}
		};
	});
	onDestroy(() => {
		if (tickHandle) clearInterval(tickHandle);
	});

	function pendingExtent(s: Series): {
		dataMin: number | null;
		dataMax: number | null;
		stroke: string;
	} {
		const stroke = 'rgba(120,120,128,0.35)';
		if (!s.length) return { dataMin: null, dataMax: null, stroke };
		return { dataMin: s[0].x, dataMax: s[s.length - 1].x, stroke };
	}

	function chartData(card: MetricCard) {
		return {
			datasets: [
				{
					data: series[card.id] as any,
					borderColor: card.color,
					backgroundColor: card.color + '22',
					borderWidth: 1.5,
					pointRadius: 0,
					pointHoverRadius: 0,
					fill: true,
					tension: 0.25,
					spanGaps: true
				}
			]
		};
	}

	function chartOptions(card: MetricCard) {
		return {
			responsive: true,
			maintainAspectRatio: false,
			animation: false as const,
			parsing: false as const,
			normalized: true,
			events: [] as any, // we drive hover ourselves at the wrapper level
			plugins: {
				legend: { display: false },
				tooltip: { enabled: false },
				decimation: { enabled: true, algorithm: 'lttb' as const, samples: 200 },
				pendingRegions: pendingExtent(series[card.id])
			},
			scales: {
				x: {
					type: 'linear' as const,
					min: windowStart,
					max: windowEnd,
					ticks: {
						color: 'rgba(140,140,150,0.85)',
						maxRotation: 0,
						autoSkip: true,
						maxTicksLimit: 6,
						callback: (v: any) => formatTick(v as number)
					},
					grid: { color: 'rgba(120,120,128,0.08)' }
				},
				y: {
					beginAtZero: true,
					ticks: {
						color: 'rgba(140,140,150,0.85)',
						maxTicksLimit: 4,
						callback: (v: any) => card.formatter(v as number)
					},
					grid: { color: 'rgba(120,120,128,0.08)' }
				}
			}
		};
	}

	function formatTick(t: number): string {
		const d = new Date(t);
		const h = String(d.getHours()).padStart(2, '0');
		const m = String(d.getMinutes()).padStart(2, '0');
		if (effectiveWindowMs > 24 * 60 * 60 * 1000)
			return `${d.getMonth() + 1}/${d.getDate()} ${h}:00`;
		if (effectiveWindowMs > 6 * 60 * 60 * 1000)
			return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`;
		return `${h}:${m}`;
	}

	function valueAtCrosshair(s: Series): number | null {
		if (crosshairX == null || !s.length) return null;
		let lo = 0,
			hi = s.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (s[mid].x < crosshairX) lo = mid + 1;
			else hi = mid;
		}
		const a = s[Math.max(0, lo - 1)];
		const b = s[lo];
		return Math.abs(a.x - crosshairX) < Math.abs(b.x - crosshairX) ? a.y : b.y;
	}

	function onChartMove(e: PointerEvent, wrapper: HTMLElement) {
		const canvas = wrapper.querySelector('canvas') as HTMLCanvasElement | null;
		if (!canvas) return;
		const chart = findChartFor(canvas);
		if (!chart) return;
		const rect = canvas.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const v = chart.scales?.x?.getValueForPixel(px);
		if (v == null || !isFinite(v)) return;
		crosshairX = v;
		redrawAll();
	}

	function onChartLeave() {
		if (crosshairX != null) {
			crosshairX = null;
			redrawAll();
		}
	}

	function setQuickRange(ms: number) {
		windowMs = ms;
		customStart = null;
		customEnd = null;
		showCustom = false;
		customError = null;
	}

	function applyCustomRange() {
		const s = customStartInput ? new Date(customStartInput).getTime() : NaN;
		const e = customEndInput ? new Date(customEndInput).getTime() : NaN;
		if (!isFinite(s) || !isFinite(e)) {
			customError = 'Both start and end required';
			return;
		}
		if (s >= e) {
			customError = 'Start must be before end';
			return;
		}
		customStart = s;
		customEnd = e;
		customError = null;
		showCustom = false;
	}

	function clearCustomRange() {
		customStart = null;
		customEnd = null;
		customError = null;
	}

	function togglePause() {
		if (isCustom) {
			clearCustomRange();
			paused = false;
			now = Date.now();
		} else {
			paused = !paused;
			if (!paused) now = Date.now();
		}
	}

	function toLocalInput(ts: number): string {
		const d = new Date(ts);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function toggleCustomPanel() {
		if (showCustom) {
			showCustom = false;
		} else {
			customStartInput = toLocalInput(windowStart);
			customEndInput = toLocalInput(windowEnd);
			showCustom = true;
		}
	}

	function fmtFull(t: number): string {
		return new Date(t).toLocaleString();
	}

	const activeQuickId = $derived.by(() => {
		if (isCustom) return null;
		return QUICK_RANGES.find((r) => r.ms === windowMs)?.id ?? null;
	});
</script>

{#snippet controls()}
	<div class="metrics-rangepick" role="tablist" aria-label="Time range">
		{#each QUICK_RANGES as r (r.id)}
			<button
				class="metrics-rangebtn"
				class:active={activeQuickId === r.id}
				onclick={() => setQuickRange(r.ms)}
				type="button">{r.label}</button
			>
		{/each}
		<button
			class="metrics-rangebtn metrics-rangebtn--icon"
			class:active={isCustom || showCustom}
			onclick={toggleCustomPanel}
			type="button"
			title="Custom range"
			aria-label="Custom range"><CalendarRange class="h-3.5 w-3.5" /></button
		>
	</div>
	<button
		class="metrics-iconbtn"
		onclick={togglePause}
		type="button"
		title={isLive ? 'Pause' : isCustom ? 'Resume live' : 'Resume'}
		aria-label={isLive ? 'Pause' : 'Resume'}
	>
		{#if isLive}<Pause class="h-3.5 w-3.5" />{:else}<Play class="h-3.5 w-3.5" />{/if}
	</button>
{/snippet}

{#snippet customPanel()}
	{#if showCustom}
		<div class="metrics-custompanel" role="group" aria-label="Custom date range">
			<label>
				<span>From</span>
				<input type="datetime-local" bind:value={customStartInput} />
			</label>
			<label>
				<span>To</span>
				<input type="datetime-local" bind:value={customEndInput} />
			</label>
			<div class="metrics-custompanel-actions">
				<button class="btn-mini" type="button" onclick={() => (showCustom = false)}>Cancel</button>
				<button class="btn-mini btn-mini--primary" type="button" onclick={applyCustomRange}
					>Apply</button
				>
				{#if isCustom}
					<button
						class="btn-mini btn-mini--ghost"
						type="button"
						onclick={() => {
							clearCustomRange();
							showCustom = false;
						}}>Clear</button
					>
				{/if}
			</div>
			{#if customError}<div class="metrics-custompanel-error">{customError}</div>{/if}
		</div>
	{/if}
{/snippet}

{#snippet stateBadge()}
	{#if isLive}
		<span class="metrics-badge metrics-badge--live"><span class="metrics-live-dot"></span>live</span
		>
	{:else if isCustom}
		<span class="metrics-badge metrics-badge--custom">custom</span>
	{:else}
		<span class="metrics-badge metrics-badge--paused">paused</span>
	{/if}
{/snippet}

{#snippet card(c: MetricCard, height: string, showExpand: boolean)}
	{@const Icon = c.icon}
	{@const sum = summaries[c.id]}
	{@const hover = valueAtCrosshair(series[c.id])}
	<article class="metrics-card" style="--accent: {c.color}">
		<div class="metrics-card-head">
			<div class="metrics-card-label">
				<Icon class="h-3.5 w-3.5" />
				<span>{c.label}</span>
			</div>
			<div class="metrics-card-head-right">
				<div class="metrics-card-now">
					{c.formatter(hover ?? sum.current)}
				</div>
				{#if showExpand}
					<button
						class="metrics-iconbtn metrics-iconbtn--small"
						onclick={() => (expandedCardId = c.id)}
						type="button"
						title="Expand"
						aria-label="Expand {c.label}"><Maximize2 class="h-3 w-3" /></button
					>
				{/if}
			</div>
		</div>
		<div
			class="metrics-card-chart"
			style="height: {height}"
			onpointermove={(e) => onChartMove(e, e.currentTarget)}
			onpointerleave={onChartLeave}
		>
			{#if chartReady && Line}
				<svelte:component this={Line} data={chartData(c)} options={chartOptions(c)} />
			{:else}
				<div class="metrics-card-skeleton"></div>
			{/if}
		</div>
		<dl class="metrics-card-stats">
			<div>
				<dt>avg</dt>
				<dd>{c.formatter(sum.avg)}</dd>
			</div>
			<div>
				<dt>p95</dt>
				<dd>{c.formatter(sum.p95)}</dd>
			</div>
			<div>
				<dt>max</dt>
				<dd>{c.formatter(sum.max)}</dd>
			</div>
		</dl>
	</article>
{/snippet}

<div class="metrics-root">
	<header class="metrics-header">
		<div class="metrics-title">
			<Activity class="h-4 w-4" />
			<span>Metrics</span>
			{@render stateBadge()}
		</div>
		<div class="metrics-controls">
			{@render controls()}
		</div>
	</header>

	{@render customPanel()}

	<div class="metrics-rangelabel">
		{fmtFull(windowStart)} → {fmtFull(windowEnd)}
	</div>

	<div class="metrics-grid">
		{#each CARDS as c (c.id)}
			{@render card(c, '120px', true)}
		{/each}
	</div>

	<p class="metrics-foot">
		{#if fetchError}
			<span class="metrics-foot-err">Failed to load metrics: {fetchError}</span>
		{:else if initialLoading}
			Loading…
		{:else}
			Live from <code>victoriametrics.orchard-metrics</code> · cAdvisor
		{/if}
	</p>
</div>

{#if expandedCard}
	<div class="metrics-modal-backdrop" role="presentation" onclick={() => (expandedCardId = null)}>
		<div
			class="metrics-modal"
			role="dialog"
			aria-modal="true"
			aria-label="{expandedCard.label} expanded"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => {
				if (e.key === 'Escape') expandedCardId = null;
			}}
		>
			<header class="metrics-modal-head">
				<div class="metrics-title">
					<Activity class="h-4 w-4" style="color: {expandedCard.color}" />
					<span>{expandedCard.label}</span>
					{@render stateBadge()}
				</div>
				<div class="metrics-controls">
					{@render controls()}
					<button
						class="metrics-iconbtn"
						onclick={() => (expandedCardId = null)}
						type="button"
						aria-label="Close"><X class="h-4 w-4" /></button
					>
				</div>
			</header>

			{@render customPanel()}

			<div class="metrics-rangelabel metrics-rangelabel--modal">
				{fmtFull(windowStart)} → {fmtFull(windowEnd)}
			</div>

			<div class="metrics-modal-body">
				{@render card(expandedCard, '420px', false)}
			</div>
		</div>
	</div>
{/if}

<style>
	.metrics-root {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.metrics-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.metrics-controls {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.metrics-title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--text-primary, inherit);
	}

	.metrics-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.metrics-badge--live {
		background: rgba(34, 192, 168, 0.12);
		color: #1a8e7a;
	}
	.metrics-badge--paused {
		background: rgba(255, 165, 0, 0.14);
		color: #b87100;
	}
	.metrics-badge--custom {
		background: rgba(124, 92, 255, 0.14);
		color: #5a3ed1;
	}
	:global(:root.dark) .metrics-badge--live {
		color: #6dd9c4;
	}
	:global(:root.dark) .metrics-badge--paused {
		color: #ffb84d;
	}
	:global(:root.dark) .metrics-badge--custom {
		color: #b09dff;
	}
	.metrics-live-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #22c0a8;
		animation: metrics-pulse 1.6s ease-out infinite;
	}
	@keyframes metrics-pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(34, 192, 168, 0.55);
		}
		70% {
			box-shadow: 0 0 0 8px rgba(34, 192, 168, 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(34, 192, 168, 0);
		}
	}

	.metrics-rangepick {
		display: inline-flex;
		padding: 2px;
		gap: 2px;
		border-radius: 8px;
		background: rgba(120, 120, 128, 0.08);
	}
	.metrics-rangebtn {
		padding: 4px 10px;
		font-size: 0.78rem;
		font-weight: 500;
		border: 0;
		background: transparent;
		color: var(--text-muted, rgba(140, 140, 150, 0.95));
		border-radius: 6px;
		cursor: pointer;
		transition:
			background 80ms ease,
			color 80ms ease;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.metrics-rangebtn--icon {
		padding: 4px 8px;
	}
	.metrics-rangebtn:hover {
		color: var(--text-primary, inherit);
	}
	.metrics-rangebtn.active {
		background: var(--surface, white);
		color: var(--text-primary, inherit);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
	:global(:root.dark) .metrics-rangebtn.active {
		background: rgba(255, 255, 255, 0.08);
	}

	.metrics-iconbtn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border-radius: 6px;
		border: 0;
		cursor: pointer;
		background: rgba(120, 120, 128, 0.08);
		color: var(--text-muted, rgba(140, 140, 150, 0.95));
		transition:
			background 80ms ease,
			color 80ms ease;
	}
	.metrics-iconbtn:hover {
		background: rgba(120, 120, 128, 0.16);
		color: var(--text-primary, inherit);
	}
	.metrics-iconbtn--small {
		width: 22px;
		height: 22px;
	}

	.metrics-rangelabel {
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted, rgba(140, 140, 150, 0.85));
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.metrics-rangelabel--modal {
		margin-top: -2px;
	}

	.metrics-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	@media (max-width: 720px) {
		.metrics-grid {
			grid-template-columns: 1fr;
		}
	}

	.metrics-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px 10px;
		border-radius: 10px;
		background: var(--surface, white);
		border: 1px solid rgba(120, 120, 128, 0.12);
		min-width: 0;
	}
	:global(:root.dark) .metrics-card {
		background: rgba(255, 255, 255, 0.03);
		border-color: rgba(255, 255, 255, 0.06);
	}

	.metrics-card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.metrics-card-head-right {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.metrics-card-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.78rem;
		color: var(--text-muted, rgba(140, 140, 150, 0.95));
	}
	.metrics-card-label :global(svg) {
		color: var(--accent);
	}
	.metrics-card-now {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		font-size: 1.15rem;
		color: var(--accent);
		letter-spacing: -0.01em;
	}

	.metrics-card-chart {
		position: relative;
		min-width: 0;
		touch-action: none;
	}
	.metrics-card-skeleton {
		width: 100%;
		height: 100%;
		border-radius: 6px;
		background: linear-gradient(
			90deg,
			rgba(120, 120, 128, 0.06) 0%,
			rgba(120, 120, 128, 0.1) 50%,
			rgba(120, 120, 128, 0.06) 100%
		);
		background-size: 200% 100%;
		animation: metrics-shimmer 1.4s linear infinite;
	}
	@keyframes metrics-shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}

	.metrics-card-stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		margin: 0;
		padding-top: 6px;
		border-top: 1px dashed rgba(120, 120, 128, 0.18);
	}
	.metrics-card-stats > div {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.metrics-card-stats dt {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted, rgba(140, 140, 150, 0.95));
	}
	.metrics-card-stats dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-primary, inherit);
	}

	.metrics-foot {
		margin: 4px 0 0;
		font-size: 0.72rem;
		color: var(--text-muted, rgba(140, 140, 150, 0.85));
	}
	.metrics-foot code {
		padding: 1px 5px;
		border-radius: 3px;
		background: rgba(120, 120, 128, 0.1);
		font-size: 0.7rem;
	}
	.metrics-foot-err {
		color: #d04a4a;
	}

	.metrics-modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: rgba(15, 15, 20, 0.55);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		animation: metrics-fade 140ms ease-out;
	}
	@keyframes metrics-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	.metrics-modal {
		width: min(1000px, 100%);
		max-height: calc(100vh - 48px);
		overflow: auto;
		background: var(--surface, white);
		border-radius: 14px;
		border: 1px solid rgba(120, 120, 128, 0.18);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
		padding: 18px 20px 20px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		animation: metrics-pop 180ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	:global(:root.dark) .metrics-modal {
		background: #161618;
		border-color: rgba(255, 255, 255, 0.08);
	}
	@keyframes metrics-pop {
		from {
			opacity: 0;
			transform: scale(0.97);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}
	.metrics-modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.metrics-modal-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.metrics-custompanel {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
		padding: 10px 12px;
		border-radius: 8px;
		background: rgba(120, 120, 128, 0.06);
		border: 1px solid rgba(120, 120, 128, 0.12);
	}
	.metrics-custompanel label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.72rem;
		color: var(--text-muted, rgba(140, 140, 150, 0.95));
	}
	.metrics-custompanel input[type='datetime-local'] {
		font: inherit;
		padding: 5px 8px;
		border-radius: 6px;
		border: 1px solid rgba(120, 120, 128, 0.25);
		background: var(--surface, white);
		color: var(--text-primary, inherit);
	}
	:global(:root.dark) .metrics-custompanel input[type='datetime-local'] {
		background: rgba(255, 255, 255, 0.04);
		border-color: rgba(255, 255, 255, 0.1);
	}
	.metrics-custompanel-actions {
		display: inline-flex;
		gap: 6px;
	}
	.metrics-custompanel-error {
		flex-basis: 100%;
		font-size: 0.72rem;
		color: #d04a4a;
	}

	.btn-mini {
		font: inherit;
		font-size: 0.72rem;
		font-weight: 500;
		padding: 5px 10px;
		border-radius: 6px;
		cursor: pointer;
		border: 1px solid rgba(120, 120, 128, 0.2);
		background: transparent;
		color: var(--text-primary, inherit);
	}
	.btn-mini:hover {
		background: rgba(120, 120, 128, 0.08);
	}
	.btn-mini--primary {
		background: #5a3ed1;
		color: white;
		border-color: transparent;
	}
	.btn-mini--primary:hover {
		filter: brightness(1.08);
	}
	.btn-mini--ghost {
		border: 0;
		padding: 3px 8px;
		color: var(--text-muted, rgba(140, 140, 150, 0.95));
	}
</style>
