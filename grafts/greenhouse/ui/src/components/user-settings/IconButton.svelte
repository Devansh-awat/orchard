<script lang="ts">
	import type { Snippet } from 'svelte';
	import { springHover, iconAnimation } from '@orchard/graft-ui/utils/motion.svelte';

	let {
		variant = 'default',
		disabled = false,
		title = '',
		onclick,
		children
	}: {
		variant?: 'default' | 'danger' | 'save';
		disabled?: boolean;
		title?: string;
		onclick: () => void;
		children: Snippet<[boolean]>;
	} = $props();

	// Only ever feeds an icon's `animate` prop, so it resolves through the tier.
	let hovered = $state(false);
</script>

<button
	class="ib-root ib-root--{variant}"
	{disabled}
	{title}
	type="button"
	{onclick}
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
	{@attach springHover({ lift: -1 })}
>
	{@render children(iconAnimation(hovered))}
</button>

<style>
	.ib-root {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-xs);
		border: none;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.ib-root:hover:not(:disabled) {
		color: var(--text-default);
		background-color: var(--fill-soft);
	}
	.ib-root--danger:hover:not(:disabled) {
		color: var(--status-error);
		background-color: color-mix(in srgb, var(--status-error) 8%, transparent);
	}
	.ib-root--save {
		color: var(--accent);
	}
	.ib-root--save:hover:not(:disabled) {
		color: var(--accent);
		background-color: var(--accent-subtle);
	}
	.ib-root:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
