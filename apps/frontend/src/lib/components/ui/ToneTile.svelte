<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { StatusKind } from './status';

	let {
		tone = 'neutral',
		size = 36,
		solid = false,
		class: klass = '',
		label = undefined,
		children
	}: {
		tone?: StatusKind | 'accent';
		size?: number;
		solid?: boolean;
		class?: string;
		label?: string;
		children: Snippet;
	} = $props();
</script>

<span
	class="ui-tone-tile ui-tone-tile--{tone} {klass}"
	class:ui-tone-tile--solid={solid}
	style="width: {size}px; height: {size}px;"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	{@render children()}
</span>

<style>
	.ui-tone-tile {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: calc(var(--tile-r, var(--radius-md)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--fill-quiet);
		color: var(--text-muted);
		flex-shrink: 0;
		overflow: hidden;
	}
	.ui-tone-tile--success {
		background: var(--status-success-bg);
		color: var(--status-success);
	}
	.ui-tone-tile--error {
		background: var(--status-error-bg);
		color: var(--status-error);
	}
	.ui-tone-tile--warning {
		background: var(--status-warning-bg);
		color: var(--status-warning);
	}
	.ui-tone-tile--info {
		background: var(--status-info-bg);
		color: var(--status-info);
	}
	.ui-tone-tile--progress {
		background: var(--status-progress-bg);
		color: var(--status-progress);
	}
	.ui-tone-tile--accent {
		background: color-mix(in oklab, var(--accent-solid) 12%, transparent);
		color: var(--accent-9);
	}
	.ui-tone-tile--solid.ui-tone-tile--accent {
		background: var(--accent-solid);
	}
	.ui-tone-tile--solid {
		color: var(--text-on-accent);
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, var(--text-on-accent) 22%, transparent),
			0 1px 2px color-mix(in srgb, var(--text-default) 12%, transparent);
	}
	.ui-tone-tile--solid.ui-tone-tile--neutral {
		background: var(--status-neutral-solid);
		color: var(--on-solid);
	}
	.ui-tone-tile--solid.ui-tone-tile--success {
		background: var(--status-success-solid);
		color: var(--on-solid);
	}
	.ui-tone-tile--solid.ui-tone-tile--error {
		background: var(--status-error-solid);
		color: var(--on-solid);
	}
	.ui-tone-tile--solid.ui-tone-tile--warning {
		background: var(--status-warning-solid);
		color: var(--on-solid);
	}
	.ui-tone-tile--solid.ui-tone-tile--info {
		background: var(--status-info-solid);
		color: var(--on-solid);
	}
	.ui-tone-tile--solid.ui-tone-tile--progress {
		background: var(--status-progress-solid);
		color: var(--on-solid);
	}
</style>
