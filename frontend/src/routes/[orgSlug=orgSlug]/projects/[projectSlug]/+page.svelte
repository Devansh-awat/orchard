<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
	import { mergeAttrs } from 'melt';
	import { SpatialMenu } from 'melt/builders';
	import {
		Loader2,
		Plus,
		ExternalLink,
		Trash2,
		RefreshCw,
		Server,
		Boxes,
		GitBranch,
		LayoutTemplate,
		Users,
		UserPlus
	} from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import NewResourceModal from '$lib/components/NewResourceModal.svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';

	interface Deployment {
		id: string;
		name: string;
		status: string;
		buildStatus?: string;
		replicas: number;
		image?: string;
		githubRepo?: string;
		githubBranch?: string;
	}

	interface Member {
		id: string;
		role: string;
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
		};
	}

	interface Project {
		id: string;
		name: string;
		slug: string;
		description?: string;
		namespace?: string;
		repositoryUrl?: string;
		deployments?: Deployment[];
		members?: Member[];
		organization?: {
			id: string;
			name: string;
			slug: string;
		};
		members?: WorkspaceMember[];
	}

	interface TemplateInstanceSummary {
		id: string;
		name: string;
		status: string;
		createdAt: string;
		template: {
			id: string;
			name: string;
			displayName: string;
			icon?: string;
			category?: string;
		};
		deployments: { id: string }[];
		databases: { id: string }[];
		ingresses: { id: string }[];
	}

	const deploymentMenu = new SpatialMenu<Deployment>({
		wrap: true,
		crossAxis: true
	});

	interface WorkspaceMember {
		id: string;
		role: { name: string };
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
		};
	}

	let project = $state<Project | null>(null);
	let templateInstances = $state<TemplateInstanceSummary[]>([]);
	let loading = $state(true);
	let syncing = $state(false);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let showDeleteModal = $state(false);
	let deploymentSearch = $state('');
	let showNewResourceModal = $state(false);
	let wsMembers = $state<WorkspaceMember[]>([]);
	let wsId = $state<string | null>(null);

	let filteredDeployments = $derived.by(() => {
		const deployments = project?.deployments ?? [];
		const query = deploymentSearch.trim().toLowerCase();
		if (!query) return deployments;
		return deployments.filter(deployment => {
			const name = deployment.name?.toLowerCase() ?? '';
			const status = deployment.status?.toLowerCase() ?? '';
			const image = deployment.image?.toLowerCase() ?? '';
			return (
				name.includes(query) ||
				status.includes(query) ||
				image.includes(query)
			);
		});
	});

	const orgSlug = $derived($page.params.orgSlug);
	const projectSlug = $derived($page.params.projectSlug);

	async function fetchProject() {
		loading = true;
		error = null;

		try {
			// Fetch project by slug via org
			const orgRes = await apiFetch(`/apiv1/organizations/slug/${orgSlug}`);
			if (!orgRes.ok) throw new Error('Organization not found');
			const org = await orgRes.json();

			const projRes = await apiFetch(`/apiv1/projects/slug/${projectSlug}?orgId=${org.id}`);
			if (!projRes.ok) throw new Error('Project not found');
			const projData = await projRes.json();

			// Fetch full project details
			const fullRes = await apiFetch(`/apiv1/projects/${projData.id}`);
			if (!fullRes.ok) throw new Error('Failed to fetch project');
			project = await fullRes.json();
			wsMembers = project?.members ?? [];

			if (project?.namespace) {
				syncNamespace();
			}

			// Fetch template instances
			if (project?.id) {
				try {
					const tiRes = await apiFetch(`/apiv1/projects/${project.id}/template-instances`);
					if (tiRes.ok) {
						templateInstances = await tiRes.json();
					}
				} catch { /* ignore */ }
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch project';
		} finally {
			loading = false;
		}
	}

	async function syncNamespace() {
		if (!project?.namespace) return;

		syncing = true;
		try {
			await apiFetch(`/apiv1/sync/${project.namespace}`, { method: 'POST' });
			const response = await apiFetch(`/apiv1/projects/${project.id}`);
			if (response.ok) {
				project = await response.json();
			}
		} catch (e) {
			console.error('Failed to sync namespace:', e);
		} finally {
			syncing = false;
		}
	}

	async function deleteProject() {
		if (!project) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				let errorMessage = 'Failed to delete project';
				try {
					const errorData = await response.json();
					if (errorData.message) {
						errorMessage = errorData.message;
					} else if (errorData.error) {
						errorMessage = errorData.error;
					}
				} catch {
					if (response.status === 403) {
						errorMessage = 'You do not have permission to delete this project.';
					} else if (response.status === 404) {
						errorMessage = 'Project not found';
					}
				}
				throw new Error(errorMessage);
			}

			toasts.add({
				title: 'Project deleted',
				description: `${project.name} has been deleted`,
				color: 'success'
			});

			refreshTree();
			goto(`/${orgSlug}`);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete project',
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}

	function getStatusColor(status: string) {
		switch (status?.toLowerCase()) {
			case 'running':
				return 'pj-status-running';
			case 'pending':
			case 'restarting':
			case 'scaling':
				return 'pj-status-pending';
			case 'failed':
			case 'error':
			case 'stopped':
			case 'unhealthy':
				return 'pj-status-error';
			default:
				return 'pj-status-neutral';
		}
	}

	function getStatusLabel(status: string) {
		switch (status?.toLowerCase()) {
			case 'running': return 'Running';
			case 'restarting': return 'Restarting';
			case 'scaling': return 'Scaling';
			case 'failed': return 'Failed';
			case 'stopped': return 'Stopped';
			case 'unhealthy': return 'Unhealthy';
			case 'pending': return 'Pending';
			default: return status || 'Unknown';
		}
	}

	onMount(() => {
		fetchProject();
	});

	function openDeployment(id: string) {
		return goto(`/${orgSlug}/deployments/${id}`);
	}

	function handleDeploymentClick(event: MouseEvent, id: string) {
		if (
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			event.button !== 0
		) {
			return;
		}
		event.preventDefault();
		openDeployment(id);
	}
