<script lang="ts" module>
	export type SpotlightItem = {
		id: string;
		name: string;
		href: string;
		url?: string | null;
		image?: string | null;
		background?: string | null;
		owner?: string;
		status: string;
		tone: 'success' | 'progress' | 'error' | 'neutral';
		apps?: { name: string; kind?: 'deployment' | 'database' | 'job' }[];
	};
</script>

<script lang="ts">
	import { ArrowRight, ExternalLink } from 'lucide-svelte';
	import Aura from '$lib/components/ui/Aura.svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { motion } from '$lib/utils/motion.svelte';
	import { fade } from '$lib/utils/transitions';
	import { effectiveAnimation } from '$lib/stores/preferences';

	let {
		items,
		variant = 'spotlight'
	}: {
		items: SpotlightItem[];
		variant?: 'spotlight' | 'banner';
	} = $props();

	let index = $state(0);
	let prev = $state<number | null>(null);
	let dir = $state(1);
	let hovered = $state(false);
	let focused = $state(false);
	let hidden = $state(false);
	let settle: ReturnType<typeof setTimeout> | undefined;
	let mounted = false;
	const PITCH = 13;
	const STRETCH = 17;

	const current = $derived(items[Math.min(index, items.length - 1)]);
	const auto = $derived($effectiveAnimation === 'full' && items.length > 1);
	const paused = $derived(hovered || focused || hidden);
	const apps = $derived((current?.apps ?? []).slice(0, 4));
	const extra = $derived(Math.max(0, (current?.apps?.length ?? 0) - apps.length));

	$effect(() => {
		const sync = () => (hidden = document.hidden);
		sync();
		document.addEventListener('visibilitychange', sync);
		return () => document.removeEventListener('visibilitychange', sync);
	});

	$effect(() => {
		mounted = true;
		return () => clearTimeout(settle);
	});

	function go(next: number, direction?: number) {
		const target = (next + items.length) % items.length;
		if (target === index) return;
		dir = direction ?? (target > index ? 1 : -1);
		prev = index;
		index = target;
		clearTimeout(settle);
		settle = setTimeout(() => (prev = null), 1400);
	}

	function onKey(e: KeyboardEvent) {
		if (items.length < 2) return;
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			go(index + 1, 1);
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			go(index - 1, -1);
		}
	}

	function art(active: () => boolean) {
		return (el: HTMLElement) => {
			$effect(() => {
				const on = active();
				if (!mounted) return;
				const d = dir;
				if (!on) {
					motion(el, { scale: 1.02, x: `${-3 * d}%` }, 'cinematic', { exit: true });
					return;
				}
				const run = motion(
					el,
					{ opacity: [0, 1], scale: [1.08, 1], x: [`${4 * d}%`, '0%'] },
					'cinematic'
				);
				if (!run) el.style.opacity = '1';
			});
		};
	}

	function copyIn(el: HTMLElement) {
		if (!mounted) return;
		motion(el, { opacity: [0, 1], x: [24 * dir, 0] }, 'smooth', { delay: 0.08 });
	}
</script>

