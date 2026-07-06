<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { apiFetch, toasts, subscribeOrgEvents } from '$lib/stores';
	import { Plus, Folder, Trash2, Rocket, Globe, Database } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Button, Input, EmptyState, Skeleton } from '$lib/components/ui';
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
		<div class="grid">
			{#each Array(3) as _, i (i)}
				<div class="card card--skel">
					<div class="card-top">
						<Skeleton width="2.25rem" height="2.25rem" rounded="0.5rem" />
						<div class="sk-col">
							<Skeleton width="7rem" height="0.7rem" rounded="0.25rem" />
							<Skeleton width="10rem" height="0.5rem" rounded="0.25rem" />
						</div>
					</div>
					<div class="card-bot"><Skeleton width="5rem" height="0.5rem" rounded="0.25rem" /></div>
				</div>
			{/each}
		</div>
	{:else if projects.length === 0}
		<EmptyState title="No projects yet" description="Create one to get started.">
			{#snippet icon()}<Folder size={28} />{/snippet}
		</EmptyState>
	{:else}
		<div class="grid">
			{#each projects as proj (proj.id)}
				<div
					class="card"
					role="link"
					tabindex="0"
					onclick={() => goto(`/${orgSlug}/projects/${proj.slug}`)}
					onkeydown={(e) => {
						if (e.key === 'Enter') goto(`/${orgSlug}/projects/${proj.slug}`);
					}}
				>
					<div class="card-top">
						<div class="card-av"><Folder size={14} /></div>
						<div class="card-text">
							<span class="card-name">{proj.name}</span>
							{#if proj.description}
								<span class="card-sub">{proj.description}</span>
							{/if}
						</div>
						<button
							class="card-del"
							onclick={(e) => {
								e.stopPropagation();
								deleteTarget = proj;
								deleteModalOpen = true;
							}}
							aria-label="Delete"
						>
							<Trash2 size={13} />
						</button>
					</div>
					<div class="card-bot">
						<span class="card-stat"
							><Rocket size={11} />
							{proj._count?.deployments ?? proj.deployments?.length ?? 0}</span
						>
						<span class="card-stat"
							><Globe size={11} /> {proj._count?.ingresses ?? proj.ingresses?.length ?? 0}</span
						>
						<span class="card-stat"
							><Database size={11} /> {proj._count?.databases ?? proj.databases?.length ?? 0}</span
						>
					</div>
				</div>
			{/each}
		</div>
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

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: 0.875rem;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: 0.625rem;
		background: var(--center-channel-bg);
		text-decoration: none;
		color: var(--center-channel-color);
		min-height: 8rem;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 3px 8px rgba(0, 0, 0, 0.03);
		transition:
			box-shadow 0.15s,
			transform 0.15s;
		cursor: pointer;
	}
	.card:hover {
		box-shadow:
			0 2px 4px rgba(0, 0, 0, 0.06),
			0 6px 16px rgba(0, 0, 0, 0.07);
		transform: translateY(-1px);
	}
	.card--skel {
		pointer-events: none;
	}

	.card-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.card-av {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.card-text {
		flex: 1;
		min-width: 0;
	}
	.card-name {
		display: block;
		font-size: 0.9375rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.card-sub {
		display: block;
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin-top: 0.0625rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.card-del {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.25rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		opacity: 0;
		transition: all 0.1s;
		flex-shrink: 0;
	}
	.card:hover .card-del {
		opacity: 1;
	}
	.card-del:hover {
		color: var(--error-text-color);
		background: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	.card-bot {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: auto;
		padding-top: 0.5rem;
	}
	.card-stat {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	.sk-col {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		flex: 1;
	}
</style>
