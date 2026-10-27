<script module lang="ts">
	const BRAND_MARKS = new Set(['google', 'github', 'microsoft', 'gitlab']);

	export function hasProviderMark(preset?: string | null, iconUrl?: string | null) {
		return !!iconUrl || BRAND_MARKS.has(preset ?? '');
	}
</script>

<script lang="ts">
	import { Building2, KeyRound, ShieldCheck } from 'lucide-svelte';
	import IconTile from '$lib/components/ui/IconTile.svelte';

	let {
		preset = 'generic',
		size = 16,
		iconUrl = null
	}: { preset?: string; size?: number; iconUrl?: string | null } = $props();
</script>

{#if iconUrl}
	<span class="tile" style:--size="{size}px"><IconTile src={iconUrl} class="tile-img" /></span>
{:else if preset === 'google'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="M12.24 10.29v3.62h5.05c-.22 1.3-1.6 3.8-5.05 3.8-3.04 0-5.52-2.5-5.52-5.59s2.48-5.59 5.52-5.59c1.73 0 2.89.73 3.55 1.36l2.42-2.32C16.66 3.99 14.63 3 12.24 3 7.3 3 3.3 6.98 3.3 12s4 9 8.94 9c5.16 0 8.58-3.6 8.58-8.68 0-.58-.06-1.03-.14-1.47z"
		/>
	</svg>
{:else if preset === 'github'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48 0-.24-.01-1.03-.01-1.87-2.51.46-3.16-.61-3.36-1.17-.11-.29-.6-1.17-1.03-1.41-.35-.19-.85-.65-.01-.66.79-.01 1.35.73 1.54 1.03.9 1.51 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.93 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.28.1-2.65 0 0 .84-.27 2.75 1.03A9.4 9.4 0 0 1 12 6.8c.85 0 1.7.11 2.5.33 1.91-1.3 2.75-1.03 2.75-1.03.55 1.37.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.69 0 3.83-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .26.18.58.69.48A10.02 10.02 0 0 0 22 12c0-5.52-4.48-10-10-10z"
		/>
	</svg>
{:else if preset === 'microsoft'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path d="M3 3h8.5v8.5H3zm9.5 0H21v8.5h-8.5zM3 12.5h8.5V21H3zm9.5 0H21V21h-8.5z" />
	</svg>
{:else if preset === 'gitlab'}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="m12 21.4-3.3-10.2H4.4L12 21.4Zm0 0 3.3-10.2h4.3L12 21.4Zm7.6-10.2L21 6.9c.1-.4 0-.8-.4-1L19 4.7c-.3-.3-.8-.1-1 .3l-1.7 6.2h3.3Zm-15.2 0L3 6.9c-.1-.4 0-.8.4-1L5 4.7c.3-.3.8-.1 1 .3l1.7 6.2H4.4Zm4.3 0L12 2.6l3.3 8.6H8.7Z"
		/>
	</svg>
{:else if preset === 'saml'}
	<KeyRound {size} />
{:else if preset === 'generic' || preset === 'hackclub'}
	<ShieldCheck {size} />
{:else}
	<Building2 {size} />
{/if}

<style>
	.tile {
		display: inline-grid;
		flex-shrink: 0;
		width: var(--size);
		height: var(--size);
		overflow: hidden;
		border-radius: calc(var(--size) * 0.28);
		corner-shape: var(--corner);
		box-shadow: 0 0 0 0.5px color-mix(in oklab, currentColor 35%, transparent);
	}
	.tile :global(.tile-img) {
		width: 100%;
		height: 100%;
	}
</style>
