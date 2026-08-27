<script lang="ts">
	import { motionStagger } from '$lib/utils/motion.svelte';

	let {
		label,
		used,
		limit,
		available,
		format,
		index = 0
	}: {
		label: string;
		used: number;
		limit: number | null;
		available: number | null;
		format: (n: number) => string;
		index?: number;
	} = $props();

	const unlimited = $derived(limit === null || limit <= 0);
	const ratio = $derived(unlimited ? 0 : Math.min(1, used / (limit as number)));
	const percent = $derived(Math.round(ratio * 100));

	const pressure = $derived.by<'ok' | 'warning' | 'error'>(() => {
		if (unlimited) return 'ok';
		if (ratio >= 0.95) return 'error';
		if (ratio >= 0.8) return 'warning';
		return 'ok';
	});

	const pressureLabel = $derived(
		pressure === 'error' ? 'At the limit' : pressure === 'warning' ? 'Running low' : null
	);

	const headline = $derived.by(() => {
		if (unlimited) return format(used);
		if (available === null) return format(used);
		return format(Math.max(0, available));
	});

	const caption = $derived(
		unlimited
			? 'No limit set, so nothing here will block a deploy'
			: `${format(used)} of ${format(limit as number)} in use`
	);
</script>

<div class="bm" {@attach motionStagger({ index, from: { y: 6, opacity: 0 } })}>
	<span class="bm-label">{label}</span>

	<div class="bm-value-row">
		<span class="bm-value">{headline}</span>
		{#if !unlimited && available !== null}
			<span class="bm-value-suffix">left to assign</span>
		{/if}
	</div>

	{#if unlimited}
		<p class="bm-caption">{caption}</p>
	{:else}
		<div class="bm-track" role="presentation">
			<div class="bm-fill bm-fill--{pressure}" style="--ratio: {ratio}"></div>
		</div>
		<div class="bm-foot">
			<span class="bm-caption">{caption}</span>
			<span class="bm-pct bm-pct--{pressure}">
				{#if pressureLabel}<span class="bm-dot"></span>{pressureLabel} &middot;
				{/if}{percent}%
			</span>
		</div>
	{/if}
</div>

<style>
	.bm {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.bm-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.bm-value-row {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		flex-wrap: wrap;
	}
	.bm-value {
		font-size: 1.75rem;
		line-height: 1.15;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
	}
	.bm-value-suffix {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.bm-track {
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background-color: var(--bg-sunken);
		overflow: hidden;
		margin-top: 0.125rem;
	}
	.bm-fill {
		height: 100%;
		width: calc(var(--ratio) * 100%);
		min-width: 0;
		border-radius: var(--radius-pill);
	}
	.bm-fill--ok {
		background-color: var(--accent);
	}
	.bm-fill--warning {
		background-color: var(--status-warning);
	}
	.bm-fill--error {
		background-color: var(--status-error);
	}
	.bm-foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.bm-caption {
		font-size: var(--text-micro);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.bm-pct {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-micro);
		line-height: var(--lh-caption);
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}
	.bm-pct--warning {
		color: var(--status-warning);
	}
	.bm-pct--error {
		color: var(--status-error);
	}
	.bm-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background-color: currentColor;
	}
</style>
