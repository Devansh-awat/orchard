<script lang="ts">
import { goto } from '$app/navigation';
import { page } from '$app/stores';
import { onMount } from 'svelte';
import { apiFetch, user, toasts, selectedOrganization, refreshTree } from '$lib/stores';
import { mergeAttrs } from 'melt';
import { SpatialMenu } from 'melt/builders';
import { ArrowLeft, Loader2, Plus, FolderKanban, Calendar, User, Trash2, UserPlus, LogOut, Check, X, Users, Boxes } from 'lucide-svelte';
import ConfirmModal from '$lib/components/ConfirmModal.svelte';

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
let showLeaveModal = $state(false);
let showDeleteWorkspaceModal = $state(false);
let roles = $state<Array<{ id: string; name: string }>>([]);
let currentOrgMembership = $state<OrgMember | null>(null);

	const currentUserId = $derived($user?.id);
	const currentUserMember = $derived.by(() => {
		if (!workspace || !currentUserId) return null;
		return workspace.members?.find(m => m.user.id === currentUserId);
	});
	const isWorkspaceAdmin = $derived(currentUserMember?.role?.name === 'admin');
	const isOrgAdminOrOwner = $derived(
		currentOrgMembership &&
		(currentOrgMembership.role === 'owner' || currentOrgMembership.role === 'admin')
	);
	const canManageMembers = $derived(isWorkspaceAdmin || isOrgAdminOrOwner);
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

	const wsSlug = $derived($page.params.wsSlug);
	const orgSlug = $derived($page.params.orgSlug);

	async function fetchWorkspace() {
		loading = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/workspaces/slug/${wsSlug}`);
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

	async function fetchCurrentOrgMembership() {
		if (!workspace?.organization?.id) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${workspace.organization.id}/members/me`);
			if (response.ok) {
				currentOrgMembership = await response.json();
			}
		} catch (e) {
			console.error('Failed to fetch current org membership:', e);
		}
	}

	async function addMember() {
		if (!workspace || !selectedUserId || !selectedRoleId || inviting) return;

		inviting = true;
		try {
			const response = await apiFetch(`/apiv1/workspaces/${workspace.id}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userId: selectedUserId,
					roleId: selectedRoleId
				})
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to add member');
			}

			toasts.add({
				title: 'Member added successfully',
				color: 'success'
			});

			showInviteDialog = false;
			selectedUserId = '';
			selectedRoleId = '';
			fetchWorkspace();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to add member',
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

			goto(`/${orgSlug}`);
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
		await fetchCurrentOrgMembership();
	});


	function openProject(projectSlug: string) {
		return goto(`/${orgSlug}/workspaces/${wsSlug}/projects/${projectSlug}`);
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
			goto(`/${orgSlug}`);
		} catch (e) {
			deleteError = e instanceof Error ? e.message : 'Failed to delete workspace';
		} finally {
			deletingWorkspace = false;
		}
	}
</script>

<div class="ws-page">
	{#if error}
		<div class="ws-error">{error}</div>
	{/if}

	{#if loading}
		<!-- Skeleton: Header -->
		<div class="ws-header">
			<div class="ws-header-top">
				<div class="ws-header-info">
					<div class="skeleton" style="height: 1.5rem; width: 40%; margin-bottom: 0.375rem;"></div>
					<div class="skeleton" style="height: 0.875rem; width: 60%;"></div>
				</div>
			</div>
		</div>
		<!-- Skeleton: Stats -->
		<div class="ws-stats">
			{#each Array(3) as _}
				<div class="skeleton" style="height: 1.75rem; width: 5.5rem; border-radius: 0.5rem;"></div>
			{/each}
		</div>
		<!-- Skeleton: Projects header -->
		<div class="ws-projects-header">
			<div class="skeleton" style="height: 1.125rem; width: 5rem;"></div>
		</div>
		<!-- Skeleton: Project cards -->
		<div class="ws-project-grid">
			{#each Array(4) as _}
				<div class="ws-project-card" style="pointer-events: none;">
					<div class="ws-project-card-top">
						<div class="skeleton skeleton-icon"></div>
						<div class="skeleton skeleton-badge"></div>
					</div>
					<div class="ws-project-card-body">
						<div class="skeleton skeleton-title"></div>
						<div class="skeleton skeleton-desc"></div>
					</div>
				</div>
			{/each}
		</div>
		<!-- Skeleton: Team -->
		<div class="ws-team">
			<div class="ws-team-header">
				<div class="skeleton" style="height: 0.75rem; width: 4rem;"></div>
			</div>
			<div class="ws-team-avatars">
				{#each Array(3) as _}
					<div class="skeleton" style="width: 5rem; height: 1.875rem; border-radius: 9999px;"></div>
				{/each}
			</div>
		</div>
	{:else if workspace}
		<!-- Header -->
		<div class="ws-header">
			<div class="ws-header-top">
				<div class="ws-header-info">
					<h1 class="ws-title">{workspace.name}</h1>
					{#if workspace.description}
						<p class="ws-description">{workspace.description}</p>
					{/if}
				</div>
				{#if canManageMembers}
					<button
						class="ws-btn ws-btn-danger"
						onclick={() => { showDeleteWorkspaceModal = true; }}
						disabled={deletingWorkspace}
					>
						{#if deletingWorkspace}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Trash2 class="h-4 w-4" />
						{/if}
						Delete
					</button>
				{/if}
			</div>
			{#if deleteError}
				<div class="ws-error" style="margin-top: 0.75rem;">{deleteError}</div>
			{/if}
		</div>

		<!-- Stats Row -->
		<div class="ws-stats">
			<div class="ws-stat">
				<FolderKanban class="h-4 w-4" />
				<span class="ws-stat-value">{workspace.projects?.length ?? 0}</span>
				<span class="ws-stat-label">Projects</span>
			</div>
			<div class="ws-stat">
				<Users class="h-4 w-4" />
				<span class="ws-stat-value">{workspace.members?.length ?? 0}</span>
				<span class="ws-stat-label">Members</span>
			</div>
			<div class="ws-stat">
				<Calendar class="h-4 w-4" />
				<span class="ws-stat-label">{new Date(workspace.createdAt).toLocaleDateString()}</span>
			</div>
			{#if workspace.createdBy}
				<div class="ws-stat">
					<User class="h-4 w-4" />
					<span class="ws-stat-label">by {workspace.createdBy.firstName || workspace.createdBy.email}</span>
				</div>
			{/if}
		</div>

		<!-- Projects -->
		<div class="ws-projects-header">
			<h2 class="ws-section-title">Projects</h2>
			<div class="ws-projects-toolbar">
				{#if workspace.projects?.length}
					<div class="ws-project-search-bar" {...projectMenu.root}>
						<input
							type="search"
							placeholder="Search projects..."
							class="ws-search-input"
							bind:value={projectSearch}
							{...projectMenu.input}
						/>
					</div>
				{/if}
				<a href="/{orgSlug}/workspaces/{wsSlug}/projects/new" class="ws-btn ws-btn-primary">
					<Plus class="h-4 w-4" />
					New Project
				</a>
			</div>
		</div>

		{#if !workspace.projects?.length}
			<div class="ws-empty-card">
				<span style:color="var(--surface-muted)"><FolderKanban class="h-10 w-10" /></span>
				<p>No projects yet</p>
				<a href="/{orgSlug}/workspaces/{wsSlug}/projects/new" class="ws-btn ws-btn-primary ws-btn-mt">
					<Plus class="h-4 w-4" />
					Create Project
				</a>
			</div>
		{:else if filteredProjects.length}
			<div class="ws-project-grid">
				{#each filteredProjects as project}
					{@const href = `/${orgSlug}/workspaces/${wsSlug}/projects/${project.slug}`}
					{@const item = projectMenu.getItem(project, {
						onSelect: () => openProject(project.slug)
					})}
					<a
						class="ws-project-card"
						class:is-highlighted={item.highlighted}
						{...mergeAttrs(item.attrs, {
							href,
							onclick: (event: Event) => handleProjectClick(event as MouseEvent, project.slug)
						})}
					>
						<div class="ws-project-card-top">
							<div class="ws-project-icon">
								<FolderKanban class="h-6 w-6" />
							</div>
							<div class="ws-project-deploy-badge">
								<span class="ws-project-deploy-count">
									{project._count?.deployments ?? 0}
								</span>
								<span>deployments</span>
							</div>
						</div>
						<div class="ws-project-card-body">
							<span class="ws-project-name">{project.name}</span>
							{#if project.description}
								<span class="ws-project-desc">{project.description}</span>
							{/if}
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="ws-empty-card">
				<p>No projects match "{projectSearch}"</p>
			</div>
		{/if}

		<!-- Team -->
		<div class="ws-team">
			<div class="ws-team-header">
				<h3 class="ws-team-title">
					<Users class="h-3.5 w-3.5" />
					Team ({workspace.members?.length ?? 0})
				</h3>
				<div class="ws-team-actions">
					{#if $user && currentUserId}
						{#if !isMember}
							<button
								class="ws-btn ws-btn-primary ws-btn-sm"
								onclick={joinWorkspace}
								disabled={joining}
							>
								{#if joining}
									<Loader2 class="h-3 w-3 animate-spin" />
								{:else}
									<Check class="h-3 w-3" />
								{/if}
								Join
							</button>
						{:else if !isWorkspaceAdmin}
							<button
								class="ws-btn ws-btn-ghost ws-btn-sm"
								onclick={() => { showLeaveModal = true; }}
								disabled={leaving}
							>
								{#if leaving}
									<Loader2 class="h-3 w-3 animate-spin" />
								{:else}
									<LogOut class="h-3 w-3" />
								{/if}
								Leave
							</button>
						{/if}
					{/if}
					{#if canManageMembers}
						<button
							class="ws-btn ws-btn-secondary ws-btn-sm"
							onclick={() => {
								showInviteDialog = true;
								fetchOrgMembers();
							}}
						>
							<UserPlus class="h-3 w-3" />
							Add
						</button>
					{/if}
				</div>
			</div>

			{#if workspace.members?.length}
				<div class="ws-team-avatars">
					{#each workspace.members as member}
						<div class="ws-team-member" title="{member.user.firstName || ''} {member.user.lastName || ''} ({member.role.name})">
							{#if member.user.imageUrl}
								<img
									src={member.user.imageUrl}
									alt={member.user.firstName || member.user.email}
									class="ws-team-avatar"
								/>
							{:else}
								<div class="ws-team-avatar-fallback">
									{member.user.firstName?.[0] || member.user.email[0].toUpperCase()}
								</div>
							{/if}
							<span class="ws-team-name">{member.user.firstName || member.user.email.split('@')[0]}</span>
							<span class="ws-team-role">{member.role.name}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="ws-team-empty">No members yet</p>
			{/if}
		</div>
	{/if}
</div>

{#if showInviteDialog}
	<div
		class="ws-dialog-overlay"
		onclick={(e) => {
			if (e.target === e.currentTarget) showInviteDialog = false;
		}}
		role="dialog"
		aria-modal="true"
	>
		<div class="ws-dialog">
			<div class="ws-dialog-header">
				<h2>Add Member</h2>
				<button
					class="ws-btn ws-btn-ghost"
					onclick={() => {
						showInviteDialog = false;
						selectedUserId = '';
						selectedRoleId = '';
					}}
				>
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="ws-dialog-body">
				<div class="ws-field">
					<label class="ws-label">Organization Member</label>
					{#if loadingOrgMembers}
						<p class="ws-field-hint">Loading members...</p>
					{:else if orgMembers.length === 0}
						<p class="ws-field-hint">No organization members found.</p>
					{:else}
						{@const availableMembers = orgMembers.filter(om => !workspace?.members?.some(m => m.user.id === om.user.id))}
						{#if availableMembers.length === 0}
							<p class="ws-field-hint">All organization members are already in this workspace.</p>
						{:else}
							<select
								class="ws-select"
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

				<div class="ws-field">
					<label class="ws-label">Role</label>
					<select
						class="ws-select"
						bind:value={selectedRoleId}
						disabled={inviting}
					>
						<option value="">Select a role...</option>
						{#each roles as role}
							<option value={role.id}>{role.name}</option>
						{/each}
					</select>
				</div>

				<div class="ws-dialog-actions">
					<button
						class="ws-btn ws-btn-secondary"
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
						class="ws-btn ws-btn-primary"
						onclick={addMember}
						disabled={!selectedUserId || !selectedRoleId || inviting}
					>
						{#if inviting}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<UserPlus class="h-4 w-4" />
						{/if}
						Add Member
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if workspace}
	<ConfirmModal
		bind:open={showLeaveModal}
		title="Leave this workspace?"
		description="You will need to be <strong>invited again</strong> to rejoin this workspace."
		confirmLabel="Leave"
		danger={false}
		onconfirm={leaveWorkspace}
		oncancel={() => {}}
	/>
	<ConfirmModal
		bind:open={showDeleteWorkspaceModal}
		title='Delete "{workspace.name}"?'
		description='This will permanently <strong>delete this workspace</strong> and all its projects, deployments, databases, and ingresses. This cannot be undone.'
		confirmLabel="Delete Workspace"
		onconfirm={deleteWorkspace}
		oncancel={() => {}}
	/>
{/if}

<style>
	.ws-page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	.ws-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	.ws-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	/* Header */
	.ws-header {
		margin-bottom: 1.5rem;
	}

	.ws-header-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.ws-header-info {
		flex: 1;
		min-width: 0;
	}

	.ws-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.ws-description {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	/* Stats */
	.ws-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.ws-stat {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.ws-stat-value {
		font-weight: 600;
		color: var(--center-channel-color);
	}

	/* Projects header */
	.ws-projects-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.ws-section-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.ws-projects-toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.ws-project-search-bar {
		width: 14rem;
	}

	.ws-search-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}

	.ws-search-input::placeholder {
		color: var(--surface-muted);
	}

	.ws-search-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	/* Project grid */
	.ws-project-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}

	.ws-project-card {
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

	.ws-project-card:hover,
	.ws-project-card.is-highlighted {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent);
	}

	.ws-project-card-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
	}

	.ws-project-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		color: var(--sidebar-text-active-border);
		flex-shrink: 0;
	}

	.ws-project-deploy-badge {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
		padding: 0.25rem 0.5rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.ws-project-deploy-count {
		font-weight: 700;
		color: var(--center-channel-color);
	}

	.ws-project-card-body {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.ws-project-name {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.ws-project-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* Empty card */
	.ws-empty-card {
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

	/* Team (secondary/compact) */
	.ws-team {
		margin-top: 0.5rem;
		padding: 0.875rem 1rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		border-radius: 1rem;
		background-color: color-mix(in srgb, var(--surface-bg) 50%, transparent);
	}

	.ws-team-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.625rem;
	}

	.ws-team-title {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		margin: 0;
	}

	.ws-team-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.ws-team-avatars {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.ws-team-member {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem 0.25rem 0.25rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 35%, transparent);
		transition: background-color 0.15s;
		cursor: default;
	}

	.ws-team-member:hover {
		background-color: color-mix(in srgb, var(--surface-border) 55%, transparent);
	}

	.ws-team-avatar {
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.ws-team-avatar-fallback {
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.625rem;
		font-weight: 600;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
		flex-shrink: 0;
	}

	.ws-team-name {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.ws-team-role {
		font-size: 0.625rem;
		color: var(--surface-muted);
		text-transform: capitalize;
	}

	.ws-team-empty {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	/* Buttons */
	.ws-btn {
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

	.ws-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ws-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
	}

	.ws-btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.ws-btn-mt {
		margin-top: 0.5rem;
	}

	.ws-btn-secondary {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
	}

	.ws-btn-secondary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 90%, transparent);
	}

	.ws-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.ws-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	.ws-btn-ghost {
		background: none;
		color: var(--surface-muted);
		padding: 0.375rem;
		border-radius: 0.375rem;
	}

	.ws-btn-ghost:hover {
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.ws-btn-sm {
		padding: 0.3125rem 0.625rem;
		font-size: 0.75rem;
		gap: 0.25rem;
	}

	.ws-btn-full {
		width: 100%;
		justify-content: center;
	}

	/* Dialog */
	.ws-dialog-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: rgba(0, 0, 0, 0.5);
		padding: 1rem;
	}

	.ws-dialog {
		width: 100%;
		max-width: 28rem;
		border-radius: 1rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
	}

	.ws-dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem;
		border-bottom: 1px solid var(--surface-border);
		font-weight: 600;
	}

	.ws-dialog-body {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.ws-dialog-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
		padding-top: 0.5rem;
	}

	.ws-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.ws-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.ws-field-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}

	.ws-select {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}

	.ws-select:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}
</style>
