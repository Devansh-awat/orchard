<script lang="ts">
	interface Row {
		label: string;
		sublabel?: string;
		value: number;
		/** Optional secondary value drawn as a darker fill inside the same row (e.g. "actual" within "requested"). */
		fillValue?: number;
		color?: string;
		fillColor?: string;
	}

	interface Props {
		rows: Row[];
		/** Max value used to scale all bars. If not provided, uses the largest row value. */
		max?: number | null;
		formatValue?: (n: number) => string;
		emptyLabel?: string;
	}

	let {
		rows,
		max = null,
		formatValue = (n) => String(n),
		emptyLabel = 'No data',
	}: Props = $props();

	const computedMax = $derived(max ?? Math.max(1, ...rows.map((r) => r.value)));

	function pctOf(v: number, m: number): number {
		if (!m || m <= 0) return 0;
		return Math.min(100, Math.max(0, (v / m) * 100));
	}
</script>

<div class="hbars">
	{#if rows.length === 0}
		<div class="hbars-empty">{emptyLabel}</div>
	{:else}
		{#each rows as r, i (i)}
			<div class="hbar-row">
				<div class="hbar-meta">
					<div class="hbar-label" title={r.label}>{r.label}</div>
					{#if r.sublabel}
						<div class="hbar-sublabel">{r.sublabel}</div>
					{/if}
				</div>
				<div class="hbar-track">
					<div
						class="hbar-fill"
						style="width: {pctOf(r.value, computedMax)}%; background-color: {r.color ?? 'var(--button-bg)'};"
					>
						{#if r.fillValue !== undefined}
							<div
								class="hbar-inner"
								style="width: {pctOf(r.fillValue, r.value)}%; background-color: {r.fillColor ?? 'color-mix(in srgb, var(--center-channel-color) 35%, transparent)'};"
							></div>
						{/if}
					</div>
				</div>
				<div class="hbar-value">{formatValue(r.value)}</div>
			</div>
		{/each}
	{/if}
</div>

<style>
	.hbars {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.hbars-empty {
		padding: 1.5rem 0;
		text-align: center;
		color: var(--surface-muted);
		font-size: 0.8125rem;
	}
	.hbar-row {
		display: grid;
		grid-template-columns: minmax(8rem, 14rem) 1fr auto;
		align-items: center;
		gap: 0.75rem;
	}
	.hbar-meta {
		min-width: 0;
	}
	.hbar-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hbar-sublabel {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.hbar-track {
		height: 0.625rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		border-radius: 999px;
		overflow: hidden;
		position: relative;
	}
	.hbar-fill {
		height: 100%;
		border-radius: 999px;
		position: relative;
		animation: hbar-grow 500ms cubic-bezier(0.22, 1, 0.36, 1) both;
		transition: width 250ms ease;
	}
	.hbar-inner {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		border-radius: 999px 0 0 999px;
	}
	@keyframes hbar-grow {
		from { width: 0 !important; }
	}
	.hbar-value {
		font-size: 0.75rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--center-channel-color);
		min-width: 4rem;
		text-align: right;
	}
</style>
