<script lang="ts">
	import type { Component } from 'svelte';
	import { slidingIndicator } from './slide.svelte';

	type TabDef = { id: string; label: string; badge?: string | number; icon?: Component };

	let {
		tabs,
		value = $bindable(''),
		variant = 'underline',
		label = 'Sections',
		icons = false
	}: {
		tabs: TabDef[];
		value?: string;
		variant?: 'underline' | 'toolbar';
		label?: string;
		icons?: boolean;
	} = $props();

	const els: Record<string, HTMLElement> = $state({});
</script>

<nav
	class="ui-tabs ui-tabs--{variant}"
	class:ui-tabs-card={variant === 'toolbar'}
	role="tablist"
	aria-label={label}
>
	<div class="ui-tabs-track">
		<span
			class="ui-tabs-ink ui-tabs-ink--{variant}"
			aria-hidden="true"
			{@attach slidingIndicator(() => els[value])}
		></span>
		{#each tabs as t (t.id)}
			{@const Icon = icons ? t.icon : undefined}
			<button
				bind:this={els[t.id]}
				type="button"
				class="ui-tab ui-tab--{variant}"
				class:ui-tab--active={value === t.id}
				aria-selected={value === t.id}
				role="tab"
				onclick={() => (value = t.id)}
			>
				{#if Icon}<Icon size={14} class="h-3.5 w-3.5" />{/if}
				<span>{t.label}</span>
				{#if t.badge !== undefined}<span class="ui-tab-badge">{t.badge}</span>{/if}
			</button>
		{/each}
	</div>
</nav>

<style>
	.ui-tabs {
		min-width: 0;
	}
	.ui-tabs-card {
		background-color: var(--bg-raised);
		border: none;
		box-shadow: var(--elev-1);
		border-radius: calc(var(--radius-xl) * var(--corner-scale));
		corner-shape: var(--corner);
		padding: var(--space-2);
	}
	.ui-tabs-track {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding-block: 2px;
		overflow-x: auto;
		scrollbar-width: none;
		-webkit-overflow-scrolling: touch;
	}
	.ui-tabs-track::-webkit-scrollbar {
		display: none;
	}
	.ui-tabs--underline .ui-tabs-track {
		border-bottom: 1px solid var(--border-default);
		gap: 0.25rem;
	}

	.ui-tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		border: none;
		background: none;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast),
			border-color var(--dur-fast);
	}
	.ui-tab:hover {
		color: var(--text-default);
	}
	.ui-tab:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring-color);
		outline-offset: -2px;
		border-radius: calc(var(--radius-sm) * var(--corner-scale));
		corner-shape: var(--corner);
	}

	.ui-tab--underline {
		padding: 0.5rem 0.75rem;
		margin-bottom: -1px;
		border-bottom: 2px solid transparent;
	}
	.ui-tab--underline.ui-tab--active {
		color: var(--text-default);
	}

	.ui-tab--toolbar {
		padding: var(--space-2) var(--space-3);
		border-radius: calc(var(--radius-md) * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.ui-tab--toolbar:hover {
		background-color: var(--fill-quiet);
	}
	.ui-tab--toolbar.ui-tab--active {
		color: var(--text-default);
	}
	.ui-tab--toolbar.ui-tab--active:hover {
		background-color: transparent;
	}
	.ui-tabs-ink {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}
	.ui-tabs-ink--underline::after {
		content: '';
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		height: 2px;
		background: var(--accent);
	}
	.ui-tabs-ink--toolbar {
		border-radius: calc(var(--radius-md) * var(--corner-scale));
		corner-shape: var(--corner);
		background-color: var(--fill-soft);
	}
	.ui-tabs-ink:global([data-ready]) {
		transition:
			transform var(--spring-glide-duration) var(--spring-glide),
			width var(--spring-glide-duration) var(--spring-glide);
	}

	.ui-tab-badge {
		font-size: var(--text-micro);
		font-weight: 600;
		line-height: 1;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: color-mix(in srgb, var(--text-default) 8%, transparent);
		color: var(--text-muted);
	}

	@media (max-width: 900px) {
		.ui-tabs-track {
			mask-image: linear-gradient(to right, black calc(100% - 2.5rem), transparent);
		}
	}
</style>
