<script lang="ts">
	import { Boxes, Server } from 'lucide-svelte';

	let {
		runner,
		size = 24
	}: {
		runner: string | null | undefined;
		size?: 20 | 24;
	} = $props();

	const glyph = $derived(size === 20 ? 12 : 14);
</script>

<span class="tile" class:tile--sm={size === 20} aria-hidden="true">
	{#if runner === 'vercel'}
		<svg class="vercel" viewBox="0 0 24 24" width={glyph - 2} height={glyph - 2} aria-hidden="true">
			<path d="M12 2.5 22 19.5H2Z" fill="currentColor" />
		</svg>
	{:else if runner}
		<Boxes size={glyph} strokeWidth={1.75} />
	{:else}
		<Server size={glyph} strokeWidth={1.75} />
	{/if}
</span>

<style>
	.tile {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-xs);
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 22%, transparent),
			color-mix(in srgb, var(--accent) 8%, transparent)
		);
		color: var(--accent);
	}

	.tile--sm {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 0.3125rem;
	}

	.vercel {
		display: block;
	}
</style>
