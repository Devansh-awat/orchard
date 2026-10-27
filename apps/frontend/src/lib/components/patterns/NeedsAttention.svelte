<script lang="ts">
	import Widget from '$lib/components/ui/Widget.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import { blurRiseList } from '$lib/components/ui/widgetMotion.svelte';
	import type { FailingApp } from './sidebar';

	let {
		items,
		title = 'Needs attention',
		arriving = []
	}: { items: FailingApp[]; title?: string; arriving?: string[] } = $props();

	const rise = blurRiseList();
</script>

{#if items.length > 0}
	<Widget {title}>
		<div class="rows">
			{#each items as item (item.label)}
				<a
					class="row"
					class:row--arriving={arriving.includes(item.label)}
					data-attention={item.label}
					href={item.href}
					{@attach rise(() => arriving.includes(item.label))}
				>
					<AppIcon name={item.label} kind={item.kind} icon={item.icon} size="sm" />
					<span class="text">
						<span class="name">{item.label}</span>
						{#if item.reason}<span class="reason">{item.reason}</span>{/if}
					</span>
				</a>
			{/each}
		</div>
	</Widget>
{/if}

<style>
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
	.row--arriving {
		opacity: 0;
	}
	.row:hover {
		background: var(--bg-hover);
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
	}
	.reason {
		color: var(--red-9);
		font-size: var(--text-caption);
	}
</style>
