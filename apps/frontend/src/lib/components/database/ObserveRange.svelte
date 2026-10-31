<script lang="ts">
	import { CalendarRange, ChevronLeft, ChevronRight, Pause, Play, ZoomOut } from 'lucide-svelte';
	import {
		Button,
		ControlGroup,
		Field,
		Input,
		Menu,
		MenuItem,
		MenuSeparator,
		Modal,
		SelectTrigger
	} from '$lib/components/ui';
	import { RANGES, type MetricsState } from '$lib/components/deployment/observe/metrics.svelte';

	let { metrics }: { metrics: MetricsState } = $props();

	const WEEK = 7 * 24 * 60 * 60_000;

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
		const t = (d: Date) =>
			d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
		const day = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return a.toDateString() === b.toDateString() ? `${t(a)} – ${t(b)}` : `${day(a)} – ${day(b)}`;
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
</script>

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
					shape="capsule"
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
		disabled={!metrics.custom && metrics.windowMs >= WEEK}
		onclick={() => metrics.zoomOut()}
	/>
{/snippet}

{#snippet livePart()}
	<Button
		variant="ghost"
		size="sm"
		icon={metrics.live ? Pause : Play}
		label={metrics.live ? 'Pause' : 'Follow live'}
		onclick={() => metrics.togglePause()}
	/>
{/snippet}

<div class="observe-range">
	<ControlGroup label="Time range" parts={[rangePart, zoomPart, livePart]} />
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
	.observe-range {
		display: contents;
	}
	.range {
		width: 8.5rem;
	}
	.custom {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
