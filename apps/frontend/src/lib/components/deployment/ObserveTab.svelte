<script lang="ts">
	import { untrack } from 'svelte';
	import {
		CalendarRange,
		ChevronLeft,
		ChevronRight,
		Pause,
		Play,
		RotateCw,
		ZoomOut
	} from 'lucide-svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { apiFetch } from '$lib/stores';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { readMoment } from './observe/permalink';
	import {
		Button,
		ControlGroup,
		Dropdown,
		Field,
		Input,
		Menu,
		MenuItem,
		MenuSeparator,
		Modal,
		SegmentedControl,
		SelectTrigger,
		Swap,
		UnderlineTabs
	} from '$lib/components/ui';
	import GoldenReticle from '$lib/components/ui/GoldenReticle.svelte';
	import { runtimeName, uptime } from './observe/runtime';
	import { demoOverview } from '$lib/utils/observe-demo';
	import { fitViewport } from './observe/fit';
	import { MetricsState, RANGES } from './observe/metrics.svelte';
	import { LogsState } from './observe/logs.svelte';
	import { ErrorsState, ERROR_WINDOWS } from './observe/errors.svelte';
	import { EventsState } from './observe/events.svelte';
	import MetricsView from './observe/MetricsView.svelte';
	import LogsView from './observe/LogsView.svelte';
	import RequestsView from './observe/RequestsView.svelte';
	import ErrorsView from './observe/ErrorsView.svelte';
	import EventsView from './observe/EventsView.svelte';

	type View = 'metrics' | 'logs' | 'requests' | 'errors' | 'events';

	let {
		deployment,
		active = true,
		activeTab = $bindable<string>('metrics')
	}: {
		deployment: any;
		active?: boolean;
		activeTab?: string;
	} = $props();

	const ALL_VIEWS: { value: View; label: string }[] = [
		{ value: 'metrics', label: 'Metrics' },
		{ value: 'logs', label: 'Logs' },
		{ value: 'requests', label: 'Requests' },
		{ value: 'errors', label: 'Errors' },
		{ value: 'events', label: 'Events' }
	];

	const metrics = new MetricsState();
	let restored = false;
	let restoring = true;
	let pendingMoment: { at: number | null; panel: string | null } | null = null;

	$effect(() => {
		if (restored) return;
		restored = true;
		untrack(() => {
			const m = readMoment($page.url);
			if (m.from != null && m.to != null) metrics.zoom(m.from, m.to);
			else if (m.range) {
				const r = RANGES.find((x) => x.id === m.range);
				if (r) metrics.setRange(r.ms);
			}
			if (m.at != null || m.panel) pendingMoment = { at: m.at, panel: m.panel };
		});
	});

	$effect(() => {
		const custom = metrics.custom;
		const ms = metrics.windowMs;
		untrack(() => writeRange(custom, ms));
	});

	function writeRange(custom: { from: number; to: number } | null, ms: number) {
		const url = new URL(window.location.href);
		if (custom) {
			url.searchParams.set('from', String(custom.from));
			url.searchParams.set('to', String(custom.to));
			url.searchParams.delete('range');
		} else {
			url.searchParams.delete('from');
			url.searchParams.delete('to');
			const r = RANGES.find((x) => x.ms === ms);
			if (r && r.id !== '1h') url.searchParams.set('range', r.id);
			else url.searchParams.delete('range');
		}
		if (!restoring) {
			url.searchParams.delete('at');
			url.searchParams.delete('panel');
		}
		restoring = false;
		if (url.href !== window.location.href) {
			goto(url, { replaceState: true, noScroll: true, keepFocus: true });
		}
	}

	$effect(() => {
		const loaded = metrics.loaded;
		if (!loaded || !pendingMoment || view !== 'metrics') return;
		const moment = pendingMoment;
		pendingMoment = null;
		untrack(() => {
			if (moment.at != null) metrics.hover = moment.at;
			if (moment.panel) {
				let held = 0;
				let stop = false;
				const release = () => (stop = true);
				for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart'])
					addEventListener(type, release, { once: true, capture: true });
				const reveal = (tries: number) => {
					const el = document.getElementById(moment.panel!);
					if (stop || tries > 240) return;
					if (el?.getClientRects().length) {
						const scroller = el.closest('main') ?? document.scrollingElement;
						if (scroller) {
							const box = el.getBoundingClientRect();
							const top =
								scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
							const offset = box.top - top - Math.max(0, (scroller.clientHeight - box.height) / 2);
							if (Math.abs(offset) > 2) scroller.scrollTo({ top: scroller.scrollTop + offset });
						}
						if (held === 0) metrics.focus = { panel: moment.panel!, key: Date.now() };
						if (++held > 60) return;
					}
					requestAnimationFrame(() => reveal(tries + 1));
				};
				requestAnimationFrame(() => reveal(0));
			}
		});
	});
	const logs = new LogsState();
	const errors = new ErrorsState();
	const events = new EventsState();
	let focusKilled = $state(false);

	const demo = $derived($page.url.searchParams.has('demo'));
	const hasIngress = $derived(demo || (deployment?.ingresses?.length ?? 0) > 0);
	const VIEWS = $derived(ALL_VIEWS.filter((v) => v.value !== 'requests' || hasIngress));
	const view = $derived<View>(
		VIEWS.some((v) => v.value === activeTab) ? (activeTab as View) : 'metrics'
	);

	$effect(() => {
		const tab = activeTab;
		if (!deployment || VIEWS.some((v) => v.value === tab)) return;
		untrack(() => {
			if (tab === 'killed') focusKilled = true;
			activeTab = tab === 'killed' ? 'events' : 'metrics';
		});
	});

	let capabilities = $state<any>(null);
	let overview = $state<any>(null);
	let bootstrapped: string | null = null;

	$effect(() => {
		const id = deployment?.id;
		if (!id || !active || id === bootstrapped) return;
		bootstrapped = id;
		untrack(async () => {
			if (demo) overview = demoOverview();
			const base = `/apiv1/observe/deployments/${encodeURIComponent(id)}`;
			const [caps, ov] = await Promise.all([
				apiFetch(`${base}/capabilities`).catch(() => null),
				demo ? null : apiFetch(`${base}/overview`).catch(() => null)
			]);
			if (caps?.ok) capabilities = await caps.json();
			if (ov?.ok) overview = await ov.json();
		});
	});

	const rangeLabel = $derived.by(() => {
		const c = metrics.custom;
		if (!c) {
			const preset = RANGES.find((r) => r.ms === metrics.windowMs)?.short;
			if (preset) return preset;
			const m = Math.round(metrics.windowMs / 60_000);
			return m < 120
				? `Last ${m}m`
				: m < 2880
					? `Last ${Math.round(m / 60)}h`
					: `Last ${Math.round(m / 1440)}d`;
		}
		const a = new Date(c.from);
		const b = new Date(c.to);
		const sameDay = a.toDateString() === b.toDateString();
		const t = (d: Date) =>
			d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
		const day = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return sameDay ? `${t(a)} – ${t(b)}` : `${day(a)} – ${day(b)}`;
	});

	let customOpen = $state(false);
	let customFrom = $state('');
	let customTo = $state('');
	let customError = $state<string | null>(null);

	function local(ts: number) {
		const d = new Date(ts);
		const p = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
	}

	function openCustom() {
		customFrom = local(metrics.from);
		customTo = local(metrics.to);
		customError = null;
		customOpen = true;
	}

	function applyCustom() {
		const a = new Date(customFrom).getTime();
		const b = new Date(customTo).getTime();
		if (!Number.isFinite(a) || !Number.isFinite(b)) {
			customError = 'Pick both a start and an end';
			return;
		}
		if (a >= b) {
			customError = 'The start has to be before the end';
			return;
		}
		metrics.zoom(a, b);
		customOpen = false;
	}

	const runtimeLabel = $derived(runtimeName(capabilities?.runtime ?? null) || undefined);
	const uptimeLabel = $derived.by(() => {
		const up = uptime(overview?.uptime ?? null);
		return up ? `Up ${up}` : undefined;
	});

	const guides = $derived($page.url.searchParams.has('guides'));
	let guideLines = $state<{ axis: 'x' | 'y'; at: number; label?: string }[]>([]);
	let board = $state<HTMLElement | null>(null);

	$effect(() => {
		const el = board;
		if (!guides || !el) return;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const xs = new Set<number>();
			const ys = new Set<number>();
			for (const panel of el.querySelectorAll('.metric-panel')) {
				const box = panel.getBoundingClientRect();
				if (box.bottom < 0 || box.top > innerHeight) continue;
				const hit = panel.querySelector('.chart .hit')?.getBoundingClientRect();
				if (hit) {
					xs.add(Math.round(hit.left * 2) / 2);
					xs.add(Math.round(hit.right * 2) / 2);
				}
				const title = panel.querySelector('.title')?.getBoundingClientRect();
				if (title) ys.add(Math.round(title.bottom * 2) / 2);
			}
			guideLines = [
				...[...xs].map((at) => ({ axis: 'x' as const, at, label: `${at}` })),
				...[...ys].map((at) => ({ axis: 'y' as const, at, label: `${at}` }))
			];
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		const timer = setInterval(schedule, 500);
		addEventListener('scroll', schedule, { capture: true, passive: true });
		addEventListener('resize', schedule);
		schedule();
		return () => {
			cancelAnimationFrame(frame);
			clearInterval(timer);
			removeEventListener('scroll', schedule, { capture: true });
			removeEventListener('resize', schedule);
		};
	});

	function refreshEvents() {
		if (deployment?.id) events.fetch(deployment.id, { demo, pods: deployment?.pods ?? [] });
	}
