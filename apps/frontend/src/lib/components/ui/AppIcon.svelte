<script lang="ts">
	import { Box, Database, Timer } from 'lucide-svelte';
	import AuraTile from './AuraTile.svelte';
	import RemoteImg from './RemoteImg.svelte';

	let {
		name,
		kind = 'deployment',
		icon = undefined,
		size = 'md'
	}: {
		name: string;
		kind?: 'deployment' | 'database' | 'job';
		icon?: string | null;
		size?: 'xs' | 'sm' | 'md' | 'lg';
	} = $props();

	const GLYPH = { deployment: Box, database: Database, job: Timer };
	const Glyph = $derived(GLYPH[kind]);
	const glyphSize = $derived({ xs: 11, sm: 13, md: 16, lg: 20 }[size]);
	let failed = $state(false);
</script>

<span class="icon icon--{size}">
	{#if icon && !failed}
		<RemoteImg src={icon} class="img" onerror={() => (failed = true)} />
	{:else}
		<AuraTile {name} class="aura">
			<span class="glyph"><Glyph size={glyphSize} strokeWidth={2} /></span>
		</AuraTile>
	{/if}
</span>

<style>
	.icon {
		position: relative;
		display: block;
		flex-shrink: 0;
		overflow: hidden;
		background: var(--bg-surface);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 12%, transparent);
	}
	.icon--xs {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: calc(0.3125rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.icon--sm {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.icon--md {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: calc(0.5625rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.icon--lg {
		width: 2.75rem;
		height: 2.75rem;
		border-radius: calc(0.6875rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.icon :global(.img),
	.icon :global(.aura) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.glyph {
		display: grid;
		place-items: center;
		height: 100%;
		color: var(--on-media);
	}
</style>
