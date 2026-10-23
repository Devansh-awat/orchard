<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Icon } from './types';

	let {
		label,
		href = undefined,
		onclick = undefined,
		icon = undefined,
		active = false,
		tone = 'default',
		count = undefined,
		leading = undefined,
		trailing = undefined
	}: {
		label: string;
		href?: string;
		onclick?: (e: MouseEvent) => void;
		icon?: Icon;
		active?: boolean;
		tone?: 'default' | 'danger';
		count?: number;
		leading?: Snippet;
		trailing?: Snippet;
	} = $props();
</script>

{#snippet inner()}
	{#if leading}
		<span class="lead">{@render leading()}</span>
	{:else if icon}
		{@const Glyph = icon}
		<span class="tile tile--{tone}"><Glyph size={14} aria-hidden="true" /></span>
	{/if}
	<span class="label">{label}</span>
	{#if count !== undefined}<span class="count count--{tone}">{count}</span>{/if}
	{#if trailing}{@render trailing()}{/if}
{/snippet}

{#if href}
	<a {href} class="item" class:item--active={active} aria-current={active ? 'page' : undefined}
		>{@render inner()}</a
	>
{:else}
	<button type="button" class="item" class:item--active={active} {onclick}>{@render inner()}</button
	>
{/if}

<style>
	.item {
		position: relative;
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		height: var(--nav-row-h, 2.25rem);
		padding: 0 0.5rem 0 0.375rem;
		border: none;
		border-radius: var(--nav-radius, 0.6875rem);
		corner-shape: var(--corner);
		background: none;
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		letter-spacing: -0.006em;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease,
			transform var(--spring-interactive-duration) var(--spring-interactive);
	}
	.item:hover {
		background: color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.item:active {
		transform: scale(0.98);
	}
	.item--active,
	.item--active:hover {
		background: var(--nav-active-bg);
		color: var(--nav-active-fg);
		box-shadow: var(--nav-active-shadow);
	}
	.tile {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.4375rem;
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 7%, transparent);
		color: var(--text-muted);
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.tile--danger {
		background: var(--red-solid);
		color: var(--on-solid);
	}
	.item--active .tile {
		background: var(--accent-solid);
		color: var(--on-solid);
	}
	.lead {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
	}
	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.count {
		display: grid;
		place-items: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.375rem;
		border-radius: 0.375rem;
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 8%, transparent);
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}
	.count--danger {
		background: color-mix(in oklab, var(--red-solid) 14%, transparent);
		color: var(--red-9);
	}
</style>
