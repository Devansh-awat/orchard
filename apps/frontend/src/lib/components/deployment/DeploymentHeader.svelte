<script lang="ts">
	import { Loader2, ExternalLink } from 'lucide-svelte';
	import { Play, RefreshCw, Trash2 } from '@jis3r/icons';
	import { motionStagger, cardTilt } from '$lib/utils/motion.svelte';
	import { envBadgeColor } from '$lib/utils/format';
	import type { StatusMeta } from '$lib/components/ui';

	let {
		deployment,
		projectBgImage,
		headerCollapsed,
		springCollapse,
		// Status
		deploymentStatusChip,
		debugChips = [],
		// Actions
		repoUrl,
		rebuilding,
		restarting,
		deleting,
		actionAnim,
		_isBuilding,
		onRebuild,
		onRestart,
		onShowDeleteModal,
		onTriggerActionAnim,
		onViewBuildLogs,
		// Meta
		_commitLead,
		_commitLeadMono,
		_activeBuild,
		_buildFailed,
		branch
	}: {
		deployment: any;
		projectBgImage: string | null;
		headerCollapsed: boolean;
		springCollapse: (collapsed: () => boolean) => (el: Element) => void;
		deploymentStatusChip: StatusMeta;
		debugChips?: StatusMeta[];
		repoUrl: string | undefined;
		rebuilding: boolean;
		restarting: boolean;
		deleting: boolean;
		actionAnim: Record<string, boolean>;
		_isBuilding: boolean;
		onRebuild: () => void;
		onRestart: () => void;
		onShowDeleteModal: () => void;
		onTriggerActionAnim: (id: string) => void;
		onViewBuildLogs: () => void;
		_commitLead: string | null;
		_commitLeadMono: boolean;
		_activeBuild: any;
		_buildFailed: boolean;
		branch: string | undefined;
	} = $props();
</script>

<section
	class="dep-header dep-header-card"
	class:dep-header-card--hasbg={!!projectBgImage}
	class:dep-header-card--collapsed={headerCollapsed}
	{@attach motionStagger({ index: 0, from: { y: 14, scale: 0.985 } })}
	{@attach cardTilt({ max: 2 })}
