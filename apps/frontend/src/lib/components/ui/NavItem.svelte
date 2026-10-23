<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Icon } from './types';

	let {
		label,
		href,
		icon = undefined,
		active = false,
		count = undefined,
		leading = undefined
	}: {
		label: string;
		href: string;
		icon?: Icon;
		active?: boolean;
		count?: number;
		leading?: Snippet;
	} = $props();
</script>

<a {href} class="item" class:item--active={active} aria-current={active ? 'page' : undefined}>
	{#if leading}
		{@render leading()}
	{:else if icon}
		{@const Glyph = icon}
		<Glyph size={16} aria-hidden="true" />
	{/if}
	<span class="label">{label}</span>
	{#if count !== undefined}<span class="count">{count}</span>{/if}
</a>

<style>
	.item {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-shrink: 0;
		height: var(--nav-row-h, 2rem);
		padding: 0 0.625rem;
		border-radius: var(--radius-control);
		color: var(--text-muted);
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		text-decoration: none;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.item:hover {
		background: color-mix(in oklab, var(--neutral-10) 5%, transparent);
		color: var(--text-default);
	}
	.item--active,
	.item--active:hover {
		background: var(--nav-active-bg, var(--bg-sheet));
		color: var(--text-default);
		box-shadow: var(
			--nav-active-shadow,
			0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 8%, transparent),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 10%, transparent),
			0 2px 8px -2px color-mix(in oklab, var(--neutral-10) 8%, transparent)
		);
	}
	.label {
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}
</style>
