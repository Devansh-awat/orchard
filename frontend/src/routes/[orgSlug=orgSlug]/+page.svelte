<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		apiFetch,
		selectedOrganization,
		user,
		tree,
		type TreeItem
	} from '$lib/stores';
	import {
		Loader2,
		Plus,
		FolderKanban,
		Rocket,
		ArrowRight,
		Search,
		Sparkles,
		CheckCircle2,
		XCircle,
		Box
	} from 'lucide-svelte';

	interface Workspace {
		id: string;
		name: string;
		slug: string;
		description?: string;
		organizationId: string;
		members?: unknown[];
		projects?: unknown[];
		_count?: {
			members: number;
			projects: number;
		};
		createdAt: string;
	}

	const orgSlug = $derived($page.params.orgSlug);

	let workspaces = $state<Workspace[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let greeting = $derived.by(() => {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	let userName = $derived.by(() => {
		const u = $user;
		if (!u) return '';
		return u.firstName || u.name || u.username || u.email?.split('@')[0] || '';
	});

	function collectTreeItems(items: TreeItem[], type: TreeItem['type']): TreeItem[] {
		let result: TreeItem[] = [];
		for (const item of items) {
			if (item.type === type) result.push(item);
			if (item.children) result = result.concat(collectTreeItems(item.children, type));
		}
		return result;
	}

	let allDeployments = $derived(collectTreeItems($tree, 'deployment'));

	let deploymentCount = $derived(allDeployments.length);

	function statusColor(status: string | undefined): 'green' | 'amber' | 'red' | 'gray' {
		if (!status) return 'gray';
		const s = status.toLowerCase();
		if (s === 'running') return 'green';
		if (['pending', 'restarting', 'scaling'].includes(s)) return 'amber';
		if (['failed', 'error', 'deleting', 'stopped', 'unhealthy'].includes(s)) return 'red';
		return 'gray';
	}

	function deploymentStatusLabel(status: string | undefined): string {
		if (!status) return 'Unknown';
		switch (status.toLowerCase()) {
			case 'running': return 'Running';
			case 'restarting': return 'Restarting';
			case 'scaling': return 'Scaling';
			case 'failed': return 'Failed';
			case 'stopped': return 'Stopped';
			case 'unhealthy': return 'Unhealthy';
			case 'pending': return 'Pending';
			default: return status;
		}
	}

	function buildStatusLabel(buildStatus: string | undefined): string {
		switch (buildStatus?.toLowerCase()) {
			case 'succeeded': return 'Built';
			case 'building': return 'Building';
			case 'failed': return 'Build Failed';
			default: return '';
		}
	}

	// Collect deployment details from workspace/project tree for health & activity
	interface DeploymentInfo {
		id: string;
		name: string;
		status?: string;
		buildStatus?: string;
		projectName?: string;
		workspaceName?: string;
		href: string;
	}

	function collectDeploymentInfo(items: TreeItem[], parentProject?: string, parentWorkspace?: string): DeploymentInfo[] {
		let result: DeploymentInfo[] = [];
		for (const item of items) {
			const wsName = item.type === 'workspace' ? item.name : parentWorkspace;
			const projName = item.type === 'project' ? item.name : parentProject;

			if (item.type === 'deployment') {
				result.push({
					id: item.id.replace('deployment-', ''),
					name: item.name,
					href: item.href,
					projectName: parentProject,
					workspaceName: parentWorkspace,
				});
			}
			if (item.children) {
				result = result.concat(collectDeploymentInfo(item.children, projName, wsName));
			}
		}
		return result;
	}

	let deploymentDetails = $state<Map<string, { status: string; buildStatus: string }>>(new Map());
	let deploymentsLoading = $state(true);

	// Fetch status for all deployments
	async function fetchDeploymentStatuses() {
		deploymentsLoading = true;
		const deps = collectDeploymentInfo($tree);
		const statuses = new Map<string, { status: string; buildStatus: string }>();

		await Promise.all(
			deps.map(async (dep) => {
				try {
					const res = await apiFetch(`/apiv1/deployments/${dep.id}`);
					if (res.ok) {
						const data = await res.json();
						statuses.set(dep.id, {
							status: data.status || 'unknown',
							buildStatus: data.buildStatus || 'none'
						});
					}
				} catch {
					// ignore individual failures
				}
			})
		);

		deploymentDetails = statuses;
		deploymentsLoading = false;
	}

	let deploymentsWithStatus = $derived.by(() => {
		const deps = collectDeploymentInfo($tree);
		return deps.map(d => ({
			...d,
			status: deploymentDetails.get(d.id)?.status,
			buildStatus: deploymentDetails.get(d.id)?.buildStatus
		}));
	});

	let healthSummary = $derived.by(() => {
		const deps = deploymentsWithStatus;
		let errors = 0, building = 0, healthy = 0;
		for (const d of deps) {
			const deployColor = statusColor(d.status);
			const isBuildingOrPending = d.buildStatus === 'building';
			if (deployColor === 'red' && !isBuildingOrPending) errors++;
			else if (deployColor === 'amber' || isBuildingOrPending) building++;
			else if (deployColor === 'green') healthy++;
		}
		return { errors, building, healthy, total: deps.length };
	});

	// Show deployments that need attention first (errors, building), then recent healthy ones
	let activeDeployments = $derived.by(() => {
		const deps = deploymentsWithStatus;
		const needsAttention = deps.filter(d => {
			const color = statusColor(d.status);
			return color === 'red' || color === 'amber';
		});
		const healthy = deps.filter(d => statusColor(d.status) === 'green');
		// Show all problems + up to 3 healthy
		return [...needsAttention, ...healthy.slice(0, 3)];
	});

	async function fetchWorkspaces() {
		loading = true;
		error = null;

		try {
			const wsRes = await apiFetch('/apiv1/workspaces');
			if (!wsRes.ok) {
				throw new Error('Failed to fetch workspaces');
			}
			workspaces = await wsRes.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch workspaces';
		} finally {
			loading = false;
		}
	}

	let organizationWorkspaces = $derived.by(() => {
		if (!$selectedOrganization) return workspaces;
		return workspaces.filter(w => w.organizationId === $selectedOrganization.id);
	});

	let searchQuery = $state('');

	let filteredWorkspaces = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return organizationWorkspaces;
		return organizationWorkspaces.filter(workspace => {
			const name = workspace.name.toLowerCase();
			const slug = workspace.slug.toLowerCase();
			const description = workspace.description?.toLowerCase() ?? '';
			return (
				name.includes(query) ||
				slug.includes(query) ||
				description.includes(query)
			);
		});
	});

	function openWorkspace(slug: string) {
		return goto(`/${orgSlug}/workspaces/${slug}`);
	}

	function handleWorkspaceClick(event: MouseEvent, slug: string) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
		event.preventDefault();
		openWorkspace(slug);
	}

	// Reactive: re-fetch deployment statuses when tree changes
	let treeVersion = $derived(JSON.stringify($tree.map(t => t.id)));
	$effect(() => {
		treeVersion; // subscribe
		if ($tree.length > 0) {
			fetchDeploymentStatuses();
		}
	});

	onMount(() => {
		fetchWorkspaces();
	});
