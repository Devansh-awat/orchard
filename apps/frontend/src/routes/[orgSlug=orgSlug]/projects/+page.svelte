<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { apiFetch, toasts, subscribeOrgEvents } from '$lib/stores';
	import { Plus, Folder, Trash2, Rocket, Globe, Database, MoreVertical } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Button, Input, EmptyState, Skeleton, Table, Menu, MenuItem } from '$lib/components/ui';
	import { formatRelativeTime } from '$lib/utils/format';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);

	interface Project {
		id: string;
		name: string;
		slug: string;
		description?: string;
		createdAt: string;
		deployments?: Array<{ id: string; name: string }>;
		ingresses?: Array<{ id: string; host: string }>;
		databases?: Array<{ id: string; name: string }>;
		_count?: { deployments: number; ingresses: number; databases: number };
	}

	let projects = $state<Project[]>([]);
	let loading = $state(true);
	let orgId = $state<string | null>(null);
	let creating = $state(false);
	let newName = $state('');
	let showCreate = $state(false);
	let deleteTarget = $state<Project | null>(null);
	let deleteModalOpen = $state(false);
	let deleting = $state(false);

	function toSlug(n: string) {
		return n
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
	}

	function swatchStyle(slug: string): string {
		let hash = 0;
		for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
		const h1 = hash % 360;
		const h2 = (h1 + 40 + (hash % 80)) % 360;
		return `background: linear-gradient(135deg, hsl(${h1} 65% 62%), hsl(${h2} 70% 48%))`;
	}

	const COLUMNS = [
		{ id: 'name', label: 'Project', width: 'minmax(0, 2fr)' },
		{ id: 'resources', label: 'Resources', width: 'minmax(0, 1fr)' },
		{ id: 'created', label: 'Created', width: '7rem' },
		{ id: 'actions', label: '', width: '2.5rem' }
	];

	async function fetchProjects() {
		await invalidate(`org:${orgSlug}:overview`);
	}

	async function createProject() {
		const name = newName.trim();
		if (!name || creating) return;
		creating = true;
		try {
			const slug = toSlug(name);
			const res = await apiFetch('/apiv1/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, slug, organizationId: orgId })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to create');
			}
			toasts.add({ title: `Created "${name}"`, color: 'success' });
			newName = '';
			showCreate = false;
			fetchProjects();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to create', color: 'error' });
		} finally {
			creating = false;
		}
	}

	async function deleteProject() {
		if (!deleteTarget || deleting) return;
		const deploymentCount = deleteTarget.deployments?.length ?? 0;
		if (deploymentCount > 0) {
			toasts.add({
				title: `Can't delete "${deleteTarget.name}"`,
				description: `Remove its ${deploymentCount} deployment${deploymentCount === 1 ? '' : 's'} first.`,
				color: 'error'
			});
			deleteTarget = null;
			return;
		}
		deleting = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${deleteTarget.id}`, { method: 'DELETE' });
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to delete');
			}
			toasts.add({ title: `Deleted "${deleteTarget.name}"`, color: 'success' });
			deleteTarget = null;
			fetchProjects();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to delete', color: 'error' });
		} finally {
			deleting = false;
		}
	}

	let unsub: (() => void) | null = null;

	// Only reset state on a real org-switch (previously-loaded slug differs).
	// On fresh mount, loading defaults to true and projects is [], so the
	// skeleton already shows until the promise resolves.
	let loadedOrgSlug: string | null = null;
	$effect(() => {
		const slug = data.orgSlug;
		const promise = data.projectsPromise;
		if (!promise) return;
		const isOrgSwitch = loadedOrgSlug !== null && loadedOrgSlug !== slug;
		if (isOrgSwitch) {
			loading = true;
			projects = [];
		}
		promise
			.then(({ organizationId, projects: list }) => {
				orgId = organizationId;
				projects = list ?? [];
				loadedOrgSlug = slug;
				loading = false;
			})
			.catch((e) => {
				console.error('Failed to load projects:', e);
				loading = false;
			});
	});

	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let subscribedOrgId: string | null = null;
	$effect(() => {
		const id = orgId;
		if (!id || id === subscribedOrgId) return;
		subscribedOrgId = id;
		unsub?.();
		unsub = subscribeOrgEvents(id, (ev) => {
			if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
			if (refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				invalidate(`org:${orgSlug}:overview`);
			}, 2000);
		});
	});

	onDestroy(() => {
		unsub?.();
		if (refreshTimer) clearTimeout(refreshTimer);
	});
</script>

<div class="page">
	<header class="header">
		<h1 class="title">Projects</h1>
		<Button variant="primary" onclick={() => (showCreate = true)}>
			<Plus size={15} /> New project
		</Button>
	</header>

	{#if showCreate}
		<div class="create-bar">
			<div class="create-input-wrap">
				<Input
					type="text"
					placeholder="Project name"
					bind:value={newName}
					onkeydown={(e: KeyboardEvent) => {
						if (e.key === 'Enter') createProject();
						if (e.key === 'Escape') {
							showCreate = false;
							newName = '';
						}
					}}
				/>
			</div>
			<Button
				variant="primary"
				size="sm"
				onclick={createProject}
				loading={creating}
				disabled={!newName.trim()}
			>
				Create
			</Button>
			<Button
				variant="ghost"
				size="sm"
				onclick={() => {
					showCreate = false;
					newName = '';
				}}>Cancel</Button
			>
		</div>
	{/if}

	{#if loading}
		<div class="skel-rows">
			{#each Array(4) as _, i (i)}
				<div class="skel-row">
					<Skeleton width="1.75rem" height="1.75rem" rounded="0.5rem" />
					<Skeleton width="10rem" height="0.7rem" rounded="0.25rem" />
					<Skeleton width="7rem" height="0.55rem" rounded="0.25rem" />
				</div>
			{/each}
		</div>
	{:else if projects.length === 0}
		<EmptyState title="No projects yet" description="Create one to get started.">
			{#snippet icon()}<Folder size={28} />{/snippet}
		</EmptyState>
	{:else}
		<Table
			columns={COLUMNS}
			rows={projects}
			rowKey={(p) => p.id}
			rowHref={(p) => `/${orgSlug}/projects/${p.slug}`}
		>
			{#snippet row(proj)}
				<span class="cell-name">
					<span class="swatch" style={swatchStyle(proj.slug)}></span>
					<span class="cell-name-text">
						<span class="cell-name-title">{proj.name}</span>
						{#if proj.description}
							<span class="cell-name-sub">{proj.description}</span>
						{/if}
					</span>
				</span>
				<span class="cell-stats">
					<span class="stat"
						><Rocket size={11} /> {proj._count?.deployments ?? proj.deployments?.length ?? 0}</span
					>
					<span class="stat"
						><Globe size={11} /> {proj._count?.ingresses ?? proj.ingresses?.length ?? 0}</span
					>
					<span class="stat"
						><Database size={11} /> {proj._count?.databases ?? proj.databases?.length ?? 0}</span
					>
				</span>
				<span class="cell-created" title={new Date(proj.createdAt).toLocaleString()}>
					{formatRelativeTime(new Date(proj.createdAt))}
				</span>
				<span class="cell-actions">
					<Menu placement="bottom-end">
						{#snippet trigger(attrs, _open)}
							<button
								class="row-menu-btn"
								aria-label="Project actions"
								{...attrs}
								onclick={(e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									(attrs as { onclick?: (e: Event) => void }).onclick?.(e);
								}}
							>
								<MoreVertical size={14} />
							</button>
						{/snippet}
						<MenuItem
							onclick={() => {
								deleteTarget = proj;
								deleteModalOpen = true;
							}}
						>
							<Trash2 size={14} /> Delete project
						</MenuItem>
					</Menu>
				</span>
			{/snippet}
		</Table>
	{/if}
</div>

{#if deleteTarget}
	{@const deploymentCount = deleteTarget.deployments?.length ?? 0}
	{@const hasDeployments = deploymentCount > 0}
	<ConfirmModal
		bind:open={deleteModalOpen}
		title={hasDeployments
			? `Can't delete "${deleteTarget.name}"`
			: `Delete "${deleteTarget.name}"?`}
		description={hasDeployments
			? `This project has ${deploymentCount} deployment${deploymentCount === 1 ? '' : 's'}. Delete them first before removing the project.`
			: 'This will permanently delete this project and all its databases and ingresses. This cannot be undone.'}
		confirmLabel={hasDeployments ? 'OK' : 'Delete project'}
		danger={!hasDeployments}
		onconfirm={hasDeployments
			? () => {
					deleteTarget = null;
				}
			: deleteProject}
		oncancel={() => {
			deleteTarget = null;
		}}
	/>
{/if}

<style>
	.page {
		max-width: 80rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 4rem;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.75rem;
	}
	.title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.create-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
		padding: 0.75rem;
		border-radius: 0.625rem;
		background: var(--center-channel-bg);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 3px 8px rgba(0, 0, 0, 0.03);
	}
	.create-input-wrap {
		flex: 1;
		min-width: 0;
	}

	.cell-name {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
	}

	.swatch {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
	}

	.cell-name-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.cell-name-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cell-name-sub {
		font-size: 0.75rem;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cell-stats {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.stat {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		color: var(--text-muted);
	}

	.cell-created {
		font-size: 0.75rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.cell-actions {
		display: flex;
		justify-content: flex-end;
	}

	.row-menu-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			color 120ms ease,
			background-color 120ms ease;
	}

	.row-menu-btn:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}

	.skel-rows {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.skel-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
	}
</style>
