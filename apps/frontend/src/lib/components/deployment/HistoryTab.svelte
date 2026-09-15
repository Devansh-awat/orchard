<script lang="ts">
	import { Loader2, GitBranch, GitCommit, RotateCcw } from 'lucide-svelte';
	import { History, RefreshCw, Terminal } from '@jis3r/icons';
	import { createQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { apiFetch, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import { slide } from '$lib/utils/transitions';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { formatBuildDurationBetween, formatRelativeTime } from '$lib/utils/format';
	import { SectionCard, StatusBadge, statusMeta, Button, EmptyState } from '$lib/components/ui';
	import type { Deployment } from '$lib/types/deployment';

	interface BuildRun {
		id: string;
		status: string;
		triggerType: string;
		commitSha?: string | null;
		commitMessage?: string | null;
		commitAuthorUsername?: string | null;
		branch?: string | null;
		detail?: string | null;
		createdAt: string;
	}

	let {
		deployment,
		rebuilding,
		rollingBackId = null,
		onRebuild,
		onOpenLogModal,
		onRollback,
		onViewBuildLogs
	}: {
		deployment: Deployment;
		rebuilding: boolean;
		rollingBackId?: string | null;
		onRebuild: () => void;
		onOpenLogModal: (historyId: string) => void;
		onRollback: (historyId: string) => void;
		onViewBuildLogs: () => void;
	} = $props();

	const isBuilding = $derived(
		deployment.buildStatus === 'building' ||
			deployment.buildStatus === 'queued' ||
			deployment.buildStatus === 'pending'
	);

	const runsQuery = createQuery(() => ({
		queryKey: ['build-runs', deployment.id],
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/build-runs?limit=20`);
			if (!res.ok) throw new Error(`build-runs ${res.status}`);
			return (await res.json()) as BuildRun[];
		},
		enabled: !!deployment.id,
		refetchInterval: 60_000,
		refetchIntervalInBackground: false
	}));

	const pendingRuns = $derived(
		(runsQuery.data ?? []).filter((run) => run.status === 'skipped' || run.status === 'scheduled')
	);

	type Row =
		| {
				kind: 'image';
				key: string;
				at: number;
				history: NonNullable<Deployment['imageHistory']>[number];
		  }
		| { kind: 'run'; key: string; at: number; run: BuildRun };

	const rows = $derived(
		[
			...(deployment.imageHistory ?? []).map((history): Row => ({
				kind: 'image',
				key: `image:${history.id}`,
				at: new Date(history.createdAt).getTime(),
				history
			})),
			...pendingRuns.map((run): Row => ({
				kind: 'run',
				key: `run:${run.id}`,
				at: new Date(run.createdAt).getTime(),
				run
			}))
		].sort((a, b) => b.at - a.at)
	);

	const hasRows = $derived(rows.length > 0 || deployment.buildStatus === 'failed' || isBuilding);

	$effect(() => {
		const orgId = $selectedOrganization?.id ?? null;
		if (!orgId) return;
		return subscribeOrgEvents(orgId, (ev) => {
			if (ev.type === 'build.changed' && ev.id === deployment.id) {
				queryClient.invalidateQueries({ queryKey: ['build-runs', deployment.id] });
			}
		});
	});
</script>

<SectionCard title="Deployments">
	{#snippet actions()}
		{#if deployment.githubRepo}
			<Button variant="secondary" size="sm" onclick={onRebuild} disabled={rebuilding || isBuilding}>
				{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
						size={14}
						class="h-3.5 w-3.5"
					/>{/if}
				<span>Redeploy</span>
			</Button>
		{/if}
	{/snippet}

	{#if hasRows}
		<div class="ht-table" role="list">
			<div class="ht-row ht-row--head" aria-hidden="true">
				<span>Status</span>
				<span>Commit</span>
				<span>Built in</span>
				<span>Deployed</span>
				<span></span>
			</div>

			{#if isBuilding}
				<div class="ht-row" role="listitem" transition:slide={{ duration: 150 }}>
					<span class="ht-status">
						<StatusBadge meta={statusMeta('progress', 'Building', true)} />
					</span>
					<span class="ht-commit">
						<span class="ht-msg ht-msg--muted">Deployment in progress</span>
						<span class="ht-chips">
							<span class="ht-chip"
								><GitBranch class="h-2.5 w-2.5" />{deployment.githubBranch || 'main'}</span
							>
						</span>
					</span>
					<span class="ht-cell ht-cell--empty">–</span>
					<span class="ht-cell">just now</span>
					<span class="ht-actions">
						<Loader2 class="h-3.5 w-3.5 animate-spin text-muted" />
					</span>
				</div>
			{/if}

			{#if deployment.buildStatus === 'failed'}
				<div class="ht-row" role="listitem" transition:slide={{ duration: 150 }}>
					<span class="ht-status">
						<StatusBadge meta={statusMeta('error', 'Failed')} />
					</span>
					<span class="ht-commit">
						<span class="ht-msg">Deployment failed</span>
						{#if deployment.buildError}
							<span class="ht-error" title={deployment.buildError.split('\n')[0]}
								>{deployment.buildError.split('\n')[0]}</span
							>
						{/if}
					</span>
					<span class="ht-cell ht-cell--empty">–</span>
					<span class="ht-cell">recently</span>
					<span class="ht-actions">
						{#if deployment.buildLogs || deployment.buildError}
							<Button variant="ghost" size="sm" onclick={onViewBuildLogs}>
								<Terminal size={14} class="h-3.5 w-3.5" />
								<span>Logs</span>
							</Button>
						{/if}
					</span>
				</div>
			{/if}

			{#each rows as row, _hi (row.key)}
				{#if row.kind === 'run'}
					{@const run = row.run}
					{@const queued = run.status === 'scheduled'}
					<div class="ht-row" class:ht-row--superseded={!queued} role="listitem">
						<span class="ht-status">
							<StatusBadge
								meta={queued
									? statusMeta('info', 'Queued', true)
									: statusMeta('neutral', 'Superseded')}
							/>
						</span>
						<span class="ht-commit">
							<span class="ht-msg ht-msg--muted" title={run.commitMessage ?? undefined}>
								{run.commitMessage?.split('\n')[0] || 'Queued deploy'}
							</span>
							<span class="ht-chips">
								{#if run.branch}
									<span class="ht-chip"><GitBranch class="h-2.5 w-2.5" />{run.branch}</span>
								{/if}
								{#if run.commitSha && deployment.githubRepo}
									<a
										href="{deployment.githubRepo.replace(/\.git$/, '')}/commit/{run.commitSha}"
										target="_blank"
										rel="noopener noreferrer"
										class="ht-chip ht-chip--link"
									>
										<GitCommit class="h-2.5 w-2.5" />
										<span class="ht-mono">{run.commitSha.slice(0, 7)}</span>
									</a>
								{:else if run.commitSha}
									<span class="ht-chip">
										<GitCommit class="h-2.5 w-2.5" />
										<span class="ht-mono">{run.commitSha.slice(0, 7)}</span>
									</span>
								{/if}
							</span>
						</span>
						<span class="ht-cell ht-cell--empty">–</span>
						<span class="ht-cell ht-deployed">
							<span>{formatRelativeTime(new Date(run.createdAt))}</span>
							<span class="ht-sub">{queued ? 'pushed' : 'not built'}</span>
						</span>
						<span class="ht-actions ht-actions--note">
							{queued ? 'Waiting for a build slot' : run.detail || 'Superseded by a newer build'}
						</span>
					</div>
				{:else}
					{@const history = row.history}
					{@const rowFallbackMsg = history.commitSha
						? deployment.imageHistory?.find(
								(h) => h.commitMessage && h.commitSha === history.commitSha
							)?.commitMessage
						: undefined}
					{@const rowDisplayMsgFull = history.commitMessage || rowFallbackMsg}
					{@const rowDisplayMsg = rowDisplayMsgFull?.split('\n')[0].trim()}
					{@const rowBuildDuration = formatBuildDurationBetween(
						history.buildStartedAt,
						history.buildCompletedAt
					)}
					{@const rowAuthor = history.commitAuthorUsername
						? `@${history.commitAuthorUsername}`
						: history.commitAuthorName || null}
					<div
						class="ht-row"
						class:ht-row--live={history.isActive}
						role="listitem"
						{@attach motionStagger({ index: _hi, from: { y: 10 } })}
					>
						<span class="ht-status">
							<StatusBadge
								meta={history.isActive
									? statusMeta('success', 'Live', true)
									: statusMeta('neutral', 'Ready')}
							/>
						</span>
						<span class="ht-commit">
							{#if rowDisplayMsg}
								<span class="ht-msg" title={rowDisplayMsgFull}>{rowDisplayMsg}</span>
							{:else if history.branch}
								<span class="ht-msg ht-msg--muted">Deployed from {history.branch}</span>
							{:else}
								<span class="ht-msg ht-msg--muted">Image deployment</span>
							{/if}
							<span class="ht-chips">
								{#if history.branch}
									<span class="ht-chip"><GitBranch class="h-2.5 w-2.5" />{history.branch}</span>
								{/if}
								{#if history.commitSha && deployment.githubRepo}
									<a
										href="{deployment.githubRepo.replace(/\.git$/, '')}/commit/{history.commitSha}"
										target="_blank"
										rel="noopener noreferrer"
										class="ht-chip ht-chip--link"
									>
										<GitCommit class="h-2.5 w-2.5" />
										<span class="ht-mono">{history.commitSha.slice(0, 7)}</span>
									</a>
								{:else if history.commitSha}
									<span class="ht-chip">
										<GitCommit class="h-2.5 w-2.5" />
										<span class="ht-mono">{history.commitSha.slice(0, 7)}</span>
									</span>
								{/if}
							</span>
						</span>
						{#if rowBuildDuration}
							<span class="ht-cell ht-mono">{rowBuildDuration}</span>
						{:else}
							<span class="ht-cell ht-cell--empty">–</span>
						{/if}
						<span class="ht-cell ht-deployed">
							<span>{formatRelativeTime(new Date(history.createdAt))}</span>
							<span class="ht-sub">
								{#if history.triggerType === 'auto'}
									via GitHub
								{:else if history.triggerType === 'manual' && history.triggeredBy}
									by @{history.triggeredBy.username}
								{:else if rowAuthor}
									by {rowAuthor}
								{:else}
									manual
								{/if}
							</span>
						</span>
						<span class="ht-actions">
							<Button variant="ghost" size="sm" onclick={() => onOpenLogModal(history.id)}>
								<Terminal size={14} class="h-3.5 w-3.5" />
								<span>Logs</span>
							</Button>
							{#if !history.isActive}
								<Button
									variant="secondary"
									size="sm"
									onclick={() => onRollback(history.id)}
									disabled={!!rollingBackId}
									loading={rollingBackId === history.id}
								>
									{#if rollingBackId !== history.id}<RotateCcw size={14} class="h-3.5 w-3.5" />{/if}
									<span>Roll back</span>
								</Button>
							{/if}
						</span>
					</div>
				{/if}
			{/each}
		</div>
	{:else}
		<EmptyState
			title="No deployments yet"
			description={deployment.githubRepo
				? `Push a commit to ${deployment.githubBranch || 'main'} to trigger your first deployment.`
				: 'Deployments will appear here after your first deploy.'}
		>
			{#snippet icon()}<History size={28} />{/snippet}
		</EmptyState>
	{/if}
</SectionCard>

<style>
	.ht-table {
		display: flex;
		flex-direction: column;
	}
	.ht-row {
		display: grid;
		grid-template-columns: 6.5rem minmax(0, 1fr) 5rem 8.5rem 11.5rem;
		gap: var(--space-3);
		align-items: center;
		padding: var(--space-3) var(--space-2);
		border-top: 1px solid var(--rule);
	}
	.ht-row--superseded .ht-msg {
		text-decoration: line-through;
		text-decoration-color: var(--text-faint);
	}
	.ht-actions--note {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.ht-row--head {
		border-top: none;
		padding-top: 0;
		padding-bottom: var(--space-2);
	}
	.ht-row--head > span {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.ht-status {
		display: flex;
		align-items: center;
	}
	.ht-commit {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.ht-msg {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ht-msg--muted {
		color: var(--text-muted);
		font-weight: 450;
	}
	.ht-error {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--status-error);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ht-chips {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex-wrap: wrap;
	}
	.ht-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.0625rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--fill-quiet);
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		text-decoration: none;
		max-width: 100%;
		min-width: 0;
	}
	.ht-chip--link:hover {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}
	.ht-mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-variant-numeric: tabular-nums;
	}
	.ht-cell {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.ht-cell--empty {
		color: var(--text-faint);
	}
	.ht-deployed {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.ht-sub {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.ht-actions {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: var(--space-1);
	}
	@media (max-width: 760px) {
		.ht-row {
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas:
				'commit status'
				'deployed deployed'
				'actions actions';
			row-gap: var(--space-2);
		}
		.ht-row--head {
			display: none;
		}
		.ht-status {
			grid-area: status;
		}
		.ht-commit {
			grid-area: commit;
		}
		.ht-cell:not(.ht-deployed) {
			display: none;
		}
		.ht-deployed {
			grid-area: deployed;
			flex-direction: row;
			align-items: baseline;
			gap: var(--space-1);
		}
		.ht-actions {
			grid-area: actions;
			justify-content: flex-end;
		}
	}
</style>
