<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronRight } from '@jis3r/icons';
	import { springHover, iconAnimation } from '$lib/utils/motion.svelte';

	let {
		label,
		icon,
		onclick
	}: {
		label: string;
		icon?: Snippet;
		onclick: () => void;
	} = $props();

	let hovered = $state(false);
</script>

<button
	{onclick}
	class="cp-root"
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	{@attach springHover({ lift: -2 })}
>
	{#if icon}
		<div class="cp-icon">
			{@render icon()}
		</div>
	{/if}
	<span class="cp-label">{label}</span>
	<div class="cp-arrow">
		<ChevronRight size={16} animate={iconAnimation(hovered)} />
	</div>
</button>

<style>
	.cp-root {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		width: 100%;
		padding: 0.875rem var(--space-4);
		border-radius: var(--radius-md);
		border: 1px dashed color-mix(in srgb, var(--border-default) 80%, transparent);
		background: none;
		cursor: pointer;
		color: var(--text-default);
		text-align: left;
		transition:
			border-color var(--dur-base),
			background-color var(--dur-base);
	}
	.cp-root:hover {
		border-color: var(--accent);
		border-style: solid;
		background-color: color-mix(in srgb, var(--accent) 4%, transparent);
	}
	.cp-root:hover .cp-arrow {
		color: var(--accent);
		transform: translateX(2px);
	}
	.cp-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		background-color: var(--fill-soft);
		color: var(--text-default);
		flex-shrink: 0;
	}
	.cp-label {
		flex: 1;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
	}
	.cp-arrow {
		color: var(--text-muted);
		flex-shrink: 0;
		transition:
			color var(--dur-base),
			transform var(--dur-base);
	}
</style>
