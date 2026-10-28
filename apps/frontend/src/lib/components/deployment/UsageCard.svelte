<script lang="ts">
	import Card from '$lib/components/ui/Card.svelte';
	import Metric from '$lib/components/ui/Metric.svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import { formatCpu, formatMemory } from '$lib/utils/format';

	let {
		cpu,
		mem,
		cpuLimit,
		memLimit,
		cpuRatio,
		memRatio,
		cpuHistory,
		memHistory,
		onopen
	}: {
		cpu: number | null | undefined;
		mem: number | null | undefined;
		cpuLimit: number | null;
		memLimit: number | null;
		cpuRatio: number | null;
		memRatio: number | null;
		cpuHistory: number[];
		memHistory: number[];
		onopen: () => void;
	} = $props();

	type Tone = 'neutral' | 'warning' | 'error';

	function toneOf(ratio: number | null): Tone {
		if (ratio == null) return 'neutral';
		if (ratio >= 0.95) return 'error';
		if (ratio >= 0.85) return 'warning';
		return 'neutral';
	}

	function share(ratio: number | null, limit: string | null) {
		if (ratio == null || !limit) return 'No limit';
		return `${Math.round(Math.min(ratio, 9.99) * 100)}% of ${limit}`;
	}

	const metrics = $derived([
		{
			label: 'CPU',
			value: formatCpu(cpu ?? 0),
			detail: share(cpuRatio, cpuLimit != null ? formatCpu(cpuLimit) : null),
			tone: toneOf(cpuRatio),
			history: cpuHistory
		},
		{
			label: 'Memory',
			value: formatMemory(mem ?? 0),
			detail: share(memRatio, memLimit != null ? formatMemory(memLimit) : null),
			tone: toneOf(memRatio),
			history: memHistory
		}
	]);
</script>

<Card onclick={onopen} padding="none">
	<div class="usage">
		{#each metrics as m (m.label)}
			<div class="cell">
				<Metric label={m.label} value={m.value} detail={m.detail} tone={m.tone} roll>
					{#snippet chart()}
						<Sparkline
							values={m.history}
							height={28}
							tone={m.tone}
							label="{m.label} over the last 30 minutes"
						/>
					{/snippet}
				</Metric>
			</div>
		{/each}
	</div>
</Card>

<style>
	.usage {
		display: grid;
		grid-template-columns: 1fr 1fr;
		text-align: left;
	}
	.cell {
		min-width: 0;
		padding: 1rem;
	}
	.cell + .cell {
		box-shadow: inset 1px 0 0 var(--border-default);
	}
</style>
