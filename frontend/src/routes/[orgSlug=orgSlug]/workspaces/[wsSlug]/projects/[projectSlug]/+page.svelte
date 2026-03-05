<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
	import { mergeAttrs } from 'melt';
	import { SpatialMenu } from 'melt/builders';
	import {
		ArrowLeft,
		Loader2,
		Plus,
		ExternalLink,
		Trash2,
		RefreshCw,
		Globe,
		Server,
		Boxes,
		GitBranch,
		Database
	} from 'lucide-svelte';

	interface Deployment {
		id: string;
		name: string;
		status: string;
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
		workspace?: {
			id: string;
			name: string;
			slug: string;
		};
	}

	const deploymentMenu = new SpatialMenu<Deployment>({
		wrap: true,
		crossAxis: true
	});

	let project = $state<Project | null>(null);
	let loading = $state(true);
	let syncing = $state(false);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let deploymentSearch = $state('');

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

	const workspaceSlug = $derived($page.params.wsSlug);
	const orgSlug = $derived($page.params.orgSlug);
	const projectSlug = $derived($page.params.projectSlug);

	async function fetchProject() {
		loading = true;
		error = null;

		try {
			const wsResponse = await apiFetch(`/apiv1/workspaces/slug/${workspaceSlug}`);
			if (!wsResponse.ok) {
				throw new Error('Failed to fetch workspace');
			}
			const workspace = await wsResponse.json();

			const matchedProject = workspace.projects?.find((p: Project) => p.slug === projectSlug);
			if (!matchedProject) {
				throw new Error('Project not found');
			}

			const projResponse = await apiFetch(`/apiv1/projects/${matchedProject.id}`);
			if (!projResponse.ok) {
				throw new Error('Failed to fetch project');
			}
			project = await projResponse.json();

			if (project?.namespace) {
				syncNamespace();
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
		if (!confirm(`Are you sure you want to delete ${project.name}? This action cannot be undone.`)) {
			return;
		}

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
			goto(`/${orgSlug}/workspaces/${workspaceSlug}`);
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
			case 'building':
				return 'pj-status-pending';
			case 'failed':
			case 'error':
				return 'pj-status-error';
			default:
				return 'pj-status-neutral';
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
		<!-- Back link -->
		{#if project.workspace?.slug}
			<button
				onclick={() => goto(`/${orgSlug}/workspaces/${project.workspace.slug}`)}
				class="pj-back"
			>
				<ArrowLeft class="h-4 w-4" />
				{project.workspace.name}
			</button>
		{/if}

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
						onclick={deleteProject}
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
				<a
					href="/{orgSlug}/workspaces/{workspaceSlug}/projects/{projectSlug}/databases/new"
					class="pj-btn pj-btn-secondary"
				>
					<Database class="h-4 w-4" />
					New Database
				</a>
				<a
					href="/{orgSlug}/workspaces/{workspaceSlug}/projects/{projectSlug}/ingresses/new"
					class="pj-btn pj-btn-secondary"
				>
					<Globe class="h-4 w-4" />
					New Ingress
				</a>
				<a
					href="/{orgSlug}/workspaces/{workspaceSlug}/projects/{projectSlug}/deployments/new"
					class="pj-btn pj-btn-primary"
				>
					<Plus class="h-4 w-4" />
					New Deployment
				</a>
			</div>
		</div>

		{#if !project.deployments?.length}
			<div class="pj-empty-card">
				<span style:color="var(--surface-muted)"><Server class="h-10 w-10" /></span>
				<p>No deployments yet</p>
				<a
					href="/{orgSlug}/workspaces/{workspaceSlug}/projects/{projectSlug}/deployments/new"
					class="pj-btn pj-btn-primary pj-btn-mt"
				>
					<Plus class="h-4 w-4" />
					Create Deployment
				</a>
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
								{deployment.status || 'unknown'}
							</span>
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
	{/if}
</div>

<style>
	.pj-page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2rem 1.5rem;
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

	/* Back link */
	.pj-back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		margin-bottom: 1rem;
		transition: color 0.15s;
	}

	.pj-back:hover {
		color: var(--center-channel-color);
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
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
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
		font-family: monospace;
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
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
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
		padding: 1.125rem;
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: border-color 0.15s, box-shadow 0.15s;
		cursor: pointer;
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
		background-color: color-mix(in srgb, #22c55e 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-pending {
		background-color: color-mix(in srgb, #f59e0b 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-error {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
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
		background-color: #22c55e;
		box-shadow: 0 0 6px color-mix(in srgb, #22c55e 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-pending {
		background-color: #f59e0b;
		box-shadow: 0 0 6px color-mix(in srgb, #f59e0b 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-error {
		background-color: var(--error-text-color);
		box-shadow: 0 0 6px color-mix(in srgb, var(--error-text-color) 50%, transparent);
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
		font-family: monospace;
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
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
	}

	.pj-deployment-status-badge.pj-status-pending {
		background-color: color-mix(in srgb, #f59e0b 15%, transparent);
		color: #f59e0b;
	}

	.pj-deployment-status-badge.pj-status-error {
		background-color: color-mix(in srgb, var(--error-text-color) 15%, transparent);
		color: var(--error-text-color);
	}

	.pj-deployment-status-badge.pj-status-neutral {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--surface-muted);
	}

	/* Empty state */
	.pj-empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
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
	}

	.pj-btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.pj-btn-mt {
		margin-top: 0.5rem;
	}

	.pj-btn-secondary {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
	}

	.pj-btn-secondary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 90%, transparent);
	}

	.pj-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.pj-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}
</style>
