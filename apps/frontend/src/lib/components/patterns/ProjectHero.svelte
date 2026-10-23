<script lang="ts">
	import type { Snippet } from 'svelte';
	import Aura from '$lib/components/ui/Aura.svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';

	let {
		name,
		image = undefined,
		meta = undefined,
		eyebrow = undefined,
		actions = undefined
	}: {
		name: string;
		image?: string | null;
		meta?: string;
		eyebrow?: Snippet;
		actions?: Snippet;
	} = $props();

	const letter = $derived(name.trim().charAt(0).toUpperCase());
</script>

<header class="hero">
	<Aura class="field" src={image} {name} />
	<div class="fade"></div>
	<div class="identity">
		<span class="avatar">
			{#if image}<RemoteImg src={image} class="avatar-img" />{:else}{letter}{/if}
		</span>
		<div class="text">
			{#if eyebrow}<div class="eyebrow">{@render eyebrow()}</div>{/if}
			<h1 class="name">{name}</h1>
			{#if meta}<p class="meta">{meta}</p>{/if}
		</div>
		{#if actions}<div class="actions">{@render actions()}</div>{/if}
	</div>
</header>

<style>
	.hero {
		position: relative;
		display: flex;
		align-items: flex-end;
		height: 15rem;
		margin-bottom: 1.5rem;
		isolation: isolate;
	}
	.hero :global(.field) {
		position: absolute;
		inset: 0;
		z-index: -2;
	}
	.fade {
		position: absolute;
		inset: 0;
		z-index: -1;
		background: linear-gradient(
			to bottom,
			transparent 0%,
			transparent 30%,
			color-mix(in oklab, var(--bg-sheet) 55%, transparent) 58%,
			color-mix(in oklab, var(--bg-sheet) 92%, transparent) 76%,
			var(--bg-sheet) 86%
		);
	}
	.identity {
		display: flex;
		align-items: flex-end;
		gap: 1rem;
		width: 100%;
		max-width: calc(var(--page-wide) + 4rem);
		margin: 0 auto;
		padding: 0 2rem;
	}
	.avatar {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 4.5rem;
		height: 4.5rem;
		border-radius: 1.25rem;
		background: var(--bg-surface);
		box-shadow:
			0 0 0 4px var(--bg-sheet),
			var(--shadow-floating);
		color: var(--text-default);
		font-size: var(--text-title-1);
		font-weight: var(--weight-semibold);
		overflow: hidden;
	}
	.avatar :global(.avatar-img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
		padding-bottom: 0.25rem;
	}
	.eyebrow {
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.name {
		color: var(--text-default);
		font-size: var(--text-title-1);
		line-height: var(--lh-title-1);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.018em;
	}
	.meta {
		color: var(--text-muted);
		font-size: var(--text-body);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
		padding-bottom: 0.25rem;
	}
	@media (max-width: 640px) {
		.identity {
			padding: 0 1rem;
		}
	}
</style>
