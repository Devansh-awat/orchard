<script lang="ts" module>
	import type { StatusMeta } from '$lib/components/ui/status';

	export type StackService = { id: string; name: string; status: StatusMeta };
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Layers } from 'lucide-svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';

	let {
		name,
		status,
		href,
		services,
		source = undefined,
		error = undefined,
		updatedAt = undefined,
		shown = 4,
		actions = undefined,
		presence = false
	}: {
		name: string;
		status: StatusMeta;
		href: string;
		services: StackService[];
		source?: string;
		error?: string | null;
		updatedAt?: string | null;
		shown?: number;
		actions?: Snippet;
		presence?: boolean;
	} = $props();

	const RANK = { error: 0, warning: 1, progress: 2, info: 3, neutral: 4, success: 5 };
	const ordered = $derived(
		services
			.map((s, i) => ({ s, i }))
			.sort((a, b) => RANK[a.s.status.kind] - RANK[b.s.status.kind] || a.i - b.i)
			.map(({ s }) => s)
	);
	const visible = $derived(ordered.slice(0, shown));
	const hidden = $derived(ordered.length - visible.length);
	const quiet = $derived(status.kind === 'success' || status.kind === 'neutral');
</script>

<ListRow title={name} {href} {actions} {presence}>
	{#snippet leading()}
		<span class="tile">
			<Layers size={16} />
			<span class="dot"><StatusDot meta={status} size={8} /></span>
		</span>
	{/snippet}
	{#snippet titleSuffix()}
		{#if !quiet}<span class="state state--{status.kind}">{status.label}</span>{/if}
	{/snippet}
	{#snippet subtitle()}
		{#if error}
			<span class="error">{error}</span>
		{:else}
			<span class="services">
				{#each visible as s (s.id)}
					{@const loud = s.status.kind !== 'success' && s.status.kind !== 'neutral'}
					<span class="service">
						<StatusDot meta={s.status} size={6} />
						<span>{s.name}</span>
						{#if loud}<span class="state state--{s.status.kind}"
								>{s.status.label.toLowerCase()}</span
							>{/if}
					</span>
				{:else}
					<span>No services</span>
				{/each}
				{#if hidden > 0}<span class="more">+{hidden}</span>{/if}
			</span>
			{#if source}
				<span aria-hidden="true">·</span>
				<span class="source">{source}</span>
			{/if}
		{/if}
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
	.services {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.625rem;
	}
	.service {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.3125rem;
	}
	.more {
		flex-shrink: 0;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.source {
		flex-shrink: 10;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--text-faint);
	}
	.error {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--status-error);
	}
</style>
