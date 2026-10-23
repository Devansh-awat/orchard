<script lang="ts">
	import { onMount } from 'svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import { decorativeMotion } from '$lib/utils/motion.svelte';

	type Stats = {
		running: number;
		total: number;
		building: number;
		failing: number;
		deploysToday: number;
		deploysFailedToday: number;
		cpu: { used: number; limit: number };
		memory: { usedGiB: number; limitGiB: number };
		requests24h?: number[];
	};

	let { variant = 'numbers', stats }: { variant?: 'numbers' | 'rings' | 'sentence'; stats: Stats } =
		$props();

	const one = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
	const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
	const n = (v: number) => one.format(v);
	const ratio = (a: number, b: number) => (b > 0 ? Math.min(1, Math.max(0, a / b)) : 0);
	const plural = (v: number, word: string, many = `${word}s`) => (v === 1 ? word : many);

	const succeeded = $derived(Math.max(0, stats.deploysToday - stats.deploysFailedToday));
	const requests = $derived(stats.requests24h?.reduce((sum, v) => sum + v, 0) ?? 0);
	const hasRequests = $derived((stats.requests24h?.length ?? 0) > 1);

	const rings = $derived([
		{
			key: 'running',
			tone: 'green',
			label: 'Running',
			value: ratio(stats.running, stats.total),
			main: `${stats.running}/${stats.total}`,
			unit: plural(stats.total, 'app')
		},
		{
			key: 'deploys',
			tone: 'blue',
			label: 'Deploys',
			value: stats.deploysToday ? ratio(succeeded, stats.deploysToday) : 0,
			main: `${succeeded}/${stats.deploysToday}`,
			unit: 'succeeded'
		},
		{
			key: 'memory',
			tone: 'amber',
			label: 'Memory',
			value: ratio(stats.memory.usedGiB, stats.memory.limitGiB),
			main: `${n(stats.memory.usedGiB)}/${n(stats.memory.limitGiB)}`,
			unit: 'GiB'
		}
	]);

	const SIZE = 88;
	const STROKE = 10;
	const GAP = 2;
	const radius = (i: number) => SIZE / 2 - STROKE / 2 - i * (STROKE + GAP);

	let filled = $state(false);

	onMount(() => {
		if (!decorativeMotion()) {
			filled = true;
			return;
		}
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => (filled = true));
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

{#if variant === 'numbers'}
	<div class="cells">
		<div class="cell">
			<span class="label">Apps running</span>
			<span class="value-line">
				<span class="value">{stats.running}</span>
				<span class="of">of {stats.total}</span>
			</span>
			<span class="detail">
				{#if stats.failing > 0}
					<span class="bad">{stats.failing} failing</span>
				{:else if stats.building > 0}
					<span>{stats.building} building</span>
				{:else}
					<span>All healthy</span>
				{/if}
			</span>
		</div>
		<div class="cell">
			<span class="label">Deploys today</span>
			<span class="value-line">
				<span class="value">{stats.deploysToday}</span>
			</span>
			<span class="detail">
				{#if stats.deploysFailedToday > 0}
					<span class="bad">{stats.deploysFailedToday} failed</span>
				{:else if stats.deploysToday > 0}
					<span>All succeeded</span>
				{:else}
					<span>None yet</span>
				{/if}
			</span>
		</div>
		<div class="cell">
			<span class="label">CPU</span>
			<span class="value-line">
				<span class="value">{n(stats.cpu.used)}</span>
				<span class="of">of {n(stats.cpu.limit)} {plural(stats.cpu.limit, 'core')}</span>
			</span>
			<span class="detail">
				<span class="meter" aria-hidden="true">
					<span class="meter-fill" style:--r={ratio(stats.cpu.used, stats.cpu.limit)}></span>
				</span>
			</span>
		</div>
		<div class="cell">
			<span class="label">Memory</span>
			<span class="value-line">
				<span class="value">{n(stats.memory.usedGiB)}</span>
				<span class="of">of {n(stats.memory.limitGiB)} GiB</span>
			</span>
			<span class="detail">
				<span class="meter" aria-hidden="true">
					<span class="meter-fill" style:--r={ratio(stats.memory.usedGiB, stats.memory.limitGiB)}
					></span>
				</span>
			</span>
		</div>
		{#if hasRequests && stats.requests24h}
			<div class="cell">
				<span class="label">Requests</span>
				<span class="value-line">
					<span class="value">{compact.format(requests)}</span>
					<span class="of">in 24h</span>
				</span>
				<span class="detail detail--chart">
					<Sparkline values={stats.requests24h} tone="neutral" height={16} />
				</span>
			</div>
		{/if}
	</div>
{:else if variant === 'rings'}
	<div class="rings" class:rings--filled={filled}>
		<svg
			class="dial"
			width={SIZE}
			height={SIZE}
			viewBox="0 0 {SIZE} {SIZE}"
			role="img"
			aria-label="{stats.running} of {stats.total} apps running, {succeeded} of {stats.deploysToday} deploys succeeded today, {n(
				stats.memory.usedGiB
			)} of {n(stats.memory.limitGiB)} GiB memory used"
		>
			{#each rings as ring, i (ring.key)}
				<g class="ring-{ring.tone}" transform="rotate(-90 {SIZE / 2} {SIZE / 2})">
					<circle class="track" cx={SIZE / 2} cy={SIZE / 2} r={radius(i)} stroke-width={STROKE} />
					<circle
						class="arc"
						class:arc--empty={ring.value <= 0}
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={radius(i)}
						stroke-width={STROKE}
						pathLength="100"
						style:--r={ring.value}
						style:--i={i}
					/>
				</g>
			{/each}
		</svg>
		<dl class="legend">
			{#each rings as ring (ring.key)}
				<div class="legend-row">
					<dt class="legend-label">{ring.label}</dt>
					<dd class="legend-value ink-{ring.tone}">
						<span class="legend-main">{ring.main}</span>
						<span class="legend-unit">{ring.unit}</span>
					</dd>
				</div>
			{/each}
		</dl>
	</div>
{:else}
	<p class="sentence">
		<span class="num">{stats.running}</span> of <span class="num">{stats.total}</span>
		{plural(stats.total, 'app')} running{#if stats.failing > 0},
			<span class="bad"><span class="num">{stats.failing}</span> failing</span
			>{/if}{#if stats.building > 0},
			<span class="num">{stats.building}</span> building{/if}.
		{#if stats.deploysToday > 0}
			<span class="num">{stats.deploysToday}</span>
			{plural(stats.deploysToday, 'deploy')} today{#if stats.deploysFailedToday > 0},
				<span class="bad"><span class="num">{stats.deploysFailedToday}</span> failed</span>{/if}.
		{:else}
			No deploys yet today.
		{/if}
		Using <span class="num">{n(stats.cpu.used)}</span> of
		<span class="num">{n(stats.cpu.limit)}</span>
		{plural(stats.cpu.limit, 'core')} and <span class="num">{n(stats.memory.usedGiB)}</span> of
		<span class="num">{n(stats.memory.limitGiB)}</span> GiB.
	</p>
{/if}

<style>
	.cells {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(0, 1fr);
		min-width: 0;
	}
	.cell {
		display: flex;
		flex-direction: column;
		gap: 0.8125rem;
		min-width: 0;
		padding: 0.125rem 1.25rem;
	}
	.cell:first-child {
		padding-left: 0;
	}
	.cell:last-child {
		padding-right: 0;
	}
	.cell + .cell {
		box-shadow: inset 0.5px 0 0 var(--border-strong);
	}
	.label {
		display: block;
		overflow: hidden;
		padding-block: 0.3em;
		margin-block: -0.3em;
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
	}
	.value-line {
		display: flex;
		align-items: baseline;
		gap: 0.3125rem;
		min-width: 0;
		white-space: nowrap;
	}
	.value {
		display: block;
		color: var(--text-default);
		font-size: var(--text-title-1);
		line-height: var(--lh-title-1);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
		text-box: trim-both cap alphabetic;
	}
	.of {
		display: block;
		overflow: hidden;
		padding-block: 0.3em;
		margin-block: -0.3em;
		color: var(--text-muted);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		font-variant-numeric: tabular-nums;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
	}
	.detail {
		display: flex;
		align-items: center;
		height: 0.75rem;
		min-width: 0;
		overflow: hidden;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.detail > span:not(.meter) {
		text-box: trim-both cap alphabetic;
	}
	.detail--chart {
		height: 1rem;
		margin-block: -0.125rem;
	}
	.detail--chart :global(svg) {
		max-width: 7rem;
	}
	.bad {
		color: var(--status-error);
		font-weight: var(--weight-medium);
	}
	.meter {
		position: relative;
		display: block;
		width: 100%;
		max-width: 7rem;
		height: 0.25rem;
		overflow: hidden;
		border-radius: var(--radius-pill);
		background: var(--bg-active);
	}
	.meter-fill {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: var(--neutral-8);
		transform: translateX(calc((var(--r) - 1) * 100%));
		transition: transform var(--spring-smooth-duration) var(--spring-smooth);
	}

	.rings {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		min-width: 0;
	}
	.dial {
		display: block;
		flex-shrink: 0;
		overflow: visible;
	}
	.ring-green {
		--tone: var(--green-7);
	}
	.ring-blue {
		--tone: var(--blue-7);
	}
	.ring-amber {
		--tone: var(--amber-7);
	}
	.track {
		fill: none;
		stroke: color-mix(in oklab, var(--tone) 16%, transparent);
	}
	.arc {
		fill: none;
		stroke: var(--tone);
		stroke-linecap: round;
		stroke-dasharray: 100 200;
		stroke-dashoffset: 100;
		transition: stroke-dashoffset var(--spring-smooth-duration) var(--spring-smooth)
			calc(var(--i) * 60ms + 80ms);
	}
	.rings--filled .arc {
		stroke-dashoffset: calc((1 - var(--r)) * 100);
	}
	.arc--empty {
		opacity: 0;
	}
	:global(html.motion-reduce) .arc {
		transition: none;
	}
	.legend {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
		margin: 0;
	}
	.legend-row {
		display: flex;
		flex-direction: column;
		gap: 0.4375rem;
		min-width: 0;
	}
	.legend-label {
		display: block;
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
	.legend-value {
		display: flex;
		align-items: baseline;
		gap: 0.25rem;
		margin: 0;
		white-space: nowrap;
	}
	.legend-main {
		display: block;
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.012em;
		font-variant-numeric: tabular-nums;
		text-box: trim-both cap alphabetic;
	}
	.legend-unit {
		display: block;
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
		opacity: 0.8;
	}
	.ink-green {
		color: var(--green-9);
	}
	.ink-blue {
		color: var(--blue-9);
	}
	.ink-amber {
		color: var(--amber-9);
	}

	.sentence {
		max-width: 40rem;
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-title-3);
		line-height: 1.55;
		text-wrap: pretty;
	}
	.num {
		color: var(--text-default);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}
	.sentence .bad,
	.sentence .bad .num {
		color: var(--status-error);
		font-weight: var(--weight-semibold);
	}
</style>
