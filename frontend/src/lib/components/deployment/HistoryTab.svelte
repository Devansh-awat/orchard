<script lang="ts">
	import { Loader2, GitBranch, GitCommit } from 'lucide-svelte';
	import { History, RefreshCw, Terminal } from '@jis3r/icons';
	import { slide } from 'svelte/transition';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { formatBuildDurationBetween } from '$lib/utils/format';
	import type { Deployment, ImageHistory } from '$lib/types/deployment';

	let {
		deployment,
		rebuilding,
		onRebuild,
		onOpenLogModal,
		onRollback,
		onViewBuildLogs,
	}: {
		deployment: Deployment;
		rebuilding: boolean;
		onRebuild: () => void;
		onOpenLogModal: (historyId: string) => void;
		onRollback: (historyId: string) => void;
		onViewBuildLogs: () => void;
	} = $props();

	const isBuilding = $derived(
		deployment.buildStatus === 'building' || deployment.buildStatus === 'queued' || deployment.buildStatus === 'pending'
	);
</script>

<div class="card rounded-2xl overflow-hidden">
	<div class="dep-list-header">
		<div>
			<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Deployments</p>
			<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
				{#if deployment.githubRepo}
					History of every build for <span class="font-mono">{deployment.githubRepo.replace('https://github.com/', '').replace(/\.git$/, '')}</span>
				{:else}
					History of every build
				{/if}
			</p>
		</div>
		{#if deployment.githubRepo}
			<button onclick={onRebuild} disabled={rebuilding} class="btn btn-secondary btn-sm">
				{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw size={14} class="h-3.5 w-3.5" />{/if}
				<span>Redeploy</span>
			</button>
		{/if}
	</div>

	{#if (deployment.imageHistory?.length ?? 0) > 0 || deployment.buildStatus === 'failed' || isBuilding}
		<div class="dep-list-table">
			<div class="dep-list-row dep-list-row--head">
				<div class="dep-col-status">Status</div>
				<div class="dep-col-commit">Commit</div>
				<div class="dep-col-built">Built</div>
				<div class="dep-col-author">Author</div>
				<div class="dep-col-meta">Created</div>
				<div class="dep-col-actions"></div>
			</div>

			{#if isBuilding}
				<div class="dep-list-row dep-list-row--building" transition:slide={{ duration: 150 }}>
					<div class="dep-col-status">
						<span class="dep-status">
							<span class="dep-status-dot dep-status-dot--building"></span>
							<span class="dep-status-label">Building</span>
						</span>
					</div>
					<div class="dep-col-commit">
						<div class="dep-commit-stack">
							<span class="dep-commit-msg dep-commit-msg--muted">Build in progress…</span>
							<div class="dep-commit-meta">
								<span class="dep-mini-chip"><GitBranch class="h-2.5 w-2.5" />{deployment.githubBranch || 'main'}</span>
							</div>
						</div>
					</div>
					<div class="dep-col-built">
						<span class="dep-meta-text dep-meta-text--placeholder">—</span>
					</div>
					<div class="dep-col-author">
						<span class="dep-meta-text dep-meta-text--placeholder">—</span>
					</div>
					<div class="dep-col-meta">
						<span class="dep-meta-text">just now</span>
					</div>
					<div class="dep-col-actions">
						<Loader2 class="h-3.5 w-3.5 animate-spin" style="color: var(--surface-muted);" />
					</div>
				</div>
			{/if}

			{#if deployment.buildStatus === 'failed'}
				<div class="dep-list-row dep-list-row--failed" transition:slide={{ duration: 150 }}>
					<div class="dep-col-status">
						<span class="dep-status">
							<span class="dep-status-dot dep-status-dot--failed"></span>
							<span class="dep-status-label" style="color: #ef4444;">Error</span>
						</span>
					</div>
					<div class="dep-col-commit">
						<div class="dep-commit-stack">
							<span class="dep-commit-msg" style="color: #ef4444;">Build failed</span>
							{#if deployment.buildError}
								<div class="dep-commit-meta">
									<span class="dep-meta-text font-mono" style="color: color-mix(in srgb, #ef4444 60%, var(--surface-muted)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">{deployment.buildError.split('\n')[0]}</span>
								</div>
							{/if}
						</div>
					</div>
					<div class="dep-col-built">
						<span class="dep-meta-text dep-meta-text--placeholder">—</span>
					</div>
					<div class="dep-col-author">
						<span class="dep-meta-text dep-meta-text--placeholder">—</span>
					</div>
					<div class="dep-col-meta">
						<span class="dep-meta-text">recently</span>
					</div>
					<div class="dep-col-actions">
						{#if deployment.buildLogs || deployment.buildError}
							<button onclick={onViewBuildLogs} class="dep-action-btn" title="View build logs">
								<Terminal size={14} class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				</div>
			{/if}

			{#each deployment.imageHistory ?? [] as history, _hi}
				{@const timeAgo = (() => {
					const diff = Date.now() - new Date(history.createdAt).getTime();
					const mins = Math.floor(diff / 60000);
					if (mins < 1) return 'just now';
					if (mins < 60) return `${mins}m ago`;
					const hrs = Math.floor(mins / 60);
					if (hrs < 24) return `${hrs}h ago`;
					const days = Math.floor(hrs / 24);
					if (days < 30) return `${days}d ago`;
					return new Date(history.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
				})()}
				{@const rowFallbackMsg = history.commitSha
					? deployment.imageHistory?.find((h) => h.commitMessage && h.commitSha === history.commitSha)?.commitMessage
					: undefined}
				{@const rowDisplayMsgFull = history.commitMessage || rowFallbackMsg}
				{@const rowDisplayMsg = rowDisplayMsgFull?.split('\n')[0].trim()}
				{@const rowBuildDuration = formatBuildDurationBetween(history.buildStartedAt, history.buildCompletedAt)}
				{@const rowAuthor = history.commitAuthorUsername || history.commitAuthorName || null}
				<div class="dep-list-row" class:dep-list-row--active={history.isActive} {@attach motionStagger({ index: _hi, stride: 0.035, from: { y: 10 } })}>
					<div class="dep-col-status">
						<span class="dep-status">
							<span class="dep-status-dot dep-status-dot--ready" class:dep-status-dot--live={history.isActive}></span>
							<span class="dep-status-label">Ready</span>
						</span>
						{#if history.isActive}
							<span class="dep-current-pill">Current</span>
						{/if}
					</div>
					<div class="dep-col-commit">
						<div class="dep-commit-stack">
							{#if rowDisplayMsg}
								<span class="dep-commit-msg" title={rowDisplayMsgFull}>{rowDisplayMsg}</span>
							{:else if history.branch}
								<span class="dep-commit-msg dep-commit-msg--muted">Deployed from {history.branch}</span>
							{:else}
								<span class="dep-commit-msg dep-commit-msg--muted">Image build</span>
							{/if}
							<div class="dep-commit-meta">
								{#if history.branch}
									<span class="dep-mini-chip"><GitBranch class="h-2.5 w-2.5" />{history.branch}</span>
								{/if}
								{#if history.commitSha && deployment.githubRepo}
									<a
										href="{deployment.githubRepo.replace(/\.git$/, '')}/commit/{history.commitSha}"
										target="_blank"
										rel="noopener noreferrer"
										class="dep-mini-chip dep-mini-chip--link"
										onclick={(e) => e.stopPropagation()}
									>
										<GitCommit class="h-2.5 w-2.5" />
										<span class="font-mono">{history.commitSha.slice(0, 7)}</span>
									</a>
								{:else if history.commitSha}
									<span class="dep-mini-chip">
										<GitCommit class="h-2.5 w-2.5" />
										<span class="font-mono">{history.commitSha.slice(0, 7)}</span>
									</span>
								{/if}
							</div>
						</div>
					</div>
					<div class="dep-col-built">
						{#if rowBuildDuration}
							<span class="dep-meta-text dep-meta-text--mono">{rowBuildDuration}</span>
						{:else}
							<span class="dep-meta-text dep-meta-text--placeholder">—</span>
						{/if}
					</div>
					<div class="dep-col-author">
						{#if rowAuthor}
							<span class="dep-meta-text dep-meta-author">
								{history.commitAuthorUsername ? `@${history.commitAuthorUsername}` : rowAuthor}
							</span>
						{:else}
							<span class="dep-meta-text dep-meta-text--placeholder">—</span>
						{/if}
					</div>
					<div class="dep-col-meta">
						<span class="dep-meta-text">{timeAgo}</span>
						<span class="dep-meta-sub">
							{#if history.triggerType === 'manual' && history.triggeredBy}
								by <span class="dep-meta-user">@{history.triggeredBy.username}</span>
							{:else if history.triggerType === 'auto'}
								via GitHub
							{:else}
								manual
							{/if}
						</span>
					</div>
					<div class="dep-col-actions">
						<button onclick={() => onOpenLogModal(history.id)} class="dep-action-btn" title="View logs">
							<Terminal size={14} class="h-3.5 w-3.5" />
						</button>
						{#if !history.isActive}
							<button onclick={() => onRollback(history.id)} class="dep-action-btn dep-action-btn--primary" title="Promote to production">
								<RefreshCw size={14} class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="dep-list-empty">
			<span style="color: var(--surface-muted);"><History size={32} class="h-8 w-8 mx-auto mb-2" /></span>
			<p class="text-sm font-medium" style="color: var(--center-channel-color);">No deployments yet</p>
			<p class="text-xs mt-1" style="color: var(--surface-muted);">
				{#if deployment.githubRepo}
					Push a commit to {deployment.githubBranch || 'main'} to trigger your first deployment.
				{:else}
					Builds will appear here after your first deploy.
				{/if}
			</p>
		</div>
	{/if}
</div>
