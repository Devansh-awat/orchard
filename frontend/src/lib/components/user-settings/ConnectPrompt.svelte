<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronRight } from '@jis3r/icons';
	import { springHover } from '$lib/utils/motion.svelte';

	let {
		label,
		hint = '',
		icon,
		onclick,
	}: {
		label: string;
		hint?: string;
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
	{@attach springHover({ lift: -2, stiffness: 340, damping: 24 })}
>
	{#if icon}
		<div class="cp-icon">
			{@render icon()}
		</div>
	{/if}
	<div class="cp-text">
		<span class="cp-label">{label}</span>
		{#if hint}
			<span class="cp-hint">{hint}</span>
		{/if}
	</div>
	<div class="cp-arrow">
		<ChevronRight size={16} animate={hovered} />
	</div>
</button>

<style>
	.cp-root {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		width: 100%;
		padding: 0.875rem 1rem;
		border-radius: 0.75rem;
		border: 1px dashed color-mix(in srgb, var(--surface-border) 80%, transparent);
		background: none;
		cursor: pointer;
		color: var(--center-channel-color);
		text-align: left;
		transition: all 150ms;
	}
	.cp-root:hover {
		border-color: var(--button-bg);
		border-style: solid;
		background-color: color-mix(in srgb, var(--button-bg) 4%, transparent);
	}
	.cp-root:hover .cp-arrow {
		color: var(--button-bg);
		transform: translateX(2px);
	}
	.cp-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--center-channel-color) 7%, transparent);
		color: var(--center-channel-color);
		flex-shrink: 0;
	}
	.cp-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
	}
	.cp-label {
		font-size: 0.875rem;
		font-weight: 550;
	}
	.cp-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}
	.cp-arrow {
		color: var(--surface-muted);
		flex-shrink: 0;
		transition: all 150ms;
	}
</style>
