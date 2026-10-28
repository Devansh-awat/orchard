<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Box, Database, Timer } from 'lucide-svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
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
		presence?: boolean;
	} = $props();

	const KIND_ICON = { deployment: Box, database: Database, job: Timer };
	const KindIcon = $derived(KIND_ICON[kind]);
	const quiet = $derived(status.kind === 'success' || status.kind === 'neutral');
</script>

<ListRow title={name} {href} {actions} {presence}>
	{#snippet leading()}
		<span class="tile">
			{#if image}
				<RemoteImg src={image} class="tile-img" />
			{:else}
				<KindIcon size={16} />
			{/if}
			<span class="dot"><StatusDot meta={status} size={8} /></span>
		</span>
	{/snippet}
	{#snippet titleSuffix()}
		{#if !quiet}<span class="state state--{status.kind}">{status.label}</span>{/if}
	{/snippet}
	{#snippet subtitle()}
		{#if url}<span class="url">{url}</span>{/if}
		{#if url && detail}<span aria-hidden="true">·</span>{/if}
		{#if detail}<span class="detail">{detail}</span>{/if}
	{/snippet}
	{#snippet trailing()}
		{#if updatedAt}<RelativeTime date={updatedAt} />{/if}
	{/snippet}
</ListRow>

<style>
	.tile {
		position: relative;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: linear-gradient(var(--bg-surface), var(--neutral-2));
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 8%, transparent);
		color: var(--text-muted);
	}
	.tile :global(.tile-img) {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: calc(0.25rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.dot {
		position: absolute;
		right: -0.1875rem;
		bottom: -0.1875rem;
		display: flex;
		padding: 0.125rem;
		border-radius: 50%;
		background: var(--bg-surface);
	}
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
</style>
