<script lang="ts">
	import { ChevronRight } from 'lucide-svelte';
	import Widget from '$lib/components/ui/Widget.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import type { FailingApp } from './sidebar';

	let { items, title = 'Needs attention' }: { items: FailingApp[]; title?: string } = $props();

	const crashing = resourceStatus('crashing');
</script>

{#if items.length > 0}
	<Widget {title}>
		{#snippet meta()}<span class="count">{items.length} failing</span>{/snippet}
		<div class="rows">
			{#each items as item (item.label)}
				<a class="row" href={item.href}>
					<span class="icon">
						<AppIcon name={item.label} kind={item.kind} icon={item.icon} size="sm" />
						<span class="dot"><StatusDot meta={crashing} size={7} /></span>
					</span>
					<span class="text">
						<span class="name">{item.label}</span>
						{#if item.reason}<span class="reason">{item.reason}</span>{/if}
					</span>
					{#if item.at}<span class="when"><RelativeTime date={item.at} /></span>{/if}
					<ChevronRight size={14} class="chev" />
				</a>
			{/each}
		</div>
	</Widget>
{/if}

<style>
	.count {
		color: var(--red-9);
		font-weight: var(--weight-semibold);
	}
	.rows {
		display: flex;
		flex-direction: column;
		margin: 0 -0.5rem -0.5rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem;
		border-radius: calc(0.625rem * var(--corner-scale));
		corner-shape: var(--corner);
		color: inherit;
		text-decoration: none;
		transition: background-color var(--dur-fast) ease;
	}
	.row:hover {
		background: var(--bg-hover);
	}
	.icon {
		position: relative;
		flex-shrink: 0;
	}
	.dot {
		position: absolute;
		right: -0.1875rem;
		bottom: -0.1875rem;
		display: flex;
		padding: 2px;
		border-radius: 50%;
		background: var(--bg-surface);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.name,
	.reason {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.name {
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
	}
	.reason {
		color: var(--text-muted);
		font-size: var(--text-caption);
	}
	.when {
		flex-shrink: 0;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
	}
	.row :global(.chev) {
		flex-shrink: 0;
		color: var(--text-faint);
	}
</style>
