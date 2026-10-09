<script lang="ts">
	import { decorativeMotion } from '$lib/utils/motion.svelte';
	import { GRID, POSES, REST, TICK_MS, draw, type PipPose } from './pip';

	let {
		pose = 'idle',
		size = 54,
		playing = true,
		label = null
	}: {
		pose?: PipPose;
		size?: number;
		playing?: boolean;
		label?: string | null;
	} = $props();

	let tick = $state(0);

	const moving = $derived(playing && decorativeMotion());

	$effect(() => {
		if (!moving) return;
		void pose;
		tick = 0;
		const timer = setInterval(() => (tick += 1), TICK_MS);
		return () => clearInterval(timer);
	});

	const frame = $derived(moving ? POSES[pose][tick % POSES[pose].length] : REST[pose]);
	const runs = $derived(draw(frame));
</script>

<svg
	class="mascot"
	viewBox="0 0 {GRID} {GRID}"
	width={size}
	height={size}
	shape-rendering="crispEdges"
	role={label ? 'img' : undefined}
	aria-label={label ?? undefined}
	aria-hidden={label ? undefined : 'true'}
>
	{#each runs as r (`${r.x}:${r.y}`)}
		<rect class="c c--{r.cell}" x={r.x} y={r.y} width={r.w} height="1" />
	{/each}
</svg>

<style>
	.mascot {
		display: block;
		flex: none;
		overflow: visible;
	}

	.c--B {
		fill: var(--accent);
	}

	.c--L {
		fill: color-mix(in oklab, var(--accent) 55%, white);
	}

	.c--D {
		fill: color-mix(in oklab, var(--accent) 70%, black);
	}

	.c--W {
		fill: color-mix(in oklab, white 94%, var(--accent));
	}

	.c--E {
		fill: color-mix(in oklab, var(--accent) 18%, black);
	}

	.c--C {
		fill: color-mix(in oklab, var(--accent) 45%, white);
	}

	.c--Y {
		fill: var(--hue-amber);
	}
</style>
