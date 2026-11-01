<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title = undefined,
		description = undefined,
		actions = undefined,
		footer = undefined,
		flush = false,
		fill = false,
		size = 'md',
		tone = 'default',
		class: className = '',
		children = undefined
	}: {
		title?: string;
		description?: string;
		actions?: Snippet;
		footer?: Snippet;
		flush?: boolean;
		fill?: boolean;
		size?: 'sm' | 'md';
		tone?: 'default' | 'danger';
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<section class="section section--{tone} section--{size} {className}" class:section--fill={fill}>
	{#if title || actions}
		<header class="head">
			<div class="heading">
				{#if title}<h2 class="title">{title}</h2>{/if}
				{#if description}<p class="desc">{description}</p>{/if}
			</div>
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</header>
	{/if}
	{#if children}
		<div class="body" class:body--flush={flush}>{@render children()}</div>
	{/if}
	{#if footer}<footer class="foot">{@render footer()}</footer>{/if}
</section>

<style>
	@property --section-control-inset {
		syntax: '<length>';
		inherits: true;
		initial-value: 0px;
	}
	.section {
		--section-pad: 1rem;
		--section-control-h: 1.75rem;
		--section-title-gap: 0.75rem;
		min-width: 0;
		border-radius: calc(var(--section-r, var(--radius-card)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		overflow: clip;
	}
	.section--fill {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
	}
	.section--fill .body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.section--danger {
		background: color-mix(in oklab, var(--status-error) 5%, var(--bg-surface));
		box-shadow:
			0 0 0 1px color-mix(in oklab, var(--status-error) 24%, var(--border-default)),
			0 1px 2px rgb(0 0 0 / 0.04);
	}
	.section--danger .title {
		color: var(--status-error);
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: var(--section-pad) var(--section-pad) 0;
	}
	.head:last-child {
		padding-bottom: var(--section-pad);
	}
	.heading {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.title {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		text-box: trim-both cap alphabetic;
		font-weight: var(--weight-semibold);
		color: var(--text-default);
	}
	.desc {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.actions {
		--section-control-shift: calc(0.5cap - var(--section-control-h) / 2);
		display: flex;
		align-items: center;
		height: var(--section-control-h);
		gap: 0.5rem;
		flex-shrink: 0;
		margin-top: var(--section-control-shift);
		margin-right: var(--section-control-shift);
		font-size: var(--text-headline);
		--section-control-inset: calc(var(--section-pad) + var(--section-control-shift));
	}
	.head:last-child .actions {
		margin-bottom: var(--section-control-shift);
	}
	.actions:not(:has(:global(button, a, input, .sb, .pill))) {
		margin-right: 0;
	}
	.actions > :global(:is(.sb, .pill)) {
		box-sizing: border-box;
		min-height: var(--section-control-h);
		padding-inline: 0.75rem;
		border-radius: 999px;
	}
	.actions > :global(.button) {
		border-radius: 999px;
		corner-shape: round;
	}
	.actions > :global(.seg) {
		--radius-control: calc(var(--section-r, var(--radius-card)) - var(--section-control-inset));
	}
	.body {
		padding: var(--section-title-gap) var(--section-pad) var(--section-pad);
	}
	.body--flush {
		padding: 0.75rem 0 0;
	}
	.body > :global(.ui-list:not(.ui-list--inset):first-child) {
		margin-top: -0.75rem;
	}
	.body > :global(.ui-list:not(.ui-list--inset):last-child) {
		margin-bottom: -0.75rem;
	}
	.head:last-child .heading > :last-child:not(.title) {
		text-box: trim-end text alphabetic;
	}
	.head + .body--flush {
		padding-top: 0.75rem;
	}
	.section--sm {
		--section-pad: 0.75rem;
	}
	.section--sm .title,
	.section--sm .actions {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
	.section--sm .head + .body--flush {
		padding-top: 0.25rem;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem;
		border-top: 1px solid var(--border-default);
		background: var(--bg-sunken);
	}
</style>
