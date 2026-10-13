<script lang="ts">
	import { untrack } from 'svelte';
	import Pip from './mascot/Pip.svelte';
	import type { SandboxBoot, SandboxBootPhase, SandboxStatus } from '../../lib/types/sandbox';
	import { fmtElapsed } from '../sandbox/chat/steps';

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

	const pose = $derived(
		status === 'stopping' ? 'sleep' : !waking ? 'idle' : boot?.ready ? 'happy' : 'thinking'
	);

	const title = $derived(
		status === 'stopping'
			? 'Putting the machine to sleep'
			: status === 'deleting'
				? 'Deleting the machine'
				: 'Waking up the machine'
	);

	const detail = $derived(boot?.ready ? 'Almost there' : (boot?.label?.trim() ?? ''));
</script>

<div class="wake" role="status" aria-live="polite">
	<span class="art" aria-hidden="true"><Pip {pose} size={72} /></span>
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
		display: inline-grid;
		place-items: center;
		margin-bottom: 0.75rem;
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
