<script lang="ts">
	import { Minus, Plus } from 'lucide-svelte';

	let {
		value = $bindable(1),
		min = 1,
		max = 99
	}: {
		value?: number;
		min?: number;
		max?: number;
	} = $props();

	function clamp(n: number): number {
		if (!Number.isFinite(n)) return min;
		return Math.min(max, Math.max(min, Math.round(n)));
	}
</script>

<div class="stepper">
	<button
		type="button"
		class="stepper-btn"
		aria-label="Decrease"
		disabled={value <= min}
		onclick={() => (value = clamp(value - 1))}
	>
		<Minus size={13} />
	</button>
	<input
		type="number"
		class="stepper-input"
		inputmode="numeric"
		bind:value
		{min}
		{max}
		onblur={() => (value = clamp(value))}
	/>
	<button
		type="button"
		class="stepper-btn"
		aria-label="Increase"
		disabled={value >= max}
		onclick={() => (value = clamp(value + 1))}
	>
		<Plus size={13} />
	</button>
</div>

<style>
	.stepper {
		display: inline-flex;
		align-items: stretch;
		height: 2rem;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--bg-raised);
		overflow: hidden;
	}

	.stepper-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.stepper-btn:hover:not(:disabled) {
		background: var(--accent-subtle);
		color: var(--text-default);
	}

	.stepper-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.stepper-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.stepper-input {
		width: 2.75rem;
		border: none;
		border-left: 1px solid var(--border-default);
		border-right: 1px solid var(--border-default);
		background: transparent;
		color: var(--text-default);
		font-size: 0.8125rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		text-align: center;
		appearance: textfield;
		-moz-appearance: textfield;
	}

	.stepper-input::-webkit-outer-spin-button,
	.stepper-input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.stepper-input:focus {
		outline: none;
		background: var(--accent-subtle);
	}
</style>
