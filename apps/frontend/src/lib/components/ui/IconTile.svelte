<script lang="ts">
	import type { Snippet } from 'svelte';
	import RemoteImg from './RemoteImg.svelte';

	// An icon tile that fills its squircle with the image and never leaves an
	// empty or gappy square:
	//   - the `fallback` (letter / emoji / swatch) is the always-present base layer,
	//     so it shows instantly and there is no empty square during the fetch
	//   - the image fades in *over* it once loaded; on error it renders nothing and
	//     the fallback simply stays
	//   - `tint` is a coloured plate painted as the image's OWN background, so a
	//     logo with transparency fills the tile with colour instead of letting the
	//     letter show through. It rides the image's opacity, so it only appears once
	//     the image has actually loaded, never a gradient flashing before a letter.
	let {
		src,
		alt = '',
		class: klass = '',
		tint,
		eager = false,
		onerror,
		fallback
	}: {
		src?: string | null;
		alt?: string;
		class?: string;
		tint?: string;
		eager?: boolean;
		onerror?: () => void;
		fallback?: Snippet;
	} = $props();
</script>

<span class="icon-tile {klass}">
	{#if fallback}
		<span class="icon-tile-fb">{@render fallback()}</span>
	{/if}
	{#if src}
		<RemoteImg
			{src}
			{alt}
			{eager}
			{onerror}
			class="icon-tile-img"
			style={tint ? `background: ${tint}` : undefined}
		/>
	{/if}
</span>

<style>
	.icon-tile {
		position: relative;
		display: inline-grid;
		overflow: hidden;
		flex-shrink: 0;
	}
	.icon-tile-fb {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
	}
	.icon-tile :global(.icon-tile-img) {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
