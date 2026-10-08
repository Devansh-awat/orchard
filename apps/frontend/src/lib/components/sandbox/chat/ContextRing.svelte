<script lang="ts">
	import { ocFmtTokens } from '../opencode';
	import type { ContextMeter } from './session-store.svelte';

	let { meter }: { meter: ContextMeter } = $props();

	const R = 7;
	const C = 2 * Math.PI * R;
	const tone = $derived(meter.pct >= 90 ? 'error' : meter.pct >= 75 ? 'warning' : 'neutral');
	const label = $derived(
		meter.limit ? `${Math.round(meter.pct)}%` : meter.used > 0 ? ocFmtTokens(meter.used) : '0%'
	);
	const title = $derived(
		meter.used > 0
			? `${ocFmtTokens(meter.used)}${meter.limit ? ` of ${ocFmtTokens(meter.limit)}` : ''} context used\n${meter.tooltip}`
			: 'No context used yet'
	);
</script>

<span
	class="ctx ctx--{tone}"
	{title}
	role="meter"
	aria-label="Context used"
	aria-valuenow={Math.round(meter.pct)}
	aria-valuemin={0}
	aria-valuemax={100}
>
	<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
		<circle class="ctx-track" cx="9" cy="9" r={R} />
		<circle
			class="ctx-fill"
			cx="9"
			cy="9"
			r={R}
			stroke-dasharray={C}
			stroke-dashoffset={C * (1 - meter.pct / 100)}
		/>
	</svg>
	<span class="ctx-label">{label}</span>
</span>

<style>
	.ctx {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0 0.25rem;
		color: var(--text-faint);
	}

	.ctx-track {
		fill: none;
		stroke: var(--fill-medium);
		stroke-width: 2.25;
	}

	.ctx-fill {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 2.25;
		stroke-linecap: round;
		transform: rotate(-90deg);
		transform-origin: 50% 50%;
	}

	.ctx--warning .ctx-fill {
		stroke: var(--status-warning);
	}

	.ctx--error .ctx-fill {
		stroke: var(--status-error);
	}

	.ctx--warning {
		color: var(--status-warning);
	}

	.ctx--error {
		color: var(--status-error);
	}

	.ctx-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-variant-numeric: tabular-nums;
	}
</style>
