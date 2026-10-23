<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Plus, ArrowRight } from 'lucide-svelte';
	import Aura from '$lib/components/ui/Aura.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';

	let {
		name,
		href,
		image = undefined,
		meta = undefined,
		onNew = undefined,
		children
	}: {
		name: string;
		href: string;
		image?: string | null;
		meta?: string;
		onNew?: () => void;
		children: Snippet;
	} = $props();

	const letter = $derived(name.trim().charAt(0).toUpperCase());
</script>

<section class="group" aria-label={name}>
	<header class="head">
		<Aura class="backdrop" src={image} {name} still />
		<div class="scrim"></div>
		<a class="identity" {href}>
			<span class="avatar">
				{#if image}<RemoteImg src={image} class="avatar-img" />{:else}{letter}{/if}
			</span>
			<span class="text">
				<span class="name">{name}</span>
				{#if meta}<span class="meta">{meta}</span>{/if}
			</span>
		</a>
		<div class="actions">
			{#if onNew}<Button variant="media" size="sm" icon={Plus} onclick={onNew}>New</Button>{/if}
			<Button variant="media" size="sm" icon={ArrowRight} label="Open {name}" {href} />
		</div>
	</header>
	<div class="body">{@render children()}</div>
</section>

<style>
	.group {
		min-width: 0;
		border-radius: var(--radius-panel);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		overflow: clip;
	}
	.head {
		position: relative;
		display: flex;
		align-items: center;
		gap: 1rem;
		height: 4.5rem;
		padding: 0 1rem;
		isolation: isolate;
	}
	.head :global(.backdrop) {
		position: absolute;
		inset: 0;
		z-index: -2;
	}
	.scrim {
		position: absolute;
		inset: 0;
		z-index: -1;
		background: var(--media-scrim);
	}
	.identity {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		color: var(--on-media);
		text-decoration: none;
	}
	.avatar {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		background: var(--on-media-fill);
		box-shadow:
			inset 0 0 0 0.5px var(--on-media-edge),
			var(--on-media-shadow);
		color: var(--on-media);
		font-size: var(--text-headline);
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
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.name,
	.meta {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.name {
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.01em;
	}
	.meta {
		color: var(--on-media-muted);
		font-size: var(--text-callout);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
</style>
