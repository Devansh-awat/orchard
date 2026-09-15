<script lang="ts">
	let { value = 0, onchange }: { value?: number; onchange: (value: number) => void } = $props();

	const DOTS = 18;
	const SWEEP = 280;
	const START = 130;

	const dots = Array.from({ length: DOTS }, (_, i) => {
		const angle = (START + (i / (DOTS - 1)) * SWEEP) * (Math.PI / 180);
		return {
			fraction: i / (DOTS - 1),
			x: 50 + Math.cos(angle) * 46,
			y: 50 + Math.sin(angle) * 46
		};
	});

	let dragging = $state(false);

	function clamp(next: number) {
		return Math.min(1, Math.max(0, next));
	}

	function startDrag(event: PointerEvent) {
		if (event.button !== 0) return;
		const originY = event.clientY;
		const base = value;
		dragging = true;

		const move = (moveEvent: PointerEvent) => {
			onchange(clamp(base + (originY - moveEvent.clientY) / 140));
		};
		const end = () => {
			dragging = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
			window.removeEventListener('pointercancel', end);
		};

		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end);
		window.addEventListener('pointercancel', end);
	}

	function onKey(event: KeyboardEvent) {
		const step = event.shiftKey ? 0.2 : 0.05;
		if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onchange(clamp(value + step));
		else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onchange(clamp(value - step));
		else if (event.key === 'Home') onchange(0);
		else if (event.key === 'End') onchange(1);
		else return;
		event.preventDefault();
	}
</script>

<div class="dial-wrap">
	<span class="dial-label">Grain</span>
	<div
		class="dial"
		class:dial--active={dragging}
		role="slider"
		tabindex="0"
		aria-label="Grain"
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={Math.round(value * 100)}
		aria-valuetext="{Math.round(value * 100)} percent"
		onpointerdown={startDrag}
		onkeydown={onKey}
	>
		<svg viewBox="0 0 100 100" aria-hidden="true">
			{#each dots as dot (dot.fraction)}
				<circle
					cx={dot.x}
					cy={dot.y}
					r={dot.fraction <= value ? 3.2 : 2.2}
					class={dot.fraction <= value && value > 0 ? 'dial-dot dial-dot--on' : 'dial-dot'}
				/>
			{/each}
		</svg>
		<span class="dial-core" style="--grain-preview: {0.18 + value * 0.72};"></span>
	</div>
</div>

<style>
	.dial-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.375rem;
	}

	.dial-label {
		font-size: var(--text-caption);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.dial {
		position: relative;
		width: 3.5rem;
		height: 3.5rem;
		cursor: ns-resize;
		touch-action: none;
	}

	.dial:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring-color);
		outline-offset: var(--focus-ring-offset);
		border-radius: 50%;
	}

	.dial svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.dial-dot {
		fill: var(--fill-medium);
		transition: fill var(--dur-fast) ease;
	}

	.dial-dot--on {
		fill: var(--accent);
	}

	.dial-core {
		position: absolute;
		inset: 22%;
		border-radius: 50%;
		background-color: var(--fill-medium);
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Cfilter id='d' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.45' numOctaves='1' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='80' height='80' filter='url(%23d)'/%3E%3C/svg%3E");
		background-size: 40px 40px;
		opacity: var(--grain-preview, 0.2);
		box-shadow: inset 0 0 0 1px var(--rule);
	}

	.dial--active .dial-core {
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}
</style>
