<script lang="ts">
	import type { Snippet } from 'svelte';
	import { springHover } from '$lib/utils/motion.svelte';

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
	{@attach springHover({ lift: -1, stiffness: 450, damping: 24 })}
>
	{@render children(hovered)}
</button>

<style>
	.ib-root {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition: all 120ms;
	}
	.ib-root:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
	}
	.ib-root--danger:hover:not(:disabled) {
		color: var(--error-text-color);
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
	}
	.ib-root--save {
		color: var(--button-bg);
	}
	.ib-root--save:hover:not(:disabled) {
		color: var(--button-bg);
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
	}
	.ib-root:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
