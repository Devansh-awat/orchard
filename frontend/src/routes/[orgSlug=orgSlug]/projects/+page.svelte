<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, selectedOrganization, toasts, refreshTree } from '$lib/stores';
	import { Plus, Loader2, Folder, Trash2, Rocket, Globe, Database } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';

	const orgSlug = $derived($page.params.orgSlug);

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
	let creating = $state(false);
	let newName = $state('');
	let showCreate = $state(false);
	let deleteTarget = $state<Project | null>(null);
	let deleteModalOpen = $state(false);
	let deleting = $state(false);

	function toSlug(n: string) { return n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

	async function fetchProjects() {
		loading = true;
		try {
			const orgId = $selectedOrganization?.id;
			const url = orgId ? `/apiv1/projects?orgId=${orgId}` : '/apiv1/projects';
			const res = await apiFetch(url);
			if (!res.ok) throw new Error();
			projects = await res.json();
		} catch { /* */ }
		finally { loading = false; }
	}

	async function createProject() {
		const name = newName.trim();
		if (!name || creating) return;
		creating = true;
		try {
			const slug = toSlug(name);
			const orgId = $selectedOrganization?.id;
			const res = await apiFetch('/apiv1/projects', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, slug, organizationId: orgId })
			});
			if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message || 'Failed to create'); }
			toasts.add({ title: `Created "${name}"`, color: 'success' });
			newName = '';
			showCreate = false;
			refreshTree();
			fetchProjects();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to create', color: 'error' });
		} finally { creating = false; }
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
			if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message || 'Failed to delete'); }
			toasts.add({ title: `Deleted "${deleteTarget.name}"`, color: 'success' });
			deleteTarget = null;
			refreshTree();
			fetchProjects();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to delete', color: 'error' });
		} finally { deleting = false; }
	}

	onMount(fetchProjects);
</script>

