<script lang="ts">
	import { onMount } from 'svelte';
	import {
		MARK_CENTER,
		MARK_INNER,
		MARK_OUTLINE,
		MARK_VIEWBOX,
		PETAL_RADIUS,
		PETALS
	} from '$lib/mark';
	import { prefersReduced } from '$lib/motion.svelte';

	let { secret = $bindable(false), class: className = '' }: { secret?: boolean; class?: string } =
		$props();

	const IMPULSE = 620;
	const TOP = 3600;
	const REVEAL = 1800;
	const FLING = 7;

	const directions = PETALS.map((p) => {
		const x = p.cx - MARK_CENTER;
		const y = p.cy - MARK_CENTER;
		const length = Math.hypot(x, y) || 1;
		return { x: x / length, y: y / length };
	});

	let angle = $state(0);
	let omega = $state(0);
	let raf = 0;
	let last = 0;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	const fling = $derived(FLING * Math.pow(Math.min(1, omega / TOP), 1.5));
	const rpm = $derived(Math.round(omega / 6));

	function frame(now: number) {
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		angle = (angle + omega * dt) % 360;
		omega *= Math.exp(-0.85 * dt);
		if (omega > REVEAL && !secret) {
			secret = true;
			clearTimeout(hideTimer);
		}
		if (omega < 6) {
			omega = 0;
			raf = 0;
			if (secret) hideTimer = setTimeout(() => (secret = false), 5000);
			return;
		}
		raf = requestAnimationFrame(frame);
	}

	function spin() {
		if (prefersReduced()) {
			secret = !secret;
			return;
		}
		clearTimeout(hideTimer);
		omega = Math.min(TOP, omega + IMPULSE);
		if (!raf) {
			last = performance.now();
			raf = requestAnimationFrame(frame);
		}
	}

	onMount(() => () => {
		cancelAnimationFrame(raf);
		clearTimeout(hideTimer);
	});
</script>

<button
	type="button"
	onclick={spin}
	aria-label="Spin the orchard"
	class="spin-mark group relative block rounded-full {className}"
	class:spinning={omega > 0}
>
	<svg viewBox={MARK_VIEWBOX} class="hint size-full overflow-visible" aria-hidden="true">
		<g
			style:transform="rotate({angle}deg)"
			style:transform-origin="{MARK_CENTER}px {MARK_CENTER}px"
		>
			<path
				d="{MARK_OUTLINE} {MARK_INNER}"
				fill="none"
				stroke="#fff"
				stroke-width="1.15"
				stroke-linejoin="round"
			/>
			{#each PETALS as petal, i (i)}
				<circle
					cx={petal.cx + directions[i].x * fling}
					cy={petal.cy + directions[i].y * fling}
					r={PETAL_RADIUS}
					fill="none"
					stroke="#fff"
					stroke-width="1.15"
				/>
			{/each}
		</g>
	</svg>
	<span
		class="readout pointer-events-none absolute top-full left-1/2 mt-2 -translate-x-1/2 font-mono text-[11px] whitespace-nowrap text-white tabular-nums"
		class:readout-on={omega > 120}
		aria-hidden="true"
	>
		{rpm} rpm
	</span>
</button>

<style>
	.spin-mark {
		cursor: pointer;
	}

	.spin-mark:focus-visible {
		outline: 3px solid var(--color-cream);
		outline-offset: 6px;
	}

	.hint {
		transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.spin-mark:not(.spinning):hover .hint {
		transform: rotate(-14deg) scale(1.04);
	}

	.readout {
		opacity: 0;
		transition: opacity 0.3s ease;
	}

	.readout-on {
		opacity: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.hint,
		.readout {
			transition: none;
		}

		.spin-mark:not(.spinning):hover .hint {
			transform: none;
		}
	}
</style>
