<script lang="ts">
	import { Loader2, ExternalLink, EllipsisVertical, Pencil, Square } from 'lucide-svelte';
	import { Play, RefreshCw, Trash2 } from '@jis3r/icons';
	import { motionStagger, springCollapse } from '$lib/utils/motion.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import { appUrl } from '$lib/appUrl';
	import { StatusBadge, Button, Menu, MenuItem } from '$lib/components/ui';
	import type { StatusMeta } from '$lib/components/ui';

	let {
		deployment,
		headerCollapsed,
		deploymentStatusChip,
		buildStatusChip = null,
		debugChips = [],
		repoUrl,
		rebuilding,
		restarting,
		stopped,
		stopping,
		starting,
		deleting,
		actionAnim,
		_isBuilding,
		onRebuild,
		onRestart,
		onStop,
		onStart,
		onRename,
		onShowDeleteModal,
		onTriggerActionAnim,
		onViewBuildLogs,
		_commitLead,
		_commitLeadMono,
		_activeBuild,
		_buildFailed,
		branch
	}: {
		deployment: any;
		headerCollapsed: boolean;
		deploymentStatusChip: StatusMeta;
		buildStatusChip?: StatusMeta | null;
		debugChips?: StatusMeta[];
		repoUrl: string | undefined;
		rebuilding: boolean;
		restarting: boolean;
		stopped: boolean;
		stopping: boolean;
		starting: boolean;
		deleting: boolean;
		actionAnim: Record<string, boolean>;
		_isBuilding: boolean;
		onRebuild: () => void;
		onRestart: () => void;
		onStop: () => void;
		onStart: () => void;
		onRename?: () => void;
		onShowDeleteModal: () => void;
		onTriggerActionAnim: (id: string) => void;
		onViewBuildLogs: () => void;
		_commitLead: string | null;
		_commitLeadMono: boolean;
		_activeBuild: any;
		_buildFailed: boolean;
		branch: string | undefined;
	} = $props();

	const repoLabel = $derived(
		deployment?.githubRepo
			? deployment.githubRepo.replace('https://github.com/', '').replace(/\.git$/, '')
			: null
	);
	const commitUrl = $derived(
		deployment?.githubRepo && _activeBuild?.commitSha
			? `${deployment.githubRepo.replace(/\.git$/, '')}/commit/${_activeBuild.commitSha}`
			: null
	);
</script>

