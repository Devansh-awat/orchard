<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		Clock,
		Ellipsis,
		GitBranch,
		GitCommitHorizontal,
		Github,
		Globe,
		Layers,
		Loader2,
		Pencil,
		Square,
		Trash2
	} from 'lucide-svelte';
	import { Play, RefreshCw } from '@jis3r/icons';
	import { motionStagger, springCollapse } from '$lib/utils/motion.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import { ingressUrl } from '$lib/ingress-url';
	import { StatusBadge, Button, Menu, MenuItem, MenuSeparator } from '$lib/components/ui';
	import MetaList from '$lib/components/ui/MetaList.svelte';
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
	const when = $derived(
		_activeBuild
			? `${formatRelativeTime(new Date(_activeBuild.createdAt))}${
					_activeBuild.triggerType === 'manual' && _activeBuild.triggeredBy
						? ` by @${_activeBuild.triggeredBy.username}`
						: ''
				}`
			: null
	);
	const factItems = $derived(
		[
			deployment.ingresses?.[0]
				? {
						label:
							deployment.ingresses[0].host +
							(deployment.ingresses.length > 1 ? ` +${deployment.ingresses.length - 1}` : ''),
						icon: Globe,
						href: ingressUrl(deployment.ingresses[0]),
						external: true
					}
				: null,
			deployment.environment ? { label: deployment.environment.name, icon: Layers } : null,
			repoLabel
				? {
						label: repoLabel,
						icon: Github,
						href: deployment.githubRepo.replace(/\.git$/, ''),
						external: true
					}
				: null,
			_activeBuild?.branch || branch
				? { label: _activeBuild?.branch || branch, icon: GitBranch, mono: true }
				: null,
			_commitLead
				? {
						label: _commitLead,
						icon: GitCommitHorizontal,
						href: commitUrl ?? undefined,
						external: !!commitUrl,
						mono: _commitLeadMono
					}
				: null,
			when ? { label: when, icon: Clock } : null
		].filter((x) => x !== null)
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
		{#each debugChips as chip (chip.label)}
			<StatusBadge meta={chip} />
		{/each}
	</div>
{/snippet}

{#snippet actions()}
	<div class="dh-actions">
		{#if setup}{@render setup()}{/if}
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
		{/if}
		<Menu placement="bottom-end">
			{#snippet trigger(props)}
				<Button {...props} variant="ghost" size="sm" icon={Ellipsis} label="More actions" />
			{/snippet}
			{#if stopped && repoUrl}
				<MenuItem icon={RefreshCw} disabled={rebuilding || _isBuilding} onclick={onRebuild}
					>Deploy and start</MenuItem
				>
			{/if}
			{#if !stopped}
				<MenuItem icon={Square} disabled={stopping || restarting} onclick={onStop}>Stop</MenuItem>
			{/if}
			{#if onRename}
				<MenuItem icon={Pencil} onclick={onRename}>Rename</MenuItem>
			{/if}
			<MenuSeparator />
			<MenuItem icon={Trash2} danger disabled={deleting} onclick={onShowDeleteModal}>
				Delete app
			</MenuItem>
		</Menu>
	</div>
{/snippet}

{#snippet facts()}
	<div class="dh-facts">
		<MetaList items={factItems} />
		{#if _buildFailed && (deployment.buildLogs || deployment.buildError)}
			<Button variant="ghost" size="sm" onclick={onViewBuildLogs}>View deployment logs</Button>
		{/if}
	</div>
{/snippet}

<section class="dh-card" {@attach motionStagger({ index: 0, from: { y: 14 } })}>
	<div class="dh-top">
		{@render identity()}
		{@render actions()}
	</div>
	<div class="dh-body" {@attach springCollapse(() => headerCollapsed)}>
		<div class="dh-body-inner">
			{@render facts()}
		</div>
	</div>
</section>

<style>
	.dh-card {
		padding: 0.25rem 0 0;
	}
	.dh-facts {
		display: flex;
		align-items: center;
		gap: 0.5rem 1rem;
		flex-wrap: wrap;
		min-width: 0;
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
