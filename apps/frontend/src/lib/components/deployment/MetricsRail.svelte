<script lang="ts">
	import Card from '$lib/components/ui/Card.svelte';
	import Metric from '$lib/components/ui/Metric.svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import { formatCpu, formatMemory } from '$lib/utils/format';
	import type { UsageHistory } from './usage-history.svelte';

	let {
		cpu,
		mem,
		cpuLimit,
		memLimit,
		cpuRatio,
		memRatio,
		history,
		onopen
	}: {
		cpu: number | null | undefined;
		mem: number | null | undefined;
		cpuLimit: number | null;
		memLimit: number | null;
		cpuRatio: number | null;
		memRatio: number | null;
		history: UsageHistory;
		onopen: (view: 'metrics' | 'http') => void;
	} = $props();

	type Tone = 'neutral' | 'warning' | 'error';

	function pressure(ratio: number | null): Tone {
		if (ratio == null) return 'neutral';
		if (ratio >= 0.95) return 'error';
		if (ratio >= 0.85) return 'warning';
		return 'neutral';
	}

	function share(ratio: number | null, limit: string | null) {
		if (ratio == null || !limit) return 'No limit';
		return `${Math.round(Math.min(ratio, 9.99) * 100)}% of ${limit}`;
	}

	const last = (values: number[]) => values[values.length - 1] ?? null;
	const rate = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(1));

	const cards = $derived.by(() => {
		const list: {
			id: string;
			label: string;
			value: string;
			unit?: string;
			detail: string;
			tone: Tone;
			values: number[];
			view: 'metrics' | 'http';
		}[] = [
			{
				id: 'cpu',
				label: 'CPU',
				value: formatCpu(cpu ?? 0),
				detail: share(cpuRatio, cpuLimit != null ? formatCpu(cpuLimit) : null),
				tone: pressure(cpuRatio),
				values: history.cpu,
				view: 'metrics'
			},
			{
				id: 'mem',
				label: 'Memory',
				value: formatMemory(mem ?? 0),
				detail: share(memRatio, memLimit != null ? formatMemory(memLimit) : null),
				tone: pressure(memRatio),
				values: history.mem,
				view: 'metrics'
			}
		];
		const req = last(history.requests);
		if (req != null) {
			list.push({
				id: 'req',
				label: 'Requests',
				value: rate(req),
				unit: '/s',
				detail: 'Last 30 min',
				tone: 'neutral',
				values: history.requests,
				view: 'http'
			});
		}
		const err = last(history.errors);
		if (err != null) {
			list.push({
				id: 'err',
				label: 'Errors',
				value: err.toFixed(2),
				unit: '%',
				detail: 'Of requests',
				tone: err >= 5 ? 'error' : err >= 1 ? 'warning' : 'neutral',
				values: history.errors,
				view: 'http'
			});
		}
		return list;
	});
</script>

<div class="rail">
	{#each cards as card (card.id)}
		<Card onclick={() => onopen(card.view)} padding="sm" class="metric-card">
			<Metric
				label={card.label}
				value={card.value}
				unit={card.unit}
				detail={card.detail}
				tone={card.tone}
				roll
				size="sm"
			>
				{#snippet chart()}
					<Sparkline
						values={card.values}
						height={28}
						tone={card.tone}
						label="{card.label} over the last 30 minutes"
					/>
				{/snippet}
			</Metric>
		</Card>
	{/each}
</div>

<style>
	.rail {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	.rail :global(.metric-card) {
		min-width: 0;
		text-align: left;
	}
</style>
