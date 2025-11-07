<script lang="ts">
import { goto } from '$app/navigation';
import { page } from '$app/stores';
import { onMount } from 'svelte';
import { apiFetch, user, toasts, selectedOrganization, refreshTree } from '$lib/stores';
import { mergeAttrs } from 'melt';
import { SpatialMenu } from 'melt/builders';
import { ArrowLeft, Loader2, Plus, FolderKanban, Calendar, User, Trash2, UserPlus, LogOut, Check, X } from 'lucide-svelte';

interface Project {
	id: string;
	name: string;
	slug: string;
	description?: string;
	repositoryUrl?: string;
	_count?: {
		deployments: number;
	};
	members?: Member[];
}

	interface Member {
		id: string;
		role: {
			name: string;
		};
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
		};
	}

	interface Workspace {
		id: string;
		name: string;
		slug: string;
		description?: string;
		createdAt: string;
		createdBy?: {
			firstName?: string;
			lastName?: string;
			email: string;
		};
		projects?: Project[];
		members?: Member[];
		organization?: {
			id: string;
			name: string;
			slug: string;
		};
	}

	interface OrgMember {
		id: string;
		userId: string;
		role: 'owner' | 'admin' | 'member';
		user: {
			id: string;
			email: string;
			firstName?: string;
			lastName?: string;
			imageUrl?: string;
		};
	}

	const projectMenu = new SpatialMenu<Project>({
		wrap: true,
		crossAxis: true
	});

let workspace = $state<Workspace | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let projectSearch = $state('');
let deleteError = $state<string | null>(null);
let deletingWorkspace = $state(false);
let orgMembers = $state<OrgMember[]>([]);
let loadingOrgMembers = $state(false);
let showInviteDialog = $state(false);
let selectedUserId = $state<string>('');
let selectedRoleId = $state<string>('');
let inviting = $state(false);
let joining = $state(false);
let leaving = $state(false);
let roles = $state<Array<{ id: string; name: string }>>([]);

	const currentUserId = $derived($user?.id);
	const currentUserMember = $derived.by(() => {
		if (!workspace || !currentUserId) return null;
		return workspace.members?.find(m => m.user.id === currentUserId);
	});
	const isWorkspaceAdmin = $derived(currentUserMember?.role?.name === 'admin');
	const isMember = $derived(!!currentUserMember);

	let filteredProjects = $derived.by(() => {
		const list = workspace?.projects ?? [];
		const query = projectSearch.trim().toLowerCase();
		if (!query) return list;
		return list.filter(project => {
			const name = project.name.toLowerCase();
			const slugMatch = project.slug.toLowerCase();
			const description = project.description?.toLowerCase() ?? '';
			return (
				name.includes(query) ||
				slugMatch.includes(query) ||
				description.includes(query)
			);
		});
	});

	const slug = $derived($page.params.slug);

	async function fetchWorkspace() {
		loading = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/workspaces/slug/${slug}`);
			if (!response.ok) {
				throw new Error('Failed to fetch workspace');
			}
			workspace = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch workspace';
		} finally {
			loading = false;
		}
	}

	async function fetchRoles() {
		try {
			const response = await apiFetch('/apiv1/workspaces/roles');
			if (response.ok) {
				roles = await response.json();
			}
		} catch (e) {
			console.error('Failed to fetch roles:', e);
		}
	}

	async function fetchOrgMembers() {
		if (!workspace?.organization?.id) return;

		loadingOrgMembers = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${workspace.organization.id}/members`);
			if (response.ok) {
				orgMembers = await response.json();
			} else {
				console.error('Failed to fetch org members:', response.status, await response.text());
			}
		} catch (e) {
			console.error('Failed to fetch org members:', e);
		} finally {
			loadingOrgMembers = false;
		}
	}

	async function inviteMember() {
		if (!workspace || !selectedUserId || !selectedRoleId || inviting) return;

		inviting = true;
		try {
			const response = await apiFetch(`/apiv1/workspaces/${workspace.id}/invite`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userId: selectedUserId,
					roleId: selectedRoleId
				})
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to invite member');
			}

			toasts.add({
				title: 'Member invited',
				color: 'success'
			});

			showInviteDialog = false;
			selectedUserId = '';
			selectedRoleId = '';
			fetchWorkspace();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to invite member',
				color: 'error'
			});
		} finally {
			inviting = false;
		}
	}

	async function joinWorkspace() {
		if (!workspace || joining) return;

		joining = true;
		try {
			const response = await apiFetch(`/apiv1/workspaces/${workspace.id}/join`, {
				method: 'POST'
			});

			if (!response.ok) {
				const data = await response.json();
				const errorMessage = data.message || 'Failed to join workspace';
				
				if (errorMessage.includes('already a member')) {
					toasts.add({
						title: 'Already a member',
						description: 'Refreshing workspace...',
						color: 'info'
					});
					await fetchWorkspace();
					return;
				}
				
				throw new Error(errorMessage);
			}

			toasts.add({
				title: 'Joined workspace',
				color: 'success'
			});

			await fetchWorkspace();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to join workspace',
				color: 'error'
			});
		} finally {
			joining = false;
		}
	}

	async function leaveWorkspace() {
		if (!workspace || leaving) return;
		
		const confirmLeave = window.confirm('Leave this workspace? You will need to be invited again to rejoin.');
		if (!confirmLeave) return;

		leaving = true;
		try {
			const response = await apiFetch(`/apiv1/workspaces/${workspace.id}/leave`, {
				method: 'POST'
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to leave workspace');
			}

			toasts.add({
				title: 'Left workspace',
				color: 'success'
			});

			goto('/');
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to leave workspace',
				color: 'error'
			});
		} finally {
			leaving = false;
		}
	}

	onMount(async () => {
		await user.fetchUser();
		await fetchWorkspace();
		await fetchRoles();
	});

	
	function openProject(projectSlug: string) {
		return goto(`/workspaces/${slug}/projects/${projectSlug}`);
	}

