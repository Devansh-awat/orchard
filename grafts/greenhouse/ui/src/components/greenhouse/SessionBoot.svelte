<script lang="ts" module>
	export type BootStepState = 'pending' | 'active' | 'done';

	export interface BootStep {
		id: string;
		label: string;
		state: BootStepState;
	}
</script>

<script lang="ts">
	import { GitBranch } from 'lucide-svelte';
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { motionStagger } from '@orchardlabs/graft-ui/utils/motion.svelte';
	import { fmtElapsed } from '../sandbox/chat/steps';
	import Pip from './mascot/Pip.svelte';

	let {
		headline,
		branch = null,
		steps,
		prompt = null,
		startedAt,
		leaving = false
	}: {
		headline: string;
		branch?: string | null;
		steps: BootStep[];
		prompt?: string | null;
		startedAt: number;
		leaving?: boolean;
	} = $props();

	const SLOW_MS = 12_000;
	const SHOW_TIMER_MS = 2_000;

	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(timer);
	});

	const began = new SvelteMap<string, number>();
	const took = new SvelteMap<string, number>();

	$effect(() => {
		const at = Date.now();
		for (const step of steps) {
			untrack(() => {
				if (step.state !== 'pending' && !began.has(step.id)) began.set(step.id, at);
				if (step.state === 'done' && !took.has(step.id)) {
					took.set(step.id, at - (began.get(step.id) ?? startedAt));
				}
			});
		}
	});

	const shown = $derived(
		steps.map((step) => (took.has(step.id) ? { ...step, state: 'done' as const } : step))
	);
	const done = $derived(shown.filter((s) => s.state === 'done').length);
	const progress = $derived(steps.length ? done / steps.length : 0);
	const slow = $derived(!leaving && now - startedAt > SLOW_MS);

	function seconds(ms: number): string {
		return ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : fmtElapsed(ms);
	}
</script>

