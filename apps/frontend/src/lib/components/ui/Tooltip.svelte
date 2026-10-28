<script lang="ts">
	import { Tooltip } from 'melt/builders';
	import type { Snippet } from 'svelte';
	import type { Placement } from '@floating-ui/dom';

	let {
		text,
		placement = 'top',
		shortcut = undefined,
		delay = 450,
		children
	}: {
		text: string;
		placement?: Placement;
		shortcut?: string;
		delay?: number;
		children: Snippet;
	} = $props();

	const tip = new Tooltip({
		openDelay: () => delay,
		closeDelay: 0,
		disableHoverableContent: true,
		floatingConfig: { computePosition: { placement }, offset: { mainAxis: 6 } }
	});
</script>

<span class="trigger" {...tip.trigger}>{@render children()}</span>
<div class="tip" {...tip.content}>
	{text}
	{#if shortcut}<kbd class="kbd">{shortcut}</kbd>{/if}
</div>

<style>
	.trigger {
		display: inline-flex;
		min-width: 0;
	}
	.tip {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 18rem;
		margin: 0;
		padding: 0.3125rem 0.5rem;
		border: none;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--neutral-10);
		color: var(--neutral-app);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: var(--weight-medium);
		box-shadow: var(--shadow-floating);
		pointer-events: none;
		opacity: 0;
		transform: scale(0.96);
		transition:
			opacity var(--fade-out) var(--curve-in),
			transform var(--spring-settle-duration) var(--spring-settle),
			display var(--fade-out) allow-discrete,
			overlay var(--fade-out) allow-discrete;
	}
	.tip:popover-open {
		opacity: 1;
		transform: none;
		transition:
			opacity var(--fade-in) var(--curve-out),
			transform var(--spring-snap-duration) var(--spring-snap),
			display var(--fade-in) allow-discrete,
			overlay var(--fade-in) allow-discrete;
	}
	@starting-style {
		.tip:popover-open {
			opacity: 0;
			transform: scale(0.96);
		}
	}
	.kbd {
		font-family: inherit;
		color: color-mix(in oklab, var(--neutral-app) 60%, transparent);
	}
</style>