{#if current}
	<section
		class="shelf shelf--{variant}"
		aria-roledescription="carousel"
		aria-label="Recent projects"
		onpointerenter={() => (hovered = true)}
		onpointerleave={() => (hovered = false)}
		onfocusin={() => (focused = true)}
		onfocusout={() => (focused = false)}
		onkeydown={onKey}
	>
		<div class="stage" aria-hidden="true">
			{#each items as item, i (item.id)}
				{#if i === index || i === prev}
					<div class="art" class:art--on={i === index} {@attach art(() => i === index)}>
						{#if item.background}
							<RemoteImg src={item.background} class="poster" eager />
							<RemoteImg src={item.background} class="poster poster--soft" eager />
						{:else}
							<Aura name={item.name} />
						{/if}
					</div>
				{/if}
			{/each}
			<div class="veil"></div>
		</div>

		<div class="copy-stack" aria-live="polite">
			{#key current.id}
				<div class="copy" {@attach copyIn} out:fade={{ duration: 160 }}>
					{#if variant === 'spotlight'}
						<div class="byline">
							<AppIcon name={current.name} kind="project" icon={current.image} size="sm" />
							{#if current.owner}<span class="owner">{current.owner}</span>{/if}
						</div>
					{:else}
						<span class="lead"
							><AppIcon name={current.name} kind="project" icon={current.image} size="lg" /></span
						>
					{/if}
					<div class="text">
						<h2 class="name">{current.name}</h2>
						<p class="status status--{current.tone}">
							<span class="dot" aria-hidden="true"></span><span class="status-label"
								>{current.status}</span
							>
						</p>
					</div>
					{#if variant === 'spotlight'}
						<div class="actions">
							<a class="open" href={current.href}
								><span class="open-label">Open project</span><ArrowRight
									size={16}
									aria-hidden="true"
								/></a
							>
							{#if current.url}
								<Button
									variant="media"
									href={current.url}
									iconRight={ExternalLink}
									target="_blank"
									rel="noreferrer">Visit</Button
								>
							{/if}
							{#if apps.length}
								<span class="apps" aria-label="{current.apps?.length} apps">
									{#each apps as a (a.name)}
										<span class="app" title={a.name}
											><AppIcon name={a.name} kind={a.kind ?? 'deployment'} size="sm" /></span
										>
									{/each}
									{#if extra}<span class="more">+{extra}</span>{/if}
								</span>
							{/if}
						</div>
					{/if}
				</div>
			{/key}
		</div>

		{#if variant === 'banner'}
			<div class="side">
				<a class="open" href={current.href}
					><span class="open-label">Open</span><ArrowRight size={15} aria-hidden="true" /></a
				>
				{#if current.url}
					<Button
						variant="media"
						size="sm"
						href={current.url}
						icon={ExternalLink}
						label="Visit {current.name}"
						target="_blank"
						rel="noreferrer"
					/>
				{/if}
			</div>
		{/if}

		{#if items.length > 1}
			<div class="dots" role="group" aria-label="Choose project" style:--count={items.length}>
				{#each items as item, i (item.id)}
					<button
						type="button"
						class="pip"
						class:pip--on={i === index}
						class:pip--auto={auto}
						style:--x="{i * PITCH + (i > index ? STRETCH : 0)}px"
						aria-label="Show {item.name}"
						aria-current={i === index ? 'true' : undefined}
						onclick={() => go(i)}
					>
						<span class="shape"
							><span class="cap"></span><span class="bar"></span><span class="cap cap--end"
							></span></span
						>
						{#if i === index && auto}
							{#key index}
								<span class="track"
									><span
										class="fill"
										class:fill--paused={paused}
										onanimationend={() => go(index + 1, 1)}
									></span></span
								>
							{/key}
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</section>
{/if}

<style>
	.shelf {
		--pad: 2rem;
		position: relative;
		display: flex;
		min-width: 0;
		overflow: clip;
		isolation: isolate;
		border-radius: calc(var(--radius-panel) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-active);
		box-shadow:
			0 0 0 0.5px var(--border-default),
			var(--shadow-raised);
		color: var(--on-media);
	}
	.shelf--spotlight {
		height: 22rem;
	}
	.shelf--banner {
		height: 9rem;
		--pad: 1.5rem;
		background: var(--bg-raised);
		color: var(--text-default);
	}

	.stage {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		contain: paint;
	}
	.shelf--banner .stage {
		left: 34%;
		mask-image: linear-gradient(90deg, transparent, var(--on-media) 46%);
	}
	.art {
		position: absolute;
		inset: -4%;
		z-index: 0;
		will-change: transform, opacity;
	}
	.art--on {
		z-index: 1;
	}
	.art :global(.aura),
	.art :global(.poster) {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.art :global(.poster) {
		object-fit: cover;
		object-position: center 40%;
	}
	.art :global(.poster--soft) {
		filter: blur(28px) saturate(1.3);
		transform: scale(1.15);
		mask-image: linear-gradient(90deg, var(--on-media) 32%, transparent 72%);
	}
	.veil {
		position: absolute;
		inset: 0;
		z-index: 2;
		background: linear-gradient(20deg, var(--on-media-pill) 0%, transparent 58%), var(--media-veil);
	}
	.shelf--banner .veil {
		background:
			linear-gradient(270deg, var(--on-media-pill) 10%, transparent 55%),
			linear-gradient(270deg, var(--on-media-pill), transparent 80%);
	}
	.shelf--banner .art :global(.poster--soft) {
		display: none;
	}

	.copy-stack {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.copy {
		grid-area: 1 / 1;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 1.5rem;
		min-width: 0;
		padding: var(--pad);
		padding-right: 8rem;
	}
	.shelf--banner .copy {
		flex-direction: row;
		align-items: center;
		justify-content: flex-start;
		gap: 1rem;
		padding-right: 1rem;
	}

	.byline {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin-bottom: auto;
		color: var(--on-media-muted);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
	.byline :global(.icon) {
		box-shadow: 0 0 0 0.5px var(--on-media-edge);
	}
	.owner {
		text-box: trim-both cap alphabetic;
	}
	.lead {
		display: flex;
		flex-shrink: 0;
	}

	.text {
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
		min-width: 0;
	}
	.shelf--banner .text {
		gap: 0.75rem;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: calc(var(--text-display) * 1.5);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.03em;
		line-height: 1;
		text-shadow: var(--on-media-shadow);
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.shelf--banner .name {
		font-size: var(--text-title-1);
		letter-spacing: -0.018em;
		text-shadow: none;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--on-media-muted);
		font-size: var(--text-body);
		font-variant-numeric: tabular-nums;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.shelf--banner .status {
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.status-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.dot {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--neutral-6);
	}
	.status--success .dot {
		background: var(--green-7);
	}
	.status--progress .dot {
		background: var(--amber-7);
	}
	.status--error .dot {
		background: var(--red-7);
	}
	.status--error {
		color: var(--on-media);
		font-weight: var(--weight-medium);
	}
	.shelf--banner .status--error {
		color: var(--status-error);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.open {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 2.25rem;
		padding: 0 0.875rem 0 1rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--on-media);
		color: oklch(from var(--on-media-pill) l c h / 0.88);
		box-shadow: var(--on-media-shadow);
		font-size: var(--text-body);
		font-weight: var(--weight-semibold);
		text-decoration: none;
		white-space: nowrap;
		transition:
			opacity var(--dur-fast) ease,
			transform var(--spring-interactive-duration) var(--spring-interactive);
	}
	.open:hover {
		opacity: 0.9;
	}
	.open:active {
		transform: scale(0.96);
	}
	.open:focus-visible,
	.pip:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--on-media-edge);
	}
	.open-label {
		text-box: trim-both cap alphabetic;
	}
	.actions :global(.button) {
		height: 2.25rem;
	}

	.apps {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-left: 0.75rem;
		padding-left: 1rem;
		box-shadow: inset 0.5px 0 0 var(--on-media-edge);
	}
	.app {
		display: flex;
	}
	.app :global(.icon) {
		box-shadow: 0 0 0 0.5px var(--on-media-edge);
	}
	.more {
		color: var(--on-media-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		font-variant-numeric: tabular-nums;
		text-box: trim-both cap alphabetic;
		padding-left: 0.125rem;
	}

	.side {
		position: absolute;
		top: 50%;
		right: var(--pad);
		display: flex;
		align-items: center;
		gap: 0.375rem;
		translate: 0 -50%;
	}
	.side .open {
		height: 1.75rem;
		padding: 0 0.625rem 0 0.75rem;
		border-radius: calc(0.5625rem * var(--corner-scale));
		font-size: var(--text-callout);
		gap: 0.3125rem;
	}

	.dots {
		--dot: 7px;
		--stretch: 17px;
		position: absolute;
		right: var(--pad);
		bottom: calc(var(--pad) + 0.6875rem);
		width: calc(var(--count) * var(--dot) + (var(--count) - 1) * 6px + var(--stretch));
		height: var(--dot);
	}
	.shelf--banner .dots {
		bottom: 0.875rem;
	}
	.pip {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--dot);
		height: var(--dot);
		padding: 0;
		border: none;
		border-radius: 50%;
		background: none;
		cursor: pointer;
		transform: translateX(var(--x));
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.pip::before {
		content: '';
		position: absolute;
		inset: -0.5rem -0.1875rem;
	}
	.shape {
		position: absolute;
		inset: 0;
		opacity: 0.42;
		transition: opacity var(--dur-fast) ease;
	}
	.pip:hover .shape {
		opacity: 0.7;
	}
	.pip--on .shape {
		opacity: 1;
	}
	.pip--on.pip--auto .shape {
		opacity: 0.42;
	}
	.cap,
	.bar {
		position: absolute;
		top: 0;
		left: 0;
		height: var(--dot);
		background: var(--on-media);
	}
	.cap {
		width: var(--dot);
		border-radius: 50%;
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.bar {
		left: calc(var(--dot) / 2);
		width: var(--stretch);
		transform: scaleX(0);
		transform-origin: left center;
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.pip--on .cap--end {
		transform: translateX(var(--stretch));
	}
	.pip--on .bar {
		transform: scaleX(1);
	}
	.track {
		position: absolute;
		top: 0;
		left: 0;
		width: calc(var(--dot) + var(--stretch));
		height: var(--dot);
		overflow: hidden;
		border-radius: var(--radius-pill);
	}
	.fill {
		position: absolute;
		inset: 0;
		background: var(--on-media);
		transform: translateX(-100%);
		animation: advance 8s linear both;
	}
	.fill--paused {
		animation-play-state: paused;
	}
	@keyframes advance {
		to {
			transform: translateX(0);
		}
	}

	@media (max-width: 720px) {
		.shelf--spotlight {
			--pad: 1.25rem;
			height: 20rem;
		}
		.copy {
			padding-right: var(--pad);
			padding-bottom: calc(var(--pad) + 1.5rem);
		}
		.name {
			font-size: var(--text-display);
		}
		.apps {
			display: none;
		}
		.dots {
			bottom: var(--pad);
		}
	}
</style>
