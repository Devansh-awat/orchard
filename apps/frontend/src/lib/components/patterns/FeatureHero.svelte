<script lang="ts" module>
	export type FeatureItem = {
		id: string;
		title: string;
		eyebrow?: string;
		description?: string;
		icon?: string | null;
		href?: string;
	};
</script>

<script lang="ts">
	import { ArrowRight } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import IconTile from '$lib/components/ui/IconTile.svelte';
	import { bakeBlur } from '$lib/components/aura/aura';
	import { decorativeMotion, fade, springTiming } from '$lib/utils/motion.svelte';

	let {
		items,
		cta = 'Deploy',
		onSelect = undefined,
		interval = 7000
	}: {
		items: FeatureItem[];
		cta?: string;
		onSelect?: (item: FeatureItem) => void;
		interval?: number;
	} = $props();

	let index = $state(0);
	let paused = $state(false);
	let baked = $state<Record<string, string>>({});

	const current = $derived(items[Math.min(index, items.length - 1)]);

	$effect(() => {
		for (const item of items) {
			if (!item.icon || baked[item.icon]) continue;
			const src = item.icon;
			bakeBlur(src).then((url) => {
				if (url) baked[src] = url;
			});
		}
	});

	$effect(() => {
		if (paused || items.length < 2 || !decorativeMotion()) return;
		const id = setTimeout(() => {
			if (!document.hidden) index = (index + 1) % items.length;
		}, interval);
		return () => clearTimeout(id);
	});

	function go(i: number) {
		index = (i + items.length) % items.length;
	}

	function enter(el: HTMLElement) {
		if (!decorativeMotion()) return;
		el.animate([{ transform: 'translateY(0.5rem)' }, { transform: 'none' }], springTiming('glide'));
		el.animate([{ opacity: 0 }, { opacity: 1 }], { ...fade('in'), fill: 'backwards' });
	}

	function choose(e: MouseEvent) {
		if (!onSelect || e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		onSelect(current);
	}
</script>

{#if current}
	<section
		class="hero"
		aria-roledescription="carousel"
		aria-label="Featured"
		onpointerenter={() => (paused = true)}
		onpointerleave={() => (paused = false)}
		onfocusin={() => (paused = true)}
		onfocusout={() => (paused = false)}
		onkeydown={(e) => {
			if (e.key === 'ArrowRight') go(index + 1);
			if (e.key === 'ArrowLeft') go(index - 1);
		}}
	>
		<div class="backdrop" aria-hidden="true">
			{#each items as item, i (item.id)}
				<span
					class="mesh"
					class:mesh--on={i === index}
					style:--mesh={item.icon && baked[item.icon] ? `url("${baked[item.icon]}")` : 'none'}
				></span>
			{/each}
			<span class="veil"></span>
		</div>
		{#key current.id}
			<div class="copy" {@attach enter}>
				{#if current.eyebrow}<p class="eyebrow">{current.eyebrow}</p>{/if}
				<h2 class="title">{current.title}</h2>
				{#if current.description}<p class="description">{current.description}</p>{/if}
				<div class="actions">
					<Button
						variant="media"
						size="lg"
						href={current.href}
						iconRight={ArrowRight}
						onclick={choose}>{cta}</Button
					>
				</div>
			</div>
			<div class="poster" {@attach enter} aria-hidden="true">
				<IconTile src={current.icon} class="poster-tile" tint="var(--bg-raised)">
					{#snippet fallback()}<span class="poster-letter">{current.title.charAt(0)}</span
						>{/snippet}
				</IconTile>
			</div>
		{/key}
		{#if items.length > 1}
			<div class="dots" role="tablist" aria-label="Featured items">
				{#each items as item, i (item.id)}
					<button
						type="button"
						role="tab"
						class="dot"
						class:dot--on={i === index}
						aria-selected={i === index}
						aria-label={item.title}
						onclick={() => go(i)}
					></button>
				{/each}
			</div>
		{/if}
	</section>
{/if}

<style>
	.hero {
		--hero-r: calc(1.5rem * var(--corner-scale));
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: end;
		gap: 2rem;
		min-height: 18rem;
		padding: 2rem 2.5rem 2.25rem;
		overflow: hidden;
		isolation: isolate;
		border-radius: var(--hero-r);
		corner-shape: var(--corner);
		background: var(--neutral-10);
		color: var(--on-media);
		box-shadow: var(--shadow-raised);
	}
	.backdrop {
		position: absolute;
		inset: 0;
		z-index: -1;
	}
	.mesh {
		position: absolute;
		inset: -20%;
		background-image: var(--mesh);
		background-size: cover;
		background-position: center;
		filter: saturate(1.35);
		opacity: 0;
		transform: scale(1.08);
		transition:
			opacity var(--fade-long) var(--curve-in-out),
			transform var(--spring-cinematic-duration) var(--spring-cinematic);
	}
	.mesh--on {
		opacity: 1;
		transform: none;
	}
	.veil {
		position: absolute;
		inset: 0;
		background:
			linear-gradient(
				100deg,
				oklch(0 0 0 / 0.55) 0%,
				oklch(0 0 0 / 0.3) 45%,
				oklch(0 0 0 / 0.05) 100%
			),
			linear-gradient(0deg, oklch(0 0 0 / 0.35), transparent 60%);
	}
	.copy {
		grid-column: 1;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: 32rem;
	}
	.eyebrow {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: var(--weight-medium);
		color: var(--on-media-muted);
	}
	.title {
		margin: 0;
		font-size: var(--text-display);
		line-height: var(--lh-display);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.025em;
		text-wrap: balance;
	}
	.description {
		display: -webkit-box;
		margin: 0;
		overflow: hidden;
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		color: var(--on-media-muted);
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		text-wrap: pretty;
	}
	.actions {
		margin-top: 1rem;
	}
	.poster {
		grid-column: 2;
		grid-row: 1;
		align-self: center;
	}
	.poster :global(.poster-tile) {
		display: grid;
		width: 8.5rem;
		height: 8.5rem;
		border-radius: calc(2rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow:
			0 0 0 0.5px var(--on-media-edge),
			0 18px 40px -12px oklch(0 0 0 / 0.45);
	}
	.poster-letter {
		font-size: 3rem;
		font-weight: var(--weight-semibold);
		color: var(--text-muted);
	}
	.dots {
		position: absolute;
		right: 2.5rem;
		bottom: 1.25rem;
		display: flex;
		gap: 0.375rem;
	}
	.dot {
		width: 0.4375rem;
		height: 0.4375rem;
		padding: 0;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--on-media-edge);
		cursor: pointer;
		transition:
			width var(--spring-glide-duration) var(--spring-glide),
			background-color var(--fade-in) var(--curve-out);
	}
	.dot--on {
		width: 1.25rem;
		background: var(--on-media);
	}
	.dot:focus-visible {
		outline: 2px solid var(--on-media);
		outline-offset: 2px;
	}
	@media (max-width: 44rem) {
		.hero {
			grid-template-columns: minmax(0, 1fr);
			padding: 1.5rem;
		}
		.poster {
			display: none;
		}
	}
</style>
