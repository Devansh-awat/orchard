<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onDestroy, untrack } from 'svelte';
	import GraftCards from '$lib/grafts/GraftCards.svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { apiFetch, toasts, subscribeOrgEvents, sseStatusFor, user } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import type { PageData } from './$types';
	import { Ellipsis, ExternalLink, Palette, Plus, RotateCw } from 'lucide-svelte';
	import {
		Alert,
		Breadcrumbs,
		Button,
		EmptyState,
		List,
		Menu,
		MenuItem,
		Page,
		SearchField,
		SectionCard,
		Skeleton,
		Swap,
		UnderlineTabs
	} from '$lib/components/ui';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import ProjectSpotlight, {
		type SpotlightItem
	} from '$lib/components/patterns/ProjectSpotlight.svelte';
	import ProjectBackdrop from '$lib/components/patterns/ProjectBackdrop.svelte';
	import NeedsAttention from '$lib/components/patterns/NeedsAttention.svelte';
	import RecentBuilds from '$lib/components/patterns/RecentBuilds.svelte';
	import type { FailingApp } from '$lib/components/patterns/sidebar';
	import { resourceStatus } from '$lib/components/ui/status';
	import { EnvironmentSwitcher } from '$lib/components/environment';
	import { buildsQueryOptions } from '$lib/queries/overview';
	import { toBuildItems } from '$lib/components/org-dashboard/build-items';
	import { IMG_ICONS, favUrl, knownIcon } from '$lib/components/org-dashboard/helpers.svelte';
	import type { ActiveBuild, RecentBuild } from '$lib/components/org-dashboard';
	import { ingressUrl } from '$lib/ingress-url';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Anomalies from '$lib/components/anomalies/Anomalies.svelte';
	import { projectGradientEnabled } from '$lib/stores';

	import {
		ProjectSettingsTab,
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
	let showDeleteModal = $state(false);
	let deploymentSearch = $state('');
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
			const response = await apiFetch(`/apiv1/projects/${deletedId}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirmName: project.name })
			});
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

	const TAB_LABEL: Record<ProjectTab, string> = {
		resources: 'Overview',
		variables: 'Variables',
		compose: 'Compose',
		members: 'Members',
		settings: 'Settings'
	};
	const showSettings = $derived(canDelete || canTransferOwnership || canMoveToOrg || canEdit);
	const tabs = $derived(
		PROJECT_TABS.filter((t) => t !== 'settings' || showSettings).map((t) => ({
			id: t,
			label: TAB_LABEL[t],
			badge:
				t === 'resources'
					? envFilteredDeployments.length +
						envFilteredDatabases.length +
						envFilteredTemplateInstances.length
					: t === 'compose'
						? composeStacks.length || undefined
						: t === 'members'
							? projectMembers.length
							: undefined
		}))
	);

	function depIcon(d: Deployment) {
		const known = knownIcon(d.image);
		if (known) return known;
		if (favFailed.has(d.id)) return null;
		const host = d.ingresses?.[0]?.host;
		return host ? favUrl(host.split('/')[0]) : null;
	}

	function depDetail(d: Deployment) {
		const host = d.ingresses?.[0]?.host;
		const branch = d.githubBranch;
		return [host, branch].filter(Boolean).join(' · ') || d.image || undefined;
	}

	function depUpdatedAt(d: Deployment) {
		const h = d.imageHistory?.[0];
		return (
			(d as { updatedAt?: string }).updatedAt ?? h?.buildCompletedAt ?? h?.buildStartedAt ?? null
		);
	}

	const failing = $derived<FailingApp[]>(
		(project?.deployments ?? [])
			.filter((d) => resourceStatus(d.status, d.buildStatus).kind === 'error')
			.map((d) => ({
				label: d.displayName || d.name,
				href: `/${orgSlug}/deployments/${d.id}`,
				reason: resourceStatus(d.status, d.buildStatus).label,
				kind: 'deployment' as const,
				icon: depIcon(d)
			}))
	);

	const heroStatus = $derived.by(() => {
		const deps = project?.deployments ?? [];
		const kinds = deps.map((d) => resourceStatus(d.status, d.buildStatus).kind);
		const errors = deps.filter((_, i) => kinds[i] === 'error');
		if (errors.length === 1) {
			const d = errors[0];
			return {
				tone: 'error' as const,
				label: `${d.displayName || d.name} is ${resourceStatus(d.status, d.buildStatus).label.toLowerCase()}`
			};
		}
		if (errors.length > 1)
			return { tone: 'error' as const, label: `${errors.length} apps need attention` };
		const building = kinds.filter((k) => k === 'progress' || k === 'warning').length;
		if (building) return { tone: 'progress' as const, label: `${building} building` };
		if (!deps.length && !databases.length)
			return { tone: 'neutral' as const, label: 'Nothing deployed yet' };
		return { tone: 'success' as const, label: 'All running' };
	});

	const visitUrl = $derived.by(() => {
		const ing = (project?.deployments ?? []).flatMap((d) => d.ingresses ?? [])[0];
		return ing ? ingressUrl(ing) : null;
	});

	const spotlight = $derived<SpotlightItem[]>(
		project
			? [
					{
						id: project.id,
						name: project.name,
						href: `/${orgSlug}/projects/${project.slug}`,
						url: visitUrl,
						image: project.icon ?? null,
						background: project.backgroundImage ?? null,
						owner: project.organization?.name,
						status: heroStatus.label,
						tone: heroStatus.tone,
						apps: [
							...(project.deployments ?? []).map((d) => ({
								name: d.displayName || d.name,
								kind: 'deployment' as const
							})),
							...databases.map((db) => ({ name: db.name, kind: 'database' as const }))
						]
					}
				]
			: []
	);

	const buildsQuery = createQuery(() => ({
		...buildsQueryOptions(orgSlug ?? ''),
		enabled: !!orgSlug && !!project
	}));
	const projectDeploymentIds = $derived(new Set((project?.deployments ?? []).map((d) => d.id)));
	const builds = $derived(
		toBuildItems(
			(buildsQuery.data?.active ?? []) as ActiveBuild[],
			(buildsQuery.data?.recent ?? []) as RecentBuild[],
			{
				orgSlug: orgSlug ?? '',
				failedFav: favFailed,
				only: (id) => projectDeploymentIds.has(id)
			}
		).slice(0, 6)
	);

	async function restart(d: Deployment) {
		const res = await apiFetch(`/apiv1/deployments/${d.id}/restart`, { method: 'POST' });
		if (res.ok) {
			toasts.add({ title: `Restarting ${d.displayName || d.name}`, color: 'success' });
			scheduleProjectRefetch();
		} else toasts.add({ title: 'Restart failed', color: 'error' });
	}

	function copyUrl(d: Deployment) {
		const ing = d.ingresses?.[0];
		if (!ing) return;
		navigator.clipboard.writeText(ingressUrl(ing));
		toasts.add({ title: 'URL copied', color: 'success' });
	}

	onDestroy(() => {
		if (refetchTimer) clearTimeout(refetchTimer);
	});
</script>

<svelte:head><title>{project?.name ?? 'Project'}</title></svelte:head>

{#if project?.backgroundImage && $projectGradientEnabled}
	<div class="backdrop" aria-hidden="true">
		<ProjectBackdrop name={project.name} image={project.backgroundImage} />
	</div>
{/if}

{#snippet side()}
	<div class="side">
		<NeedsAttention items={failing} />
		{#if builds.length}<RecentBuilds {builds} />{/if}
	</div>
{/snippet}

{#snippet deploymentRow(d: Deployment)}
	<EntityRow
		kind="deployment"
		name={d.displayName || d.name}
		status={resourceStatus(d.status, d.buildStatus)}
		image={depIcon(d)}
		detail={depDetail(d)}
		updatedAt={depUpdatedAt(d)}
		href="/{orgSlug}/deployments/{d.id}"
	>
		{#snippet actions()}
			<Menu placement="bottom-end">
				{#snippet trigger(props)}
					<Button {...props} size="sm" variant="ghost" icon={Ellipsis} label="Actions" />
				{/snippet}
				{#if d.ingresses?.[0]}
					<MenuItem icon={ExternalLink} href={ingressUrl(d.ingresses[0])} target="_blank"
						>Visit</MenuItem
					>
					<MenuItem onclick={() => copyUrl(d)}>Copy URL</MenuItem>
				{/if}
				<MenuItem icon={RotateCw} onclick={() => restart(d)}>Restart</MenuItem>
				<MenuItem href="/{orgSlug}/deployments/{d.id}?tab=deploys">View deploys</MenuItem>
			</Menu>
		{/snippet}
	</EntityRow>
{/snippet}

{#if loading}
	<Page title="Project" width="wide">
		{#snippet hero()}
			<div class="hero"><Skeleton height="21rem" rounded="1.5rem" /></div>
		{/snippet}
		<Skeleton height="16rem" rounded="1.125rem" />
	</Page>
{:else if error || !project}
	<Page title="Project" width="default">
		<EmptyState title="This project did not load" description={error ?? 'Project not found'}>
			<Button variant="secondary" onclick={fetchProject}>Try again</Button>
		</EmptyState>
	</Page>
{:else}
	<Page
		title={project.name}
		width="wide"
		aside={activeTab === 'resources' && (failing.length || builds.length) ? side : undefined}
	>
		{#snippet hero()}
			<div class="hero">
				<ProjectSpotlight
					items={spotlight}
					variant={activeTab === 'resources' ? 'spotlight' : 'banner'}
					primary={{
						label: 'New app',
						href: `/${orgSlug}/new?projectSlug=${projectSlug}`,
						icon: Plus
					}}
				>
					{#snippet tools()}
						{#if canEdit}
							<Button
								variant="media"
								icon={Palette}
								label="Customize"
								onclick={() => (showCustomize = true)}
							/>
						{/if}
					{/snippet}
				</ProjectSpotlight>
				<div class="bar">
					<UnderlineTabs
						label="Project sections"
						{tabs}
						bind:value={() => activeTab, (v) => gotoTab(v as ProjectTab)}
					/>
					<div class="bar-tools">
						{#if activeTab === 'resources'}
							<SearchField placeholder="Search" size="sm" bind:value={deploymentSearch} />
						{/if}
						{#if activeTab === 'resources' || activeTab === 'variables'}
							<EnvironmentSwitcher projectId={project.id} bind:selectedEnvId />
						{/if}
					</div>
				</div>
			</div>
		{/snippet}

		<div class="body">
			{#if sseDisconnected}
				<Alert tone="warning" title="Live updates offline">
					Reconnecting. What you see may be out of date.
					{#snippet actions()}
						<Button variant="secondary" size="sm" onclick={() => location.reload()}>Reload</Button>
					{/snippet}
				</Alert>
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

			<Swap key={activeTab}>
				{#if activeTab === 'resources'}
					<div class="overview">
						<Anomalies scope={{ kind: 'project', id: project.id }} />
						{#if envFilteredDeployments.length || envFilteredDatabases.length || envFilteredTemplateInstances.length}
							<List label="Resources">
								{#each envFilteredDeployments as d (d.id)}
									{@render deploymentRow(d)}
								{/each}
								{#each envFilteredDatabases as db (db.id)}
									<EntityRow
										kind="database"
										name={db.name}
										status={resourceStatus(db.status)}
										image={IMG_ICONS.postgres}
										detail={db.mode ? `${db.dbName} · ${db.mode}` : db.dbName}
										updatedAt={db.createdAt}
										href="/{orgSlug}/databases/{db.id}"
									/>
								{/each}
								{#each envFilteredTemplateInstances as ti (ti.id)}
									<EntityRow
										kind="deployment"
										name={ti.name}
										status={resourceStatus(ti.status)}
										image={ti.template.icon ?? null}
										detail={ti.template.displayName}
										updatedAt={ti.createdAt}
										href="/{orgSlug}/template-instances/{ti.id}"
									/>
								{/each}
							</List>
						{:else}
							<EmptyState
								title={deploymentSearch
									? `Nothing matches “${deploymentSearch}”`
									: selectedEnvName
										? `Nothing in ${selectedEnvName} yet`
										: 'Nothing deployed yet'}
							>
								{#if !deploymentSearch && canEdit}
									<Button
										variant="primary"
										icon={Plus}
										href="/{orgSlug}/new?projectSlug={projectSlug}">New app</Button
									>
								{/if}
							</EmptyState>
						{/if}
						{#if orgId}
							<GraftCards
								slot="project.overview.cards"
								props={{
									orgId,
									orgSlug: orgSlug ?? '',
									projectId: project.id,
									projectSlug: project.slug
								}}
							/>
						{/if}
					</div>
				{:else if activeTab === 'variables'}
					<SectionCard>
						{#if selectedEnvId}
							<SharedVarsEditor
								environmentId={selectedEnvId}
								envName={selectedEnvName}
							/>
						{:else}
							<EmptyState title="Pick an environment to edit its variables" />
						{/if}
					</SectionCard>
				{:else if activeTab === 'compose'}
					<ComposeTab
						{composeStacks}
						{composeStacksLoading}
						orgSlug={orgSlug ?? ''}
						projectSlug={projectSlug ?? ''}
					/>
				{:else if activeTab === 'members'}
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
				{:else if activeTab === 'settings'}
					<ProjectSettingsTab
						projectId={project?.id ?? ''}
						{canEdit}
						{canDelete}
						{canTransferOwnership}
						{canMoveToOrg}
						transferPending={!!pendingTransfer}
						{deleting}
						onDelete={() => (showDeleteModal = true)}
						onTransferOwnership={() => (showTransferModal = true)}
						onMoveToOrg={() => (showMoveModal = true)}
					/>
				{/if}
			</Swap>
		</div>
	</Page>
{/if}

{#if project}
	<ConfirmModal
		bind:open={showDeleteModal}
		title={`Delete "${project.name}"?`}
		description="This <strong>permanently deletes the project</strong> and everything in every one of its environments: apps, databases with their data and backups, domains, jobs and container images. There is no undo and no recovery."
		html
		confirmText={project.name}
		confirmLabel="Delete project forever"
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
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}
	.hero {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		max-width: calc(var(--page-wide) + 4rem);
		margin: 0 auto;
		padding: 2rem 2rem 1.5rem;
	}
	.bar {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: var(--space-4);
	}
	.bar > :global(.ui-tabs) {
		flex: 1 1 auto;
		min-width: 0;
	}
	.bar-tools {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: var(--space-2);
		padding-bottom: 0.375rem;
	}
	.body,
	.overview,
	.side {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
</style>
