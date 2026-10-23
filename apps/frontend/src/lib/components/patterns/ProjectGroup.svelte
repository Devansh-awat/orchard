<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { Plus, ArrowRight, ChevronRight } from 'lucide-svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import { bakeBlur } from '$lib/components/aura/aura';
	import { folder } from '$lib/utils/motion.svelte';

	let {
		name,
		href,
		image = undefined,
		background = undefined,
		owner = undefined,
		counts = [],
		updatedAt = undefined,
		summary = undefined,
		expanded = $bindable(true),
		onNew = undefined,
		layout = 'cards',
		density = 'regular',
		children
	}: {
		name: string;
		href: string;
		image?: string | null;
		background?: string | null;
		owner?: string;
		counts?: string[];
		updatedAt?: string | null;
		summary?: { tone: 'success' | 'error' | 'progress' | 'neutral'; label: string };
		expanded?: boolean;
		onNew?: () => void;
		layout?: 'cards' | 'rows' | 'dense' | 'lines';
		density?: 'regular' | 'compact';
		children: Snippet;
	} = $props();

	let host = $state<HTMLElement>();
	let iconEl = $state<HTMLElement>();
	let mesh = $state<string | null>(null);
	let awake = $state(false);

	onMount(() => {
		if (!host) return;
		if (background) bakeBlur(background).then((url) => (mesh = url));
	});
</script>

<section
	bind:this={host}
	class="project project--{density}"
	class:project--media={!!background}
	class:project--awake={awake}
	aria-label={name}
	onpointerenter={() => (awake = true)}