function handleProjectClick(event: MouseEvent, projectSlug: string) {
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
	openProject(projectSlug);
}

	async function deleteWorkspace() {
		if (!workspace || deletingWorkspace) return;
		const confirmDelete = window.confirm('Delete this workspace? This action cannot be undone.');
		if (!confirmDelete) return;

		deletingWorkspace = true;
		deleteError = null;

		try {
			const response = await apiFetch(`/apiv1/workspaces/${workspace.id}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to delete workspace');
			}

			refreshTree();
			goto('/');
		} catch (e) {
			deleteError = e instanceof Error ? e.message : 'Failed to delete workspace';
		} finally {
			deletingWorkspace = false;
		}
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
				<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading workspace...</p>
			</div>
		</div>
	{:else if workspace}
		<!-- Workspace Header -->
		<div
			class="mb-8 rounded-3xl border p-6 shadow-sm"
			style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div>
					<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Workspace</p>
					<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">
						{workspace.name}
					</h1>
					{#if workspace.description}
						<p class="mt-2 text-sm" style="color: var(--surface-muted);">
							{workspace.description}
						</p>
					{/if}
					<div class="mt-3 flex flex-wrap items-center gap-4 text-xs" style="color: var(--surface-muted);">
						{#if workspace.createdBy}
							<div class="flex items-center gap-1">
								<User class="h-4 w-4" />
								<span>Created by {workspace.createdBy.firstName || workspace.createdBy.email}</span>
							</div>
						{/if}
						<div class="flex items-center gap-1">
							<Calendar class="h-4 w-4" />
							<span>{new Date(workspace.createdAt).toLocaleDateString()}</span>
						</div>
					</div>
				</div>
				<div class="flex flex-wrap gap-3 text-xs md:justify-end" style="color: var(--surface-muted);">
					<span
						class="rounded-full px-3 py-1 font-medium"
						style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
					>
						{workspace.projects?.length ?? 0} projects
					</span>
					<span
						class="rounded-full px-3 py-1 font-medium"
						style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
					>
						{workspace.members?.length ?? 0} members
					</span>
				</div>
			</div>
		</div>

		<div class="grid gap-6 lg:grid-cols-3">
			<!-- Projects Section -->
			<div class="lg:col-span-2">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-lg font-semibold" style="color: var(--center-channel-color);">
						Projects ({workspace.projects?.length ?? 0})
					</h2>
					<a href="/workspaces/{slug}/projects/new" class="btn btn-primary">
						<Plus class="h-4 w-4" />
						New Project
					</a>
				</div>

				{#if !workspace.projects?.length}
					<div class="card p-8 text-center">
						<FolderKanban class="mx-auto h-12 w-12 text-gray-400" />
						<h3 class="mt-4 font-medium" style="color: var(--center-channel-color);">No projects yet</h3>
						<p class="mt-2 text-sm" style="color: var(--surface-muted);">
							Create your first project to start deploying.
						</p>
						<a href="/workspaces/{slug}/projects/new" class="btn btn-primary mt-4">
							<Plus class="h-4 w-4" />
							Create Project
						</a>
						<button
							class="btn btn-secondary mt-3 inline-flex items-center justify-center gap-2"
							onclick={deleteWorkspace}
							disabled={deletingWorkspace}
						>
							{#if deletingWorkspace}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Trash2 class="h-4 w-4" />
							{/if}
							Delete workspace
						</button>
						{#if deleteError}
							<div class="alert alert-error mt-3">{deleteError}</div>
						{/if}
					</div>
				{:else}
					<div class="flex flex-col gap-4" {...projectMenu.root}>
						<label class="workspace-search flex items-center gap-3 rounded-2xl border px-4 py-2 text-sm shadow-sm transition">
							<span class="text-xs font-semibold uppercase tracking-wide">Search</span>
							<input
								type="search"
								placeholder="Filter projects..."
								class="flex-1 bg-transparent text-base focus:outline-none"
								bind:value={projectSearch}
								{...projectMenu.input}
							/>
						</label>

						{#if filteredProjects.length}
							<div class="max-h-[70vh] overflow-y-auto pr-1">
								<div
									class="grid gap-4 p-1"
									style:grid-template-columns="repeat(auto-fill,minmax(220px,1fr))"
								>
									{#each filteredProjects as project}
										{@const href = `/workspaces/${slug}/projects/${project.slug}`}
										{@const item = projectMenu.getItem(project, {
											onSelect: () => openProject(project.slug)
										})}
										<a
											class={`workspace-card group flex h-full flex-col gap-4 rounded-2xl border p-4 text-left shadow-sm transition-all ${
												item.highlighted ? 'workspace-card--highlight' : ''
											}`}
											{...mergeAttrs(item.attrs, {
												href,
												onclick: event => handleProjectClick(event as MouseEvent, project.slug)
											})}
										>
											<div class="flex items-start justify-between gap-4">
												<div>
													<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">
														Project
													</p>
													<h3 class="mt-1 text-lg font-semibold" style="color: var(--center-channel-color);">
														{project.name}
													</h3>
												</div>
											</div>
											{#if project.description}
												<p class="line-clamp-3 text-sm" style="color: var(--surface-muted);">
													{project.description}
												</p>
											{/if}
											{#if project.repositoryUrl}
												<p class="truncate text-xs font-mono" style="color: var(--surface-muted);">
													{project.repositoryUrl}
												</p>
											{/if}
											<div
												class="mt-auto flex items-center gap-4 text-sm"
												style="color: var(--surface-muted);"
											>
												<div class="flex items-center gap-1">
													<FolderKanban class="h-4 w-4" />
													<span>{project._count?.deployments ?? 0} deployments</span>
												</div>
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
									No projects match “{projectSearch}”.
								</p>
								<p class="mt-1 text-sm">Try adjusting your search.</p>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Members Section -->
			<div class="space-y-3">
				<div class="flex items-center justify-between">
					<h2 class="text-lg font-semibold" style="color: var(--center-channel-color);">
						Members ({workspace.members?.length ?? 0})
					</h2>
					{#if isWorkspaceAdmin}
						<button
							class="btn btn-sm btn-primary"
							onclick={() => {
								showInviteDialog = true;
								fetchOrgMembers();
							}}
						>
							<UserPlus class="h-4 w-4" />
							Invite
						</button>
					{/if}
				</div>
				<div class="card">
					<div class="divide-y" style="border-color: var(--surface-border);">
						{#if workspace.members?.length}
							{#each workspace.members as member}
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
									<div class="min-w-0 flex-1">
										<p class="truncate text-sm font-medium" style="color: var(--center-channel-color);">
											{member.user.firstName} {member.user.lastName || ''}
										</p>
										<p class="truncate text-xs" style="color: var(--surface-muted);">{member.user.email}</p>
									</div>
									<span class="badge badge-neutral text-xs">
										{member.role.name}
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
				{#if $user && currentUserId}
					{#if !isMember}
						<button
							class="btn btn-primary w-full"
							onclick={joinWorkspace}
							disabled={joining}
						>
							{#if joining}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Check class="h-4 w-4" />
							{/if}
							Join Workspace
						</button>
					{:else if !isWorkspaceAdmin}
						<button
							class="btn btn-secondary w-full"
							onclick={leaveWorkspace}
							disabled={leaving}
						>
							{#if leaving}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<LogOut class="h-4 w-4" />
							{/if}
							Leave Workspace
						</button>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if showInviteDialog}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) showInviteDialog = false;
		}}
		role="dialog"
		aria-modal="true"
	>
		<div
			class="w-full max-w-md rounded-2xl border p-6 shadow-lg"
			style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<div class="mb-4 flex items-center justify-between">
				<h2 class="text-lg font-semibold">Invite Member</h2>
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => {
						showInviteDialog = false;
						selectedUserId = '';
						selectedRoleId = '';
					}}
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="space-y-4">
				<div>
					<label class="mb-2 block text-sm font-medium">Organization Member</label>
					{#if loadingOrgMembers}
						<p class="text-sm text-gray-500">Loading members...</p>
					{:else if orgMembers.length === 0}
						<p class="text-sm text-gray-500">No organization members found. There may be an issue loading members.</p>
					{:else}
						{@const availableMembers = orgMembers.filter(om => !workspace?.members?.some(m => m.user.id === om.user.id))}
						{#if availableMembers.length === 0}
							<p class="text-sm text-gray-500">All organization members are already in this workspace. Add more members to your organization first.</p>
						{:else}
							<select
								class="select select-bordered w-full"
								bind:value={selectedUserId}
								disabled={inviting}
							>
								<option value="">Select a member...</option>
								{#each availableMembers as orgMember}
									<option value={orgMember.user.id}>
										{orgMember.user.firstName} {orgMember.user.lastName || ''} ({orgMember.user.email})
									</option>
								{/each}
							</select>
						{/if}
					{/if}
				</div>

				<div>
					<label class="mb-2 block text-sm font-medium">Role</label>
					<select
						class="select select-bordered w-full"
						bind:value={selectedRoleId}
						disabled={inviting}
					>
						<option value="">Select a role...</option>
						{#each roles as role}
							<option value={role.id}>{role.name}</option>
						{/each}
					</select>
				</div>

				<div class="flex gap-3">
					<button
						class="btn btn-secondary flex-1"
						onclick={() => {
							showInviteDialog = false;
							selectedUserId = '';
							selectedRoleId = '';
						}}
						disabled={inviting}
					>
						Cancel
					</button>
					<button
						class="btn btn-primary flex-1"
						onclick={inviteMember}
						disabled={!selectedUserId || !selectedRoleId || inviting}
					>
						{#if inviting}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<UserPlus class="h-4 w-4" />
						{/if}
						Invite
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