<div class="boot" class:boot--leaving={leaving} role="status" aria-live="polite">
	<div class="bt-sweep" aria-hidden="true">
		<span class="bt-sweep-fill" style="transform: scaleX({0.08 + progress * 0.92})"></span>
		{#if !leaving}<span class="bt-sweep-shine" data-motion="progress"></span>{/if}
	</div>

	<div class="bt-card">
		<div class="bt-hero" aria-hidden="true">
			<span class="bt-halo" data-motion="progress"></span>
			<Pip pose={leaving ? 'happy' : 'thinking'} size={56} />
		</div>

		<h2 class="bt-headline">{leaving ? 'Ready' : headline}</h2>
		<p class="bt-branch" class:bt-branch--waiting={!branch}>
			<GitBranch size={13} strokeWidth={1.75} />
			<span class="bt-branch-name">{branch ?? 'Naming the branch'}</span>
		</p>

		<ol class="bt-steps">
			{#each shown as step, i (step.id)}
				<li class="bt-step" data-state={step.state} {@attach motionStagger({ index: i, from: { y: 4 } })}>
					<span class="bt-mark" aria-hidden="true">
						{#if step.state === 'done'}
							<svg viewBox="0 0 16 16" class="bt-check">
								<circle cx="8" cy="8" r="7.25" class="bt-check-disc" />
								<path d="M4.75 8.25 7 10.5l4.25-4.75" class="bt-check-tick" />
							</svg>
						{:else if step.state === 'active'}
							<svg viewBox="0 0 16 16" class="bt-ring" data-motion="progress">
								<circle cx="8" cy="8" r="6.5" class="bt-ring-track" />
								<path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" class="bt-ring-arc" />
							</svg>
						{:else}
							<span class="bt-dot"></span>
						{/if}
					</span>
					<span class="bt-label">{step.label}</span>
					<span class="bt-time">
						{#if step.state === 'done' && (took.get(step.id) ?? 0) >= 500}
							{seconds(took.get(step.id) ?? 0)}
						{:else if step.state === 'active' && now - (began.get(step.id) ?? now) > SHOW_TIMER_MS}
							{fmtElapsed(now - (began.get(step.id) ?? now))}
						{/if}
					</span>
					<span class="bt-sr">
						{step.state === 'done' ? 'done' : step.state === 'active' ? 'in progress' : 'waiting'}
					</span>
				</li>
			{/each}
		</ol>

		{#if prompt}
			<figure class="bt-prompt">
				<blockquote class="bt-prompt-text">{prompt}</blockquote>
				<figcaption class="bt-prompt-cap">Sends as soon as the agent is ready</figcaption>
			</figure>
		{/if}

		<p class="bt-slow" class:bt-slow--on={slow}>
			The first session on a big repository can take a minute.
		</p>
	</div>
</div>

<style>
	.boot {
		position: relative;
		display: flex;
		flex: 1;
		min-height: 0;
		align-items: center;
		justify-content: center;
		padding: var(--space-6);
		overflow: hidden;
		background: var(--gh-editor);
		transition: opacity 220ms ease;
	}

	.boot--leaving {
		opacity: 0;
		pointer-events: none;
		transition-delay: 260ms;
	}

	.bt-sweep {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 2px;
		overflow: hidden;
		background: var(--gh-line-soft);
	}

	.bt-sweep-fill {
		position: absolute;
		inset: 0;
		background: var(--gh-accent);
		transform-origin: left center;
		transition: transform 420ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.bt-sweep-shine {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 30%;
		background: linear-gradient(
			90deg,
			transparent,
			color-mix(in srgb, var(--gh-text) 55%, transparent),
			transparent
		);
		opacity: 0.45;
		animation: shine 1.6s ease-in-out infinite;
	}

	@keyframes shine {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(340%);
		}
	}

	.bt-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		max-width: 22rem;
		text-align: center;
	}

	.bt-hero {
		position: relative;
		display: grid;
		place-items: center;
		width: 6rem;
		height: 6rem;
		margin-bottom: 0.5rem;
	}

	.bt-halo {
		position: absolute;
		inset: -0.25rem;
		border-radius: 50%;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--gh-accent) 45%, transparent) 0%,
			transparent 70%
		);
		animation: breathe 2.4s ease-in-out infinite;
	}

	.boot--leaving .bt-halo {
		animation: none;
		opacity: 0;
		transition: opacity 200ms ease;
	}

	@keyframes breathe {
		0%,
		100% {
			transform: scale(0.85);
			opacity: 0.55;
		}
		50% {
			transform: scale(1.15);
			opacity: 1;
		}
	}

	.bt-hero :global(canvas),
	.bt-hero :global(svg) {
		position: relative;
	}

	.bt-headline {
		margin: 0;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		font-weight: 600;
		color: var(--gh-text);
	}

	.bt-branch {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 100%;
		margin: 0.375rem 0 0;
		padding: 0.125rem 0.5rem;
		border-radius: 999px;
		background: var(--gh-hover);
		color: var(--gh-muted);
	}

	.bt-branch--waiting {
		color: var(--gh-faint);
	}

	.bt-branch--waiting .bt-branch-name {
		font-family: inherit;
	}

	.bt-branch-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--gh-mono);
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
	}

	.bt-steps {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		width: 100%;
		margin: 1.5rem 0 0;
		padding: 0.375rem;
		list-style: none;
		border: 1px solid var(--gh-line-soft);
		border-radius: var(--gh-r-row);
		background: color-mix(in srgb, var(--gh-hover) 50%, transparent);
	}

	.bt-step {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: 2rem;
		padding: 0 0.5rem;
		border-radius: var(--gh-r-control);
		text-align: left;
		transition:
			background-color 200ms ease,
			color 200ms ease;
	}

	.bt-step[data-state='active'] {
		background: var(--gh-hover);
	}

	.bt-mark {
		display: grid;
		place-items: center;
		flex: none;
		width: 1rem;
		height: 1rem;
	}

	.bt-mark svg {
		width: 1rem;
		height: 1rem;
	}

	.bt-ring {
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.bt-ring-track {
		fill: none;
		stroke: var(--gh-line);
		stroke-width: 1.75;
	}

	.bt-ring-arc {
		fill: none;
		stroke: var(--gh-accent);
		stroke-width: 1.75;
		stroke-linecap: round;
	}

	.bt-check-disc {
		fill: var(--gh-new);
		transform-origin: center;
		animation: pop 320ms cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.bt-check-tick {
		fill: none;
		stroke: var(--bg-app);
		stroke-width: 1.75;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-dasharray: 12;
		stroke-dashoffset: 12;
		animation: tick 260ms 120ms ease-out forwards;
	}

	@keyframes pop {
		from {
			transform: scale(0.4);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}

	@keyframes tick {
		to {
			stroke-dashoffset: 0;
		}
	}

	.bt-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background: var(--gh-line);
	}

	.bt-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--gh-faint);
	}

	.bt-step[data-state='active'] .bt-label {
		color: var(--gh-text);
	}

	.bt-step[data-state='done'] .bt-label {
		color: var(--gh-muted);
	}

	.bt-time {
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}

	.bt-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.bt-prompt {
		width: 100%;
		margin: 1rem 0 0;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--gh-line-soft);
		border-radius: var(--gh-r-row);
		text-align: left;
	}

	.bt-prompt-text {
		margin: 0;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		color: var(--gh-text);
	}

	.bt-prompt-cap {
		margin-top: 0.375rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.bt-slow {
		margin: 1rem 0 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
		opacity: 0;
		transition: opacity 400ms ease;
	}

	.bt-slow--on {
		opacity: 1;
	}
</style>