<div class="page">
	<header class="header">
		<h1 class="title">Projects</h1>
		<button class="btn-primary" onclick={() => showCreate = true}><Plus size={15} /> New Project</button>
	</header>

	{#if showCreate}
		<div class="create-bar">
			<input
				type="text"
				class="create-input"
				placeholder="Project name..."
				bind:value={newName}
				onkeydown={(e) => { if (e.key === 'Enter') createProject(); if (e.key === 'Escape') { showCreate = false; newName = ''; } }}
			/>
			<button class="btn-primary btn-sm" onclick={createProject} disabled={!newName.trim() || creating}>
				{#if creating}<Loader2 size={13} class="spin" />{/if}
				Create
			</button>
			<button class="btn-ghost btn-sm" onclick={() => { showCreate = false; newName = ''; }}>Cancel</button>
		</div>
	{/if}

	{#if loading}
		<div class="grid">
			{#each Array(3) as _}
				<div class="card card--skel">
					<div class="card-top"><div class="sk sk-icon"></div><div class="sk-col"><div class="sk" style="width:7rem;height:0.7rem"></div><div class="sk" style="width:10rem;height:0.5rem"></div></div></div>
					<div class="card-bot"><div class="sk" style="width:5rem;height:0.5rem"></div></div>
				</div>
			{/each}
		</div>
	{:else if projects.length === 0}
		<div class="empty">
			<Folder size={28} />
			<p>No projects yet. Create one to get started.</p>
		</div>
	{:else}
		<div class="grid">
			{#each projects as proj (proj.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div
					class="card"
					role="link"
					tabindex="0"
					onclick={() => goto(`/${orgSlug}/projects/${proj.slug}`)}
					onkeydown={(e) => { if (e.key === 'Enter') goto(`/${orgSlug}/projects/${proj.slug}`); }}
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
							onclick={(e) => { e.stopPropagation(); deleteTarget = proj; deleteModalOpen = true; }}
							aria-label="Delete"
						>
							<Trash2 size={13} />
						</button>
					</div>
					<div class="card-bot">
						<span class="card-stat"><Rocket size={11} /> {proj._count?.deployments ?? proj.deployments?.length ?? 0}</span>
						<span class="card-stat"><Globe size={11} /> {proj._count?.ingresses ?? proj.ingresses?.length ?? 0}</span>
						<span class="card-stat"><Database size={11} /> {proj._count?.databases ?? proj.databases?.length ?? 0}</span>
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
		title={hasDeployments ? `Can't delete "${deleteTarget.name}"` : `Delete "${deleteTarget.name}"?`}
		description={hasDeployments
			? `This project has ${deploymentCount} deployment${deploymentCount === 1 ? '' : 's'}. Delete them first before removing the project.`
			: 'This will permanently delete this project and all its databases and ingresses. This cannot be undone.'}
		confirmLabel={hasDeployments ? 'OK' : 'Delete Project'}
		danger={!hasDeployments}
		onconfirm={hasDeployments ? (() => { deleteTarget = null; }) : deleteProject}
		oncancel={() => { deleteTarget = null; }}
	/>
{/if}

<style>
	.page { max-width: 80rem; margin: 0 auto; padding: 2.5rem 2.5rem 4rem; }

	.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.75rem; }
	.title { font-size: 1.5rem; font-weight: 700; color: var(--center-channel-color); margin: 0; letter-spacing: -0.02em; }

	.btn-primary {
		display: inline-flex; align-items: center; gap: 0.375rem;
		padding: 0.5rem 1rem; border-radius: 0.5rem; font-size: 0.8125rem; font-weight: 600;
		background: var(--button-bg); color: var(--button-color);
		border: none; cursor: pointer; transition: opacity 0.15s; white-space: nowrap;
	}
	.btn-primary:hover { opacity: 0.85; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost {
		display: inline-flex; align-items: center; gap: 0.375rem;
		padding: 0.5rem 0.75rem; border-radius: 0.5rem; font-size: 0.8125rem; font-weight: 500;
		background: none; color: var(--surface-muted); border: none; cursor: pointer;
	}
	.btn-ghost:hover { color: var(--center-channel-color); }
	.btn-sm { padding: 0.375rem 0.75rem; font-size: 0.75rem; }

	.create-bar {
		display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.5rem;
		padding: 0.75rem; border-radius: 0.625rem;
		background: var(--center-channel-bg);
		box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 3px 8px rgba(0,0,0,0.03);
	}
	.create-input {
		flex: 1; padding: 0.4375rem 0.75rem; border-radius: 0.375rem;
		border: 1px solid var(--surface-border); background: var(--center-channel-bg);
		color: var(--center-channel-color); font-size: 0.8125rem;
	}
	.create-input:focus { outline: none; border-color: var(--sidebar-text-active-border); }
	.create-input::placeholder { color: var(--surface-muted); }

	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 0.875rem; }

	.card {
		display: flex; flex-direction: column; gap: 0.5rem;
		padding: 1rem; border-radius: 0.625rem; background: var(--center-channel-bg);
		text-decoration: none; color: var(--center-channel-color); min-height: 8rem;
		box-shadow:
			0 1px 2px rgba(0,0,0,0.04),
			0 3px 8px rgba(0,0,0,0.03);
		transition: box-shadow 0.15s, transform 0.15s; cursor: pointer;
	}
	.card:hover {
		box-shadow:
			0 2px 4px rgba(0,0,0,0.06),
			0 6px 16px rgba(0,0,0,0.07);
		transform: translateY(-1px);
	}
	.card--skel { pointer-events: none; }

	.card-top { display: flex; align-items: center; gap: 0.5rem; }
	.card-av {
		width: 2.25rem; height: 2.25rem; border-radius: 0.5rem; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: color-mix(in srgb, #4a8aff 10%, transparent);
		color: #4a8aff;
	}
	.card-text { flex: 1; min-width: 0; }
	.card-name { display: block; font-size: 0.9375rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.card-sub { display: block; font-size: 0.75rem; color: var(--surface-muted); margin-top: 0.0625rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

	.card-del {
		display: flex; align-items: center; justify-content: center;
		width: 1.5rem; height: 1.5rem; border-radius: 0.25rem;
		border: none; background: none; color: var(--surface-muted);
		cursor: pointer; opacity: 0; transition: all 0.1s; flex-shrink: 0;
	}
	.card:hover .card-del { opacity: 1; }
	.card-del:hover { color: var(--error-text-color); background: color-mix(in srgb, var(--error-text-color) 10%, transparent); }

	.card-bot {
		display: flex; align-items: center; gap: 0.75rem;
		margin-top: auto; padding-top: 0.5rem;
	}
	.card-stat { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.6875rem; color: var(--surface-muted); }

	.empty {
		display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
		padding: 4rem 2rem; text-align: center; color: var(--surface-muted); font-size: 0.875rem;
	}

	/* Skeletons */
	.sk-icon { width: 2.25rem; height: 2.25rem; border-radius: 0.5rem; }
	.sk-col { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; }
	:global(.sk) {
		background: linear-gradient(90deg, color-mix(in srgb, var(--surface-border) 40%, transparent) 25%, color-mix(in srgb, var(--surface-border) 18%, transparent) 50%, color-mix(in srgb, var(--surface-border) 40%, transparent) 75%);
		background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 0.25rem;
	}
	:global(.spin) { animation: spin 1s linear infinite; }
	@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
	@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
