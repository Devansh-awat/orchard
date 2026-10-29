<script lang="ts">
	let {
		items,
		format,
		emphasis = $bindable(null),
		label
	}: {
		items: { id: string; label: string; value: number | null; color?: string }[];
		format: (v: number) => string;
		emphasis?: string | null;
		label: string;
	} = $props();

	const ranked = $derived(
		[...items].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
	);
	const peak = $derived(Math.max(0, ...ranked.map((i) => i.value ?? 0)) || 1);
</script>

<ol class="top" aria-label={label}>
	{#each ranked as item (item.id)}
		<li
			class="item"
			class:item--on={emphasis === item.id}
			onpointerenter={() => (emphasis = item.id)}
			onpointerleave={() => (emphasis = null)}
		>
			<span class="value">{item.value == null ? '–' : format(item.value)}</span>
			<span class="track">
				<span
					class="bar"
					style:width="{Math.max(0, ((item.value ?? 0) / peak) * 100)}%"
					style:--bar={item.color ?? 'var(--neutral-8)'}
				></span>
				<span class="name">{item.label}</span>
			</span>
		</li>
	{/each}
</ol>

<style>
	.top {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--text-callout);
		font-variant-numeric: tabular-nums;
	}
	.item {
		display: grid;
		grid-template-columns: 5.5rem minmax(0, 1fr);
		align-items: center;
		gap: 0.75rem;
	}
	.value {
		text-align: right;
		color: var(--text-default);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}
	.track {
		position: relative;
		display: flex;
		align-items: center;
		height: 1.75rem;
		min-width: 0;
	}
	.bar {
		position: absolute;
		inset: 0 auto 0 0;
		min-width: 2px;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--bar) 28%, transparent);
		transition: background-color var(--dur-fast) ease;
	}
	.item--on .bar {
		background: color-mix(in oklab, var(--bar) 45%, transparent);
	}
	.name {
		position: relative;
		overflow: hidden;
		padding-inline: 0.5rem;
		color: var(--text-default);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
