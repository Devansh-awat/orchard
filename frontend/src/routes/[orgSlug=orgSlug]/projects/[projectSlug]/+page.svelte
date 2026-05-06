<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { apiFetch, toasts, refreshTree, subscribeOrgEvents } from '$lib/stores';
	import type { PageData } from './$types';
	import { mergeAttrs } from 'melt';
	import { SpatialMenu } from 'melt/builders';
	import {
		Loader2,
		Plus,
		ExternalLink,
		Trash2,
		Server,
		GitBranch,
		LayoutTemplate,
		Users,
		Database as DatabaseIcon,
		Palette,
		Upload,
		Image as ImageIcon,
		Smile,
		X as XIcon
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
		ingresses?: Array<{ id: string; host: string }>;
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
		icon?: string | null;
		backgroundImage?: string | null;
		deployments?: Deployment[];
		members?: ProjectMember[];
		organization?: {
			id: string;
			name: string;
			slug: string;
		};
		currentUserRole?: {
			orgRole: string;
			projectRole: string | null;
			canEdit: boolean;
		};
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
		_count?: { deployments: number; databases: number; ingresses: number };
		deployments?: { id: string }[];
		databases?: { id: string }[];
		ingresses?: { id: string }[];
	}

	const deploymentMenu = new SpatialMenu<Deployment>({
		wrap: true,
		crossAxis: true
	});

	interface ProjectMember {
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
	const canEdit = $derived(project?.currentUserRole?.canEdit ?? false);
	let templateInstances = $state<TemplateInstanceSummary[]>([]);

	interface DatabaseSummary {
		id: string;
		name: string;
		dbName: string;
		status: string;
		mode?: string;
		createdAt: string;
	}
	let databases = $state<DatabaseSummary[]>([]);
	let loading = $state(true);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let heroImgReady = $state(false);
	let showDeleteModal = $state(false);
	let deploymentSearch = $state('');
	let showNewResourceModal = $state(false);
	let projectMembers = $state<ProjectMember[]>([]);
	let newMemberRole = $state<'member' | 'admin' | 'viewer'>('member');
	let addingMember = $state(false);
	let favFailed = $state<Set<string>>(new Set());

	// Customize modal (icon + background image)
	let showCustomize = $state(false);
	let iconMode = $state<'emoji' | 'image'>('emoji');
	let emojiValue = $state('');
	const emojiSuggestions = ['🚀', '⚡', '✨', '🌱', '🔥', '🧪', '📦', '🛠️', '🌊', '🎯', '🧩', '🪐'];
	let savingCustom = $state(false);
	let uploadingIcon = $state(false);
	let uploadingBg = $state(false);
	let iconPreview = $state<string | null>(null); // current or newly uploaded icon URL (for image mode)
	let bgPreview = $state<string | null>(null);

	function isImageUrl(v?: string | null) {
		return !!v && /^https?:\/\//.test(v);
	}

	function openCustomize() {
		const icon = project?.icon ?? '';
		if (icon && isImageUrl(icon)) {
			iconMode = 'image';
			iconPreview = icon;
			emojiValue = '';
		} else {
			iconMode = 'emoji';
			emojiValue = icon;
			iconPreview = null;
		}
		bgPreview = project?.backgroundImage ?? null;
		showCustomize = true;
	}

	async function handleIconFile(e: Event) {
		if (!project) return;
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadingIcon = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await apiFetch(`/apiv1/projects/${project.id}/icon`, { method: 'POST', body: fd });
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Upload failed');
			}
			const updated = await res.json();
			iconPreview = updated.icon;
			project = { ...project, icon: updated.icon };
			toasts.add({ title: 'Icon uploaded', color: 'success' });
		} catch (err) {
			toasts.add({ title: 'Upload failed', description: err instanceof Error ? err.message : '', color: 'error' });
		} finally {
			uploadingIcon = false;
			input.value = '';
		}
	}

	async function handleBgFile(e: Event) {
		if (!project) return;
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadingBg = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await apiFetch(`/apiv1/projects/${project.id}/background-image`, { method: 'POST', body: fd });
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Upload failed');
			}
			const updated = await res.json();
			bgPreview = updated.backgroundImage;
			project = { ...project, backgroundImage: updated.backgroundImage };
			toasts.add({ title: 'Background uploaded', color: 'success' });
		} catch (err) {
			toasts.add({ title: 'Upload failed', description: err instanceof Error ? err.message : '', color: 'error' });
		} finally {
			uploadingBg = false;
			input.value = '';
		}
	}

	async function saveCustomize() {
		if (!project || savingCustom) return;
		savingCustom = true;
		try {
			const payload: Record<string, string | null> = {};
			if (iconMode === 'emoji') {
				payload.icon = emojiValue.trim() || null;
			}
			// In image mode, icon was already persisted by the upload endpoint; no need to overwrite.
			// Background was also already persisted by its upload endpoint. But if user cleared it:
			if (bgPreview === null && project.backgroundImage) {
				payload.backgroundImage = null;
			}
			if (iconMode === 'emoji' && project.icon && isImageUrl(project.icon)) {
				// User switched from image back to emoji → clear the image URL if they also left emoji empty.
				if (!emojiValue.trim()) payload.icon = null;
			}

			if (Object.keys(payload).length > 0) {
				const res = await apiFetch(`/apiv1/projects/${project.id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				if (!res.ok) {
					const d = await res.json().catch(() => ({}));
					throw new Error(d.message || 'Failed to save');
				}
				const updated = await res.json();
				project = { ...project, icon: updated.icon, backgroundImage: updated.backgroundImage };
			}
			toasts.add({ title: 'Project updated', color: 'success' });
			showCustomize = false;
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to save', color: 'error' });
		} finally {
			savingCustom = false;
		}
	}

	function clearBg() { bgPreview = null; }
	let removingMemberId = $state<string | null>(null);

	interface OrgMember {
		id: string;
		role: string;
		user: {
			id: string;
			email: string;
			firstName?: string;
			lastName?: string;
			imageUrl?: string;
		};
	}
	let orgMembers = $state<OrgMember[]>([]);
	let memberSearch = $state('');
	let pickerOpen = $state(false);
	let pickerInput = $state<HTMLInputElement | null>(null);

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

	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);
	const projectSlug = $derived(data.projectSlug);

	async function fetchProject() {
		await invalidate(`project:${orgSlug}/${projectSlug}`);
	}

	function applyProjectData(p: any) {
		project = p;
		projectMembers = p.members ?? [];
		templateInstances = p.templateInstances ?? [];
		databases = p.databases ?? [];
	}

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

	let lastSyncedNamespace: string | null = null;
	async function syncNamespace() {
		if (!project?.namespace) return;
		// Only sync once per namespace per page mount. Without this guard, every
		// SSE-triggered project refetch re-runs sync, which spams the endpoint.
		if (project.namespace === lastSyncedNamespace) return;
		lastSyncedNamespace = project.namespace;
		try {
			await apiFetch(`/apiv1/sync/${project.namespace}`, { method: 'POST' });
			const response = await apiFetch(`/apiv1/projects/${project.id}`);
			if (response.ok) project = await response.json();
		} catch (e) {
			console.error('Failed to sync namespace:', e);
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
			toasts.add({ title: 'Member added', color: 'success' });
			memberSearch = '';
			pickerOpen = false;
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

	let unsub: (() => void) | null = null;
	let hasLoadedOnce = false;

	$effect(() => {
		const promise = data.projectPromise;
		const isInitial = !hasLoadedOnce;
		if (isInitial) {
			error = null;
			loading = true;
		}
		promise
			.then((p) => {
				if (!p) return;
				applyProjectData(p);
				hasLoadedOnce = true;
				loading = false;
				error = null;
				if (p?.namespace) syncNamespace();
				const orgIdValue = p?.organization?.id;
				if (orgIdValue) {
					unsub?.();
					unsub = subscribeOrgEvents(
						orgIdValue,
						(ev) => {
							if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
							if (
								ev.projectId === p.id ||
								ev.type === 'project.changed' ||
								ev.type === 'membership.changed'
							) {
								invalidate(`project:${orgSlug}/${projectSlug}`);
							}
						},
						{ invalidateDependencies: [] },
					);
				}
			})
			.catch((e) => {
				if (isInitial) {
					error = e instanceof Error ? e.message : 'Failed to fetch project';
					loading = false;
				}
			});
	});

	onDestroy(() => unsub?.());

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

<div class="pj-page" class:pj-page--hasbg={!!project?.backgroundImage}>
	{#if project?.backgroundImage && heroImgReady}
		<div class="pj-accent-glow" aria-hidden="true">
			<div class="pj-accent-glow-layer pj-accent-glow-layer--1" style="background-image: url({JSON.stringify(project.backgroundImage)});"></div>
			<div class="pj-accent-glow-layer pj-accent-glow-layer--2" style="background-image: url({JSON.stringify(project.backgroundImage)});"></div>
			<div class="pj-accent-glow-layer pj-accent-glow-layer--3" style="background-image: url({JSON.stringify(project.backgroundImage)});"></div>
			<div class="pj-accent-glow-fade"></div>
		</div>
	{/if}

	<div class="pj-page-inner">
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

		<!-- Hero / Header -->
		{#if project.backgroundImage}
			{#if heroImgReady}
				<div
					class="pj-hero-bleed"
					style="background-image: url({JSON.stringify(project.backgroundImage)});"
					aria-hidden="true"
				></div>
			{/if}
			<div class="pj-hero">
				<img
					class="pj-hero-img"
					src={project.backgroundImage}
					alt=""
					fetchpriority="high"
					decoding="async"
					onload={() => (heroImgReady = true)}
				/>
				<div class="pj-hero-fade"></div>
				<div class="pj-hero-content">
					<div class="pj-header-info">
						<h1 class="pj-title pj-title--onhero">
							{#if project.icon}
								<span class="pj-title-icon">
									{#if /^https?:\/\//.test(project.icon)}
										<img src={project.icon} alt="" />
									{:else}
										{project.icon}
									{/if}
								</span>
							{/if}
							{project.name}
						</h1>
						{#if project.description}
							<p class="pj-description pj-description--onhero">{project.description}</p>
						{/if}
					</div>
					<div class="pj-header-actions">
						{#if canEdit}
						<button onclick={openCustomize} class="pj-btn pj-btn-secondary pj-btn--onhero">
							<Palette class="h-4 w-4" /> Customize
						</button>
						{/if}
						{#if canEdit}
						<button onclick={() => (showDeleteModal = true)} disabled={deleting} class="pj-btn pj-btn-danger">
							{#if deleting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Trash2 class="h-4 w-4" />{/if}
							Delete
						</button>
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<div class="pj-header">
				<div class="pj-header-top">
					<div class="pj-header-info">
						<h1 class="pj-title">
							{#if project.icon}
								<span class="pj-title-icon">
									{#if /^https?:\/\//.test(project.icon)}
										<img src={project.icon} alt="" />
									{:else}
										{project.icon}
									{/if}
								</span>
							{/if}
							{project.name}
						</h1>
						{#if project.description}
							<p class="pj-description">{project.description}</p>
						{/if}
					</div>
					<div class="pj-header-actions">
						{#if canEdit}
						<button onclick={openCustomize} class="pj-btn pj-btn-secondary">
							<Palette class="h-4 w-4" /> Customize
						</button>
						{/if}
						{#if canEdit}
						<button onclick={() => (showDeleteModal = true)} disabled={deleting} class="pj-btn pj-btn-danger">
							{#if deleting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Trash2 class="h-4 w-4" />{/if}
							Delete
						</button>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		{#if project.repositoryUrl}
			<div class="pj-stats">
				<a
					href={project.repositoryUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="pj-stat pj-stat-link"
				>
					<ExternalLink class="h-4 w-4" />
					<span class="pj-stat-label">Repository</span>
				</a>
			</div>
		{/if}

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
				{#each filteredDeployments as deployment (deployment.id)}
					{@const href = `/${orgSlug}/deployments/${deployment.id}`}
					{@const item = deploymentMenu.getItem(deployment, {
						onSelect: () => openDeployment(deployment.id)
					})}
					{@const host = deployment.ingresses?.[0]?.host?.split('/')[0]}
					<a
						class="pj-deployment-card"
						class:is-highlighted={item.highlighted}
						{...mergeAttrs(item.attrs, {
							href,
							onclick: (event: Event) => handleDeploymentClick(event as MouseEvent, deployment.id)
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
									<span class="pj-deployment-favicon-letter">{deployment.name.charAt(0).toUpperCase()}</span>
								{/if}
								<span class="pj-deployment-favicon-dot {getStatusColor(deployment.status)}"></span>
							</div>
							<div class="pj-deployment-badges">
								<span class="pj-deployment-status-badge {getStatusColor(deployment.status)}">
									{getStatusLabel(deployment.status)}
								</span>
								{#if deployment.buildStatus && deployment.buildStatus !== 'none' && deployment.buildStatus !== 'succeeded'}
									<span class="pj-deployment-build-badge pj-build-{deployment.buildStatus}">
										Build: {deployment.buildStatus === 'building' ? 'Building' : deployment.buildStatus === 'failed' ? 'Failed' : deployment.buildStatus}
									</span>
								{/if}
							</div>
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

		<!-- Databases -->
		{#if databases.length}
			<div class="pj-deployments-header" style="margin-top: 1rem;">
				<h2 class="pj-section-title">
					<DatabaseIcon class="h-4 w-4" style="color: var(--pj-color-green); display: inline;" />
					Databases
				</h2>
			</div>
			<div class="pj-deployment-grid">
				{#each databases as db (db.id)}
					<a
						href="/{orgSlug}/databases/{db.id}"
						class="pj-deployment-card"
					>
						<div class="pj-deployment-card-top">
							<div class="pj-deployment-indicator" style="background-color: color-mix(in srgb, var(--pj-color-green) 12%, transparent)">
								<DatabaseIcon class="h-5 w-5" style="color: var(--pj-color-green)" />
							</div>
							<span class="pj-deployment-status-badge" style="background-color: color-mix(in srgb, {db.status === 'ready' ? 'var(--pj-color-green)' : db.status === 'error' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'} 15%, transparent); color: {db.status === 'ready' ? 'var(--pj-color-green)' : db.status === 'error' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'}">
								{db.status}
							</span>
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
				<h2 class="pj-section-title">
					<LayoutTemplate class="h-4 w-4" style="color: var(--sidebar-text-active-border); display: inline;" />
					Template Instances
				</h2>
			</div>
			<div class="pj-deployment-grid">
				{#each templateInstances as ti (ti.id)}
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
								{(ti._count ? ti._count.deployments + ti._count.databases + ti._count.ingresses : (ti.deployments?.length ?? 0) + (ti.databases?.length ?? 0) + (ti.ingresses?.length ?? 0))} resources
							</span>
						</div>
					</a>
				{/each}
			</div>
		{/if}

		<!-- Members -->
		<div class="pj-members-section">
			<div class="pj-members-card">
				<div class="pj-members-head">
					<div class="pj-members-title">
						<Users size={16} />
						<span>Members</span>
						<span class="pj-members-count">{projectMembers.length}</span>
					</div>
					{#if canEdit}
					<div class="pj-picker">
						<input
							type="text"
							bind:this={pickerInput}
							bind:value={memberSearch}
							placeholder="Add a member…"
							class="pj-invite-input"
							onfocus={() => { pickerOpen = true; ensureOrgMembersLoaded(); }}
							onblur={() => setTimeout(() => (pickerOpen = false), 150)}
						/>
						{#if pickerOpen && filteredOrgMembers.length > 0}
							<div class="pj-picker-dropdown">
								{#each filteredOrgMembers as om (om.id)}
									<button
										type="button"
										class="pj-picker-item"
										onmousedown={(e) => e.preventDefault()}
										onclick={() => addMember(om.user.email)}
										disabled={addingMember}
									>
										{#if om.user.imageUrl}
											<img src={om.user.imageUrl} alt="" class="pj-member-avatar" />
										{:else}
											<div class="pj-member-avatar pj-member-avatar--letter">
												{(om.user.firstName ?? om.user.email).charAt(0).toUpperCase()}
											</div>
										{/if}
										<div class="pj-member-info">
											<span class="pj-member-name">
												{#if om.user.firstName}{om.user.firstName}{#if om.user.lastName}&nbsp;{om.user.lastName}{/if}{:else}{om.user.email}{/if}
											</span>
											{#if om.user.firstName}
												<span class="pj-member-email">{om.user.email}</span>
											{/if}
										</div>
									</button>
								{/each}
							</div>
						{:else if pickerOpen && memberSearch.trim() && filteredOrgMembers.length === 0}
							<div class="pj-picker-dropdown">
								<div class="pj-picker-empty">No matching org members</div>
							</div>
						{/if}
					</div>
					{/if}
				</div>

				{#if projectMembers.length > 0}
					<ul class="pj-members-list">
						{#each projectMembers as m (m.id)}
							<li class="pj-member">
								{#if m.user.imageUrl}
									<img src={m.user.imageUrl} alt="" class="pj-member-avatar" />
								{:else}
									<div class="pj-member-avatar pj-member-avatar--letter">
										{(m.user.firstName ?? m.user.email).charAt(0).toUpperCase()}
									</div>
								{/if}
								<div class="pj-member-info">
									<span class="pj-member-name">
										{#if m.user.firstName}{m.user.firstName}{#if m.user.lastName}&nbsp;{m.user.lastName}{/if}{:else}{m.user.email}{/if}
									</span>
									<span class="pj-member-email">{m.user.email}</span>
								</div>
								<span class="pj-role-chip pj-role-chip--{m.role.name}">{m.role.name}</span>
								{#if canEdit}
								<button
									class="pj-member-remove"
									title="Remove member"
									aria-label="Remove {m.user.firstName ?? m.user.email}"
									onclick={() => removeMember(m.id)}
									disabled={removingMemberId === m.id}
								>
									{#if removingMemberId === m.id}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<Trash2 class="h-3.5 w-3.5" />
									{/if}
								</button>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<div class="pj-members-empty">No members yet. Add someone from your organization above.</div>
				{/if}
			</div>
		</div>
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
		title='Delete "{project.name}"?'
		description='This will permanently <strong>delete this project</strong> and all its resources (deployments, databases, ingresses). This cannot be undone.'
		confirmLabel="Delete Project"
		onconfirm={deleteProject}
		oncancel={() => {}}
	/>
{/if}

{#if showCustomize}
	<div
		class="cm-overlay"
		onclick={() => (showCustomize = false)}
		role="presentation"
	>
		<div
			class="cm-modal"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-label="Customize project"
		>
			<button class="cm-close" onclick={() => (showCustomize = false)} aria-label="Close">
				<XIcon class="h-4 w-4" />
			</button>

			<div class="cm-hero" style={bgPreview ? `background-image: url(${JSON.stringify(bgPreview)});` : ''}>
				{#if bgPreview}
					<div class="cm-hero-scrim"></div>
				{:else}
					<div class="cm-hero-placeholder" aria-hidden="true"></div>
				{/if}
				<div class="cm-hero-content">
					<div class="cm-hero-icon" class:cm-hero-icon--empty={!(iconMode === 'emoji' ? emojiValue.trim() : iconPreview)}>
						{#if iconMode === 'emoji' && emojiValue.trim()}
							<span class="cm-hero-emoji">{emojiValue.trim()}</span>
						{:else if iconMode === 'image' && iconPreview}
							<img src={iconPreview} alt="" />
						{:else}
							<Smile class="h-5 w-5" />
						{/if}
					</div>
					<div class="cm-hero-meta">
						<span class="cm-hero-eyebrow">Preview</span>
						<span class="cm-hero-name">{project?.name ?? 'Project'}</span>
					</div>
				</div>
			</div>

			<div class="cm-body">
				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Icon</h3>
						<div class="cm-segmented" role="tablist" aria-label="Icon source">
							<button
								type="button"
								role="tab"
								aria-selected={iconMode === 'emoji'}
								class="cm-seg"
								class:cm-seg--active={iconMode === 'emoji'}
								onclick={() => (iconMode = 'emoji')}
							>Emoji</button>
							<button
								type="button"
								role="tab"
								aria-selected={iconMode === 'image'}
								class="cm-seg"
								class:cm-seg--active={iconMode === 'image'}
								onclick={() => (iconMode = 'image')}
							>Image</button>
						</div>
					</div>

					{#if iconMode === 'emoji'}
						<div class="cm-emoji-grid" role="radiogroup" aria-label="Emoji suggestions">
							{#each emojiSuggestions as emoji}
								<button
									type="button"
									role="radio"
									aria-checked={emojiValue.trim() === emoji}
									class="cm-emoji-chip"
									class:cm-emoji-chip--active={emojiValue.trim() === emoji}
									onclick={() => (emojiValue = emoji)}
								>{emoji}</button>
							{/each}
						</div>
						<div class="cm-emoji-custom">
							<input
								type="text"
								class="cm-input"
								placeholder="or paste any emoji…"
								maxlength="8"
								bind:value={emojiValue}
							/>
						</div>
					{:else}
						<label class="cm-drop" class:cm-drop--filled={!!iconPreview}>
							{#if uploadingIcon}
								<div class="cm-drop-state">
									<Loader2 class="h-5 w-5 animate-spin" />
									<span>Uploading…</span>
								</div>
							{:else if iconPreview}
								<div class="cm-drop-filled">
									<img src={iconPreview} alt="Project icon preview" class="cm-drop-thumb cm-drop-thumb--square" />
									<div class="cm-drop-meta">
										<span class="cm-drop-meta-title">Icon uploaded</span>
										<span class="cm-drop-meta-hint">Click to replace</span>
									</div>
								</div>
							{:else}
								<div class="cm-drop-state">
									<div class="cm-drop-icon"><Upload class="h-5 w-5" /></div>
									<div class="cm-drop-text">
										<span class="cm-drop-title">Upload icon</span>
										<span class="cm-drop-hint">PNG, JPG, SVG · up to 2 MB</span>
									</div>
								</div>
							{/if}
							<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" onchange={handleIconFile} disabled={uploadingIcon} />
						</label>
					{/if}
				</section>

				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Background</h3>
						{#if bgPreview}
							<button type="button" class="cm-text-btn" onclick={clearBg}>
								<Trash2 class="h-3.5 w-3.5" /> Remove
							</button>
						{/if}
					</div>

					<label class="cm-drop" class:cm-drop--filled={!!bgPreview}>
						{#if uploadingBg}
							<div class="cm-drop-state">
								<Loader2 class="h-5 w-5 animate-spin" />
								<span>Uploading…</span>
							</div>
						{:else if bgPreview}
							<div class="cm-drop-filled">
								<img src={bgPreview} alt="Background preview" class="cm-drop-thumb cm-drop-thumb--wide" />
								<div class="cm-drop-meta">
									<span class="cm-drop-meta-title">Background set</span>
									<span class="cm-drop-meta-hint">Click to replace</span>
								</div>
							</div>
						{:else}
							<div class="cm-drop-state">
								<div class="cm-drop-icon"><ImageIcon class="h-5 w-5" /></div>
								<div class="cm-drop-text">
									<span class="cm-drop-title">Upload background</span>
									<span class="cm-drop-hint">PNG, JPG, WebP · up to 8 MB</span>
								</div>
							</div>
						{/if}
						<input type="file" accept="image/png,image/jpeg,image/webp" onchange={handleBgFile} disabled={uploadingBg} />
					</label>
				</section>
			</div>

			<div class="cm-footer">
				<button class="pj-btn pj-btn-secondary" onclick={() => (showCustomize = false)} disabled={savingCustom}>
					Cancel
				</button>
				<button class="pj-btn pj-btn-primary" onclick={saveCustomize} disabled={savingCustom || uploadingIcon || uploadingBg}>
					{#if savingCustom}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					Save changes
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(:root) {
		--pj-color-green: #15803d;
		--pj-color-amber: #b45309;
		--pj-color-red: #b91c1c;
		/* Darker secondary text than --surface-muted for better light-mode contrast. */
		--pj-text-secondary: color-mix(in srgb, var(--center-channel-color) 70%, var(--surface-muted));
	}

	:global(:root.dark) {
		--pj-color-green: #4ade80;
		--pj-color-amber: #fbbf24;
		--pj-color-red: #f87171;
		/* Dark mode muted is already high enough contrast. */
		--pj-text-secondary: var(--surface-muted);
	}

	.pj-page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
		position: relative;
	}
	.pj-page--hasbg .pj-page-inner { position: relative; z-index: 1; }

	/* Subtle animated accent glow — spans the full viewport width, fades into the page.
	   3 rotating blurred copies of the banner, opacity-stacked (no blend modes). */
	.pj-accent-glow {
		position: absolute; top: 0;
		left: 50%; transform: translateX(-50%);
		width: 100vw; max-width: 100vw;
		height: 32rem;
		pointer-events: none; overflow: hidden;
		z-index: 0;
		animation: pj-glow-in 700ms ease-out both;
	}
	@keyframes pj-glow-in { from { opacity: 0; } to { opacity: 1; } }
	.pj-accent-glow-layer {
		position: absolute; inset: -40%;
		background-size: cover; background-position: center;
		filter: blur(80px) saturate(1.5);
		will-change: transform;
		transform-origin: 50% 50%;
	}
	.pj-accent-glow-layer--1 {
		transform: scale(1.6) rotate(0deg);
		animation: pj-accent-spin-a 32s linear infinite;
		opacity: 0.55;
	}
	.pj-accent-glow-layer--2 {
		transform: scale(2.1) translate(8%, -6%) rotate(70deg);
		animation: pj-accent-spin-b 48s linear infinite;
		opacity: 0.35;
	}
	.pj-accent-glow-layer--3 {
		transform: scale(2.6) translate(-10%, 9%) rotate(140deg);
		animation: pj-accent-spin-c 64s linear infinite;
		opacity: 0.25;
	}
	.pj-accent-glow-fade {
		position: absolute; inset: 0;
		background: linear-gradient(180deg, rgba(0,0,0,0) 45%, var(--center-channel-bg) 100%);
	}
	@keyframes pj-accent-spin-a { from { transform: scale(1.6) rotate(0deg); } to { transform: scale(1.6) rotate(360deg); } }
	@keyframes pj-accent-spin-b { from { transform: scale(2.1) translate(8%, -6%) rotate(70deg); } to { transform: scale(2.1) translate(8%, -6%) rotate(430deg); } }
	@keyframes pj-accent-spin-c { from { transform: scale(2.6) translate(-10%, 9%) rotate(140deg); } to { transform: scale(2.6) translate(-10%, 9%) rotate(-220deg); } }
	@media (prefers-reduced-motion: reduce) {
		.pj-accent-glow-layer--1, .pj-accent-glow-layer--2, .pj-accent-glow-layer--3 { animation: none; }
	}

	/* Hero (unblurred banner) */
	.pj-hero {
		position: relative;
		border-radius: 1rem;
		overflow: hidden;
		margin-bottom: 1.5rem;
		height: 18rem;
		box-shadow: 0 10px 30px rgba(0,0,0,0.22);
		z-index: 1;
	}
	/* Extended bleed — continues the banner image below the hero at low opacity,
	   slowly fading to the page background over ~50rem. */
	.pj-hero-bleed {
		position: absolute;
		top: 2.5rem; /* matches pj-page top padding so it starts right under the viewport top */
		left: 50%; transform: translateX(-50%);
		width: 100vw;
		height: 60rem;
		background-size: cover;
		background-position: center top;
		-webkit-mask-image: linear-gradient(180deg,
			rgba(0,0,0,0) 0%,
			rgba(0,0,0,0.22) 30%,
			rgba(0,0,0,0.14) 50%,
			rgba(0,0,0,0.06) 75%,
			rgba(0,0,0,0) 100%);
		mask-image: linear-gradient(180deg,
			rgba(0,0,0,0) 0%,
			rgba(0,0,0,0.22) 30%,
			rgba(0,0,0,0.14) 50%,
			rgba(0,0,0,0.06) 75%,
			rgba(0,0,0,0) 100%);
		filter: blur(40px) saturate(1.2);
		pointer-events: none;
		z-index: 0;
		animation: pj-bleed-in 500ms ease-out both;
	}
	@keyframes pj-bleed-in {
		from { opacity: 0; transform: translateX(-50%) translateY(-0.75rem); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}
	@media (prefers-reduced-motion: reduce) {
		.pj-hero-bleed { animation: pj-bleed-fade 200ms ease-out both; }
		@keyframes pj-bleed-fade { from { opacity: 0; } to { opacity: 1; } }
	}
	.pj-hero-img {
		position: absolute; inset: 0;
		width: 100%; height: 100%;
		object-fit: cover;
		display: block;
	}
	.pj-hero-fade {
		position: absolute; inset: 0;
		background: linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,0.7) 100%);
	}
	.pj-hero-content {
		position: absolute; left: 0; right: 0; bottom: 0;
		padding: 1.25rem 1.5rem;
		display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem;
		color: #fff;
	}
	.pj-title--onhero { color: #fff !important; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }
	.pj-description--onhero { color: rgba(255,255,255,0.9) !important; text-shadow: 0 1px 2px rgba(0,0,0,0.3); }

	/* Breadcrumb sits over the gradient bleed always when a banner exists,
	   so force it to white regardless of theme. */
	.pj-page--hasbg :global(.bc-item),
	.pj-page--hasbg :global(.bc-link),
	.pj-page--hasbg :global(.bc-current),
	.pj-page--hasbg :global(.bc-sep) { color: rgba(255,255,255,0.85) !important; }
	.pj-page--hasbg :global(.bc-link:hover) { color: #fff !important; }
	.pj-page--hasbg :global(.bc-current) { color: #fff !important; }
	.pj-btn--onhero {
		background: rgba(255,255,255,0.18) !important;
		color: #fff !important;
		border: 1px solid rgba(255,255,255,0.3) !important;
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}
	.pj-btn--onhero:hover:not(:disabled) {
		background: rgba(255,255,255,0.28) !important;
	}

	/* Favicon replacing the status indicator */
	.pj-deployment-favicon {
		position: relative;
		width: 2.25rem; height: 2.25rem; flex-shrink: 0;
		border-radius: 0.5rem; overflow: visible;
		display: flex; align-items: center; justify-content: center;
		background: color-mix(in srgb, var(--surface-border) 35%, transparent);
	}
	.pj-deployment-favicon img {
		width: 100%; height: 100%;
		border-radius: 0.5rem;
		object-fit: contain;
		padding: 0.25rem;
		background: var(--center-channel-bg);
	}
	.pj-deployment-favicon-letter {
		font-size: 0.875rem; font-weight: 700;
		color: var(--center-channel-color);
	}
	.pj-deployment-favicon-dot {
		position: absolute;
		bottom: -2px; right: -2px;
		width: 0.75rem; height: 0.75rem;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--center-channel-bg);
	}
	.pj-deployment-favicon-dot.pj-status-running { background: #22c55e; }
	.pj-deployment-favicon-dot.pj-status-pending { background: #f59e0b; }
	.pj-deployment-favicon-dot.pj-status-error { background: #ef4444; }
	.pj-deployment-favicon-dot.pj-status-neutral { background: #9ca3af; }

	.pj-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--pj-text-secondary);
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
		position: relative;
	}
	.pj-header--hasbg {
		padding: 1.5rem 1.5rem 1.25rem;
		border-radius: 0.875rem;
		background-size: cover;
		background-position: center;
		background-repeat: no-repeat;
		overflow: hidden;
		color: #fff;
		box-shadow: 0 2px 6px rgba(0,0,0,0.08), 0 10px 28px rgba(0,0,0,0.06);
	}
	.pj-header-overlay {
		position: absolute; inset: 0; pointer-events: none;
		background: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.55) 100%);
	}
	.pj-header--hasbg .pj-header-top { position: relative; z-index: 1; }
	.pj-header--hasbg :global(.pj-title),
	.pj-header--hasbg :global(.pj-description) { color: #fff; }
	.pj-header--hasbg :global(.pj-description) { color: rgba(255,255,255,0.85); }

	.pj-title-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.75rem; height: 1.75rem; margin-right: 0.5rem;
		font-size: 1.25rem; vertical-align: -0.25rem; line-height: 1;
	}
	.pj-title-icon img { width: 100%; height: 100%; object-fit: contain; border-radius: 0.25rem; }

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
		color: var(--pj-text-secondary);
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
		color: var(--pj-text-secondary);
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

	.pj-deployment-badges {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
		justify-content: flex-end;
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
		color: var(--pj-text-secondary);
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
		color: var(--pj-text-secondary);
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
		color: var(--pj-text-secondary);
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
		color: var(--pj-text-secondary);
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
		color: var(--pj-text-secondary);
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
	.pj-members-section { margin-top: 2.25rem; }

	.pj-members-card {
		background: var(--center-channel-bg);
		border: 1px solid color-mix(in srgb, var(--surface-border) 55%, transparent);
		border-radius: 0.875rem;
		overflow: visible;
		box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 4px 14px rgba(0,0,0,0.04);
	}

	.pj-members-head {
		display: flex; align-items: center; gap: 1rem;
		padding: 0.875rem 1rem;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 45%, transparent);
	}
	.pj-members-title {
		display: inline-flex; align-items: center; gap: 0.5rem;
		font-size: 0.8125rem; font-weight: 600; color: var(--center-channel-color);
		flex-shrink: 0;
	}
	.pj-members-count {
		display: inline-flex; align-items: center; justify-content: center;
		min-width: 1.25rem; height: 1.25rem; padding: 0 0.375rem;
		border-radius: 999px;
		font-size: 0.6875rem; font-weight: 600;
		background: color-mix(in srgb, var(--surface-border) 55%, transparent);
		color: var(--pj-text-secondary);
	}

	.pj-members-list {
		list-style: none; margin: 0; padding: 0;
		display: flex; flex-direction: column;
	}

	.pj-member {
		display: flex; align-items: center; gap: 0.75rem;
		padding: 0.625rem 1rem;
		transition: background-color 0.12s;
	}
	.pj-member:hover { background: color-mix(in srgb, var(--surface-border) 25%, transparent); }
	.pj-member + .pj-member {
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 35%, transparent);
	}

	.pj-member-avatar {
		width: 2rem; height: 2rem;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}
	.pj-member-avatar--letter {
		display: flex; align-items: center; justify-content: center;
		background: linear-gradient(135deg,
			color-mix(in srgb, var(--sidebar-text-active-border) 22%, transparent),
			color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent));
		color: var(--sidebar-text-active-border);
		font-size: 0.75rem; font-weight: 700;
	}

	.pj-member-info {
		flex: 1; min-width: 0;
		display: flex; flex-direction: column; gap: 0.0625rem;
	}
	.pj-member-name {
		font-size: 0.8125rem; font-weight: 600;
		color: var(--center-channel-color);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.pj-member-email {
		font-size: 0.6875rem;
		color: var(--pj-text-secondary);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}

	/* Role chips — color-coded by role */
	.pj-role-chip {
		flex-shrink: 0;
		display: inline-flex; align-items: center;
		padding: 0.1875rem 0.5rem;
		border-radius: 999px;
		font-size: 0.6875rem; font-weight: 600;
		text-transform: capitalize;
		letter-spacing: 0.01em;
		border: 1px solid transparent;
	}
	.pj-role-chip--admin {
		background: color-mix(in srgb, #f59e0b 14%, transparent);
		color: #b45309;
		border-color: color-mix(in srgb, #f59e0b 30%, transparent);
	}
	:global(:root.dark) .pj-role-chip--admin { color: #fbbf24; }
	.pj-role-chip--member {
		background: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		color: var(--sidebar-text-active-border);
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent);
	}
	.pj-role-chip--viewer {
		background: color-mix(in srgb, var(--surface-border) 45%, transparent);
		color: var(--pj-text-secondary);
	}

	.pj-member-remove {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.75rem; height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer; flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.12s, background-color 0.12s, color 0.12s;
	}
	.pj-member:hover .pj-member-remove { opacity: 1; }
	.pj-member-remove:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 14%, transparent);
		color: var(--error-text-color);
	}
	.pj-member-remove:disabled { opacity: 0.6; cursor: not-allowed; }
	.pj-member-remove:focus-visible { opacity: 1; outline: 2px solid var(--sidebar-text-active-border); outline-offset: 1px; }

	.pj-members-empty {
		padding: 1.25rem 1rem;
		font-size: 0.8125rem;
		color: var(--pj-text-secondary);
		text-align: center;
	}

	.pj-picker { position: relative; flex: 1; max-width: 18rem; margin-left: auto; }
	.pj-invite-input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		background: color-mix(in srgb, var(--surface-border) 20%, var(--center-channel-bg));
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.12s, background-color 0.12s;
	}
	.pj-invite-input::placeholder { color: var(--surface-muted); }
	.pj-invite-input:focus {
		outline: none;
		background: var(--center-channel-bg);
		border-color: var(--sidebar-text-active-border);
	}

	.pj-picker-dropdown {
		position: absolute;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		z-index: 20;
		max-height: 10rem;
		overflow-y: auto;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		box-shadow:
			0 4px 12px rgb(0 0 0 / 0.08),
			0 2px 4px rgb(0 0 0 / 0.04);
		padding: 0.25rem;
	}

	.pj-picker-item {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.5rem;
		border: none;
		background: transparent;
		border-radius: 0.5rem;
		cursor: pointer;
		text-align: left;
	}

	.pj-picker-item:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.pj-picker-item:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pj-picker-empty {
		padding: 0.75rem;
		font-size: 0.8125rem;
		color: var(--pj-text-secondary);
		text-align: center;
	}

	/* Customize modal */
	.cm-overlay {
		position: fixed; inset: 0; z-index: 60;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center;
		padding: 1.5rem;
		animation: cm-fade 150ms ease-out;
	}
	@keyframes cm-fade {
		from { opacity: 0; }
		to   { opacity: 1; }
	}

	.cm-modal {
		position: relative;
		width: 100%;
		max-width: 32rem;
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		border-radius: 1rem;
		overflow: hidden;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.06),
			0 24px 60px rgba(0, 0, 0, 0.28);
		animation: cm-pop 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
	}
	@keyframes cm-pop {
		from { opacity: 0; transform: translateY(8px) scale(0.98); }
		to   { opacity: 1; transform: translateY(0) scale(1); }
	}

	.cm-close {
		position: absolute;
		top: 0.75rem; right: 0.75rem;
		z-index: 2;
		display: flex; align-items: center; justify-content: center;
		width: 1.875rem; height: 1.875rem;
		border-radius: 0.5rem;
		border: none;
		background: rgba(0, 0, 0, 0.35);
		color: #fff;
		cursor: pointer;
		backdrop-filter: blur(6px);
		transition: background-color 0.15s;
	}
	.cm-close:hover { background: rgba(0, 0, 0, 0.55); }

	/* Preview hero — the centerpiece */
	.cm-hero {
		position: relative;
		height: 9rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 20%, var(--surface-bg));
		background-size: cover;
		background-position: center;
		overflow: hidden;
	}
	.cm-hero-placeholder {
		position: absolute; inset: 0;
		background:
			radial-gradient(circle at 20% 30%, color-mix(in srgb, var(--sidebar-text-active-border) 45%, transparent) 0%, transparent 55%),
			radial-gradient(circle at 85% 75%, color-mix(in srgb, var(--sidebar-text-active-color) 35%, transparent) 0%, transparent 50%),
			linear-gradient(135deg,
				color-mix(in srgb, var(--sidebar-text-active-border) 22%, var(--surface-bg)) 0%,
				color-mix(in srgb, var(--sidebar-text-active-color) 18%, var(--surface-bg)) 100%);
	}
	.cm-hero-scrim {
		position: absolute; inset: 0;
		background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.6) 100%);
	}
	.cm-hero-content {
		position: absolute;
		left: 1.25rem; bottom: 1rem;
		display: flex; align-items: center; gap: 0.75rem;
		color: #fff;
	}
	.cm-hero-icon {
		width: 2.75rem; height: 2.75rem;
		border-radius: 0.75rem;
		background: rgba(255, 255, 255, 0.15);
		border: 1px solid rgba(255, 255, 255, 0.25);
		backdrop-filter: blur(8px);
		display: flex; align-items: center; justify-content: center;
		overflow: hidden;
		flex-shrink: 0;
	}
	.cm-hero-icon--empty { color: rgba(255, 255, 255, 0.75); }
	.cm-hero-emoji { font-size: 1.5rem; line-height: 1; }
	.cm-hero-icon img { width: 100%; height: 100%; object-fit: cover; }
	.cm-hero-meta { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
	.cm-hero-eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.7);
	}
	.cm-hero-name {
		font-size: 1.0625rem;
		font-weight: 600;
		line-height: 1.2;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 22rem;
	}

	/* Body */
	.cm-body {
		padding: 1.25rem 1.25rem 0.5rem;
		display: flex; flex-direction: column; gap: 1.25rem;
	}

	.cm-section { display: flex; flex-direction: column; gap: 0.625rem; }
	.cm-section-head {
		display: flex; align-items: center; justify-content: space-between;
		min-height: 1.75rem;
	}
	.cm-section-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.cm-text-btn {
		display: inline-flex; align-items: center; gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		border: none; background: none;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.15s, background-color 0.15s;
	}
	.cm-text-btn:hover {
		color: var(--error-text-color);
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	/* Segmented control */
	.cm-segmented {
		display: inline-flex;
		padding: 0.1875rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
	.cm-seg {
		padding: 0.25rem 0.625rem;
		border-radius: 0.375rem;
		border: none; background: none;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.12s, background-color 0.12s, box-shadow 0.12s;
	}
	.cm-seg:hover:not(.cm-seg--active) { color: var(--center-channel-color); }
	.cm-seg--active {
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	/* Emoji picker */
	.cm-emoji-grid {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 0.375rem;
	}
	.cm-emoji-chip {
		aspect-ratio: 1;
		display: flex; align-items: center; justify-content: center;
		font-size: 1.125rem;
		border-radius: 0.5rem;
		border: 1px solid transparent;
		background: color-mix(in srgb, var(--surface-border) 30%, transparent);
		cursor: pointer;
		transition: background-color 0.12s, border-color 0.12s, transform 0.12s;
	}
	.cm-emoji-chip:hover {
		background: color-mix(in srgb, var(--surface-border) 60%, transparent);
		transform: translateY(-1px);
	}
	.cm-emoji-chip--active {
		background: color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
		border-color: var(--sidebar-text-active-border);
	}
	.cm-emoji-custom { display: flex; }
	.cm-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background: var(--control-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.12s, box-shadow 0.12s;
	}
	.cm-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 18%, transparent);
	}
	.cm-input::placeholder { color: var(--surface-muted); }

	/* Upload drop zone */
	.cm-drop {
		position: relative;
		display: flex;
		align-items: center;
		padding: 0.875rem;
		border-radius: 0.625rem;
		border: 1.5px dashed color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-color));
		background: color-mix(in srgb, var(--surface-border) 18%, transparent);
		cursor: pointer;
		transition: border-color 0.15s, background-color 0.15s;
		min-height: 3.75rem;
	}
	.cm-drop:hover {
		border-color: var(--sidebar-text-active-border);
		background: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent);
	}
	.cm-drop--filled {
		border-style: solid;
		border-color: color-mix(in srgb, var(--surface-border) 70%, transparent);
		background: var(--surface-bg);
	}
	.cm-drop > input[type="file"] { display: none; }

	.cm-drop-state {
		display: flex; align-items: center; gap: 0.75rem;
		color: var(--surface-muted);
		width: 100%;
	}
	.cm-drop-icon {
		display: flex; align-items: center; justify-content: center;
		width: 2.25rem; height: 2.25rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
		flex-shrink: 0;
	}
	.cm-drop-text { display: flex; flex-direction: column; gap: 0.125rem; }
	.cm-drop-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.cm-drop-hint {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	.cm-drop-filled {
		display: flex; align-items: center; gap: 0.75rem;
		width: 100%;
	}
	.cm-drop-thumb {
		border-radius: 0.375rem;
		object-fit: cover;
		flex-shrink: 0;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
	}
	.cm-drop-thumb--square { width: 2.5rem; height: 2.5rem; }
	.cm-drop-thumb--wide { width: 4.5rem; height: 2.5rem; }
	.cm-drop-meta { display: flex; flex-direction: column; gap: 0.125rem; }
	.cm-drop-meta-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.cm-drop-meta-hint {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	/* Footer */
	.cm-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.25rem 1.25rem;
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		margin-top: 0.5rem;
	}
</style>