{#snippet identity()}
	<div class="dh-identity">
		<h1 class="dh-name">{deployment.displayName || deployment.name}</h1>
		<StatusBadge meta={deploymentStatusChip} />
		{#if buildStatusChip}
			<StatusBadge meta={buildStatusChip} />
		{/if}
		{#if deployment.environment}
			<span class="dh-env-chip" title="Environment: {deployment.environment.name}">
				{deployment.environment.name}
			</span>
		{/if}
		{#each debugChips as chip (chip.label)}
			<StatusBadge meta={chip} />
		{/each}
	</div>
{/snippet}

{#snippet actions()}
	<div class="dh-actions">
		{#if repoUrl}
			<Button
				variant="primary"
				size="sm"
				onclick={onRebuild}
				disabled={rebuilding || _isBuilding}
				onmouseenter={() => onTriggerActionAnim('redeploy')}
			>
				{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
						size={14}
						animate={actionAnim.redeploy ?? false}
					/>{/if}
				<span>Redeploy</span>
			</Button>
		{/if}
		{#if stopped}
			<Button variant="primary" size="sm" onclick={onStart} disabled={starting}>
				{#if starting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play size={14} />{/if}
				<span>Start</span>
			</Button>
		{:else}
			<Button
				variant="secondary"
				size="sm"
				onclick={onRestart}
				disabled={restarting || stopping}
				onmouseenter={() => onTriggerActionAnim('restart')}
			>
				{#if restarting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play
						size={14}
						animate={actionAnim.restart ?? false}
					/>{/if}
				<span>Restart</span>
			</Button>
			<Button variant="secondary" size="sm" onclick={onStop} disabled={stopping || restarting}>
				{#if stopping}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Square size={14} />{/if}
				<span>Stop</span>
			</Button>
		{/if}
		<Menu placement="bottom-end">
			{#snippet trigger(props, open)}
				<button
					{...props}
					class="dh-more"
					class:dh-more--open={open}
					aria-label="More actions"
					title="More actions"
				>
					<EllipsisVertical size={16} />
				</button>
			{/snippet}
			{#if onRename}
				<MenuItem onclick={onRename}>
					<Pencil size={14} />
					<span>Rename</span>
				</MenuItem>
			{/if}
			<MenuItem danger disabled={deleting} onclick={onShowDeleteModal}>
				<Trash2 size={14} />
				<span>Delete app</span>
			</MenuItem>
		</Menu>
	</div>
{/snippet}

{#snippet metaLine()}
	<p class="dh-meta">
		{#if _commitLead}
			{#if commitUrl}
				<a
					href={commitUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="dh-meta-lead dh-meta-link"
					class:dh-mono={_commitLeadMono}>{_commitLead}</a
				>
			{:else}
				<span class="dh-meta-lead" class:dh-mono={_commitLeadMono}>{_commitLead}</span>
			{/if}
		{/if}
		{#if repoLabel}
			{#if _commitLead}<span class="dh-meta-dot">·</span>{/if}
			<a
				href={deployment.githubRepo.replace(/\.git$/, '')}
				target="_blank"
				rel="noopener noreferrer"
				class="dh-meta-link"
			>
				{repoLabel}
			</a>
		{/if}
		{#if _activeBuild?.branch || branch}
			{#if repoLabel}<span class="dh-meta-dot">·</span>{/if}
			<span class="dh-mono">{_activeBuild?.branch || branch}</span>
		{/if}
		{#if _activeBuild}
			<span class="dh-meta-dot">·</span>
			<span>{formatRelativeTime(new Date(_activeBuild.createdAt))}</span>
			{#if _activeBuild.triggerType === 'manual' && _activeBuild.triggeredBy}
				<span>by @{_activeBuild.triggeredBy.username}</span>
			{:else if _activeBuild.triggerType === 'auto'}
				<span>via GitHub</span>
			{/if}
		{/if}
		{#if _buildFailed && (deployment.buildLogs || deployment.buildError)}
			<span class="dh-meta-dot">·</span>
			<button class="dh-meta-link dh-meta-button" onclick={onViewBuildLogs}>
				View deployment logs
			</button>
		{/if}
	</p>
{/snippet}

{#snippet domains()}
	{#if deployment.ingresses?.length}
		<div class="dh-domains">
			{#each deployment.ingresses.slice(0, 3) as ingress (ingress.id)}
				<a
					href={appUrl(ingress.host, ingress.path, ingress.tlsEnabled)}
					target="_blank"
					rel="noopener noreferrer"
					class="dh-domain"
				>
					{ingress.host}
					<ExternalLink class="dh-domain-icon" size={12} />
				</a>
			{/each}
			{#if deployment.ingresses.length > 3}
				<a href="?tab=network" class="dh-domain dh-domain--more">
					+{deployment.ingresses.length - 3} more
				</a>
			{/if}
		</div>
	{/if}
{/snippet}

<section class="dh-card" {@attach motionStagger({ index: 0, from: { y: 14 } })}>
	<div class="dh-top">
		{@render identity()}
		{@render actions()}
	</div>
	<div class="dh-body" {@attach springCollapse(() => headerCollapsed)}>
		<div class="dh-body-inner">
			{@render metaLine()}
			{@render domains()}
		</div>
	</div>
</section>

<style>
	.dh-card {
		background-color: var(--bg-raised);
		border: none;
		box-shadow: var(--elev-1);
		border-radius: var(--radius-xl);
		padding: var(--space-5) var(--space-6);
	}
	.dh-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3) var(--space-4);
		flex-wrap: wrap;
		min-width: 0;
	}
	.dh-identity {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		min-width: 0;
		flex: 1 1 16rem;
	}
	.dh-name {
		font-size: var(--text-title-1);
		line-height: var(--lh-title-1);
		letter-spacing: var(--track-title);
		font-weight: 600;
		color: var(--text-default);
		margin: 0;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dh-env-chip {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.75rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		white-space: nowrap;
		color: var(--text-muted);
		border: 1px solid var(--rule-strong);
		background: transparent;
	}
	.dh-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}
	.dh-more {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-md);
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.dh-more:hover,
	.dh-more--open {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}
	.dh-body {
		overflow: hidden;
	}
	.dh-body-inner {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding-top: var(--space-3);
	}
	.dh-meta {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		min-width: 0;
	}
	.dh-meta-lead {
		font-weight: 600;
		color: var(--text-default);
	}
	.dh-mono {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
	}
	.dh-meta-dot {
		color: var(--text-faint);
	}
	.dh-meta-link {
		display: inline-flex;
		align-items: center;
		min-height: 1.5rem;
		color: inherit;
		text-decoration: none;
		border-radius: var(--radius-xs);
	}
	.dh-meta-link:hover {
		color: var(--text-default);
		text-decoration: underline;
	}
	.dh-meta-button {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		cursor: pointer;
		color: var(--text-link);
	}
	.dh-meta-button:hover {
		text-decoration: underline;
	}
	.dh-domains {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.dh-domain {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.25rem 0.75rem;
		border-radius: var(--radius-pill);
		background-color: var(--fill-quiet);
		color: var(--text-muted);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		text-decoration: none;
		max-width: 100%;
		min-width: 0;
	}
	.dh-domain:hover {
		background-color: var(--fill-soft);
		color: var(--text-default);
	}
	:global(.dh-domain-icon) {
		flex-shrink: 0;
		opacity: 0.6;
	}
	@media (max-width: 640px) {
		.dh-card {
			padding: var(--space-4);
		}
		.dh-actions {
			width: 100%;
			justify-content: flex-start;
		}
	}
</style>