</script>

<div class="hp">
	<div class="hp-grid-bg"></div>

	<!-- Header: greeting + primary action -->
	<div class="hp-topbar">
		<div>
			<h1 class="hp-greeting">{greeting}{userName ? `, ${userName}` : ''}</h1>
			{#if !loading && healthSummary.total > 0}
				<p class="hp-subline">
					{#if healthSummary.errors > 0}
						<span class="hp-subline-alert">{healthSummary.errors} {healthSummary.errors === 1 ? 'issue needs' : 'issues need'} attention</span>
					{:else if healthSummary.building > 0}
						{healthSummary.building} {healthSummary.building === 1 ? 'deployment' : 'deployments'} in progress
					{:else}
						All {healthSummary.total} {healthSummary.total === 1 ? 'deployment' : 'deployments'} healthy
					{/if}
				</p>
			{/if}
		</div>
		<a href="/{orgSlug}/workspaces/new" class="hp-new-btn">
			<Plus size={16} />
			New Workspace
		</a>
	</div>

	{#if error}
		<div class="hp-error">{error}</div>
	{/if}

	{#if loading}
		<!-- Skeleton: stats row -->
		<div class="hp-stats">
			{#each Array(2) as _}
				<div class="hp-stat hp-skeleton-card">
					<div class="skeleton" style="width: 2.5rem; height: 2.5rem; border-radius: 0.75rem;"></div>
					<div class="hp-stat-info">
						<div class="skeleton" style="width: 2rem; height: 1.25rem;"></div>
						<div class="skeleton" style="width: 5rem; height: 0.75rem;"></div>
					</div>
				</div>
			{/each}
		</div>
		<!-- Skeleton: workspace cards -->
		<div class="hp-grid">
			{#each Array(3) as _}
				<div class="hp-card hp-skeleton-card">
					<div class="hp-card-top">
						<div class="skeleton skeleton-icon"></div>
					</div>
					<div class="hp-card-body">
						<div class="skeleton skeleton-title"></div>
						<div class="skeleton skeleton-desc"></div>
					</div>
					<div class="hp-card-footer">
						<div class="skeleton skeleton-badge"></div>
						<div class="skeleton skeleton-badge"></div>
					</div>
				</div>
			{/each}
		</div>
		<!-- Skeleton: deployment list -->
		<div class="hp-section">
			<div class="hp-section-header">
				<div class="skeleton" style="width: 7rem; height: 1rem; border-radius: 0.25rem;"></div>
			</div>
			<div class="hp-deploy-list">
				{#each Array(3) as _}
					<div class="hp-deploy-item hp-skeleton-card">
						<div class="hp-deploy-status">
							<div class="skeleton" style="width: 1rem; height: 1rem; border-radius: 50%;"></div>
						</div>
						<div class="hp-deploy-info">
							<div class="skeleton" style="width: 8rem; height: 0.875rem; border-radius: 0.25rem;"></div>
							<div class="skeleton" style="width: 5rem; height: 0.625rem; border-radius: 0.25rem; margin-top: 0.25rem;"></div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{:else}

		<!-- ===== Section 1: Resource overview (the numbers that matter) ===== -->
		<div class="hp-stats">
			<div class="hp-stat">
				<div class="hp-stat-icon hp-stat-icon--workspaces">
					<FolderKanban size={18} />
				</div>
				<div class="hp-stat-info">
					<span class="hp-stat-value">{organizationWorkspaces.length}</span>
					<span class="hp-stat-label">{organizationWorkspaces.length === 1 ? 'workspace' : 'workspaces'}</span>
				</div>
			</div>
			<div class="hp-stat">
				<div class="hp-stat-icon hp-stat-icon--deployments">
					<Rocket size={18} />
				</div>
				<div class="hp-stat-info">
					<span class="hp-stat-value">{deploymentCount}</span>
					<span class="hp-stat-label">{deploymentCount === 1 ? 'deployment' : 'deployments'}</span>
				</div>
			</div>
		</div>

		<!-- ===== Section 2: Workspaces ===== -->
		<div class="hp-section">
			<div class="hp-section-header">
				<h2 class="hp-section-title">Workspaces</h2>
				{#if organizationWorkspaces.length > 3}
					<div class="hp-search-wrap">
						<div class="hp-search-icon-wrapper">
							<Search size={14} />
						</div>
						<input
							type="search"
							placeholder="Search..."
							class="hp-search"
							bind:value={searchQuery}
						/>
					</div>
				{/if}
			</div>

			{#if !organizationWorkspaces.length}
				<div class="hp-empty hp-empty--dashed">
					<div class="hp-empty-icon">
						<Sparkles size={24} />
					</div>
					<h3 class="hp-empty-title">Create your first workspace</h3>
					<p class="hp-empty-desc">Workspaces organize your projects, deployments, and team members in one place.</p>
					<a href="/{orgSlug}/workspaces/new" class="hp-new-btn">
						<Plus size={16} />
						Create Workspace
					</a>
				</div>
			{:else if filteredWorkspaces.length}
				<div class="hp-grid">
					{#each filteredWorkspaces as workspace}
						<a
							href={`/${orgSlug}/workspaces/${workspace.slug}`}
							onclick={(event) => handleWorkspaceClick(event, workspace.slug)}
							class="hp-card"
						>
							<div class="hp-card-top">
								<div class="hp-card-icon">
									<FolderKanban size={18} />
								</div>
								<div class="hp-card-arrow">
									<ArrowRight size={14} />
								</div>
							</div>
							<div class="hp-card-body">
								<span class="hp-card-name">{workspace.name}</span>
								{#if workspace.description}
									<span class="hp-card-desc">{workspace.description}</span>
								{/if}
							</div>
							<div class="hp-card-footer">
								<span class="hp-card-count">
									{workspace._count?.projects ?? workspace.projects?.length ?? 0} projects
								</span>
								<span class="hp-card-count">
									{workspace._count?.members ?? workspace.members?.length ?? 0} members
								</span>
							</div>
						</a>
					{/each}
				</div>
			{:else}
				<div class="hp-empty">
					<p>No workspaces match "{searchQuery}"</p>
				</div>
			{/if}
		</div>

		<!-- ===== Section 3: Deployments ===== -->
		{#if deploymentsLoading && deploymentCount > 0}
			<div class="hp-section">
				<div class="hp-section-header">
					<h2 class="hp-section-title">Deployments</h2>
				</div>
				<div class="hp-deploy-list">
					{#each Array(Math.min(deploymentCount, 4)) as _}
						<div class="hp-deploy-item hp-skeleton-card">
							<div class="hp-deploy-status">
								<div class="skeleton" style="width: 1rem; height: 1rem; border-radius: 50%;"></div>
							</div>
							<div class="hp-deploy-info">
								<div class="skeleton" style="width: 8rem; height: 0.875rem; border-radius: 0.25rem;"></div>
								<div class="skeleton" style="width: 5rem; height: 0.625rem; border-radius: 0.25rem; margin-top: 0.25rem;"></div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else if activeDeployments.length > 0}
			<div class="hp-section">
				<div class="hp-section-header">
					<h2 class="hp-section-title">Deployments</h2>
					{#if deploymentsWithStatus.length > activeDeployments.length}
						<span class="hp-section-count">{deploymentsWithStatus.length} total</span>
					{/if}
				</div>
				<div class="hp-deploy-list">
					{#each activeDeployments as dep}
						<a href={dep.href} class="hp-deploy-item">
						<div class="hp-deploy-status">
							{#if dep.buildStatus === 'building'}
								<Loader2 size={16} class="hp-icon--amber animate-spin" />
							{:else if statusColor(dep.status) === 'green'}
								<CheckCircle2 size={16} class="hp-icon--green" />
							{:else if statusColor(dep.status) === 'amber'}
								<Loader2 size={16} class="hp-icon--amber animate-spin" />
							{:else if statusColor(dep.status) === 'red'}
								<XCircle size={16} class="hp-icon--red" />
							{:else}
								<Box size={16} class="hp-icon--gray" />
							{/if}
						</div>
						<div class="hp-deploy-info">
							<span class="hp-deploy-name">{dep.name}</span>
							<span class="hp-deploy-meta">
								{#if dep.projectName}
									{dep.projectName}
								{/if}
								{#if dep.buildStatus === 'building' || dep.buildStatus === 'failed'}
									{#if dep.projectName}&middot;{/if}
									<span class="hp-deploy-meta-status hp-deploy-meta-status--{dep.buildStatus === 'building' ? 'amber' : 'red'}">{buildStatusLabel(dep.buildStatus)}</span>
								{:else if dep.status}
									{#if dep.projectName}&middot;{/if}
									<span class="hp-deploy-meta-status hp-deploy-meta-status--{statusColor(dep.status)}">{deploymentStatusLabel(dep.status)}</span>
								{/if}
							</span>
						</div>
							<ArrowRight size={14} class="hp-deploy-arrow" />
						</a>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