>
	{#if projectBgImage}
		<div class="dep-header-backdrop" aria-hidden="true">
			<div
				class="dep-header-bg dep-header-bg--1"
				style="background-image: url({JSON.stringify(projectBgImage)});"
			></div>
			<div
				class="dep-header-bg dep-header-bg--2"
				style="background-image: url({JSON.stringify(projectBgImage)});"
			></div>
			<div
				class="dep-header-bg dep-header-bg--3"
				style="background-image: url({JSON.stringify(projectBgImage)});"
			></div>
			<div class="dep-header-veil"></div>
		</div>
	{/if}
	<div class="dep-header-top">
		<div class="dep-header-identity">
			<h1 class="dep-header-name">{deployment.name}</h1>
			<span class="dep-status-chip dep-status-chip--{deploymentStatusChip.kind}">
				<span class="dep-status-dot" class:dep-status-dot--pulse={deploymentStatusChip.pulse}
				></span>
				{deploymentStatusChip.label}
			</span>
			{#if deployment.environment}
				<span
					class="dep-env-chip"
					style="--env-c: {envBadgeColor(deployment.environment.slug)}"
					title="Environment: {deployment.environment.name}"
				>
					<span class="dep-env-dot"></span>
					{deployment.environment.name}
				</span>
			{/if}
			{#each debugChips as chip (chip.label)}
				<span class="dep-status-chip dep-status-chip--{chip.kind}">
					<span class="dep-status-dot" class:dep-status-dot--pulse={chip.pulse}></span>
					{chip.label}
				</span>
			{/each}
		</div>
		<div class="dep-header-actions">
			{#if repoUrl}
				<button
					onclick={onRebuild}
					disabled={rebuilding || _isBuilding}
					class="btn btn-secondary btn-sm"
					onmouseenter={() => onTriggerActionAnim('redeploy')}
				>
					{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
							size={14}
							animate={actionAnim.redeploy ?? false}
						/>{/if}
					<span>Redeploy</span>
				</button>
			{/if}
			<button
				onclick={onRestart}
				disabled={restarting}
				class="btn btn-secondary btn-sm"
				onmouseenter={() => onTriggerActionAnim('restart')}
			>
				{#if restarting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play
						size={14}
						animate={actionAnim.restart ?? false}
					/>{/if}
				<span>Restart</span>
			</button>
			<button
				onclick={onShowDeleteModal}
				disabled={deleting}
				class="btn btn-sm dep-delete-btn"
				aria-label="Delete app"
				title="Delete app"
				onmouseenter={() => onTriggerActionAnim('delete')}
			>
				{#if deleting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2
						size={14}
						animate={actionAnim.delete ?? false}
					/>{/if}
			</button>
		</div>
	</div>

	<!-- Body: meta + domains. Spring-collapses when the user leaves Overview. -->
	<div class="dep-header-body" {@attach springCollapse(() => headerCollapsed)}>
		<p class="dep-header-meta">
			{#if _commitLead}
				{#if deployment.githubRepo && _activeBuild?.commitSha}
					<a
						href="{deployment.githubRepo.replace(/\.git$/, '')}/commit/{_activeBuild.commitSha}"
						target="_blank"
						rel="noopener noreferrer"
						class="dep-meta-lead dep-meta-lead-link"
						class:dep-meta-mono={_commitLeadMono}>{_commitLead}</a
					>
				{:else}
					<span class="dep-meta-lead" class:dep-meta-mono={_commitLeadMono}>{_commitLead}</span>
				{/if}
			{/if}
			{#if deployment.githubRepo}
				{#if _commitLead}<span class="dep-meta-dot">·</span>{/if}
				<a
					href={deployment.githubRepo.replace(/\.git$/, '')}
					target="_blank"
					rel="noopener noreferrer"
					class="dep-meta-link"
				>
					{deployment.githubRepo.replace('https://github.com/', '').replace(/\.git$/, '')}
				</a>
			{/if}
			{#if _activeBuild?.branch || branch}
				{#if deployment.githubRepo}<span class="dep-meta-dot">·</span>{/if}
				<span class="dep-meta-mono">{_activeBuild?.branch || branch}</span>
			{/if}
			{#if _activeBuild}
				<span class="dep-meta-dot">·</span>
				<span
					>{(() => {
						const diff = Date.now() - new Date(_activeBuild.createdAt).getTime();
						const mins = Math.floor(diff / 60000);
						if (mins < 1) return 'just now';
						if (mins < 60) return `${mins}m ago`;
						const hrs = Math.floor(mins / 60);
						if (hrs < 24) return `${hrs}h ago`;
						const days = Math.floor(hrs / 24);
						if (days < 30) return `${days}d ago`;
						return new Date(_activeBuild.createdAt).toLocaleDateString('en-US', {
							month: 'short',
							day: 'numeric'
						});
					})()}</span
				>
				{#if _activeBuild.triggerType === 'manual' && _activeBuild.triggeredBy}
					<span>by</span>
					<span class="dep-meta-strong">@{_activeBuild.triggeredBy.username}</span>
				{:else if _activeBuild.triggerType === 'auto'}
					<span>via GitHub</span>
				{/if}
			{/if}
			{#if _buildFailed && (deployment.buildLogs || deployment.buildError)}
				<span class="dep-meta-dot">·</span>
				<button class="dep-meta-link dep-meta-button" onclick={onViewBuildLogs}
					>View deployment logs</button
				>
			{/if}
		</p>

		{#if deployment.ingresses?.length}
			<div class="dep-header-divider" aria-hidden="true"></div>
			<div class="dep-header-domains">
				{#each deployment.ingresses.slice(0, 4) as ingress (ingress.id)}
					<a
						href="{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}"
						target="_blank"
						rel="noopener noreferrer"
						class="dep-meta-domain"
					>
						{ingress.host}
						<ExternalLink class="dep-meta-domain-icon h-3 w-3" />
					</a>
				{/each}
			</div>
		{/if}
	</div>
</section>
