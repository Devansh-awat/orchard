<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { ArrowRight, Sprout } from 'lucide-svelte';
	import { Skeleton, StatusDot } from '@orchard/graft-ui';
	import { sandboxStatus } from '../../lib/status';
	import { timeAgo } from '../../lib/utils/time';
	import { SandboxDisabledError, sandboxesQueryOptions } from '../../lib/queries/sandboxes';
	import { isSandboxTransitional, type SandboxListResponse } from '../../lib/types/sandbox';

	const sandboxesQuery = createQuery(() => ({
		...sandboxesQueryOptions(),
		refetchInterval: (query: { state: { data?: SandboxListResponse } }) => {
			const list = query.state.data?.sandboxes ?? [];
			return list.some((s) => isSandboxTransitional(s.status)) ? 5_000 : 30_000;
		}
	}));

	const disabled = $derived(sandboxesQuery.error instanceof SandboxDisabledError);
	const sandboxes = $derived(sandboxesQuery.data?.sandboxes ?? []);
	const maxSandboxes = $derived(sandboxesQuery.data?.maxSandboxes ?? null);
	const usedPct = $derived(
		maxSandboxes ? Math.min(100, Math.round((sandboxes.length / maxSandboxes) * 100)) : 0
	);
</script>

<div class="sut">
	{#if sandboxesQuery.isPending}
		<Skeleton height="8rem" />
	{:else if disabled}
		<p class="sut-disabled">Sandboxes are not available to you yet.</p>
	{:else}
		<div class="sut-meter">
			<div class="sut-meter-head">
				<span class="sut-meter-icon"><Sprout size={15} /></span>
				<span class="sut-meter-count">
					{#if maxSandboxes === null}
						{sandboxes.length} sandbox{sandboxes.length === 1 ? '' : 'es'}, no limit
					{:else}
						{sandboxes.length} of {maxSandboxes} sandbox{maxSandboxes === 1 ? '' : 'es'} used
					{/if}
				</span>
			</div>
			{#if maxSandboxes !== null}
			<div
				class="sut-meter-track"
				role="meter"
				aria-valuenow={sandboxes.length}
				aria-valuemin={0}
				aria-valuemax={maxSandboxes ?? 0}
				aria-label="Sandbox usage"
			>
				<div class="sut-meter-fill" style="width: {usedPct}%"></div>
			</div>
			{/if}
		</div>
		{#if sandboxes.length > 0}
			<div class="sut-list">
				{#each sandboxes as s (s.id)}
					<div class="sut-row">
						<StatusDot meta={sandboxStatus(s.status)} size={7} />
						<span class="sut-row-name">{s.name}</span>
						<span class="sut-row-when">
							{s.lastActiveAt ? `active ${timeAgo(s.lastActiveAt)}` : 'never active'}
						</span>
					</div>
				{/each}
			</div>
		{/if}
		<a href="/sandboxes" class="sut-link">
			Manage in Greenhouse <ArrowRight size={13} />
		</a>
	{/if}
</div>

<style>
	.sut {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 28rem;
	}

	.sut-disabled {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.sut-meter {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
	}

	.sut-meter-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sut-meter-icon {
		display: inline-flex;
		color: var(--accent);
	}

	.sut-meter-count {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}

	.sut-meter-track {
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
		overflow: hidden;
	}

	.sut-meter-fill {
		height: 100%;
		border-radius: var(--radius-pill);
		background: var(--accent);
	}

	.sut-list {
		display: flex;
		flex-direction: column;
	}

	.sut-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.25rem;
	}

	.sut-row-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sut-row-when {
		margin-left: auto;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
	}

	.sut-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		align-self: flex-start;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
	}

	.sut-link:hover {
		text-decoration: underline;
	}
</style>
