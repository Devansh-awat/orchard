<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { animate } from 'motion';
	import { springPop } from '$lib/utils/motion.svelte';
	import { apiFetch, toasts, refreshTree, subscribeOrgEvents, sseStatusFor } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import type { PageData } from './$types';
	import { SpatialMenu } from 'melt/builders';
	import { Server, TriangleAlert } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import NewResourceModal from '$lib/components/NewResourceModal.svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';

	import {
		ProjectHero,
		ProjectHeader,
		ProjectTabs,
		ResourcesTab,
		ComposeTab,
		MembersTab,
		CustomizeModal
	} from '$lib/components/project';
	import type {
		Project,
		Deployment,
		ProjectMember,
		TemplateInstanceSummary,
		DatabaseSummary,
		ComposeStackSummary,
		OrgMember,
		PendingInvitation
	} from '$lib/components/project';

	import '$lib/components/project/project.css';

	// Disable native macOS rubber-band overscroll on this page only
	onMount(() => {
		const main = document.querySelector<HTMLElement>('main.flex-1');
		if (!main) return;
		const prev = main.style.overscrollBehavior;
		main.style.overscrollBehavior = 'none';
		return () => {
			main.style.overscrollBehavior = prev;
		};
	});

	const deploymentMenu = new SpatialMenu<Deployment>({
		wrap: true,
		crossAxis: true
	});

	// --- Props / page data ---
	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);
	const projectSlug = $derived(data.projectSlug);

	// --- State ---
	let project = $state<Project | null>(null);
	const canEdit = $derived(project?.currentUserRole?.canEdit ?? false);
	const canManageMembers = $derived(project?.currentUserRole?.canManageMembers ?? false);
	const canDelete = $derived(project?.currentUserRole?.canDelete ?? false);
	let templateInstances = $state<TemplateInstanceSummary[]>([]);
	let databases = $state<DatabaseSummary[]>([]);
	let loading = $state(true);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let heroImgReady = $state(false);
	let showDeleteModal = $state(false);
	let deploymentSearch = $state('');
	let showNewResourceModal = $state(false);
	let projectMembers = $state<ProjectMember[]>([]);
	let pendingInvitations = $state<PendingInvitation[]>([]);
	let revokingInviteId = $state<string | null>(null);
	let newMemberRole = $state<'member' | 'admin' | 'viewer'>('member');
	let addingMember = $state(false);
	let favFailed = $state<Set<string>>(new Set());
	let showCustomize = $state(false);
	let removingMemberId = $state<string | null>(null);
	let updatingMemberId = $state<string | null>(null);
	let openRoleMenuId = $state<string | null>(null);
	let activeTab = $state<'resources' | 'compose' | 'members'>('resources');
	let memberSearch = $state('');

	// Compose stacks — keyed by project id so SSE-driven project refetches
	// don't re-trigger this request (staleTime gates background refetches).
	const composeQuery = createQuery(() => {
		const projectId = project?.id;
		return {
			queryKey: ['compose-stacks', projectId ?? ''],
			enabled: !!projectId,
			queryFn: async () => {
				const response = await apiFetch(`/apiv1/projects/${projectId}/compose-stacks`);
				if (!response.ok) throw new Error('Failed to fetch compose stacks');
				return response.json() as Promise<ComposeStackSummary[]>;
			},
			staleTime: 30_000
		};
	});
	const composeStacks = $derived<ComposeStackSummary[]>(composeQuery.data ?? []);
	const composeStacksLoading = $derived(!!project?.id && composeQuery.isPending);

	// --- Hero/tab animation ---
	let tabsRowEl = $state<HTMLElement | null>(null);
	let tabPanelEl = $state<HTMLElement | null>(null);
	let firstTabRun = true;

	$effect(() => {
		const _tab = activeTab; // subscribe
		if (firstTabRun) {
			firstTabRun = false;
			return;
		}
		const dir = activeTab === 'members' ? -1 : 1;
		tick().then(() => {
			if (tabsRowEl) {
				animate(
					tabsRowEl,
					{ y: [dir * 5, 0] },
					{ type: 'spring', stiffness: 220, damping: 15, mass: 0.9 }
				);
			}
			if (tabPanelEl) {
				animate(
					tabPanelEl,
					{ y: [dir * 9, 0], opacity: [0.5, 1] },
					{ type: 'spring', stiffness: 180, damping: 15, mass: 1.2, delay: 0.05 }
				);
			}
		});
	});

	// --- Org members for picker ---
	let orgMembers = $state<OrgMember[]>([]);
	let orgMembersLoaded = false;

	async function ensureOrgMembersLoaded() {
		if (orgMembersLoaded || !project) return;
		orgMembersLoaded = true;
		try {
			const res = await apiFetch(`/apiv1/organizations/${project.organization?.id ?? ''}/members`);
			if (res.ok) orgMembers = await res.json();
		} catch {
			orgMembersLoaded = false;
		}
	}

	const availableOrgMembers = $derived.by(() => {
		const existingUserIds = new Set(projectMembers.map((m) => m.user.id));
		return orgMembers.filter((m) => !existingUserIds.has(m.user.id));
	});

	const filteredOrgMembers = $derived.by(() => {
		const query = memberSearch.trim().toLowerCase();
		if (!query) return availableOrgMembers;
		return availableOrgMembers.filter((m) => {
			const name = `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.toLowerCase();
			return name.includes(query) || m.user.email.toLowerCase().includes(query);
		});
	});

	// --- Filtered deployments ---
	let filteredDeployments = $derived.by(() => {
		const deployments = project?.deployments ?? [];
		const query = deploymentSearch.trim().toLowerCase();
		if (!query) return deployments;
		return deployments.filter((deployment) => {
			const name = deployment.name?.toLowerCase() ?? '';
			const status = deployment.status?.toLowerCase() ?? '';
			const image = deployment.image?.toLowerCase() ?? '';
			return name.includes(query) || status.includes(query) || image.includes(query);
		});
	});

	async function fetchProject() {
		await queryClient.invalidateQueries({ queryKey: ['project-detail', orgSlug, projectSlug] });
	}

	function applyProjectData(p: any) {
		project = p;
		projectMembers = p.members ?? [];
		pendingInvitations = p.pendingInvitations ?? [];
		templateInstances = p.templateInstances ?? [];
		databases = p.databases ?? [];
	}

	// --- Namespace sync ---
	let lastSyncedNamespace: string | null = null;
	async function syncNamespace() {
		if (!project?.namespace) return;
		if (project.namespace === lastSyncedNamespace) return;
		lastSyncedNamespace = project.namespace;
		try {
			// The server exposes sync as GET (kubernetes.controller.ts) — a POST
			// here 404s and the namespace never syncs.
			await apiFetch(`/apiv1/sync/${project.namespace}`);
			// Refresh through the query (coalesced) instead of a second full
			// project GET that could race and overwrite fresher data.
			scheduleProjectRefetch();
		} catch (e) {
			console.error('Failed to sync namespace:', e);
		}
	}

	// --- Actions ---
	async function deleteProject() {
		if (!project) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}`, { method: 'DELETE' });
			if (!response.ok) {
				let errorMessage = 'Failed to delete project';
				try {
					const errorData = await response.json();
					if (errorData.message) errorMessage = errorData.message;
					else if (errorData.error) errorMessage = errorData.error;
				} catch {
					if (response.status === 403)
						errorMessage = 'You do not have permission to delete this project.';
					else if (response.status === 404) errorMessage = 'Project not found';
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

	async function addMember(email: string) {
		if (!project || !email) return;
		addingMember = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, role: newMemberRole })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to add member');
			}
			const result = await response.json().catch(() => ({}));
			if (result.invited) {
				toasts.add({
					title: 'Invitation sent',
					description: `${email} will join this project as a guest once they accept`,
					color: 'success'
				});
			} else {
				toasts.add({ title: 'Member added', color: 'success' });
			}
			memberSearch = '';
			newMemberRole = 'member';
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to add member',
				color: 'error'
			});
		} finally {
			addingMember = false;
		}
	}

	async function updateMemberRole(memberId: string, role: string, prevRole: string) {
		if (!project || role === prevRole) return;
		updatingMemberId = memberId;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/members/${memberId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update role');
			}
			toasts.add({ title: 'Role updated', color: 'success' });
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update role',
				color: 'error'
			});
			await fetchProject();
		} finally {
			updatingMemberId = null;
		}
	}

	async function removeMember(memberId: string) {
		if (!project) return;
		removingMemberId = memberId;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/members/${memberId}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to remove member');
			}
			toasts.add({ title: 'Member removed', color: 'success' });
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove member',
				color: 'error'
			});
		} finally {
			removingMemberId = null;
		}
	}

	async function revokeInvitation(invitationId: string) {
		if (!project) return;
		revokingInviteId = invitationId;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/invitations/${invitationId}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to revoke invitation');
			}
			toasts.add({ title: 'Invitation revoked', color: 'success' });
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to revoke invitation',
				color: 'error'
			});
		} finally {
			revokingInviteId = null;
		}
	}

	// --- Customize handlers ---
	async function handleCustomizeSave(payload: Record<string, string | null>) {
		if (!project) return;
		if (Object.keys(payload).length > 0) {
			const res = await apiFetch(`/apiv1/projects/${project.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to save');
			}
			const updated = await res.json();
			project = {
				...project,
				name: updated.name,
				icon: updated.icon,
				backgroundImage: updated.backgroundImage
			};
		}
		toasts.add({ title: 'Project updated', color: 'success' });
	}

	async function handleIconUpload(file: File): Promise<string | null> {
		if (!project) return null;
		const fd = new FormData();
		fd.append('file', file);
		const res = await apiFetch(`/apiv1/projects/${project.id}/icon`, { method: 'POST', body: fd });
		if (!res.ok) {
			const d = await res.json().catch(() => ({}));
			toasts.add({
				title: 'Upload failed',
				description: d.message || 'Upload failed',
				color: 'error'
			});
			return null;
		}
		const updated = await res.json();
		project = { ...project, icon: updated.icon };
		toasts.add({ title: 'Icon uploaded', color: 'success' });
		return updated.icon;
	}

	async function handleBgUpload(file: File): Promise<string | null> {
		if (!project) return null;
		const fd = new FormData();
		fd.append('file', file);
		const res = await apiFetch(`/apiv1/projects/${project.id}/background-image`, {
			method: 'POST',
			body: fd
		});
		if (!res.ok) {
			const d = await res.json().catch(() => ({}));
			toasts.add({
				title: 'Upload failed',
				description: d.message || 'Upload failed',
				color: 'error'
			});
			return null;
		}
		const updated = await res.json();
		project = { ...project, backgroundImage: updated.backgroundImage };
		toasts.add({ title: 'Background uploaded', color: 'success' });
		return updated.backgroundImage;
	}

	// --- Navigation ---
	function openDeployment(id: string) {
		return goto(`/${orgSlug}/deployments/${id}`);
	}

	function handleDeploymentClick(event: MouseEvent, id: string) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
			return;
		event.preventDefault();
		openDeployment(id);
	}

	// --- Live updates: SSE connection health ---
	let sseStatusValue = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
	const sseDisconnected = $derived(sseStatusValue === 'disconnected');
	const orgId = $derived(project?.organization?.id ?? null);

	// Coalesce SSE bursts (a single deploy emits many pod/deployment events in
	// quick succession) into one refetch instead of N concurrent full reloads.
	let refetchTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleProjectRefetch() {
		if (refetchTimer) return;
		refetchTimer = setTimeout(() => {
			refetchTimer = null;
			queryClient.invalidateQueries({ queryKey: ['project-detail', orgSlug, projectSlug] });
		}, 350);
	}

	// ── TanStack Query: project data ──
	const TRANSIENT_DEPLOYMENT_STATUSES = new Set(['scaling', 'restarting', 'pending', 'unhealthy']);
	const projectQuery = createQuery(() => ({
		queryKey: ['project-detail', orgSlug, projectSlug],
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/projects/by-slugs/${orgSlug}/${projectSlug}`);
			if (!res.ok) {
				if (res.status === 404) throw new Error('Project not found');
				if (res.status === 403) throw new Error('Access denied');
				throw new Error(`Project load failed: ${res.status}`);
			}
			return res.json();
		},
		// Adaptive polling: fast while any resource is transitioning, fallback
		// poll while SSE is down, silent otherwise (SSE drives refetches).
		refetchInterval: (() => {
			const transient = (project?.deployments ?? []).some(
				(d: Deployment) =>
					TRANSIENT_DEPLOYMENT_STATUSES.has((d.status ?? '').toLowerCase()) ||
					(d.buildStatus ?? '').toLowerCase() === 'building'
			);
			if (transient) return 4000;
			if (sseStatusValue === 'disconnected') return 10_000;
			return false;
		})(),
		refetchIntervalInBackground: false
	}));

	// Reset page state when navigating between projects so the skeleton shows
	// instead of the previous project's data.
	let loadedSlug: string | null = null;
	let lastQueryData: unknown = null;
	$effect(() => {
		const slug = projectSlug;
		untrack(() => {
			if (loadedSlug !== null && loadedSlug !== slug) {
				lastQueryData = null;
				error = null;
				loading = true;
				project = null;
				projectMembers = [];
				pendingInvitations = [];
				templateInstances = [];
				databases = [];
				lastSyncedNamespace = null;
			}
			loadedSlug = slug;
		});
	});

	// Apply query data to local state (latest-wins: TanStack never resolves a
	// stale response after a newer one, which is what made cards flicker to
	// "Pending" under bursts of invalidations before).
	$effect(() => {
		const qData = projectQuery.data;
		const qError = projectQuery.error;
		const qPending = projectQuery.isPending;
		untrack(() => {
			if (qPending && !lastQueryData) return; // initial load — keep skeleton
			if (qError && !qData) {
				error = qError instanceof Error ? qError.message : 'Failed to fetch project';
				loading = false;
				return;
			}
			if (!qData || qData === lastQueryData) return;
			lastQueryData = qData;
			applyProjectData(qData);
			loading = false;
			error = null;
			if (qData?.namespace) syncNamespace();
		});
	});

	// Subscribe to org SSE once the org is known; re-runs only if orgId changes.
	$effect(() => {
		const id = orgId;
		if (!id) return;
		const unsubStatus = sseStatusFor(id).subscribe((v) => (sseStatusValue = v));
		const unsubEvents = subscribeOrgEvents(
			id,
			(ev) => {
				if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
				if (
					ev.projectId === project?.id ||
					ev.type === 'project.changed' ||
					ev.type === 'membership.changed'
				) {
					scheduleProjectRefetch();
				}
			},
			{ invalidateDependencies: [] }
		);
		return () => {
			unsubStatus();
			unsubEvents();
		};
	});

	onDestroy(() => {
		if (refetchTimer) clearTimeout(refetchTimer);
	});