>
	{#if background}<div
			class="backdrop"
			class:backdrop--ready={!!mesh}
			style:--mesh={mesh ? `url("${mesh}")` : 'none'}
		>
			<div class="mesh mesh--1"></div>
			<div class="mesh mesh--2"></div>
			<div class="mesh mesh--3"></div>
			<div class="veil"></div>
		</div>{/if}

	<header class="head">
		<button
			type="button"
			class="toggle"
			aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<span class="chev" class:chev--open={expanded} aria-hidden="true"
				><ChevronRight size={16} /></span
			>
			<span class="icon" bind:this={iconEl}
				><AppIcon
					{name}
					kind="project"
					icon={image}
					size={density === 'compact' ? 'md' : 'lg'}
				/></span
			>
			<span class="text">
				<span class="name">{name}</span>
				<span class="meta">
					{#if owner}<span class="owner">{owner}</span>{/if}
					{#each counts as c, i (i)}
						{#if owner || i > 0}<span class="sep" aria-hidden="true"></span>{/if}<span>{c}</span>
					{/each}
					{#if updatedAt}<span class="sep" aria-hidden="true"></span><RelativeTime
							date={updatedAt}
						/>{/if}
				</span>
			</span>
		</button>
		{#if summary}
			<span class="summary summary--{summary.tone}"
				><span class="summary-dot"></span><span class="summary-label">{summary.label}</span></span
			>
		{/if}
		<div class="actions">
			{#if onNew}
				<button type="button" class="round" onclick={onNew} aria-label="New in {name}"
					><Plus size={15} /></button
				>
			{/if}
			<a class="round" {href} aria-label="Open {name}"><ArrowRight size={15} /></a>
		</div>
	</header>

	<div class="body" {@attach folder(() => expanded, { origin: () => iconEl })}>
		<div class="cards cards--{layout}">{@render children()}</div>
	</div>
</section>

<style>
	.project {
		--head-h: 5rem;
		--h-fg: var(--text-default);
		--h-muted: var(--text-muted);
		--h-fill: color-mix(in oklab, var(--neutral-10) 6%, transparent);
		--h-fill-hover: color-mix(in oklab, var(--neutral-10) 10%, transparent);
		--h-edge: color-mix(in oklab, var(--neutral-10) 10%, transparent);
		--h-pill: color-mix(in oklab, var(--neutral-10) 6%, transparent);
		position: relative;
		min-width: 0;
		border-radius: calc(var(--radius-panel) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: var(--shadow-raised);
		overflow: clip;
		isolation: isolate;
	}
	.project--compact {
		--head-h: 3.5rem;
		border-radius: calc(0.875rem * var(--corner-scale));
	}
	.project--compact .text {
		gap: 0.4375rem;
	}
	.project--compact .name {
		font-size: var(--text-body);
	}
	.project--compact .meta {
		font-size: var(--text-caption);
	}
	.project--compact .head {
		gap: 0.625rem;
		padding-right: 1rem;
	}
	.project--media {
		--h-fg: var(--on-media);
		--h-muted: var(--on-media-muted);
		--h-fill: var(--on-media-fill);
		--h-fill-hover: var(--on-media-fill-hover);
		--h-edge: var(--on-media-edge);
		--h-pill: var(--on-media-pill);
	}
	.project:not(.project--media) .head {
		box-shadow: inset 0 -1px 0 var(--border-default);
	}
	.backdrop {
		position: absolute;
		inset: 0 0 auto;
		z-index: -1;
		height: var(--head-h);
		overflow: hidden;
		background: var(--bg-active);
		contain: paint;
	}
	.mesh {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 200%;
		aspect-ratio: 1;
		background-image: var(--mesh);
		background-size: cover;
		background-position: center;
		opacity: 0;
		transition: opacity 500ms ease-out;
	}
	.mesh--1 {
		transform: translate(-50%, -50%) scale(1.1) rotate(0deg);
	}
	.mesh--2 {
		transform: translate(-50%, -50%) scale(1.45) rotate(70deg);
	}
	.mesh--3 {
		transform: translate(-50%, -50%) scale(1.8) rotate(140deg);
	}
	.backdrop--ready .mesh--1 {
		opacity: 0.9;
	}
	.backdrop--ready .mesh--2 {
		opacity: 0.55;
	}
	.backdrop--ready .mesh--3 {
		opacity: 0.4;
	}
	.project--awake .mesh--1 {
		animation: spin-a 28s linear infinite paused;
	}
	.project--awake .mesh--2 {
		animation: spin-b 44s linear infinite paused;
	}
	.project--awake .mesh--3 {
		animation: spin-c 60s linear infinite paused;
	}
	.project:hover .mesh {
		animation-play-state: running;
	}
	@keyframes spin-a {
		to {
			transform: translate(-50%, -50%) scale(1.1) rotate(360deg);
		}
	}
	@keyframes spin-b {
		to {
			transform: translate(-50%, -50%) scale(1.45) rotate(430deg);
		}
	}
	@keyframes spin-c {
		to {
			transform: translate(-50%, -50%) scale(1.8) rotate(-220deg);
		}
	}
	.veil {
		position: absolute;
		inset: 0;
		background: var(--media-veil);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: var(--head-h);
		padding: 0 1.25rem 0 0.75rem;
		color: var(--h-fg);
	}
	.chev {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: 50%;
		background: none;
		color: var(--h-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.chev--open {
		transform: rotate(90deg);
	}
	.toggle:hover .chev {
		background: var(--h-fill);
		color: var(--h-fg);
	}
	.toggle {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.75rem;
		align-self: stretch;
		min-width: 0;
		padding: 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.toggle:focus-visible {
		outline: none;
	}
	.toggle:focus-visible .chev {
		box-shadow: 0 0 0 2px var(--accent-solid);
	}
	.icon {
		display: flex;
		flex-shrink: 0;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-title-3);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.012em;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		color: var(--h-muted);
		font-size: var(--text-callout);
		font-variant-numeric: tabular-nums;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.meta > :global(*) {
		text-box: trim-both cap alphabetic;
	}
	.owner {
		color: var(--h-fg);
	}
	.sep {
		width: 2px;
		height: 2px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--h-muted);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}
	.project:hover .actions,
	.head:focus-within .actions {
		opacity: 1;
	}
	@media (hover: none) {
		.actions {
			opacity: 1;
		}
	}
	.summary {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		color: var(--h-muted);
		font-size: var(--text-callout);
		font-variant-numeric: tabular-nums;
	}
	.summary-label {
		text-box: trim-both cap alphabetic;
	}
	.summary-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--neutral-6);
	}
	.summary--success .summary-dot {
		background: var(--green-6);
	}
	.summary--progress .summary-dot {
		background: var(--amber-6);
	}
	.summary--error .summary-dot {
		background: var(--red-6);
	}
	.summary--error {
		color: var(--h-fg);
		font-weight: var(--weight-semibold);
	}
	.round {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		height: 1.75rem;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--h-fill);
		color: var(--h-fg);
		font: inherit;
		font-size: var(--text-callout);
		font-weight: var(--weight-semibold);
		text-decoration: none;
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.round {
		width: 2rem;
		height: 2rem;
	}
	.round:hover {
		background: var(--h-fill-hover);
	}

	.body {
		overflow: clip;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		padding: 0.875rem;
		background: var(--bg-sunken);
	}
	@media (min-width: 100rem) {
		.cards {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.cards--dense {
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.5rem;
		padding: 0.625rem;
	}
	.cards--lines {
		grid-template-columns: minmax(0, 1fr);
		gap: 0.125rem;
		padding: 0.375rem;
		background: none;
	}
	.cards--rows {
		grid-template-columns: minmax(0, 1fr);
		gap: 0;
		padding: 0.375rem 0.5rem;
		background: none;
	}
	@media (max-width: 720px) {
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
