<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { StatusKind } from './status';

	let {
		tone = 'neutral',
		muted = false,
		struck = false,
		class: klass = '',
		time = undefined,
		tile,
		title,
		meta = undefined,
		actions = undefined,
		...rest
	}: {
		tone?: StatusKind;
		muted?: boolean;
		struck?: boolean;
		class?: string;
		time?: Snippet;
		tile: Snippet;
		title: Snippet;
		meta?: Snippet;
		actions?: Snippet;
	} & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
	class="ui-arow motion-echo echo--{tone} {klass}"
	class:ui-arow--muted={muted}
	class:ui-arow--struck={struck}
	role="listitem"
	{...rest}
>
	<div class="ui-arow-time">
		{#if time}{@render time()}{/if}
	</div>
	<div class="ui-arow-spine" aria-hidden="true"><span class="ui-arow-dot"></span></div>
	<div class="ui-arow-tile">{@render tile()}</div>
	<div class="ui-arow-main">
		<span class="ui-arow-title">{@render title()}</span>
		{#if meta}<span class="ui-arow-meta">{@render meta()}</span>{/if}
	</div>
	{#if actions}<div class="ui-arow-actions">{@render actions()}</div>{/if}
</div>

<style>
	.ui-arow {
		display: grid;
		grid-template-columns: 3.25rem 1rem 1.5rem minmax(0, 1fr) auto;
		gap: var(--space-2);
		align-items: center;
		min-height: 2.125rem;
		padding: 0.1875rem 0.5rem 0.1875rem 0;
		border-radius: var(--radius-sm);
		corner-shape: var(--corner);
		transition: background-color var(--dur-fast);
	}
	.ui-arow:hover {
		background-color: var(--bg-hover);
	}
	.ui-arow-time {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
		text-align: right;
		white-space: nowrap;
	}
	.ui-arow-spine {
		position: relative;
		align-self: stretch;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.ui-arow-spine::before {
		content: '';
		position: absolute;
		top: -0.1875rem;
		bottom: -0.1875rem;
		left: 50%;
		width: 1px;
		background: var(--rule);
	}
	.ui-arow-dot {
		position: relative;
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 50%;
		background: var(--echo-color, var(--border-strong));
		box-shadow: 0 0 0 2px var(--bg-surface);
	}
	.ui-arow--muted .ui-arow-dot {
		background: var(--border-strong);
	}
	.ui-arow-tile {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.ui-arow-main {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}
	.ui-arow-title {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		flex-shrink: 0;
		max-width: 60%;
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
	}
	.ui-arow--muted .ui-arow-title {
		font-weight: 500;
		color: var(--text-muted);
	}
	.ui-arow--struck .ui-arow-title {
		text-decoration: line-through;
		text-decoration-color: var(--text-faint);
	}
	.ui-arow-meta {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-1);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.ui-arow-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.125rem;
		white-space: nowrap;
		opacity: 0;
		transition: opacity var(--dur-fast);
	}
	.ui-arow:hover .ui-arow-actions,
	.ui-arow:focus-within .ui-arow-actions {
		opacity: 1;
	}
	@media (max-width: 760px) {
		.ui-arow {
			grid-template-columns: 1rem 1.5rem minmax(0, 1fr);
			grid-template-areas:
				'spine tile main'
				'spine time time'
				'spine actions actions';
			row-gap: 0.125rem;
		}
		.ui-arow-time {
			grid-area: time;
			text-align: left;
		}
		.ui-arow-spine {
			grid-area: spine;
		}
		.ui-arow-tile {
			grid-area: tile;
		}
		.ui-arow-main {
			grid-area: main;
			flex-wrap: wrap;
		}
		.ui-arow-title {
			max-width: 100%;
		}
		.ui-arow-actions {
			grid-area: actions;
			justify-content: flex-start;
			opacity: 1;
		}
	}
</style>
