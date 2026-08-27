<script lang="ts">
	import { ChevronRight } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import { SegmentedControl } from '$lib/components/ui';
	import type { BreakdownItem } from './types';

	let {
		items,
		orgSlug
	}: {
		items: BreakdownItem[];
		orgSlug: string;
	} = $props();

	let metric = $state<'cpu' | 'memory'>('cpu');

	const valueOf = (i: BreakdownItem) => (metric === 'cpu' ? i.cpuMilli : i.memoryBytes);
	const format = $derived(metric === 'cpu' ? formatCpuMilli : formatMemoryBytes);

	const ranked = $derived.by(() => {
		const sorted = [...items].sort((a, b) => valueOf(b) - valueOf(a));
		const top = sorted.length > 0 ? valueOf(sorted[0]) : 0;
		return sorted.map((item) => ({
			item,
			value: valueOf(item),
			share: top > 0 ? valueOf(item) / top : 0
		}));
	});

	const total = $derived(items.reduce((sum, i) => sum + valueOf(i), 0));

	function hrefFor(item: BreakdownItem): string | null {
		if (item.kind === 'deployment') return `/${orgSlug}/deployments/${item.id}`;
		if (item.kind === 'database') return `/${orgSlug}/databases/${item.id}`;
		return null;
	}
</script>

<div class="ub">
	<div class="ub-head">
		<span class="ub-total">{format(total)} across {items.length} workloads</span>
		<SegmentedControl
			label="Rank by"
			bind:value={metric}
			options={[
				{ value: 'cpu', label: 'CPU' },
				{ value: 'memory', label: 'Memory' }
			]}
		/>
	</div>

	<ul class="ub-list">
		{#each ranked as entry, i (`${entry.item.kind}:${entry.item.id}`)}
			{@const href = hrefFor(entry.item)}
			<li {@attach motionStagger({ index: i, from: { y: 4, opacity: 0 } })}>
				<svelte:element
					this={href ? 'a' : 'div'}
					href={href ?? undefined}
					class="ub-row"
					class:ub-row--link={!!href}
				>
					<span class="ub-bar" style="--share: {entry.share}"></span>
					<span class="ub-main">
						<span class="ub-name">{entry.item.name}</span>
						<span class="ub-meta">
							{entry.item.projectName} &middot; {entry.item.kind}
							{#if entry.item.replicas > 1}&middot; {entry.item.replicas} replicas{/if}
						</span>
					</span>
					<span class="ub-value">
						<span class="ub-primary">{format(entry.value)}</span>
						<span class="ub-secondary">
							{metric === 'cpu'
								? formatMemoryBytes(entry.item.memoryBytes)
								: formatCpuMilli(entry.item.cpuMilli)}
						</span>
					</span>
					{#if href}
						<ChevronRight class="ub-chev h-3.5 w-3.5" />
					{/if}
				</svelte:element>
			</li>
		{/each}
	</ul>
</div>

<style>
	.ub {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.ub-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.ub-total {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.ub-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ub-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
		overflow: hidden;
		color: inherit;
		text-decoration: none;
	}
	.ub-bar {
		position: absolute;
		inset: 0 auto 0 0;
		width: calc(var(--share) * 100%);
		background-color: var(--accent-subtle);
		border-radius: var(--radius-md);
		pointer-events: none;
	}
	.ub-row--link:hover {
		background-color: var(--bg-hover);
	}
	.ub-main {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
		min-width: 0;
		flex: 1;
	}
	.ub-name {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ub-meta {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ub-value {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.0625rem;
		flex-shrink: 0;
	}
	.ub-primary {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
	}
	.ub-secondary {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.ub-row :global(.ub-chev) {
		position: relative;
		flex-shrink: 0;
		color: var(--text-faint);
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.ub-row--link:hover :global(.ub-chev) {
		opacity: 1;
	}
</style>
