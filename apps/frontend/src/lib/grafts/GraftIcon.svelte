<script lang="ts">
	import { Puzzle } from 'lucide-svelte';

	let {
		icon,
		assetBase,
		size = 15
	}: { icon?: string; assetBase: string; size?: number } = $props();

	const kind = $derived(!icon ? 'fallback' : icon.trimStart().startsWith('<svg') ? 'svg' : 'image');
	const src = $derived(
		icon && kind === 'image'
			? /^(https?:)?\/\//.test(icon) || icon.startsWith('/')
				? icon
				: `${assetBase}/${icon}`
			: ''
	);
</script>

{#if kind === 'svg'}
	<span class="graft-icon" style={`width:${size}px;height:${size}px`}>{@html icon}</span>
{:else if kind === 'image'}
	<img class="graft-icon" {src} alt="" width={size} height={size} />
{:else}
	<Puzzle {size} />
{/if}

<style>
	.graft-icon {
		display: inline-flex;
		flex: none;
	}

	.graft-icon :global(svg) {
		width: 100%;
		height: 100%;
	}
</style>
