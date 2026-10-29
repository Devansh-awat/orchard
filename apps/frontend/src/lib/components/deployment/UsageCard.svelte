<script lang="ts">
	import { Button, SectionCard } from '$lib/components/ui';
	import NumberRoll from '$lib/components/ui/NumberRoll.svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import { formatCpu, formatMemory } from '$lib/utils/format';

	const MIB = 1024 * 1024;
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
		onopen: () => void;
	} = $props();

	type Tone = 'neutral' | 'warning' | 'error';

	let scrub = $state<{ id: string; index: number } | null>(null);

	function pressure(ratio: number | null): Tone {
		if (ratio == null) return 'neutral';
		if (ratio >= 0.95) return 'error';
		if (ratio >= 0.85) return 'warning';
		return 'neutral';
	}

	const rows = $derived([
		{
			id: 'cpu',
			label: 'CPU',
			value: formatCpu(cpu ?? 0),
			at: (v: number) => formatCpu(Math.round(v)),
			limitRaw: cpuLimit,
			scale: 1,
			limit: cpuLimit != null ? formatCpu(cpuLimit) : null,
			ratio: cpuRatio,
			tone: pressure(cpuRatio),
			values: history.cpu
		},
		{
			id: 'mem',
			label: 'Memory',
			value: formatMemory(mem ?? 0),
			at: (v: number) => formatMemory(v * MIB),
			limitRaw: memLimit,
			scale: MIB,
			limit: memLimit != null ? formatMemory(memLimit) : null,
			ratio: memRatio,
			tone: pressure(memRatio),
			values: history.mem
		}
	]);
</script>

<SectionCard title="Usage" size="sm" flush>
	{#snippet actions()}
		<Button variant="ghost" size="sm" onclick={onopen}>Details</Button>
	{/snippet}
	<ul class="rows">
		{#each rows as row (row.id)}
			{@const point = scrub?.id === row.id ? row.values[scrub.index] : undefined}
			<li class="row row--{row.tone}">
				<span class="label">{row.label}</span>
				<span class="reading">
					<span class="value"
						>{#if point !== undefined}{row.at(point)}{:else}<NumberRoll
								value={row.value}
							/>{/if}</span
					>
					<span class="share">
						{#if point !== undefined && row.limitRaw}
							{Math.round(((point * row.scale) / row.limitRaw) * 100)}% of {row.limit}
						{:else if row.ratio != null && row.limit}
							{Math.round(Math.min(row.ratio, 9.99) * 100)}% of {row.limit}
						{:else}
							No limit
						{/if}
					</span>
				</span>
				<span class="trend">
					<Sparkline
						values={row.values}
						height={28}
						tone={row.tone}
						label="{row.label} over the last 30 minutes"
						interactive
						onScrub={(i) => (scrub = i === null ? null : { id: row.id, index: i })}
					/>
				</span>
				{#if row.ratio != null}
					<span
						class="bar"
						role="meter"
						aria-label="{row.label} used"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(Math.min(row.ratio, 1) * 100)}
						><span class="fill" style:width="{Math.min(row.ratio, 1) * 100}%"></span></span
					>
				{/if}
			</li>
		{/each}
	</ul>
</SectionCard>

<style>
	.rows {
		margin: 0;
		padding: 0 0 0.5rem;
		list-style: none;
	}
	.row {
		--tone: var(--neutral-7);
		display: grid;
		grid-template-columns: minmax(0, 1fr) 7rem;
		grid-template-areas:
			'label label'
			'reading trend'
			'bar bar';
		align-items: center;
		column-gap: 1rem;
		padding: 0.75rem 1.25rem 0.875rem;
	}
	.row + .row {
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.row--warning {
		--tone: var(--status-warning-solid);
	}
	.row--error {
		--tone: var(--status-error-solid);
	}
	.label {
		grid-area: label;
		margin-bottom: 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.reading {
		grid-area: reading;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.value {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
		color: var(--text-default);
		white-space: nowrap;
	}
	.share {
		overflow: hidden;
		font-size: var(--text-caption);
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row--warning .share {
		color: var(--status-warning);
	}
	.row--error .share {
		color: var(--status-error);
	}
	.trend {
		grid-area: trend;
		display: flex;
		align-items: center;
		min-width: 0;
		height: 1.75rem;
	}
	.trend > :global(*) {
		flex: 1 1 auto;
	}
	.bar {
		grid-area: bar;
		margin-top: 0.625rem;
		height: 0.25rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--bg-active);
	}
	.fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--tone);
		transition: width var(--spring-glide-duration) var(--spring-glide);
	}
</style>
