<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { auraColors, resolveColors } from './Aura.svelte';
	import { bakeBlur, colorsImage } from '$lib/components/aura/aura';

	let {
		name,
		image = undefined,
		class: className = '',
		children = undefined
	}: {
		name: string;
		image?: string | null;
		class?: string;
		children?: Snippet;
	} = $props();

	let host = $state<HTMLElement>();
	let baked = $state<string | null>(null);

	onMount(() => {
		if (!host) return;
		const source = image || colorsImage(resolveColors(host, auraColors(name)));
		if (source) bakeBlur(source).then((url) => (baked = url));
	});
</script>

<div bind:this={host} class="tile {className}" class:tile--ready={!!baked}>
	<div class="paint" style:background-image={baked ? `url("${baked}")` : undefined}></div>
	{#if children}<div class="over">{@render children()}</div>{/if}
</div>

<style>
	.tile {
		position: relative;
		overflow: hidden;
		background: var(--bg-active);
		isolation: isolate;
	}
	.paint {
		position: absolute;
		inset: -20%;
		z-index: -1;
		background-size: cover;
		background-position: center;
		opacity: 0;
		transform: rotate(18deg) scale(1.15);
		transition: opacity 500ms ease;
	}
	.tile--ready .paint {
		opacity: 1;
	}
	.over {
		position: relative;
		height: 100%;
	}
</style>
