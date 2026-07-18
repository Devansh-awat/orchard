<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronRight } from 'lucide-svelte';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';

	let {
		href,
		title,
		description = '',
		icon,
		index = 0
	}: {
		href: string;
		title: string;
		description?: string;
		icon?: Snippet<[boolean]>;
		index?: number;
	} = $props();

	let hovered = $state(false);
</script>

<a
	{href}
	class="slr-root"
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	{@attach motionStagger({ index, stride: 0.06, from: { y: 12, opacity: 0, scale: 0.985 } })}
	{@attach springHover({ lift: -1, stiffness: 420, damping: 24 })}
>
	{#if icon}
		<span class="slr-icon">{@render icon(hovered)}</span>
	{/if}
	<span class="slr-text">
		<span class="slr-title">{title}</span>
		{#if description}<span class="slr-desc">{description}</span>{/if}
	</span>
	<ChevronRight class="slr-chevron h-4 w-4" />
</a>

<style>
	.slr-root {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 1.125rem;
		border: 1px solid var(--border-default);
		border-radius: 0.875rem;
		background-color: var(--bg-surface);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.02);
		text-decoration: none;
		color: var(--text-default);
	}
	.slr-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--text-default) 7%, transparent);
		color: var(--text-default);
	}
	.slr-text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.slr-title {
		font-size: 0.875rem;
		font-weight: 600;
		line-height: 1.3;
	}
	.slr-desc {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-top: 0.0625rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.slr-root :global(.slr-chevron) {
		flex-shrink: 0;
		color: var(--text-faint);
		transition: color 120ms, transform 150ms ease;
	}
	.slr-root:hover :global(.slr-chevron) {
		color: var(--text-muted);
		transform: translateX(2px);
	}
</style>
