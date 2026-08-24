<script lang="ts">
	let {
		value = $bindable(1),
		min = 0,
		max = 10,
		step = 1,
		label,
		disabled = false,
		ticks = false,
		onchange = undefined
	}: {
		value: number;
		min?: number;
		max?: number;
		step?: number;
		label: string;
		disabled?: boolean;
		ticks?: boolean;
		onchange?: (value: number) => void;
	} = $props();

	let trackEl = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);
	let dragStartValue = $state(value);

	const span = $derived(Math.max(1, max - min));
	const percent = $derived(((clamp(value) - min) / span) * 100);
	const tickValues = $derived(
		ticks && span / step <= 20
			? Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => min + i * step)
			: []
	);

	function clamp(next: number) {
		return Math.min(max, Math.max(min, next));
	}

	function commit(next: number) {
		const snapped = clamp(min + Math.round((next - min) / step) * step);
		if (snapped === value) return;
		value = snapped;
		onchange?.(snapped);
	}

	function valueAt(clientX: number) {
		if (!trackEl) return value;
		const rect = trackEl.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		return min + ratio * span;
	}

	function onPointerDown(event: PointerEvent) {
		if (disabled || !trackEl) return;
		dragging = true;
		dragStartValue = value;
		trackEl.setPointerCapture(event.pointerId);
		commit(valueAt(event.clientX));
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging) return;
		commit(valueAt(event.clientX));
	}

	function onPointerUp(event: PointerEvent) {
		if (!dragging || !trackEl) return;
		dragging = false;
		trackEl.releasePointerCapture(event.pointerId);
	}

	function onPointerCancel(event: PointerEvent) {
		if (!dragging || !trackEl) return;
		dragging = false;
		trackEl.releasePointerCapture(event.pointerId);
		commit(dragStartValue);
	}

	function onKeyDown(event: KeyboardEvent) {
		if (disabled) return;
		const keys: Record<string, number> = {
			ArrowRight: step,
			ArrowUp: step,
			ArrowLeft: -step,
			ArrowDown: -step,
			PageUp: step * 5,
			PageDown: -step * 5
		};
		if (event.key === 'Home') {
			event.preventDefault();
			commit(min);
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			commit(max);
			return;
		}
		const delta = keys[event.key];
		if (delta === undefined) return;
		event.preventDefault();
		commit(value + delta);
	}
</script>

<div class="ui-slider" class:ui-slider--disabled={disabled}>
	<div
		bind:this={trackEl}
		class="ui-slider-hit"
		class:ui-slider-hit--dragging={dragging}
		role="slider"
		tabindex={disabled ? -1 : 0}
		aria-label={label}
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={value}
		aria-disabled={disabled}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerCancel}
		onkeydown={onKeyDown}
	>
		<div class="ui-slider-track">
			<div class="ui-slider-fill" style="width: {percent}%;"></div>
		</div>
		{#each tickValues as tick (tick)}
			<span
				class="ui-slider-tick"
				class:ui-slider-tick--filled={tick <= value}
				style="left: {((tick - min) / span) * 100}%;"
			></span>
		{/each}
		<div
			class="ui-slider-thumb"
			class:ui-slider-thumb--dragging={dragging}
			style="left: {percent}%;"
		></div>
	</div>
</div>

<style>
	.ui-slider {
		width: 100%;
	}

	.ui-slider-hit {
		position: relative;
		width: 100%;
		height: 2rem;
		cursor: pointer;
		outline: none;
		touch-action: none;
		user-select: none;
	}

	.ui-slider--disabled .ui-slider-hit {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.ui-slider-track {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 0.375rem;
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-pill);
		transform: translateY(-50%);
		overflow: hidden;
	}

	.ui-slider-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background-color: var(--accent);
		border-radius: var(--radius-pill);
		transition: width var(--dur-fast) ease;
	}

	.ui-slider-hit--dragging .ui-slider-fill {
		transition: none;
	}

	.ui-slider-tick {
		position: absolute;
		top: 50%;
		width: 0.1875rem;
		height: 0.1875rem;
		border-radius: 50%;
		background-color: var(--border-strong);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	.ui-slider-tick--filled {
		background-color: var(--text-on-accent);
		opacity: 0.7;
	}

	.ui-slider-thumb {
		position: absolute;
		top: 50%;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 50%;
		background-color: var(--bg-app);
		border: 2px solid var(--accent);
		box-shadow: var(--elev-2);
		transform: translate(-50%, -50%);
		pointer-events: none;
		transition:
			transform var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease,
			left var(--dur-fast) ease;
	}

	.ui-slider-hit:hover .ui-slider-thumb {
		transform: translate(-50%, -50%) scale(1.1);
		box-shadow: var(--elev-3);
	}

	.ui-slider-thumb--dragging {
		transform: translate(-50%, -50%) scale(1.15);
		box-shadow: var(--elev-4);
		transition: none;
	}

	.ui-slider-hit:focus-visible .ui-slider-thumb {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
