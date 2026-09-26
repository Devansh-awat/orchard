<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { animate } from 'motion';
	import { springPop, motionEnabled, transition } from '$lib/utils/motion.svelte';
	import { apiFetch, toasts, subscribeOrgEvents, sseStatusFor, user } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import type { PageData } from './$types';
	import { SpatialMenu } from 'melt/builders';
	import { Server, TriangleAlert, ChevronLeft } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import NewResourceModal from '$lib/components/NewResourceModal.svelte';
	import MeshGradient from '$lib/components/MeshGradient.svelte';
	import { projectGradientEnabled } from '$lib/stores';

	import {
		ProjectHero,
		ProjectHeader,
		ProjectTabs,
		ProjectSettingsTab,
		ResourcesTab,
		ComposeTab,
		MembersTab,
		CustomizeModal,
		TransferOwnershipModal,
		MoveToOrgModal,
		TransferBanner,
		type ProjectTab
	} from '$lib/components/project';
	import { SharedVarsEditor } from '$lib/components/environment';
	import { environmentsQueryOptions } from '$lib/queries/environments';
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
	const canTransferOwnership = $derived(project?.currentUserRole?.canTransferOwnership ?? false);
	const canMoveToOrg = $derived(canTransferOwnership || canDelete);
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
	let showTransferModal = $state(false);
	let showMoveModal = $state(false);
	let requestingTransfer = $state(false);
	let respondingToTransfer = $state<'accept' | 'decline' | 'cancel' | null>(null);
	const pendingTransfer = $derived(project?.pendingTransfer ?? null);
	const viewerIsTransferRecipient = $derived(
		!!pendingTransfer && !!$user?.id && pendingTransfer.to.id === $user.id
	);
	let openRoleMenuId = $state<string | null>(null);
	const PROJECT_TABS: ProjectTab[] = ['resources', 'variables', 'compose', 'members', 'settings'];
	function tabFromUrl(url: URL): ProjectTab {
		const t = url.searchParams.get('tab');
		return t && (PROJECT_TABS as string[]).includes(t) ? (t as ProjectTab) : 'resources';
	}
	const activeTab = $derived(tabFromUrl($page.url));
	function gotoTab(tab: ProjectTab) {
		const url = new URL(window.location.href);
		if (tab === 'resources') url.searchParams.delete('tab');
		else url.searchParams.set('tab', tab);
		if (url.href === window.location.href) return;
		void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}
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
	let firstTabRun = true;

	$effect(() => {
		const _tab = activeTab; // subscribe
		if (firstTabRun) {
			firstTabRun = false;
			return;
		}
		if (!motionEnabled()) return;
		tick().then(() => {
			if (tabsRowEl) animate(tabsRowEl, { opacity: [0.72, 1] }, transition('smooth'));
		});
	});

	let firstPanelMount = true;
	// Transforms on an ancestor of a backdrop-filtered card re-resolve the
	// backdrop root every frame, which reads as the glass snapping between
	// solid and translucent. Fade instead.
	function tabPanelEnter(node: HTMLElement) {
		if (firstPanelMount) {
			firstPanelMount = false;
			return;
		}
		if (!motionEnabled()) return;
		animate(node, { opacity: [0, 1] }, transition('smooth'));
	}

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
	let selectedEnvId = $state('');
	const projectEnvQuery = createQuery(() => ({
		...environmentsQueryOptions(project?.id ?? ''),
		enabled: !!project?.id
	}));
	const selectedEnvObj = $derived(
		(projectEnvQuery.data ?? []).find((e: any) => e.id === selectedEnvId) ?? null
	);
	const selectedEnvName = $derived(selectedEnvObj?.name ?? '');
	const selectedEnvSlug = $derived(selectedEnvObj?.slug ?? '');

	let filteredDeployments = $derived.by(() => {
		const deployments = project?.deployments ?? [];
		const query = deploymentSearch.trim().toLowerCase();
		if (!query) return deployments;
		return deployments.filter((deployment) => {
			const name = deployment.name?.toLowerCase() ?? '';
			const displayName = deployment.displayName?.toLowerCase() ?? '';
			const status = deployment.status?.toLowerCase() ?? '';
			const image = deployment.image?.toLowerCase() ?? '';
			return (
				name.includes(query) ||
				displayName.includes(query) ||
				status.includes(query) ||
				image.includes(query)
			);
		});
	});

	// Scope resources to the selected environment. A row matches when its
	// environmentId equals the selected env; rows without an environmentId
	// (legacy/unmigrated) fall into the default env only, never every env.
	const selectedEnvIsDefault = $derived(selectedEnvObj?.isDefault ?? false);
	function matchesEnv(row: { environmentId?: string | null }): boolean {
		if (!selectedEnvId) return true;
		return row.environmentId === selectedEnvId || (!row.environmentId && selectedEnvIsDefault);
	}

	let envFilteredDeployments = $derived.by(() => filteredDeployments.filter(matchesEnv));
	let envFilteredDatabases = $derived.by(() => databases.filter(matchesEnv));
	// Template instances aren't environment-scoped, so surface them in the
	// default environment only rather than duplicating across every env.
	let envFilteredTemplateInstances = $derived.by(() =>
		!selectedEnvId || selectedEnvIsDefault ? templateInstances : []
	);

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
		const deletedId = project.id;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${deletedId}`, { method: 'DELETE' });
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
			queryClient.setQueryData(
				['overview', orgSlug],
				(prev: { projects?: { id: string }[] } | undefined) =>
					prev
						? { ...prev, projects: (prev.projects ?? []).filter((p) => p.id !== deletedId) }
						: prev
			);
			queryClient.invalidateQueries({ queryKey: ['overview', orgSlug] });
			queryClient.invalidateQueries({ queryKey: ['builds', orgSlug] });
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

	async function requestTransfer(userId: string) {
		if (!project) return;
		requestingTransfer = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/transfer-request`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to request the transfer');
			}
			showTransferModal = false;
			toasts.add({
				title: 'Transfer requested',
				description: 'Ownership moves once they accept',
				color: 'success'
			});
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to request the transfer',
				color: 'error'
			});
		} finally {
			requestingTransfer = false;
		}
	}

	async function cancelTransfer() {
		if (!project) return;
		respondingToTransfer = 'cancel';
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/transfer-request`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to cancel the transfer');
			}
			toasts.add({ title: 'Transfer canceled', color: 'success' });
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to cancel the transfer',
				color: 'error'
			});
		} finally {
			respondingToTransfer = null;
		}
	}

	async function respondToTransfer(action: 'accept' | 'decline') {
		const transfer = project?.pendingTransfer;
		if (!transfer) return;
		respondingToTransfer = action;
		try {
			const response = await apiFetch(`/apiv1/project-transfers/${transfer.id}/${action}`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || `Failed to ${action} the transfer`);
			}
			if (action === 'accept') {
				const result = await response.json().catch(() => ({}));
				toasts.add({
					title: 'You now own this project',
					description: result.promotedToAdmin ? 'Your project role was raised to admin' : undefined,
					color: 'success'
				});
			} else {
				toasts.add({ title: 'Transfer declined', color: 'success' });
			}
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : `Failed to ${action} the transfer`,
				color: 'error'
			});
		} finally {
			respondingToTransfer = null;
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
		refetchInterval: (() => {
			const transient = (project?.deployments ?? []).some(
				(d: Deployment) =>
					TRANSIENT_DEPLOYMENT_STATUSES.has((d.status ?? '').toLowerCase()) ||
					(d.buildStatus ?? '').toLowerCase() === 'building'
			);
			const sseUp = sseStatusValue === 'connected';
			if (transient) return sseUp ? 15_000 : 4_000;
			if (!sseUp) return 10_000;
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
		const unsubEvents = subscribeOrgEvents(id, (ev) => {
			if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
			if (
				ev.projectId === project?.id ||
				ev.type === 'project.changed' ||
				ev.type === 'membership.changed'
			) {
				scheduleProjectRefetch();
			}
		});
		return () => {
			unsubStatus();
			unsubEvents();
		};
	});

	onDestroy(() => {
		if (refetchTimer) clearTimeout(refetchTimer);
	});
</script>

<div class="pj-page" class:pj-page--hasbg={!!project?.backgroundImage && $projectGradientEnabled}>
	{#if project?.backgroundImage && $projectGradientEnabled}
		<div class="pj-mesh-bg" aria-hidden="true">
			<MeshGradient src={project.backgroundImage} class="pj-mesh-canvas" />
			<div class="pj-mesh-scrim"></div>
			<div class="pj-treat pj-treat--aura"></div>
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
						<div class="skeleton" style="height: 1.5rem; width: 40%; margin-bottom: 0.5rem;"></div>
						<div class="skeleton" style="height: 0.875rem; width: 55%;"></div>
					</div>
					<div class="pj-header-actions">
						<div
							class="skeleton"
							style="height: 2rem; width: 4.5rem; border-radius: var(--radius-sm);"
						></div>
						<div
							class="skeleton"
							style="height: 2rem; width: 5rem; border-radius: var(--radius-sm);"
						></div>
					</div>
				</div>
			</div>
			<div class="pj-stats">
				{#each Array(3) as _, i (i)}
					<div
						class="skeleton"
						style="height: 1.75rem; width: 6rem; border-radius: var(--radius-sm);"
					></div>
				{/each}
			</div>
			<div class="pj-deployments-header">
				<div class="skeleton" style="height: 1.125rem; width: 7rem;"></div>
			</div>
			<div class="pj-deployment-grid">
				{#each Array(3) as _, i (i)}
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
			<a class="pj-back" href="/{orgSlug}">
				<ChevronLeft size={15} />
				Your Apps
			</a>

			<!-- Hero / Header -->
			{#if project.backgroundImage}
				<ProjectHero
					{project}
					{canEdit}
					bind:heroImgReady
					onCustomize={() => (showCustomize = true)}
				/>
			{:else}
				<ProjectHeader {project} {canEdit} onCustomize={() => (showCustomize = true)} />
			{/if}

			{#if pendingTransfer && $user}
				<TransferBanner
					transfer={pendingTransfer}
					isRecipient={viewerIsTransferRecipient}
					canCancel={canTransferOwnership}
					accepting={respondingToTransfer === 'accept'}
					declining={respondingToTransfer === 'decline'}
					canceling={respondingToTransfer === 'cancel'}
					onaccept={() => respondToTransfer('accept')}
					ondecline={() => respondToTransfer('decline')}
					oncancel={cancelTransfer}
				/>
			{/if}

			<!-- Tab bar -->
			<ProjectTabs
				{activeTab}
				onSelect={gotoTab}
				resourceCount={envFilteredDeployments.length +
					envFilteredDatabases.length +
					envFilteredTemplateInstances.length}
				composeCount={composeStacks.length}
				membersCount={projectMembers.length}
				repositoryUrl={project.repositoryUrl}
				hasDeployments={!!project.deployments?.length}
				bind:deploymentSearch
				onNewResource={() => {
					gotoTab('resources');
					showNewResourceModal = true;
				}}
				bind:tabsRowEl
				{deploymentMenu}
				projectId={project.id}
				bind:selectedEnvId
				showSettings={canDelete || canTransferOwnership || canMoveToOrg}
			/>

			{#if activeTab === 'resources'}
				<div class="pj-tab-panel" {@attach tabPanelEnter}>
					<ResourcesTab
						filteredDeployments={envFilteredDeployments}
						databases={envFilteredDatabases}
						templateInstances={envFilteredTemplateInstances}
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

			{#if activeTab === 'variables'}
				<div class="pj-tab-panel" {@attach tabPanelEnter}>
					<div class="pj-section-card pj-glass">
						{#if selectedEnvId}
							<SharedVarsEditor
								environmentId={selectedEnvId}
								envName={selectedEnvName}
								envSlug={selectedEnvSlug}
							/>
						{:else}
							<p class="pj-vars-empty">Select an environment to manage its variables.</p>
						{/if}
					</div>
				</div>
			{/if}

			{#if activeTab === 'compose'}
				<div class="pj-tab-panel" {@attach tabPanelEnter}>
					<ComposeTab
						{composeStacks}
						{composeStacksLoading}
						orgSlug={orgSlug ?? ''}
						projectSlug={projectSlug ?? ''}
					/>
				</div>
			{/if}

			{#if activeTab === 'members'}
				<div class="pj-tab-panel" {@attach tabPanelEnter}>
					<MembersTab
						{projectMembers}
						{pendingInvitations}
						{canManageMembers}
						{canEdit}
						{canTransferOwnership}
						ownerId={project.ownerId ?? null}
						bind:memberSearch
						bind:newMemberRole
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

			{#if activeTab === 'settings'}
				<div class="pj-tab-panel" {@attach tabPanelEnter}>
					<ProjectSettingsTab
						{canDelete}
						{canTransferOwnership}
						{canMoveToOrg}
						transferPending={!!pendingTransfer}
						{deleting}
						onDelete={() => (showDeleteModal = true)}
						onTransferOwnership={() => (showTransferModal = true)}
						onMoveToOrg={() => (showMoveModal = true)}
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
	{selectedEnvId}
/>

{#if project}
	<ConfirmModal
		bind:open={showDeleteModal}
		title={`Delete "${project.name}"?`}
		description="This will permanently <strong>delete this project</strong> and all its resources (apps, databases, ingresses). This cannot be undone."
		html
		confirmLabel="Delete Project"
		onconfirm={deleteProject}
		oncancel={() => {}}
	/>

	<TransferOwnershipModal
		bind:open={showTransferModal}
		projectName={project.name}
		{projectMembers}
		ownerId={project.ownerId ?? null}
		submitting={requestingTransfer}
		onrequest={requestTransfer}
	/>

	<MoveToOrgModal
		bind:open={showMoveModal}
		projectId={project.id}
		projectName={project.name}
		currentSlug={project.slug}
		currentOrgId={project.organization?.id ?? ''}
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
	.pj-vars-panel {
		max-width: 46rem;
	}
	.pj-vars-empty {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--surface-muted);
	}

	.pj-sse-alert {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		margin-bottom: 1rem;
		border-radius: var(--radius-md);
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
		font-size: var(--text-footnote);
		font-weight: 600;
		line-height: 1.3;
	}
	.pj-sse-alert-hint {
		font-size: var(--text-caption);
		opacity: 0.85;
		line-height: 1.4;
	}
	.pj-sse-alert-action {
		display: inline-flex;
		align-items: center;
		padding: 0.3125rem 0.75rem;
		border-radius: var(--radius-xs);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
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
			opacity var(--dur-fast),
			background-color var(--dur-fast);
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
