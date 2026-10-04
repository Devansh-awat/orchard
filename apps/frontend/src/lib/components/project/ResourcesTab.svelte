<script lang="ts">
	import { Server, GitBranch, Plus, Database as DatabaseIcon, LayoutTemplate } from 'lucide-svelte';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';
	import { mergeAttrs } from 'melt';
	import { StatusBadge, resourceStatus, statusMeta, IconTile } from '$lib/components/ui';
	import { IMG_ICONS } from '$lib/components/org-dashboard/helpers.svelte';
	import type { Deployment, DatabaseSummary, TemplateInstanceSummary } from './types';

	let {
		filteredDeployments,
		databases,
		templateInstances,
		orgSlug,
		deploymentSearch = '',
		deploymentMenu,
		favFailed = $bindable(new Set<string>()),
		onDeploymentClick,
		onNewResource,
		onOpenDeployment
	}: {
		filteredDeployments: Deployment[];
		databases: DatabaseSummary[];
		templateInstances: TemplateInstanceSummary[];
		orgSlug: string;
		deploymentSearch?: string;
		deploymentMenu: any;
		favFailed?: Set<string>;
		onDeploymentClick: (event: MouseEvent, id: string) => void;
		onNewResource?: () => void;
		onOpenDeployment: (id: string) => void;
	} = $props();

	const POSTGRES_LOGO = IMG_ICONS.postgres;

	function formatBuildDuration(deployment: Deployment): string | null {
		const history = deployment.imageHistory?.[0];
		if (!history?.buildStartedAt || !history?.buildCompletedAt) return null;
		const ms =
			new Date(history.buildCompletedAt).getTime() - new Date(history.buildStartedAt).getTime();
		if (ms < 1000) return '<1s';
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const rem = seconds % 60;
		return `${minutes}m ${rem}s`;
	}

	function getDeploymentAuthor(deployment: Deployment): string | null {
		const history = deployment.imageHistory?.[0];
		if (history?.commitAuthorName) return history.commitAuthorName;
		if (history?.triggeredBy) {
			const t = history.triggeredBy;
			return t.firstName ? `${t.firstName} ${t.lastName ?? ''}`.trim() : (t.username ?? null);
		}
		if (deployment.creator) {
			const c = deployment.creator;
			return c.firstName ? `${c.firstName} ${c.lastName ?? ''}`.trim() : (c.username ?? null);
		}
		return null;
	}

	// Derive whether there are any deployments at all (before filtering)
	const hasAnyDeployments = $derived(
		filteredDeployments.length > 0 || deploymentSearch.trim().length > 0
	);
</script>

