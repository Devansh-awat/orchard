<script lang="ts">
	import { Box, Database, Globe, Layers, LayoutTemplate, Timer } from 'lucide-svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import type { StatusMeta } from '$lib/components/ui/status';

	let {
		kind,
		image = undefined,
		status = undefined
	}: {
		kind: 'deployment' | 'database' | 'job' | 'stack' | 'template' | 'domain';
		image?: string | null;
		status?: StatusMeta;
	} = $props();

	const KIND_ICON = {
		deployment: Box,
		database: Database,
		job: Timer,
		stack: Layers,
		template: LayoutTemplate,
		domain: Globe
	};
	const KindIcon = $derived(KIND_ICON[kind]);
	let failedSrc = $state<string | null>(null);
	const showImage = $derived(!!image && failedSrc !== image);
</script>

<span class="tile">
	{#if showImage}
		<RemoteImg src={image} class="tile-img" onerror={() => (failedSrc = image ?? null)} />
	{:else}
		<KindIcon size={16} />
	{/if}
	{#if status}<span class="dot"><StatusDot meta={status} size={8} /></span>{/if}
</span>

<style>
	.tile {
		position: relative;
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: linear-gradient(var(--bg-surface), var(--neutral-2));
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 8%, transparent);
		color: var(--text-muted);
	}
	.tile :global(.tile-img) {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: calc(0.25rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.dot {
		position: absolute;
		right: -0.1875rem;
		bottom: -0.1875rem;
		display: flex;
		padding: 0.125rem;
		border-radius: 50%;
		background: var(--bg-surface);
	}
</style>
