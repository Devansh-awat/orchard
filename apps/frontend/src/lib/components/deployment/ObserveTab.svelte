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
		Dropdown,
		Field,
		Input,
		Menu,
		MenuItem,
		MenuSeparator,
		Modal,
		SegmentedControl,
		SelectTrigger,
		Swap
	} from '$lib/components/ui';
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
				requestAnimationFrame(() => {
					document.getElementById(moment.panel!)?.scrollIntoView({ block: 'center' });
					metrics.focus = { panel: moment.panel!, key: Date.now() };
				});
			}
		});
	});
	const logs = new LogsState();
	const errors = new ErrorsState();
	const events = new EventsState();

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

	function refreshEvents() {
		if (deployment?.id) events.fetch(deployment.id, { demo, pods: deployment?.pods ?? [] });
	}
</script>

<div class="observe">
	<div class="toolbar">
		<SegmentedControl
			label="Observe"
			shape="capsule"
			options={VIEWS}
			bind:value={() => view, (v) => (activeTab = v)}
		/>

		<div class="controls">
			{#if view === 'metrics' || view === 'logs' || view === 'requests'}
				<CopyButton value={$page.url.toString()} label="Copy a link to this view" />
			{/if}
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
				<div class="nav">
					<Button
						variant="ghost"
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
						icon={ChevronRight}
						label="Later"
						disabled={!metrics.custom}
						onclick={() => metrics.shift(1)}
					/>
					<Button
						variant="ghost"
						icon={ZoomOut}
						label="Zoom out"
						disabled={!metrics.custom && metrics.windowMs >= 7 * 24 * 60 * 60_000}
						onclick={() => metrics.zoomOut()}
					/>
				</div>
				{#if view === 'metrics'}
					<Button
						variant="ghost"
						icon={metrics.live ? Pause : Play}
						label={metrics.live ? 'Pause' : 'Follow live'}
						onclick={() => metrics.togglePause()}
					/>
				{:else if view === 'logs'}
					<Button
						variant="ghost"
						icon={logs.paused ? Play : Pause}
						label={logs.paused ? 'Resume logs' : 'Pause logs'}
						onclick={() => (logs.paused = !logs.paused)}
					/>
				{/if}
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
					{deployment}
					{active}
					{demo}
					{hasIngress}
					runtime={capabilities?.runtime ?? null}
					upSince={overview?.uptime ?? null}
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
				<EventsView {events} {deployment} {active} {demo} />
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
	.controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
	}
	.controls :global(:is(.button, .trigger)) {
		border-radius: 999px;
		corner-shape: round;
	}
	.nav {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.range {
		width: 9.5rem;
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
