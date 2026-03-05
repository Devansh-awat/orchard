<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		apiFetch,
		selectedOrganization
	} from '$lib/stores';
	import {
		Loader2,
		Plus,
		Users,
		FolderKanban
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

	async function fetchWorkspaces() {
		loading = true;
		error = null;

		try {
			const response = await apiFetch('/apiv1/workspaces');
			if (!response.ok) {
				throw new Error('Failed to fetch workspaces');
			}
			workspaces = await response.json();
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
		openWorkspace(slug);
	}

	onMount(() => {
		fetchWorkspaces();
	});
</script>

<div class="p-6">
	<div class="hp">
		{#if error}
			<div class="hp-error">{error}</div>
		{/if}

		<div class="hp-header">
			<h1 class="hp-title">Workspaces</h1>
			<div class="hp-actions">
				{#if organizationWorkspaces.length}
					<input
						type="search"
						placeholder="Search..."
						class="hp-search"
						bind:value={searchQuery}
					/>
				{/if}
				<a href="/{orgSlug}/workspaces/new" class="hp-new-btn">
					<Plus size={16} />
					New Workspace
				</a>
			</div>
		</div>

		{#if loading}
			<div class="hp-grid">
				{#each Array(6) as _}
					<div class="hp-card hp-skeleton-card">
						<div class="hp-card-top">
							<div class="skeleton skeleton-icon"></div>
							<div class="hp-card-counts">
								<div class="skeleton skeleton-badge"></div>
								<div class="skeleton skeleton-badge"></div>
							</div>
						</div>
						<div class="hp-card-body">
							<div class="skeleton skeleton-title"></div>
							<div class="skeleton skeleton-desc"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else if !organizationWorkspaces.length}
			<div class="hp-empty hp-empty--dashed">
				<FolderKanban size={40} />
				<p>No workspaces yet</p>
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
								<FolderKanban size={20} />
							</div>
							<div class="hp-card-counts">
								<span class="hp-card-count">
									<FolderKanban size={12} /> {workspace._count?.projects ?? workspace.projects?.length ?? 0}
								</span>
								<span class="hp-card-count">
									<Users size={12} /> {workspace._count?.members ?? workspace.members?.length ?? 0}
								</span>
							</div>
						</div>
						<div class="hp-card-body">
							<span class="hp-card-name">{workspace.name}</span>
							{#if workspace.description}
								<span class="hp-card-desc">{workspace.description}</span>
							{/if}
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
</div>
