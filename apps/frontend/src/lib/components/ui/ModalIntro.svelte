<script lang="ts">
	import type { Snippet } from 'svelte';
	import ToneTile from './ToneTile.svelte';
	import type { StatusKind } from './status';
	import type { Icon } from './types';

	let {
		id = undefined,
		icon,
		tone = 'accent',
		title,
		description = undefined,
		children = undefined
	}: {
		id?: string;
		icon: Icon;
		tone?: StatusKind | 'accent';
		title: string;
		description?: string;
		children?: Snippet;
	} = $props();

	const Glyph = $derived(icon);
</script>

<div class="intro">
	<ToneTile {tone} size={40}><Glyph size={18} /></ToneTile>
	<div class="copy">
		<h2 class="title" {id}>{title}</h2>
		{#if description}<p class="desc">{description}</p>{/if}
		{#if children}<div class="desc">{@render children()}</div>{/if}
	</div>
</div>

<style>
	.intro {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.copy {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.title {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--track-headline);
		color: var(--text-default);
	}
	.desc {
		font-size: var(--text-callout);
		line-height: 1.25rem;
		color: var(--text-muted);
		text-wrap: pretty;
	}
	.desc :global(strong) {
		color: var(--text-default);
		font-weight: var(--weight-semibold);
	}
	.desc :global(code) {
		font-family: var(--font-mono);
		font-size: 0.92em;
		color: var(--text-default);
	}
</style>
