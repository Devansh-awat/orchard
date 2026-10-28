<script lang="ts">
	import Widget from '$lib/components/ui/Widget.svelte';
	import ResourceTile from './ResourceTile.svelte';
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
					<ResourceTile kind={item.kind ?? 'deployment'} image={item.icon} />
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
		margin: -0.5rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem;
		border-radius: calc((var(--widget-r) - var(--widget-pad) + 0.5rem) * var(--corner-scale));
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
