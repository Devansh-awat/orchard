<script lang="ts">
	import type { Snippet } from 'svelte';
	import { motionStagger, iconAnimation } from '@orchardlabs/graft-ui/utils/motion.svelte';

	let {
		title,
		description = '',
		icon,
		iconColor = 'default',
		badge,
		actions,
		children,
		index = 0
	}: {
		title: string;
		description?: string;
		icon?: Snippet<[boolean]>;
		iconColor?: 'default' | 'primary' | 'green' | 'amber' | 'blue';
		badge?: Snippet;
		actions?: Snippet;
		children: Snippet;
		index?: number;
	} = $props();

	// Only ever drives the icon's `animate` prop, so it resolves through the
	// motion tier rather than reporting raw hover.
	let headerHovered = $state(false);
</script>

<section class="ss-root" {@attach motionStagger({ index, from: { y: 12, opacity: 0 } })}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<header
		class="ss-header"
		onmouseenter={() => (headerHovered = true)}
		onmouseleave={() => (headerHovered = false)}
	>
		{#if icon}
			<div class="ss-icon ss-icon--{iconColor}">
				{@render icon(iconAnimation(headerHovered))}
			</div>
		{/if}
		<div class="ss-title-group">
			<h2 class="ss-title">{title}</h2>
			{#if description}
				<p class="ss-desc">{description}</p>
			{/if}
		</div>
		{#if badge}
			<div class="ss-badge-slot">
				{@render badge()}
			</div>
		{/if}
		{#if actions}
			<div class="ss-actions-slot">
				{@render actions()}
			</div>
		{/if}
	</header>
	<div class="ss-body">
		{@render children()}
	</div>
</section>

<style>
	.ss-root {
		border: none;
		border-radius: var(--radius-lg);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
	}
	.ss-header {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-5) var(--space-6);
	}
	.ss-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		flex-shrink: 0;
	}
	.ss-icon--default {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}
	.ss-icon--primary {
		background-color: var(--accent-subtle);
		color: var(--accent);
	}
	.ss-icon--green {
		background-color: color-mix(in srgb, var(--status-success) 10%, transparent);
		color: var(--status-success);
	}
	.ss-icon--amber {
		background-color: color-mix(in srgb, var(--status-warning) 12%, transparent);
		color: var(--status-warning);
	}
	.ss-icon--blue {
		background-color: color-mix(in srgb, var(--hue-blue) 10%, transparent);
		color: var(--hue-blue);
	}
	.ss-title-group {
		flex: 1;
		min-width: 0;
	}
	.ss-title {
		font-size: var(--text-title-3);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		margin: 0;
		line-height: 1.3;
	}
	.ss-desc {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0.125rem 0 0;
	}
	.ss-badge-slot {
		flex-shrink: 0;
	}
	.ss-actions-slot {
		flex-shrink: 0;
	}
	.ss-body {
		padding: 0 var(--space-6) var(--space-6);
	}
	@media (max-width: 640px) {
		.ss-header {
			padding: var(--space-4) var(--space-5);
		}
		.ss-body {
			padding: 0 var(--space-5) var(--space-5);
		}
	}
</style>
