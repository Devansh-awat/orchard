<script lang="ts">
	import { onMount } from 'svelte';
	import { GitCommit, Layers } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import { StatusBadge, buildRunStatus } from '$lib/components/ui';
	import { timeAgo } from '$lib/components/org-dashboard/helpers.svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';

	interface BuildRun {
		id: string;
		status: string;
		triggerType: string;
		commitSha?: string | null;
		commitMessage?: string | null;
		commitAuthorUsername?: string | null;
		branch?: string | null;
		detail?: string | null;
		scheduledAt: string;
		startedAt?: string | null;
		finishedAt?: string | null;
		createdAt: string;
	}

	let { deploymentId }: { deploymentId: string } = $props();

	let runs = $state<BuildRun[]>([]);
	let loaded = $state(false);

	const active = $derived(runs.filter((r) => r.status === 'building' || r.status === 'scheduled'));
	const history = $derived(runs.filter((r) => r.status !== 'building' && r.status !== 'scheduled'));
	const hasActive = $derived(active.length > 0);

	const TRIGGER_LABEL: Record<string, string> = {
		auto: 'Auto',
		manual: 'Manual',
		rebuild: 'Rebuild'
	};

	async function fetchRuns() {
		const res = await apiFetch(`/apiv1/deployments/${deploymentId}/build-runs`);
		if (res.ok) runs = await res.json();
		loaded = true;
	}

	onMount(() => {
		fetchRuns();
		const poll = setInterval(fetchRuns, 5000);
		return () => clearInterval(poll);
	});
</script>

{#if loaded && runs.length > 0}
	<div class="bq">
		{#if hasActive}
			<div class="bq-active" transition:slide={{ duration: 160 }}>
				<div class="bq-active-head">
					<Layers size={14} class="bq-active-icon" />
					<span class="bq-active-title">Build queue</span>
					<span class="bq-active-count">{active.length} active</span>
				</div>
				<div class="bq-rows">
					{#each active as run, i (run.id)}
						{@render runRow(run, i)}
					{/each}
				</div>
			</div>
		{/if}

		{#if history.length > 0}
			<div class="bq-section-label">Recent builds</div>
			<div class="bq-rows">
				{#each history as run, i (run.id)}
					{@render runRow(run, i)}
				{/each}
			</div>
		{/if}
	</div>
{/if}

{#snippet runRow(run: BuildRun, i: number)}
	<div class="bq-row" {@attach motionStagger({ index: i, from: { y: 6 } })}>
		<StatusBadge meta={buildRunStatus(run.status)} />
		{#if run.commitSha}
			<span class="bq-sha"><GitCommit size={12} />{run.commitSha.slice(0, 7)}</span>
		{/if}
		<span class="bq-msg">
			{run.commitMessage?.split('\n')[0] || run.detail || 'Build'}
		</span>
		<span class="bq-meta">
			<span class="bq-trigger">{TRIGGER_LABEL[run.triggerType] ?? run.triggerType}</span>
			<span class="bq-when">{timeAgo(run.startedAt || run.createdAt)}</span>
		</span>
	</div>
{/snippet}

<style>
	.bq {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.bq-active {
		border: 1px solid var(--status-info-border);
		background: var(--status-info-bg);
		border-radius: 0.75rem;
		padding: 0.75rem 0.875rem;
	}

	.bq-active-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.bq-active :global(.bq-active-icon) {
		color: var(--status-info);
	}

	.bq-active-title {
		font-size: 0.8125rem;
		font-weight: 650;
		color: var(--text-default);
	}

	.bq-active-count {
		font-size: 0.6875rem;
		font-weight: 550;
		color: var(--status-info);
		background: color-mix(in srgb, var(--status-info) 12%, transparent);
		border-radius: 999px;
		padding: 0.125rem 0.5rem;
		margin-left: auto;
	}

	.bq-section-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		padding: 0 0.25rem;
	}

	.bq-rows {
		display: flex;
		flex-direction: column;
	}

	.bq-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem 0.25rem;
		min-width: 0;
	}

	.bq-rows .bq-row:not(:last-child) {
		border-bottom: 1px solid var(--border-default);
	}

	.bq-sha {
		display: inline-flex;
		align-items: center;
		gap: 0.1875rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.75rem;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.bq-msg {
		font-size: 0.8125rem;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		flex: 1;
	}

	.bq-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.bq-trigger {
		font-size: 0.6875rem;
		font-weight: 550;
		color: var(--text-muted);
		background: var(--bg-sunken);
		border-radius: 999px;
		padding: 0.125rem 0.5rem;
	}

	.bq-when {
		font-size: 0.6875rem;
		color: var(--text-faint);
		white-space: nowrap;
	}

	@media (max-width: 560px) {
		.bq-msg {
			flex-basis: 100%;
			order: 3;
		}
	}
</style>
