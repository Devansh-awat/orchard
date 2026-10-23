<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { Plus, ArrowRight, ChevronRight } from 'lucide-svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import { auraColors, resolveColors } from '$lib/components/ui/Aura.svelte';
	import { bakeBlur, colorsImage } from '$lib/components/aura/aura';
	import { springCollapse, springRotate } from '$lib/utils/motion.svelte';

	let {
		name,
		href,
		image = undefined,
		background = undefined,
		owner = undefined,
		counts = [],
		updatedAt = undefined,
		live = undefined,
		expanded = $bindable(true),
		onNew = undefined,
		children
	}: {
		name: string;
		href: string;
		image?: string | null;
		background?: string | null;
		owner?: string;
		counts?: string[];
		updatedAt?: string | null;
		live?: number;
		expanded?: boolean;
		onNew?: () => void;
		children: Snippet;
	} = $props();

	let host = $state<HTMLElement>();
	let mesh = $state<string | null>(null);
	let awake = $state(false);
	const letter = $derived(name.trim().charAt(0).toUpperCase());

	onMount(() => {
		if (!host) return;
		const source = background || image || colorsImage(resolveColors(host, auraColors(name)));
		if (source) bakeBlur(source).then((url) => (mesh = url));
	});
</script>

<section
	bind:this={host}
	class="project"
	class:project--awake={awake}
	aria-label={name}
	onpointerenter={() => (awake = true)}
>
	<div
		class="backdrop"
		class:backdrop--ready={!!mesh}
		style:--mesh={mesh ? `url("${mesh}")` : 'none'}
	>
		<div class="mesh mesh--1"></div>
		<div class="mesh mesh--2"></div>
		<div class="mesh mesh--3"></div>
		<div class="veil"></div>
	</div>

	<header class="head">
		<button
			type="button"
			class="chev"
			aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
			{@attach springRotate(() => expanded, { rest: 0, on: 90 })}
		>
			<ChevronRight size={16} />
		</button>
		<a class="identity" {href}>
			<span class="avatar">
				{#if image}<RemoteImg src={image} class="avatar-img" />{:else}{letter}{/if}
			</span>
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
		</a>
		<div class="actions">
			{#if live !== undefined}<span class="live"><span class="live-dot"></span>{live}</span>{/if}
			{#if onNew}
				<button type="button" class="pill" onclick={onNew}
					><Plus size={14} /><span>New</span></button
				>
			{/if}
			<a class="round" {href} aria-label="Open {name}"><ArrowRight size={14} /></a>
		</div>
	</header>

	<div class="body" {@attach springCollapse(() => !expanded)}>
		<div class="cards">{@render children()}</div>
	</div>
</section>

<style>
	.project {
		--head-h: 5rem;
		position: relative;
		min-width: 0;
		border-radius: var(--radius-panel);
		background: var(--bg-raised);
		box-shadow: var(--shadow-raised);
		overflow: clip;
		isolation: isolate;
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
		color: var(--on-media);
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
		color: var(--on-media-muted);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.chev:hover {
		background: var(--on-media-fill);
		color: var(--on-media);
	}
	.identity {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.875rem;
		min-width: 0;
		color: inherit;
		text-decoration: none;
	}
	.avatar {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: 0.75rem;
		background: var(--on-media-fill);
		box-shadow: inset 0 0 0 0.5px var(--on-media-edge);
		font-size: var(--text-title-3);
		font-weight: var(--weight-semibold);
		overflow: hidden;
	}
	.avatar :global(.avatar-img) {
		width: 100%;
		height: 100%;
		object-fit: contain;
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
		color: var(--on-media-muted);
		font-size: var(--text-callout);
		font-variant-numeric: tabular-nums;
		mask-image: linear-gradient(90deg, black calc(100% - 1.5rem), transparent);
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.meta > :global(*) {
		text-box: trim-both cap alphabetic;
	}
	.owner {
		color: var(--on-media);
		font-weight: var(--weight-semibold);
	}
	.sep {
		width: 2px;
		height: 2px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--on-media-muted);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.live {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 1.75rem;
		padding: 0 0.625rem;
		border-radius: var(--radius-pill);
		background: var(--on-media-pill);
		font-size: var(--text-callout);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}
	.live-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--green-6);
		box-shadow: 0 0 6px var(--green-6);
	}
	.pill,
	.round {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		height: 1.75rem;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--on-media-fill);
		color: var(--on-media);
		font: inherit;
		font-size: var(--text-callout);
		font-weight: var(--weight-semibold);
		text-decoration: none;
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.pill {
		padding: 0 0.75rem 0 0.5rem;
	}
	.pill span {
		text-box: trim-both cap alphabetic;
	}
	.round {
		width: 1.75rem;
	}
	.pill:hover,
	.round:hover {
		background: var(--on-media-fill-hover);
	}

	.body {
		overflow: hidden;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		padding: 1rem;
	}
	@media (min-width: 100rem) {
		.cards {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	@media (max-width: 720px) {
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