</script>

{#if guides}<GoldenReticle golden={false} lines={guideLines} />{/if}

{#snippet rangePart()}
	<Button
		variant="ghost"
		size="sm"
		icon={ChevronLeft}
		label="Earlier"
		onclick={() => metrics.shift(-1)}
	/>
	<div class="range">
		<Menu placement="bottom-end">
			{#snippet trigger(attrs, isOpen)}
				<SelectTrigger
					{...attrs}
					open={isOpen}
					size="sm"
					block
					value={rangeLabel}
					aria-label="Time range: {rangeLabel}"
					onclear={metrics.custom ? () => metrics.clearCustom() : undefined}
				/>
			{/snippet}
			{#each RANGES as r (r.id)}
				<MenuItem
					checked={!metrics.custom && metrics.windowMs === r.ms}
					onclick={() => metrics.setRange(r.ms)}>{r.label}</MenuItem
				>
			{/each}
			<MenuSeparator />
			<MenuItem icon={CalendarRange} onclick={openCustom}>Custom range…</MenuItem>
		</Menu>
	</div>
	<Button
		variant="ghost"
		size="sm"
		icon={ChevronRight}
		label="Later"
		disabled={!metrics.custom}
		onclick={() => metrics.shift(1)}
	/>
{/snippet}

{#snippet zoomPart()}
	<Button
		variant="ghost"
		size="sm"
		icon={ZoomOut}
		label="Zoom out"
		disabled={!metrics.custom && metrics.windowMs >= 7 * 24 * 60 * 60_000}
		onclick={() => metrics.zoomOut()}
	/>
{/snippet}

{#snippet livePart()}
	{#if view === 'metrics'}
		<Button
			variant="ghost"
			size="sm"
			icon={metrics.live ? Pause : Play}
			label={metrics.live ? 'Pause' : 'Follow live'}
			onclick={() => metrics.togglePause()}
		/>
	{:else}
		<Button
			variant="ghost"
			size="sm"
			icon={logs.paused ? Play : Pause}
			label={logs.paused ? 'Resume logs' : 'Pause logs'}
			onclick={() => (logs.paused = !logs.paused)}
		/>
	{/if}
{/snippet}

<div class="observe" bind:this={board}>
	<div class="toolbar">
		<div class="views">
			<UnderlineTabs
				label="Observe"
				tabs={VIEWS.map((v) => ({ id: v.value, label: v.label }))}
				bind:value={() => view, (v) => (activeTab = v)}
			/>
		</div>

		<div class="controls">
			{#if view === 'metrics' || view === 'logs' || view === 'requests'}
				{#if view === 'metrics'}
					<SegmentedControl
						label="Split"
						shape="capsule"
						bind:value={
							() => (metrics.byPod ? 'pod' : 'total'), (v) => (metrics.byPod = v === 'pod')
						}
						options={[
							{ value: 'total', label: 'Total' },
							{ value: 'pod', label: 'By pod' }
						]}
					/>
				{/if}
				<ControlGroup
					label="Time range"
					parts={view === 'requests' ? [rangePart, zoomPart] : [rangePart, zoomPart, livePart]}
				/>
				<CopyButton value={$page.url.toString()} label="Copy a link to this view" />
			{:else if view === 'errors'}
				<SegmentedControl
					label="Status"
					shape="capsule"
					bind:value={errors.status}
					options={[
						{ value: 'unresolved', label: 'Open' },
						{ value: 'resolved', label: 'Resolved' },
						{ value: 'ignored', label: 'Ignored' },
						{ value: 'all', label: 'All' }
					]}
				/>
				<div class="window">
					<Dropdown
						bind:value={errors.window}
						options={ERROR_WINDOWS}
						placement="bottom-end"
						ariaLabel="Window"
					/>
				</div>
			{:else}
				<Button
					variant="ghost"
					icon={RotateCw}
					label="Refresh"
					loading={events.loading}
					onclick={refreshEvents}
				/>
			{/if}
		</div>
	</div>

	<div class="stage" {@attach fitViewport({ min: 26 * 16 })}>
		<Swap key={view}>
			{#if view === 'metrics'}
				<MetricsView
					{metrics}
					{runtimeLabel}
					{uptimeLabel}
					{deployment}
					{active}
					{demo}
					{hasIngress}
					sharedHttp={!!capabilities?.httpMetricsShared}
				/>
			{:else if view === 'logs'}
				<LogsView
					{logs}
					deploymentId={deployment?.id}
					deploymentName={deployment?.name}
					{active}
					windowMs={metrics.windowMs}
					custom={metrics.custom}
				/>
			{:else if view === 'requests'}
				<RequestsView
					deploymentId={deployment?.id}
					{active}
					windowMs={metrics.windowMs}
					custom={metrics.custom}
				/>
			{:else if view === 'errors'}
				<ErrorsView
					{errors}
					deploymentId={deployment?.id}
					{active}
					{demo}
					onOpenLogs={() => (activeTab = 'logs')}
				/>
			{:else}
				<EventsView {events} {deployment} {active} {demo} bind:focusKilled />
			{/if}
		</Swap>
	</div>
</div>

<Modal bind:open={customOpen} title="Custom range" size="sm">
	<div class="custom">
		<Field label="From">
			<Input type="datetime-local" bind:value={customFrom} />
		</Field>
		<Field label="To" error={customError ?? undefined}>
			<Input type="datetime-local" bind:value={customTo} error={!!customError} />
		</Field>
	</div>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (customOpen = false)}>Cancel</Button>
		<Button variant="primary" onclick={applyCustom}>Show range</Button>
	{/snippet}
</Modal>

<style>
	.observe {
		container: observe / inline-size;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.5rem 1rem;
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
		padding-block: 0.875rem;
		margin-bottom: 0;
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
		padding-bottom: 0.5rem;
	}
	.controls :global(.trigger) {
		border-radius: 999px;
		corner-shape: round;
	}
	.range {
		width: 8.5rem;
	}
	@container observe (max-width: 52rem) {
		.controls {
			order: -1;
			width: 100%;
			justify-content: flex-end;
		}
	}
	.window {
		width: 7.5rem;
	}
	.stage {
		min-width: 0;
	}
	.custom {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