</script>

<div class="pj-page">
	{#if error}
		<div class="pj-error">{error}</div>
	{/if}

	{#if loading}
		<!-- Skeleton: Back link -->
		<div class="skeleton" style="height: 0.8125rem; width: 6rem; margin-bottom: 1rem;"></div>
		<!-- Skeleton: Header -->
		<div class="pj-header">
			<div class="pj-header-top">
				<div class="pj-header-info">
					<div class="skeleton" style="height: 1.5rem; width: 40%; margin-bottom: 0.375rem;"></div>
					<div class="skeleton" style="height: 0.875rem; width: 55%;"></div>
				</div>
				<div class="pj-header-actions">
					<div class="skeleton" style="height: 2rem; width: 4.5rem; border-radius: 0.5rem;"></div>
					<div class="skeleton" style="height: 2rem; width: 5rem; border-radius: 0.5rem;"></div>
				</div>
			</div>
		</div>
		<!-- Skeleton: Stats -->
		<div class="pj-stats">
			{#each Array(3) as _}
				<div class="skeleton" style="height: 1.75rem; width: 6rem; border-radius: 0.5rem;"></div>
			{/each}
		</div>
		<!-- Skeleton: Deployments header -->
		<div class="pj-deployments-header">
			<div class="skeleton" style="height: 1.125rem; width: 7rem;"></div>
		</div>
		<!-- Skeleton: Deployment cards -->
		<div class="pj-deployment-grid">
			{#each Array(3) as _}
				<div class="pj-deployment-card" style="pointer-events: none;">
					<div class="pj-deployment-card-top">
						<div class="skeleton skeleton-icon"></div>
						<div class="skeleton skeleton-badge"></div>
					</div>
					<div class="pj-deployment-card-body">
						<div class="skeleton skeleton-title"></div>
						<div class="skeleton skeleton-desc"></div>
					</div>
					<div class="pj-deployment-card-footer">
						<div class="skeleton" style="height: 0.625rem; width: 3rem;"></div>
					</div>
				</div>
			{/each}
		</div>
	{:else if project}
		<!-- Breadcrumb -->
		<Breadcrumb crumbs={[
			{ label: 'Home', href: `/${orgSlug}` },
			{ label: 'Projects', href: `/${orgSlug}` },
			{ label: project.name }
		]} />

		<!-- Header -->
		<div class="pj-header">
			<div class="pj-header-top">
				<div class="pj-header-info">
					<h1 class="pj-title">{project.name}</h1>
					{#if project.description}
						<p class="pj-description">{project.description}</p>
					{/if}
				</div>
				<div class="pj-header-actions">
					<button
						onclick={syncNamespace}
						disabled={syncing}
						class="pj-btn pj-btn-secondary"
					>
						<RefreshCw class="h-4 w-4 {syncing ? 'animate-spin' : ''}" />
						Sync
					</button>
					<button
						onclick={() => (showDeleteModal = true)}
						disabled={deleting}
						class="pj-btn pj-btn-danger"
					>
						{#if deleting}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Trash2 class="h-4 w-4" />
						{/if}
						Delete
					</button>
				</div>
			</div>
		</div>

		<!-- Stats Row -->
		<div class="pj-stats">
			<div class="pj-stat">
				<Boxes class="h-4 w-4" />
				<span class="pj-stat-value">{project.deployments?.length ?? 0}</span>
				<span class="pj-stat-label">Deployments</span>
			</div>
			{#if project.namespace}
				<div class="pj-stat">
					<Server class="h-4 w-4" />
					<code class="pj-stat-code">{project.namespace}</code>
				</div>
			{/if}
			{#if project.repositoryUrl}
				<a
					href={project.repositoryUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="pj-stat pj-stat-link"
				>
					<ExternalLink class="h-4 w-4" />
					<span class="pj-stat-label">Repository</span>
				</a>
			{/if}
		</div>

		<!-- Deployments -->
		<div class="pj-deployments-header">
			<h2 class="pj-section-title">Deployments</h2>
			<div class="pj-deployments-toolbar">
				{#if project.deployments?.length}
					<div class="pj-deployment-search-bar" {...deploymentMenu.root}>
						<input
							type="search"
							placeholder="Search deployments..."
							class="pj-search-input"
							bind:value={deploymentSearch}
							{...deploymentMenu.input}
						/>
					</div>
				{/if}
				<button
					class="pj-btn pj-btn-primary"
					onclick={() => (showNewResourceModal = true)}
				>
					<Plus class="h-4 w-4" />
					New
				</button>
			</div>
		</div>

		{#if !project.deployments?.length}
			<div class="pj-empty-card">
				<span style:color="var(--surface-muted)"><Server class="h-10 w-10" /></span>
				<p>No deployments yet</p>
				<button
					class="pj-btn pj-btn-primary pj-btn-mt"
					onclick={() => (showNewResourceModal = true)}
				>
					<Plus class="h-4 w-4" />
					Create Resource
				</button>
			</div>
		{:else if filteredDeployments.length}
			<div class="pj-deployment-grid">
				{#each filteredDeployments as deployment}
					{@const href = `/${orgSlug}/deployments/${deployment.id}`}
					{@const item = deploymentMenu.getItem(deployment, {
						onSelect: () => openDeployment(deployment.id)
					})}
					<a
						class="pj-deployment-card"
						class:is-highlighted={item.highlighted}
						{...mergeAttrs(item.attrs, {
							href,
							onclick: (event: Event) => handleDeploymentClick(event as MouseEvent, deployment.id)
						})}
					>
						<div class="pj-deployment-card-top">
							<div class="pj-deployment-indicator {getStatusColor(deployment.status)}">
								<div class="pj-deployment-status-dot {getStatusColor(deployment.status)}"></div>
							</div>
							<span class="pj-deployment-status-badge {getStatusColor(deployment.status)}">
								{getStatusLabel(deployment.status)}
							</span>
							{#if deployment.buildStatus && deployment.buildStatus !== 'none' && deployment.buildStatus !== 'succeeded'}
								<span class="pj-deployment-build-badge pj-build-{deployment.buildStatus}">
									Build: {deployment.buildStatus === 'building' ? 'Building' : deployment.buildStatus === 'failed' ? 'Failed' : deployment.buildStatus}
								</span>
							{/if}
						</div>
						<div class="pj-deployment-card-body">
							<span class="pj-deployment-name">{deployment.name}</span>
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
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="pj-empty-card">
				<p>No deployments match "{deploymentSearch}"</p>
			</div>
		{/if}

		<!-- Template Instances -->
		{#if templateInstances.length}
			<div class="pj-deployments-header" style="margin-top: 1rem;">
				<h2 class="pj-section-title">
					<LayoutTemplate class="h-4 w-4" style="color: var(--sidebar-text-active-border); display: inline;" />
					Template Instances
				</h2>
			</div>
			<div class="pj-deployment-grid">
				{#each templateInstances as ti}
					<a
						href="/{orgSlug}/template-instances/{ti.id}"
						class="pj-deployment-card"
					>
						<div class="pj-deployment-card-top">
							<div class="pj-deployment-indicator" style="background-color: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent)">
								<LayoutTemplate class="h-5 w-5" style="color: var(--sidebar-text-active-border)" />
							</div>
							<span class="pj-deployment-status-badge" style="background-color: color-mix(in srgb, {ti.status === 'active' ? 'var(--pj-color-green)' : ti.status === 'failed' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'} 15%, transparent); color: {ti.status === 'active' ? 'var(--pj-color-green)' : ti.status === 'failed' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'}">
								{ti.status}
							</span>
						</div>
						<div class="pj-deployment-card-body">
							<span class="pj-deployment-name">{ti.name}</span>
							<span class="pj-deployment-detail">{ti.template.displayName}</span>
						</div>
						<div class="pj-deployment-card-footer">
							<span class="pj-deployment-replicas">
								{ti.deployments.length + ti.databases.length + ti.ingresses.length} resources
							</span>
						</div>
					</a>
				{/each}
			</div>
		{/if}

		<!-- Members -->
		{#if wsMembers.length > 0}
			<div class="pj-members-section">
				<div class="pj-deployments-header">
					<h2 class="pj-section-title"><Users size={16} /> Members</h2>
				</div>
				<div class="pj-members-list">
					{#each wsMembers as m (m.id)}
						<div class="pj-member">
							{#if m.user.imageUrl}
								<img src={m.user.imageUrl} alt="" class="pj-member-avatar" />
							{:else}
								<div class="pj-member-avatar pj-member-avatar--letter">
									{(m.user.firstName ?? m.user.email).charAt(0).toUpperCase()}
								</div>
							{/if}
							<div class="pj-member-info">
								<span class="pj-member-name">
									{#if m.user.firstName}{m.user.firstName}{#if m.user.lastName} {m.user.lastName}{/if}{:else}{m.user.email}{/if}
								</span>
								{#if m.user.firstName}
									<span class="pj-member-email">{m.user.email}</span>
								{/if}
							</div>
							<span class="pj-member-role">{m.role.name}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>

<NewResourceModal
	bind:open={showNewResourceModal}
	orgSlug={orgSlug ?? ''}
	projectSlug={projectSlug ?? ''}
/>

{#if project}
	<ConfirmModal
		bind:open={showDeleteModal}
		title='Delete "{project.name}"?'
		description='This will permanently <strong>delete this project</strong> and all its resources (deployments, databases, ingresses). This cannot be undone.'
		confirmLabel="Delete Project"
		onconfirm={deleteProject}
		oncancel={() => {}}
	/>
{/if}

<style>
	:global(:root) {
		--pj-color-green: #15803d;
		--pj-color-amber: #b45309;
		--pj-color-red: #b91c1c;
	}

	:global(:root.dark) {
		--pj-color-green: #4ade80;
		--pj-color-amber: #fbbf24;
		--pj-color-red: #f87171;
	}

	.pj-page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.pj-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	.pj-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	/* Header */
	.pj-header {
		margin-bottom: 1.5rem;
	}

	.pj-header-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.pj-header-info {
		flex: 1;
		min-width: 0;
	}

	.pj-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.pj-description {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	.pj-header-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	/* Stats */
	.pj-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.pj-stat {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		text-decoration: none;
	}

	.pj-stat-link:hover {
		background-color: color-mix(in srgb, var(--surface-border) 70%, transparent);
	}

	.pj-stat-value {
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.pj-stat-code {
		font-size: 0.75rem;
		font-family: var(--font-mono);
		color: var(--center-channel-color);
	}

	/* Deployments header */
	.pj-deployments-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.pj-section-title {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		margin: 0;
	}

	.pj-deployments-toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.pj-deployment-search-bar {
		width: 14rem;
	}

	.pj-search-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}

	.pj-search-input::placeholder {
		color: var(--surface-muted);
	}

	.pj-search-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	/* Deployment grid */
	.pj-deployment-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}

	.pj-deployment-card {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding: 1.25rem;
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: border-color 0.15s, box-shadow 0.15s;
		cursor: pointer;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.pj-deployment-card:hover,
	.pj-deployment-card.is-highlighted {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent);
	}

	.pj-deployment-card-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
	}

	.pj-deployment-indicator {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 0.75rem;
		flex-shrink: 0;
	}

	.pj-deployment-indicator.pj-status-running {
		background-color: color-mix(in srgb, var(--pj-color-green) 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-pending {
		background-color: color-mix(in srgb, var(--pj-color-amber) 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-error {
		background-color: color-mix(in srgb, var(--pj-color-red) 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-neutral {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.pj-deployment-status-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 50%;
	}

	.pj-deployment-status-dot.pj-status-running {
		background-color: var(--pj-color-green);
		box-shadow: 0 0 6px color-mix(in srgb, var(--pj-color-green) 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-pending {
		background-color: var(--pj-color-amber);
		box-shadow: 0 0 6px color-mix(in srgb, var(--pj-color-amber) 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-error {
		background-color: var(--pj-color-red);
		box-shadow: 0 0 6px color-mix(in srgb, var(--pj-color-red) 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-neutral {
		background-color: var(--surface-muted);
	}

	.pj-deployment-card-body {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.pj-deployment-name {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.pj-deployment-detail {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		font-family: var(--font-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pj-deployment-branch {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
		padding: 0.125rem 0.5rem;
		border-radius: 0.375rem;
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		width: fit-content;
	}

	.pj-deployment-card-footer {
		margin-top: auto;
	}

	.pj-deployment-replicas {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.pj-deployment-status-badge {
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: capitalize;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		flex-shrink: 0;
	}

	.pj-deployment-status-badge.pj-status-running {
		background-color: color-mix(in srgb, var(--pj-color-green) 15%, transparent);
		color: var(--pj-color-green);
	}

	.pj-deployment-status-badge.pj-status-pending {
		background-color: color-mix(in srgb, var(--pj-color-amber) 15%, transparent);
		color: var(--pj-color-amber);
	}

	.pj-deployment-status-badge.pj-status-error {
		background-color: color-mix(in srgb, var(--pj-color-red) 15%, transparent);
		color: var(--pj-color-red);
	}

	.pj-deployment-status-badge.pj-status-neutral {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--surface-muted);
	}

	.pj-deployment-build-badge {
		font-size: 0.7rem;
		font-weight: 500;
		padding: 0.2rem 0.5rem;
		border-radius: 9999px;
		flex-shrink: 0;
	}

	.pj-deployment-build-badge.pj-build-building {
		background-color: color-mix(in srgb, var(--pj-color-amber) 15%, transparent);
		color: var(--pj-color-amber);
	}

	.pj-deployment-build-badge.pj-build-failed {
		background-color: color-mix(in srgb, var(--pj-color-red) 15%, transparent);
		color: var(--pj-color-red);
	}

	/* Empty state */
	.pj-empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 4rem 1.5rem;
		color: var(--surface-muted);
		font-size: 0.875rem;
		border: 1px dashed var(--surface-border);
		border-radius: 1rem;
		margin-bottom: 1.5rem;
	}

	/* Buttons */
	.pj-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		text-decoration: none;
		transition: opacity 0.15s;
		white-space: nowrap;
	}

	.pj-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pj-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.08),
			0 1px 1px rgb(0 0 0 / 0.04);
	}

	.pj-btn-primary:hover:not(:disabled) {
		opacity: 0.95;
		transform: translateY(-0.5px);
		box-shadow:
			0 2px 4px rgb(0 0 0 / 0.08),
			0 4px 12px rgb(0 0 0 / 0.06);
	}

	.pj-btn-mt {
		margin-top: 0.5rem;
	}

	.pj-btn-secondary {
		background-color: transparent;
		color: var(--surface-muted);
		border: 1px solid var(--surface-border);
	}

	.pj-btn-secondary:hover:not(:disabled) {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.pj-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.pj-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	/* Members */
	.pj-members-section {
		margin-top: 2rem;
	}

	.pj-members-list {
		display: flex;
		flex-direction: column;
	}

	.pj-member {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem 0;
	}

	.pj-member + .pj-member {
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.pj-member-avatar {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}

	.pj-member-avatar--letter {
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		color: var(--sidebar-text-active-border);
		font-size: 0.6875rem;
		font-weight: 700;
	}

	.pj-member-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.pj-member-name {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pj-member-email {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pj-member-role {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--surface-muted);
		text-transform: capitalize;
		flex-shrink: 0;
	}
</style>
