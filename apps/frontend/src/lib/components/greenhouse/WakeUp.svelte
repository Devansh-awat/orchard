<script lang="ts">
	import { decorativeMotion } from '$lib/utils/motion.svelte';
	import type { SandboxBoot, SandboxStatus } from '$lib/types/sandbox';

	let { boot = null, status }: { boot?: SandboxBoot | null; status: SandboxStatus } = $props();

	const POT = ['rrrrrrrrr', '.ppppppp.', '.ppppppp.', '..ppppp..'];

	const PLANTS = [
		['.........', '.........', '.........', '.........', '.........', '...eee...'],
		['.........', '.........', '.........', '.........', '....g....', '...ese...'],
		['.........', '.........', '....g....', '...gsg...', '....s....', '...ese...'],
		['....g....', '...gsg...', '....s....', '..ggsgg..', '..g.s.g..', '...ese...'],
		['.....g...', '....sgg..', '....s....', '..ggsgg..', '.g..s..g.', '...ese...'],
		['...g.....', '..ggs....', '....s....', '..ggsgg..', '..g.s.g..', '...ese...']
	];

	const SEQUENCE = [0, 1, 2, 3, 4, 3, 5, 3, 4, 3, 5, 3];
	const TICK_MS = 260;

	let tick = $state(0);

	$effect(() => {
		if (!decorativeMotion()) return;
		const timer = setInterval(() => (tick = (tick + 1) % SEQUENCE.length), TICK_MS);
		return () => clearInterval(timer);
	});

	const frame = $derived([...PLANTS[decorativeMotion() ? SEQUENCE[tick] : 3], ...POT]);

	const title = $derived(
		status === 'stopping'
			? 'Putting the sandbox to sleep'
			: status === 'deleting'
				? 'Deleting the sandbox'
				: 'Waking up the sandbox'
	);

	const detail = $derived(boot?.ready ? 'Almost there' : (boot?.label?.trim() ?? ''));
</script>

<div class="wake" role="status" aria-live="polite">
	<div class="art" aria-hidden="true">
		{#each frame as row, y (y)}
			{#each row.split('') as cell, x (x)}
				<span class="px px--{cell === '.' ? 'off' : cell}"></span>
			{/each}
		{/each}
	</div>
	<p class="title">{title}</p>
	{#if detail}<p class="detail">{detail}</p>{/if}
</div>

<style>
	.wake {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		text-align: center;
	}

	.art {
		--px: 0.4375rem;
		display: grid;
		grid-template-columns: repeat(9, var(--px));
		grid-auto-rows: var(--px);
		margin-bottom: 1rem;
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
		background: color-mix(in oklab, var(--accent) 40%, black);
	}

	.px--r {
		background: color-mix(in oklab, var(--accent) 75%, var(--text-default));
	}

	.px--p {
		background: var(--accent);
	}

	.title {
		margin: 0;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		font-weight: 600;
		color: var(--gh-text);
	}

	.detail {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}
</style>
