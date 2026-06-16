<script lang="ts">
	import type { Snippet } from 'svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';

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

	let headerHovered = $state(false);
</script>

<section
	class="ss-root"
	{@attach motionStagger({ index, stride: 0.06, from: { y: 12, opacity: 0, scale: 0.985 } })}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<header
		class="ss-header"
		onmouseenter={() => (headerHovered = true)}
		onmouseleave={() => (headerHovered = false)}
	>
		{#if icon}
			<div class="ss-icon ss-icon--{iconColor}">
				{@render icon(headerHovered)}
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
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		overflow: hidden;
	}
	.ss-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1.25rem 1.5rem;
	}
	.ss-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
	}
	.ss-icon--default {
		background-color: color-mix(in srgb, var(--center-channel-color) 7%, transparent);
		color: var(--center-channel-color);
	}
	.ss-icon--primary {
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}
	.ss-icon--green {
		background-color: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}
	.ss-icon--amber {
		background-color: color-mix(in srgb, var(--away-indicator) 12%, transparent);
		color: var(--away-indicator);
	}
	.ss-icon--blue {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.ss-title-group {
		flex: 1;
		min-width: 0;
	}
	.ss-title {
		font-size: 0.9375rem;
		font-weight: 650;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}
	.ss-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.125rem 0 0;
	}
	.ss-badge-slot {
		flex-shrink: 0;
	}
	.ss-actions-slot {
		flex-shrink: 0;
	}
	.ss-body {
		padding: 0 1.5rem 1.5rem;
	}
	@media (max-width: 640px) {
		.ss-header {
			padding: 1rem 1.25rem;
		}
		.ss-body {
			padding: 0 1.25rem 1.25rem;
		}
	}
</style>