{#if !hasAnyDeployments && databases.length === 0 && templateInstances.length === 0}
	<div class="pj-empty-card pj-glass">
		<span style:color="var(--surface-muted)"><Server class="h-10 w-10" /></span>
		<p>No apps yet</p>
		<button class="pj-btn pj-btn-primary pj-btn-mt" onclick={onNewResource}>
			<Plus class="h-4 w-4" />
			Create Resource
		</button>
	</div>
{:else if filteredDeployments.length}
	<div class="pj-deployment-grid">
		{#each filteredDeployments as deployment, i (deployment.id)}
			{@const href = `/${orgSlug}/deployments/${deployment.id}`}
			{@const item = deploymentMenu.getItem(deployment, {
				onSelect: () => onOpenDeployment(deployment.id)
			})}
			{@const host = deployment.ingresses?.[0]?.host?.split('/')[0]}
			{@const m = resourceStatus(deployment.status)}
			<a
				class="pj-deployment-card pj-glass"
				class:is-highlighted={item.highlighted}
				{@attach motionStagger({ index: i, from: { y: 10 } })}
				{@attach springHover({ lift: -4 })}
				{...mergeAttrs(item.attrs, {
					href,
					onclick: (event: Event) => onDeploymentClick(event as MouseEvent, deployment.id)
				})}
			>
				<div class="pj-deployment-card-top">
					<div class="pj-deployment-favicon">
						{#if host && !favFailed.has(deployment.id)}
							<img
								src={`/apiv1/deployments/favicon?domain=${encodeURIComponent(host)}`}
								alt=""
								onerror={() => (favFailed = new Set(favFailed).add(deployment.id))}
							/>
						{:else}
							<span class="pj-deployment-favicon-letter"
								>{(deployment.displayName || deployment.name).charAt(0).toUpperCase()}</span
							>
						{/if}
						<span class="pj-deployment-favicon-dot status--{m.kind}"></span>
					</div>
					<span class="pj-deployment-name">{deployment.displayName || deployment.name}</span>
					<div class="pj-deployment-badges">
						<StatusBadge meta={m} />
						{#if deployment.buildStatus && deployment.buildStatus !== 'none' && deployment.buildStatus !== 'succeeded'}
							<span class="pj-deployment-build-badge pj-build-{deployment.buildStatus}">
								Deploy: {deployment.buildStatus === 'building'
									? 'Building'
									: deployment.buildStatus === 'failed'
										? 'Failed'
										: deployment.buildStatus}
							</span>
						{/if}
					</div>
				</div>
				<div class="pj-deployment-card-body">
					{#if deployment.githubRepo}
						<span class="pj-deployment-detail">{deployment.githubRepo}</span>
						{#if deployment.githubBranch}
							<span class="pj-deployment-branch">
								<GitBranch class="h-3.5 w-3.5" />
								{deployment.githubBranch}
							</span>
						{/if}
					{:else if deployment.image}
						<span class="pj-deployment-detail">{deployment.image}</span>
					{/if}
				</div>
				<div class="pj-deployment-card-footer">
					<span class="pj-deployment-replicas">
						{deployment.replicas} replica{deployment.replicas !== 1 ? 's' : ''}
					</span>
					{#if formatBuildDuration(deployment)}
						<span class="pj-deployment-meta">Deployed in {formatBuildDuration(deployment)}</span>
					{/if}
					{#if getDeploymentAuthor(deployment)}
						<span class="pj-deployment-meta">{getDeploymentAuthor(deployment)}</span>
					{/if}
				</div>
			</a>
		{/each}
	</div>
{:else if deploymentSearch.trim()}
	<div class="pj-empty-card pj-glass">
		<p>No apps match "{deploymentSearch}"</p>
	</div>
{/if}

<!-- Databases -->
{#if databases.length}
	<div class="pj-deployments-header" style="margin-top: 1rem;">
		<h2 class="pj-section-title">Databases</h2>
	</div>
	<div class="pj-deployment-grid">
		{#each databases as db, i (db.id)}
			{@const ls = db.liveStatus}
			{@const unhealthy =
				db.status !== 'restarting' &&
				!!(
					(ls?.message &&
						/oomkilled|out of memory|crashloopbackoff|back-?off|error/i.test(ls.message)) ||
					(ls?.exists !== false && ls?.ready === false && db.status === 'ready')
				)}
			{@const dbMeta = unhealthy
				? statusMeta('warning', 'Unhealthy', true)
				: resourceStatus(db.status)}
			<a
				href="/{orgSlug}/databases/{db.id}"
				class="pj-deployment-card pj-glass"
				{@attach motionStagger({ index: i, from: { y: 10 } })}
				{@attach springHover({ lift: -4 })}
			>
				<div class="pj-deployment-card-top">
					<IconTile
						class="pj-deployment-indicator pj-deployment-indicator--logo"
						src={POSTGRES_LOGO}
					>
						{#snippet fallback()}
							<DatabaseIcon class="h-5 w-5" />
						{/snippet}
					</IconTile>
					<StatusBadge meta={dbMeta} />
				</div>
				<div class="pj-deployment-card-body">
					<span class="pj-deployment-name">{db.name}</span>
					<span class="pj-deployment-detail">{db.dbName}</span>
				</div>
				<div class="pj-deployment-card-footer">
					<span class="pj-deployment-replicas">
						PostgreSQL {db.mode === 'container' ? '· container' : '· shared'}
					</span>
				</div>
			</a>
		{/each}
	</div>
{/if}

<!-- Template Instances -->
{#if templateInstances.length}
	<div class="pj-deployments-header" style="margin-top: 1rem;">
		<h2 class="pj-section-title">Template Instances</h2>
	</div>
	<div class="pj-deployment-grid">
		{#each templateInstances as ti, i (ti.id)}
			<a
				href="/{orgSlug}/template-instances/{ti.id}"
				class="pj-deployment-card pj-glass"
				{@attach motionStagger({ index: i, from: { y: 10 } })}
				{@attach springHover({ lift: -4 })}
			>
				<div class="pj-deployment-card-top">
					<div class="pj-deployment-indicator" style="color: var(--accent)">
						<LayoutTemplate class="h-5 w-5" />
					</div>
					<StatusBadge meta={resourceStatus(ti.status)} />
				</div>
				<div class="pj-deployment-card-body">
					<span class="pj-deployment-name">{ti.name}</span>
					<span class="pj-deployment-detail">{ti.template.displayName}</span>
				</div>
				<div class="pj-deployment-card-footer">
					<span class="pj-deployment-replicas">
						{ti._count
							? ti._count.deployments + ti._count.databases + ti._count.ingresses
							: (ti.deployments?.length ?? 0) +
								(ti.databases?.length ?? 0) +
								(ti.ingresses?.length ?? 0)} resources
					</span>
				</div>
			</a>
		{/each}
	</div>
{/if}
