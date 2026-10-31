<script lang="ts" module>
	export type DotStep = 'done' | 'active' | 'failed' | 'pending';
</script>

<script lang="ts">
	import { decorativeMotion } from '$lib/utils/motion.svelte';
	import type { StatusMeta } from './status';

	let {
		meta,
		size = 8,
		tone = undefined,
		steps = undefined,
		orbit = undefined,
		label = undefined
	}: {
		meta: StatusMeta;
		size?: number;
		tone?: 'deploy';
		steps?: DotStep[];
		orbit?: number;
		label?: string;
	} = $props();

	const R = 10;
	const C = 2 * Math.PI * R;
	const SPAN = 270;
	const GAP = 26;
	const CAP = 1.4;

	const live = $derived(!!meta.pulse || !!steps?.length);
	const mode = $derived(steps?.length ? 'gauge' : 'spin');
	let wasLive = $state(false);
	let settling = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const now = live;
		if (wasLive && !now && decorativeMotion()) {
			settling = true;
			clearTimeout(timer);
			timer = setTimeout(() => (settling = false), 520);
		}
		if (now) settling = false;
		wasLive = now;
		return () => clearTimeout(timer);
	});

	const ring = $derived(live || settling);
	const kind = $derived(tone ?? meta.kind);

	const arcs = $derived.by(() => {
		const list = steps ?? [];
		const n = list.length;
		if (!n) return [];
		const each = (SPAN - GAP * (n - 1)) / n;
		return list.map((state, i) => {
			const start = 135 + i * (each + GAP) + (CAP / C) * 360;
			const len = Math.max(0.6, (each / 360) * C - CAP * 2);
			return { state, start, len, i };
		});
	});
</script>

<span
	class="dot dot--{kind}"
	class:dot--live={live}
	class:dot--settle={settling}
	style:--dot-size="{size}px"
	style:--ring-size={orbit ? `${orbit}px` : undefined}
	data-motion={live ? 'progress' : undefined}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	<span class="core"></span>
	{#if ring}
		<svg class="gauge" viewBox="0 0 24 24" aria-hidden="true">
			<g class="spin-layer" class:layer--off={mode !== 'spin'}>
				<circle class="track" cx="12" cy="12" r={R} />
				<g class="orbit">
					<circle class="arc" cx="12" cy="12" r={R} stroke-dasharray="{C * 0.22} {C}" />
				</g>
			</g>
			<g class="gauge-layer" class:layer--off={mode !== 'gauge'}>
				{#each arcs as a (a.i)}
					<circle
						class="seg seg--{a.state}"
						cx="12"
						cy="12"
						r={R}
						transform="rotate({a.start} 12 12)"
						stroke-dasharray="{a.len} {C}"
						style:--len={a.len}
						style:--i={a.i}
					/>
				{/each}
			</g>
		</svg>
	{/if}
</span>

<style>
	.dot {
		--dot-color: var(--neutral-6);
		position: relative;
		display: inline-grid;
		flex-shrink: 0;
		place-items: center;
		width: var(--dot-size);
		height: var(--dot-size);
	}
	.dot--success {
		--dot-color: var(--status-success-solid);
	}
	.dot--warning {
		--dot-color: var(--status-warning-solid);
	}
	.dot--error {
		--dot-color: var(--status-error-solid);
	}
	.dot--info {
		--dot-color: var(--status-info-solid);
	}
	.dot--progress {
		--dot-color: var(--status-progress-solid);
	}
	.dot--deploy {
		--dot-color: var(--status-deploy-solid);
	}
	.core {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		background: var(--dot-color);
		transition:
			transform var(--spring-pop-duration) var(--spring-pop),
			background-color var(--fade-in) var(--curve-out);
	}
	.dot--settle .core {
		animation: core-land var(--spring-pop-duration) var(--spring-pop);
	}
	.gauge {
		position: absolute;
		top: 50%;
		left: 50%;
		width: var(--ring-size, calc(var(--dot-size) * 2.25));
		height: var(--ring-size, calc(var(--dot-size) * 2.25));
		overflow: visible;
		pointer-events: none;
		translate: -50% -50%;
		transition:
			opacity var(--fade-out) var(--curve-in),
			scale var(--spring-settle-duration) var(--spring-settle);
	}
	.dot--settle .gauge {
		opacity: 0;
		scale: 0.5;
	}
	.spin-layer,
	.gauge-layer {
		transform-origin: 12px 12px;
		transition:
			opacity var(--fade-in) var(--curve-out),
			transform var(--spring-glide-duration) var(--spring-glide);
	}
	.layer--off {
		opacity: 0;
	}
	.spin-layer.layer--off {
		transform: rotate(-90deg) scale(0.8);
	}
	.gauge-layer.layer--off {
		transform: rotate(90deg);
	}
	.track,
	.arc,
	.seg {
		fill: none;
		stroke-width: var(--ring-stroke, 2.8);
		stroke-linecap: round;
	}
	.track {
		stroke: color-mix(in oklab, var(--neutral-8) 28%, transparent);
	}
	.arc {
		stroke: var(--dot-color);
	}
	.orbit {
		transform-origin: 12px 12px;
		animation: orbit 0.95s linear infinite;
	}
	.seg {
		stroke-dashoffset: 0;
		animation: seg-in var(--spring-glide-duration) var(--spring-glide) both;
		animation-delay: calc(var(--i) * 45ms);
	}
	.seg--done {
		stroke: color-mix(in oklab, var(--neutral-9) 70%, transparent);
	}
	.seg--pending {
		stroke: color-mix(in oklab, var(--neutral-8) 30%, transparent);
	}
	.seg--failed {
		stroke: var(--status-error-solid);
	}
	.seg--active {
		stroke: var(--dot-color);
		animation:
			seg-in var(--spring-glide-duration) var(--spring-glide) both,
			seg-pulse 1.2s ease-in-out infinite alternate;
		animation-delay: calc(var(--i) * 45ms), 0ms;
	}
	@keyframes orbit {
		to {
			transform: rotate(1turn);
		}
	}
	@keyframes seg-in {
		from {
			stroke-dashoffset: calc(var(--len) * 1px);
		}
	}
	@keyframes seg-pulse {
		to {
			opacity: 0.45;
		}
	}
	@keyframes core-land {
		45% {
			transform: scale(1.22);
		}
	}
</style>
