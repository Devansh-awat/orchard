<script lang="ts" module>
	export type ResourceKind = 'deployment' | 'database' | 'job' | 'ingress' | 'volume';
	export type ResourceListItem = { name: string; type: ResourceKind; note?: string };
</script>

<script lang="ts">
	import { Globe, HardDrive } from 'lucide-svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import ToneTile from '$lib/components/ui/ToneTile.svelte';

	let { items }: { items: ResourceListItem[] } = $props();

	const KIND: Record<ResourceKind, string> = {
		deployment: 'App',
		database: 'Database',
		job: 'Job',
		ingress: 'Public URL',
		volume: 'Storage'
	};
</script>

<ul class="resources">
	{#each items as item (`${item.type}:${item.name}`)}
		<li class="row">
			{#if item.type === 'ingress'}
				<ToneTile tone="info" size={24}><Globe size={13} /></ToneTile>
			{:else if item.type === 'volume'}
				<ToneTile tone="neutral" size={24}><HardDrive size={13} /></ToneTile>
			{:else}
				<AppIcon name={item.name} kind={item.type} size="sm" />
			{/if}
			<span class="name">{item.name}</span>
			<span class="kind">{item.note ?? KIND[item.type]}</span>
		</li>
	{/each}
</ul>

<style>
	.resources {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}
	.row :global(.ui-tone-tile) {
		--tile-r: 0.375rem;
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.kind {
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
</style>
