<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Layers, LayoutTemplate } from 'lucide-svelte';
	import ResourceTile from './ResourceTile.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import type { StatusMeta } from '$lib/components/ui/status';

	let {
		kind,
		name,
		status,
		href,
		url = undefined,
		detail = undefined,
		updatedAt = undefined,
		image = undefined,
		actions = undefined,
		stack = undefined,
		template = undefined,
		flush = false,
		presence = false
	}: {
		kind: 'deployment' | 'database' | 'job';
		name: string;
		status: StatusMeta;
		href: string;
		url?: string;
		detail?: string;
		updatedAt?: string | null;
		image?: string | null;
		actions?: Snippet;
		stack?: string;
		template?: { name: string; instance: string };
		flush?: boolean;
		presence?: boolean;
	} = $props();

	const quiet = $derived(status.kind === 'success' || status.kind === 'neutral');
</script>

<ListRow title={name} {href} {actions} {presence} {flush}>
	{#snippet leading()}
		<ResourceTile {kind} {image} {status} />
	{/snippet}
	{#snippet titleSuffix()}
		{#if stack}
			<span class="stack" title="Part of the {stack} compose stack"
				><Layers size={11} strokeWidth={2.25} aria-hidden="true" /><span class="stack-name"
					>{stack}</span
				></span
			>
		{/if}
		{#if template}
			<span
				class="stack"
				title="Part of {template.instance}, made from the {template.name} template"
				><LayoutTemplate size={11} strokeWidth={2.25} aria-hidden="true" /><span class="stack-name"
					>{template.name}</span
				></span
			>
		{/if}
		{#if !quiet}<span class="state state--{status.kind}">{status.label}</span>{/if}
	{/snippet}
	{#snippet subtitle()}
		{#if url}<span class="url" title={url}>{url}</span>{/if}
		{#if url && detail}<span aria-hidden="true">·</span>{/if}
		{#if detail}<span class="detail" title={detail}>{detail}</span>{/if}
	{/snippet}
	{#snippet trailing()}
		{#if updatedAt}<RelativeTime date={updatedAt} />{/if}
	{/snippet}
</ListRow>

<style>
	.state {
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	.state--error {
		color: var(--status-error);
	}
	.state--warning {
		color: var(--status-warning);
	}
	.state--progress {
		color: var(--status-progress);
	}
	.state--info {
		color: var(--status-info);
	}
	.url {
		flex-shrink: 1;
		min-width: 3rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.detail {
		flex-shrink: 10;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.stack {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
		max-width: 45%;
		height: 1.125rem;
		padding: 0 0.375rem;
		border-radius: var(--radius-pill);
		background: var(--bg-active);
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}
	.stack :global(svg) {
		flex-shrink: 0;
	}
	.stack-name {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
	}
</style>