</script>

<div class="pj-page" class:pj-page--hasbg={!!project?.backgroundImage}>
	{#if project?.backgroundImage && heroImgReady}
		<div class="pj-accent-glow" aria-hidden="true">
			<div
				class="pj-accent-glow-layer pj-accent-glow-layer--1"
				style="background-image: url({JSON.stringify(project.backgroundImage)});"
			></div>
			<div
				class="pj-accent-glow-layer pj-accent-glow-layer--2"
				style="background-image: url({JSON.stringify(project.backgroundImage)});"
			></div>
			<div
				class="pj-accent-glow-layer pj-accent-glow-layer--3"
				style="background-image: url({JSON.stringify(project.backgroundImage)});"
			></div>
			<div class="pj-accent-glow-fade"></div>
		</div>
	{/if}

	<div class="pj-page-inner">
		{#if sseDisconnected && !loading}
			<div class="pj-sse-alert" role="alert">
				<TriangleAlert class="h-4 w-4" style="flex-shrink: 0; margin-top: 0.0625rem;" />
				<div class="pj-sse-alert-body">
					<span class="pj-sse-alert-title">Live updates offline</span>
					<span class="pj-sse-alert-hint"
						>Real-time connection lost — reconnecting automatically. Data shown may be outdated.</span
					>
				</div>
				<button class="pj-sse-alert-action" onclick={() => location.reload()}>Reload</button>
			</div>
		{/if}

		{#if error}
			<div class="pj-error">{error}</div>
		{/if}

		{#if loading}
			<!-- Skeleton -->
			<div class="skeleton" style="height: 0.8125rem; width: 6rem; margin-bottom: 1rem;"></div>
			<div class="pj-header">
				<div class="pj-header-top">
					<div class="pj-header-info">
						<div
							class="skeleton"
							style="height: 1.5rem; width: 40%; margin-bottom: 0.375rem;"
						></div>
						<div class="skeleton" style="height: 0.875rem; width: 55%;"></div>
					</div>
					<div class="pj-header-actions">
						<div class="skeleton" style="height: 2rem; width: 4.5rem; border-radius: 0.5rem;"></div>
						<div class="skeleton" style="height: 2rem; width: 5rem; border-radius: 0.5rem;"></div>
					</div>
				</div>
			</div>
			<div class="pj-stats">
				{#each Array(3) as _}
					<div class="skeleton" style="height: 1.75rem; width: 6rem; border-radius: 0.5rem;"></div>
				{/each}
			</div>
			<div class="pj-deployments-header">
				<div class="skeleton" style="height: 1.125rem; width: 7rem;"></div>
			</div>
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
			<Breadcrumb
				crumbs={[
					{ label: 'Home', href: `/${orgSlug}` },
					{ label: 'Projects', href: `/${orgSlug}` },
					{ label: project.name }
				]}
			/>

			<!-- Hero / Header -->
			{#if project.backgroundImage}
				<ProjectHero
					{project}
					{activeTab}
					{canEdit}
					{canDelete}
					{deleting}
					bind:heroImgReady
					onCustomize={() => (showCustomize = true)}
					onDelete={() => (showDeleteModal = true)}
				/>
			{:else}
				<ProjectHeader
					{project}
					{canEdit}
					{canDelete}
					{deleting}
					onCustomize={() => (showCustomize = true)}
					onDelete={() => (showDeleteModal = true)}
				/>
			{/if}

			<!-- Tab bar -->
			<ProjectTabs
				bind:activeTab
				resourceCount={(project.deployments?.length ?? 0) +
					databases.length +
					templateInstances.length}
				composeCount={composeStacks.length}
				membersCount={projectMembers.length}
				repositoryUrl={project.repositoryUrl}
				hasDeployments={!!project.deployments?.length}
				bind:deploymentSearch
				onNewResource={() => (showNewResourceModal = true)}
				bind:tabsRowEl
				{deploymentMenu}
			/>

			{#if activeTab === 'resources'}
				<div class="pj-tab-panel" bind:this={tabPanelEl}>
					<ResourcesTab
						{filteredDeployments}
						{databases}
						{templateInstances}
						orgSlug={orgSlug ?? ''}
						{deploymentSearch}
						{deploymentMenu}
						bind:favFailed
						onDeploymentClick={handleDeploymentClick}
						onNewResource={() => (showNewResourceModal = true)}
						onOpenDeployment={openDeployment}
					/>
				</div>
			{/if}

			{#if activeTab === 'compose'}
				<div class="pj-tab-panel" bind:this={tabPanelEl}>
					<ComposeTab
						{composeStacks}
						{composeStacksLoading}
						orgSlug={orgSlug ?? ''}
						projectSlug={projectSlug ?? ''}
					/>
				</div>
			{/if}

			{#if activeTab === 'members'}
				<div class="pj-tab-panel" bind:this={tabPanelEl}>
					<MembersTab
						{projectMembers}
						{pendingInvitations}
						{canManageMembers}
						{canEdit}
						bind:memberSearch
						{filteredOrgMembers}
						{addingMember}
						{removingMemberId}
						{updatingMemberId}
						{revokingInviteId}
						bind:openRoleMenuId
						onAddMember={addMember}
						onUpdateMemberRole={updateMemberRole}
						onRemoveMember={removeMember}
						onRevokeInvitation={revokeInvitation}
						onEnsureOrgMembersLoaded={ensureOrgMembersLoaded}
					/>
				</div>
			{/if}
		{/if}
	</div>
</div>

<NewResourceModal
	bind:open={showNewResourceModal}
	orgSlug={orgSlug ?? ''}
	projectSlug={projectSlug ?? ''}
/>

{#if project}
	<ConfirmModal
		bind:open={showDeleteModal}
		title={`Delete "${project.name}"?`}
		description="This will permanently <strong>delete this project</strong> and all its resources (deployments, databases, ingresses). This cannot be undone."
		confirmLabel="Delete Project"
		onconfirm={deleteProject}
		oncancel={() => {}}
	/>

	<CustomizeModal
		{project}
		bind:open={showCustomize}
		onSave={handleCustomizeSave}
		onIconUpload={handleIconUpload}
		onBgUpload={handleBgUpload}
	/>
{/if}

<style>
	.pj-sse-alert {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		margin-bottom: 1rem;
		border-radius: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--warning-text) 18%, transparent);
		background-color: color-mix(in srgb, var(--warning-text) 6%, transparent);
		color: var(--warning-text);
	}
	.pj-sse-alert-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.pj-sse-alert-title {
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.3;
	}
	.pj-sse-alert-hint {
		font-size: 0.75rem;
		opacity: 0.85;
		line-height: 1.4;
	}
	.pj-sse-alert-action {
		display: inline-flex;
		align-items: center;
		padding: 0.3125rem 0.625rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 600;
		border: 1px solid currentColor;
		background: none;
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		align-self: center;
		opacity: 0.9;
		transition:
			opacity 120ms,
			background-color 120ms;
	}
	.pj-sse-alert-action:hover {
		opacity: 1;
		background-color: color-mix(in srgb, currentColor 8%, transparent);
	}

	/* Stats skeleton only used in this page */
	.pj-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}
</style>
