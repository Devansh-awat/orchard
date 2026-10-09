<script lang="ts">
	import { decorativeMotion } from '$lib/utils/motion.svelte';

	let { playing = true }: { playing?: boolean } = $props();

	const FRAMES = [
		['.......', '.......', '.......', '.......', '.......', '.......', '..eee..'],
		['.......', '.......', '.......', '.......', '.......', '...g...', '..ese..'],
		['.......', '.......', '.......', '...g...', '..gsg..', '...s...', '..ese..'],
		['...g...', '..gsg..', '...s...', '.ggsgg.', '...s...', '...s...', '..ese..'],
		['....g..', '...sgg.', '...s...', '.ggsgg.', '...s...', '...s...', '..ese..'],
		['..g....', '.ggs...', '...s...', '.ggsgg.', '...s...', '...s...', '..ese..']
	];

	const GROW = [0, 1, 2, 3];
	const SWAY = [4, 3, 5, 3];
	const TICK_MS = 280;
	const REST = 3;

	let tick = $state(0);

	const moving = $derived(playing && decorativeMotion());

	$effect(() => {
		if (!moving) return;
		tick = 0;
		const timer = setInterval(() => (tick += 1), TICK_MS);
		return () => clearInterval(timer);
	});

	const frame = $derived(
		FRAMES[
			!moving ? REST : tick < GROW.length ? GROW[tick] : SWAY[(tick - GROW.length) % SWAY.length]
		]
	);
</script>

<span class="sprout" aria-hidden="true">
	{#each frame as row, y (y)}
		{#each row.split('') as cell, x (x)}
			<span class="px px--{cell === '.' ? 'off' : cell}"></span>
		{/each}
	{/each}
</span>

<style>
	.sprout {
		--px: 0.125rem;
		display: inline-grid;
		grid-template-columns: repeat(7, var(--px));
		grid-auto-rows: var(--px);
		flex-shrink: 0;
		image-rendering: pixelated;
	}

	.px--off {
		background: transparent;
	}

	.px--g {
		background: var(--status-success);
	}

	.px--s {
		background: color-mix(in oklab, var(--status-success) 65%, var(--text-default));
	}

	.px--e {
		background: color-mix(in oklab, var(--accent) 55%, var(--text-muted));
	}
</style>
