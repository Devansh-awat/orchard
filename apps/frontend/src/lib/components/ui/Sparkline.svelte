<script lang="ts">
	import { SpringValue, decorativeMotion } from '$lib/utils/motion.svelte';
	import { SPARK_SLACK, sparkSweep } from './cardMotion.svelte';

	let {
		values,
		tone = 'accent',
		height = 32,
		label = undefined,
		interactive = false,
		onScrub = undefined
	}: {
		values: number[];
		tone?: 'accent' | 'success' | 'warning' | 'error' | 'neutral';
		height?: number;
		label?: string;
		interactive?: boolean;
		onScrub?: (index: number | null) => void;
	} = $props();

	const id = $props.id();
	const W = 100;
	const H = 40;

	const points = $derived.by(() => {
		if (values.length < 2) return [] as [number, number][];
		const min = Math.min(...values);
		const max = Math.max(...values);
		const span = max - min || 1;
		return values.map(
			(v, i) =>
				[(i / (values.length - 1)) * W, H - 3 - ((v - min) / span) * (H - 6)] as [number, number]
		);
	});
	const line = $derived(points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' '));
	const area = $derived(points.length ? `${line} L${W},${H} L0,${H} Z` : '');

	let width = $state(0);
	let index = $state<number | null>(null);
	const x = new SpringValue(0);
	const y = new SpringValue(0);
	let snap = false;

	const lit = $derived(width > 0 && (index !== null || x.current < width - 0.5));

	$effect(() => {
		if (index === null) return;
		const p = points[index];
		if (!p) return;
		const instant = snap || !decorativeMotion();
		snap = false;
		x.to((p[0] / W) * width, 'glide', { instant });
		y.to((p[1] / H) * height, 'glide', { instant });
	});

	function scrub(ev: PointerEvent) {
		if (ev.pointerType === 'touch' || points.length < 2) return;
		const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
		const t = Math.min(Math.max((ev.clientX - box.left) / box.width, 0), 1);
		const next = Math.round(t * (points.length - 1));
		if (next === index) return;
		if (index === null) {
			snap = true;
			width = box.width;
		}
		index = next;
		onScrub?.(next);
	}

	function release() {
		if (index === null) return;
		index = null;
		onScrub?.(null);
		x.to(width, 'glide', { instant: !decorativeMotion() });
	}
</script>

{#snippet art(lit: boolean)}
	<svg data-art viewBox="0 0 {W} {H}" preserveAspectRatio="none">
		{#if !lit}
			<defs>
				<linearGradient id="fill-{id}" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="currentColor" stop-opacity="0.18" />
					<stop offset="100%" stop-color="currentColor" stop-opacity="0" />
				</linearGradient>
			</defs>
			<path data-fill d={area} fill="url(#fill-{id})" />
		{/if}
		<path
			d={line}
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linejoin="round"
			stroke-linecap="round"
			vector-effect="non-scaling-stroke"
		/>
	</svg>
{/snippet}

<span
	class="spark spark--{tone}"
	class:spark--dim={lit}
	style:height="{height}px"
	style:--slack="{SPARK_SLACK}px"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	onpointermove={interactive ? scrub : undefined}
	onpointerleave={interactive ? release : undefined}
>
	<span class="pane pane--base" {@attach sparkSweep}>{@render art(false)}</span>
	{#if interactive}
		{#if lit}
			<span class="pane pane--lit" style:transform="translateX({x.current - width}px)">
				<span class="lit-art" style:transform="translateX({width - x.current}px)"
					>{@render art(true)}</span
				>
			</span>
		{/if}
		<span
			class="scrub"
			class:scrub--on={index !== null}
			style:transform="translateX({x.current}px)"
		>
			<span class="knob" style:transform="translateY({y.current}px)"></span>
		</span>
	{/if}
</span>

<style>
	.spark {
		--spark-color: var(--accent-7);
		position: relative;
		display: block;
		width: 100%;
		color: var(--spark-color);
	}
	.spark--success {
		--spark-color: var(--green-7);
	}
	.spark--warning {
		--spark-color: var(--amber-7);
	}
	.spark--error {
		--spark-color: var(--red-7);
	}
	.spark--neutral {
		--spark-color: var(--neutral-7);
	}
	.pane {
		position: absolute;
		inset: calc(var(--slack) * -1);
		padding: var(--slack);
		overflow: clip;
		pointer-events: none;
	}
	.pane svg,
	.lit-art {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.spark--dim .pane--base {
		color: color-mix(in oklab, var(--spark-color) 32%, var(--spark-ground, var(--bg-raised)));
	}
	.scrub {
		position: absolute;
		top: -2px;
		bottom: -2px;
		left: -0.5px;
		width: 1px;
		background: color-mix(in oklab, var(--spark-color) 45%, transparent);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--dur-fast) ease;
	}
	.scrub--on {
		opacity: 1;
	}
	.knob {
		position: absolute;
		top: -0.5px;
		left: -2px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--spark-color);
		box-shadow: 0 0 0 1.5px var(--spark-ground, var(--bg-raised));
	}
</style>
