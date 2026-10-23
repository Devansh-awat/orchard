<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Icon } from './types';
	import Spinner from './Spinner.svelte';

	let {
		variant = 'secondary',
		size = 'md',
		href = undefined,
		type = 'button',
		loading = false,
		disabled = false,
		icon = undefined,
		iconRight = undefined,
		label = undefined,
		class: className = '',
		children,
		...rest
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		size?: 'md' | 'sm';
		href?: string;
		type?: 'button' | 'submit';
		loading?: boolean;
		disabled?: boolean;
		icon?: Icon;
		iconRight?: Icon;
		label?: string;
		class?: string;
		children?: Snippet;
		[key: string]: unknown;
	} = $props();

	const iconOnly = $derived(!children && !!icon);
	const iconSize = $derived(size === 'sm' ? 14 : 16);
</script>

{#snippet body()}
	{#if loading}
		<Spinner size={iconSize} />
	{:else if icon}
		{@const Leading = icon}
		<Leading size={iconSize} aria-hidden="true" />
	{/if}
	{#if children}<span class="label">{@render children()}</span>{/if}
	{#if iconRight && !loading}
		{@const Trailing = iconRight}
		<Trailing size={iconSize} aria-hidden="true" />
	{/if}
{/snippet}

{#if href && !disabled}
	<a
		{href}
		class="button button--{variant} button--{size} {className}"
		class:button--icon={iconOnly}
		aria-label={label}
		{...rest}>{@render body()}</a
	>
{:else}
	<button
		{type}
		class="button button--{variant} button--{size} {className}"
		class:button--icon={iconOnly}
		class:button--loading={loading}
		disabled={disabled || loading}
		aria-busy={loading || undefined}
		aria-label={label}
		{...rest}>{@render body()}</button
	>
{/if}

<style>
	.button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		flex-shrink: 0;
		height: 2rem;
		padding: 0 0.75rem;
		border-radius: var(--radius-control);
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		line-height: 1;
		white-space: nowrap;
		text-decoration: none;
		cursor: pointer;
		user-select: none;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease,
			opacity var(--dur-fast) ease,
			transform var(--spring-interactive-duration) var(--spring-interactive);
	}
	.button:active:not(:disabled) {
		transform: scale(0.97);
	}
	.button:disabled {
		cursor: default;
		opacity: 0.4;
	}
	.button--loading:disabled {
		opacity: 0.7;
	}
	.button--sm {
		height: 1.75rem;
		padding: 0 0.625rem;
		font-size: var(--text-callout);
		gap: 0.25rem;
	}
	.button--icon {
		width: 2rem;
		padding: 0;
	}
	.button--sm.button--icon {
		width: 1.75rem;
	}
	.label {
		display: block;
		text-box: trim-both cap alphabetic;
	}
	.label :global(svg) {
		position: relative;
		top: calc(0.5ex - 0.5cap);
		display: inline-block;
		vertical-align: middle;
	}

	.button--primary {
		background: var(--accent);
		color: var(--text-on-accent);
		box-shadow:
			inset 0 1px 0 rgb(255 255 255 / 0.14),
			0 1px 2px rgb(0 0 0 / 0.12);
	}
	.button--primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.button--secondary {
		background: var(--bg-raised);
		color: var(--text-default);
		box-shadow: var(--shadow-raised);
	}
	.button--secondary:hover:not(:disabled) {
		background: var(--bg-hover);
	}

	.button--ghost {
		background: transparent;
		color: var(--text-muted);
	}
	.button--ghost:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.button--danger {
		background: var(--red-3);
		color: var(--red-9);
	}
	.button--danger:hover:not(:disabled) {
		background: var(--red-4);
	}
</style>
