<script lang="ts">
	import { untrack } from 'svelte';
	import { decorativeMotion } from '$lib/utils/motion.svelte';
	import type { SandboxBoot, SandboxBootPhase, SandboxStatus } from '$lib/types/sandbox';
	import { fmtElapsed } from '$lib/components/sandbox/chat/steps';

	let {
		boot = null,
		status,
		sandboxId = null
	}: { boot?: SandboxBoot | null; status: SandboxStatus; sandboxId?: string | null } = $props();

	const PHASES: SandboxBootPhase[] = [
		'starting',
		'packages',
		'runtime',
		'agents',
		'storage',
		'account',
		'services',
		'ready'
	];
	const STEPS = PHASES.length - 1;
	const startedAt = Date.now();
	const memoryKey = $derived(sandboxId ? `gh-boot-ms:${sandboxId}` : null);

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const waking = $derived(status !== 'stopping' && status !== 'deleting');
	const step = $derived(boot ? Math.max(0, PHASES.indexOf(boot.phase)) : 0);
	const elapsed = $derived(fmtElapsed(now - startedAt));
	const usual = $derived.by(() => {
		if (!memoryKey) return null;
		const stored = Number(localStorage.getItem(memoryKey));
		return Number.isFinite(stored) && stored > 0 ? fmtElapsed(stored) : null;
	});

	const meta = $derived(
		[
			boot ? `Step ${Math.min(step + 1, STEPS)} of ${STEPS}` : null,
			elapsed,
			usual ? `last time ${usual}` : null
		]
			.filter(Boolean)
			.join(' · ')
	);

	let remembered = false;
	$effect(() => {
		if (!boot?.ready || !waking || remembered || !memoryKey) return;
		remembered = true;
		const key = memoryKey;
		untrack(() => localStorage.setItem(key, String(Date.now() - startedAt)));
	});

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
	{#if waking && boot}
		<div
			class="meter"
			role="progressbar"
			aria-label="Boot progress"
			aria-valuemin={0}
			aria-valuemax={STEPS}
			aria-valuenow={step}
		>
			<span class="meter-fill" style="width: {(step / STEPS) * 100}%"></span>
		</div>
		<p class="meta" aria-hidden="true">{meta}</p>
	{:else if waking}
		<p class="meta" aria-hidden="true">{meta}</p>
	{/if}
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

	.meter {
		width: 12rem;
		height: 0.25rem;
		margin-top: 0.75rem;
		border-radius: 999px;
		background: var(--fill-soft);
		overflow: hidden;
	}

	.meter-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--text-muted);
	}

	.meta {
		margin: 0.25rem 0 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}

	.detail {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}
</style>
