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
		Users,
		Globe,
		Server
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

	const workspaceSlug = $derived($page.params.slug);
	const projectSlug = $derived($page.params.projectSlug);

	async function fetchProject() {
		loading = true;
		error = null;

		try {
			// First get workspace to find project ID
			const wsResponse = await apiFetch(`/apiv1/workspaces/slug/${workspaceSlug}`);
			if (!wsResponse.ok) {
				throw new Error('Failed to fetch workspace');
			}
			const workspace = await wsResponse.json();

			const matchedProject = workspace.projects?.find((p: Project) => p.slug === projectSlug);
			if (!matchedProject) {
				throw new Error('Project not found');
			}

			// Fetch full project details
			const projResponse = await apiFetch(`/apiv1/projects/${matchedProject.id}`);
			if (!projResponse.ok) {
				throw new Error('Failed to fetch project');
			}
			project = await projResponse.json();

			// Sync with Kubernetes on first load
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
			// Refresh project data
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
						errorMessage = 'You do not have permission to delete this project. Only workspace owners or admins can delete projects.';
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
			goto(`/workspaces/${workspaceSlug}`);
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
				return 'badge-success';
			case 'pending':
			case 'building':
				return 'badge-warning';
			case 'failed':
			case 'error':
				return 'badge-error';
			default:
				return 'badge-neutral';
		}
	}

	onMount(() => {
		fetchProject();
	});

	function openDeployment(id: string) {
		return goto(`/deployments/${id}`);
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

<div class="p-6">
	<button
		onclick={() => window.history.back()}
		class="mb-6 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer"
	>
		<ArrowLeft class="h-4 w-4" />
		Back to workspace
	</button>

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<div class="flex justify-center py-12">
			<div class="text-center">
				<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
				<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading project...</p>
			</div>
		</div>
	{:else}
		{#if project}
			<!-- Project Header -->
			<div
				class="mb-8 rounded-3xl border p-6 shadow-sm"
				style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
			>
				<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
					<div>
						<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Project</p>
						<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">
							{project.name}
						</h1>
						{#if project.description}
							<p class="mt-2 text-sm" style="color: var(--surface-muted);">
								{project.description}
							</p>
						{/if}
						<div class="mt-3 flex flex-wrap items-center gap-4 text-xs" style="color: var(--surface-muted);">
							{#if project.namespace}
								<div class="flex items-center gap-1">
									<Server class="h-4 w-4" />
									<code class="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">
										{project.namespace}
									</code>
								</div>
							{/if}
							{#if project.repositoryUrl}
								<a
									href={project.repositoryUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="flex items-center gap-1 hover:text-primary-600"
								>
									<ExternalLink class="h-4 w-4" />
									Repository
								</a>
							{/if}
						</div>
					</div>
					<div class="flex flex-wrap gap-3 text-xs md:justify-end" style="color: var(--surface-muted);">
						<span
							class="rounded-full px-3 py-1 font-medium"
							style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
						>
							{project.deployments?.length ?? 0} deployments
						</span>
						<span
							class="rounded-full px-3 py-1 font-medium"
							style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
						>
							{project.members?.length ?? 0} members
						</span>
					</div>
				</div>
				<div class="mt-4 flex flex-wrap items-center justify-between gap-3">
					<div class="text-xs" style="color: var(--surface-muted);">
						Namespace synchronized from Kubernetes when available.
					</div>
					<div class="flex items-center gap-2">
						<button
							onclick={syncNamespace}
							disabled={syncing}
							class="btn btn-secondary"
						>
							<RefreshCw class="h-4 w-4 {syncing ? 'animate-spin' : ''}" />
							Sync
						</button>
						<button
							onclick={deleteProject}
							disabled={deleting}
							class="btn btn-danger"
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

			<div class="grid gap-6 lg:grid-cols-3">
				<!-- Deployments Section -->
				<div class="lg:col-span-2">
					<div class="mb-4 flex items-center justify-between">
						<h2 class="text-lg font-semibold" style="color: var(--center-channel-color);">
							Deployments ({project.deployments?.length ?? 0})
						</h2>
						<div class="flex gap-2">
							<a
								href="/workspaces/{workspaceSlug}/projects/{projectSlug}/ingresses/new"
								class="btn btn-secondary"
							>
								<Globe class="h-4 w-4" />
								New Ingress
							</a>
							<a
								href="/workspaces/{workspaceSlug}/projects/{projectSlug}/deployments/new"
								class="btn btn-primary"
							>
								<Plus class="h-4 w-4" />
								New Deployment
							</a>
						</div>
					</div>

					{#if !project.deployments?.length}
						<div class="card p-8 text-center">
							<Server class="mx-auto h-12 w-12 text-gray-400" />
							<h3 class="mt-4 font-medium" style="color: var(--center-channel-color);">No deployments yet</h3>
							<p class="mt-2 text-sm" style="color: var(--surface-muted);">
								Create your first deployment to get started.
							</p>
							<a
								href="/workspaces/{workspaceSlug}/projects/{projectSlug}/deployments/new"
								class="btn btn-primary mt-4"
							>
								<Plus class="h-4 w-4" />
								Create Deployment
							</a>
						</div>
					{:else}
						<div class="flex flex-col gap-4" {...deploymentMenu.root}>
							<label class="workspace-search flex items-center gap-3 rounded-2xl border px-4 py-2 text-sm shadow-sm transition">
								<span class="text-xs font-semibold uppercase tracking-wide">Search</span>
								<input
									type="search"
									placeholder="Filter deployments..."
									class="flex-1 bg-transparent text-base focus:outline-none"
									bind:value={deploymentSearch}
									{...deploymentMenu.input}
								/>
							</label>

							{#if filteredDeployments.length}
								<div class="max-h-[70vh] overflow-y-auto pr-1">
									<div
										class="grid gap-4 p-1"
										style:grid-template-columns="repeat(auto-fill,minmax(220px,1fr))"
									>
										{#each filteredDeployments as deployment}
											{@const href = `/deployments/${deployment.id}`}
											{@const item = deploymentMenu.getItem(deployment, {
												onSelect: () => openDeployment(deployment.id)
											})}
											<a
												class={`workspace-card group flex h-full flex-col gap-4 rounded-2xl border p-4 text-left shadow-sm transition-all ${
													item.highlighted ? 'workspace-card--highlight' : ''
												}`}
												{...mergeAttrs(item.attrs, {
													href,
													onclick: event => handleDeploymentClick(event as MouseEvent, deployment.id)
												})}
											>
												<div class="flex items-start justify-between gap-4">
													<div>
														<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">
															Deployment
														</p>
														<h3 class="mt-1 text-lg font-semibold" style="color: var(--center-channel-color);">
															{deployment.name}
														</h3>
													</div>
													<span class="badge {getStatusColor(deployment.status)}">
														{deployment.status || 'unknown'}
													</span>
												</div>
												{#if deployment.githubRepo}
													<p class="line-clamp-2 text-xs font-mono" style="color: var(--surface-muted);">
														{deployment.githubRepo}
														{#if deployment.githubBranch}
															<span class="ml-2">({deployment.githubBranch})</span>
														{/if}
													</p>
												{:else if deployment.image}
													<p class="line-clamp-3 text-xs font-mono" style="color: var(--surface-muted);">
														{deployment.image}
													</p>
												{/if}
												<div
													class="mt-auto flex items-center justify-between text-sm"
													style="color: var(--surface-muted);"
												>
													<span>
														{deployment.replicas} replica{deployment.replicas !== 1 ? 's' : ''}
													</span>
													<span>
														ID: {deployment.id.slice(0, 6)}…
													</span>
												</div>
											</a>
										{/each}
									</div>
								</div>
							{:else}
								<div
									class="rounded-2xl border border-dashed p-8 text-center"
									style="border-color: var(--surface-border); color: var(--surface-muted);"
								>
									<p class="text-lg font-medium" style="color: var(--center-channel-color);">
										No deployments match "{deploymentSearch}".
									</p>
									<p class="mt-1 text-sm">Try another search term.</p>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Members Section -->
				<div class="space-y-3">
					<h2 class="text-lg font-semibold" style="color: var(--center-channel-color);">
						Members ({project.members?.length ?? 0})
					</h2>
					<div class="card">
						<div class="divide-y" style="border-color: var(--surface-border);">
							{#if project.members?.length}
								{#each project.members as member}
									<div class="flex items-center gap-3 p-3">
										{#if member.user.imageUrl}
											<img
												src={member.user.imageUrl}
												alt={member.user.firstName || member.user.email}
												class="h-8 w-8 rounded-full object-cover"
											/>
										{:else}
											<div
												class="flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium"
												style="background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg)); color: var(--center-channel-color);"
											>
												{member.user.firstName?.[0] || member.user.email[0].toUpperCase()}
											</div>
										{/if}
										<div class="flex-1 min-w-0">
											<p class="truncate text-sm font-medium" style="color: var(--center-channel-color);">
												{member.user.firstName} {member.user.lastName || ''}
											</p>
											<p class="truncate text-xs" style="color: var(--surface-muted);">{member.user.email}</p>
										</div>
										<span class="badge badge-neutral text-xs">
											{member.role}
										</span>
									</div>
								{/each}
							{:else}
								<div class="p-4 text-center text-sm" style="color: var(--surface-muted);">
									No members
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}
	{/if}
</div>
