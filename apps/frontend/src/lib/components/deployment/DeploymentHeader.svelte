<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Loader2, ExternalLink, Ellipsis, Pencil, Square, Trash2 } from 'lucide-svelte';
	import { Play, RefreshCw } from '@jis3r/icons';
	import { motionStagger, springCollapse } from '$lib/utils/motion.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import { ingressUrl } from '$lib/ingress-url';
	import { Badge, StatusBadge, Button, Menu, MenuItem } from '$lib/components/ui';
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
		branch,
		setup = undefined
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
		setup?: Snippet;
	} = $props();

	const pendingPush = $derived(deployment?.pendingPush ?? null);
	const heldPushes = $derived(
		pendingPush ? `${pendingPush.count} push${pendingPush.count === 1 ? '' : 'es'} since` : null
	);
	const heldPushTitle = $derived(
		pendingPush
			? `${pendingPush.sha.slice(0, 7)} on ${pendingPush.branch}${pendingPush.message ? `: ${pendingPush.message.split('\n')[0]}` : ''}`
			: undefined
	);

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
		{#if stopped && heldPushes}
			<span class="dh-held-chip" title={heldPushTitle}>{heldPushes}</span>
		{/if}
		{#if buildStatusChip}
			<StatusBadge meta={buildStatusChip} />
		{/if}
		{#if deployment.environment}
			<Badge>{deployment.environment.name}</Badge>
		{/if}
		{#each debugChips as chip (chip.label)}
			<StatusBadge meta={chip} />
		{/each}
	</div>
{/snippet}

{#snippet actions()}
	<div class="dh-actions">
		{#if setup}{@render setup()}{/if}
		{#if repoUrl}
			<Button
				variant={stopped ? 'secondary' : 'primary'}
				size="sm"
				onclick={onRebuild}
				disabled={rebuilding || _isBuilding}
				onmouseenter={() => onTriggerActionAnim('redeploy')}
			>
				{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
						size={14}
						animate={actionAnim.redeploy ?? false}
					/>{/if}
				<span>{stopped ? 'Deploy and start' : 'Redeploy'}</span>
			</Button>
		{/if}
		{#if stopped}
			<Button variant="primary" size="sm" onclick={onStart} disabled={starting || _isBuilding}>
				{#if starting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play size={14} />{/if}
				<span>{pendingPush ? 'Build and start' : 'Start'}</span>
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
			{#snippet trigger(props)}
				<Button {...props} variant="ghost" size="sm" icon={Ellipsis} label="More actions" />
			{/snippet}
			{#if onRename}
				<MenuItem icon={Pencil} onclick={onRename}>Rename</MenuItem>
			{/if}
			<MenuItem icon={Trash2} danger disabled={deleting} onclick={onShowDeleteModal}>
				Delete app
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
				<a href={ingressUrl(ingress)} target="_blank" rel="noopener noreferrer" class="dh-domain">
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
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		border-radius: calc(var(--radius-panel) * var(--corner-scale));
		corner-shape: var(--corner);
		padding: 1.125rem 1.5rem;
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
	.dh-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}
	.dh-body {
		overflow: hidden;
	}
	.dh-body-inner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem 1.5rem;
		padding-top: 0.625rem;
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
	.dh-held-chip {
		display: inline-flex;
		align-items: center;
		height: 1.375rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--ink) 6%, transparent);
		cursor: default;
	}
</style>
