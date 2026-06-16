<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, selectedOrganization, toasts, refreshTree } from '$lib/stores';
	import { Plus, Loader2, Users, Boxes, ArrowRight, Trash2 } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';

	const orgSlug = $derived($page.params.orgSlug);

	interface Workspace {
		id: string;
		name: string;
		slug: string;
		description?: string;
		createdAt: string;
		_count?: { projects: number; members: number };
		members?: Array<{
			id: string;
			user: { firstName?: string; lastName?: string; email: string; imageUrl?: string };
		}>;
		projects?: Array<{ id: string; name: string; slug: string }>;
	}

	let workspaces = $state<Workspace[]>([]);
	let loading = $state(true);
	let creating = $state(false);
	let newName = $state('');
	let showCreate = $state(false);
	let deleteTarget = $state<Workspace | null>(null);
	let deleting = $state(false);

	function toSlug(n: string) {
		return n
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
	}

	async function fetchWorkspaces() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/workspaces');
			if (!res.ok) throw new Error();
			let all = await res.json();
			const orgId = $selectedOrganization?.id;
			if (orgId) all = all.filter((w: any) => w.organizationId === orgId);

			// Fetch details for member/project counts
			const detailed = await Promise.all(
				all.map(async (ws: any) => {
					try {
						const r = await apiFetch(`/apiv1/workspaces/slug/${ws.slug}`);
						return r.ok ? await r.json() : ws;
					} catch {
						return ws;
					}
				})
			);

			workspaces = detailed;
		} catch {
			/* */
		} finally {
			loading = false;
		}
	}

	async function createWorkspace() {
		const name = newName.trim();
		if (!name || creating) return;
		creating = true;
		try {
			const slug = toSlug(name);
			const orgId = $selectedOrganization?.id;

			// Create workspace
			const wsRes = await apiFetch('/apiv1/workspaces', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, slug, organizationId: orgId })
			});
			if (!wsRes.ok) {
				const d = await wsRes.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to create');
			}
			const ws = await wsRes.json();

			// Also create a project with the same name inside
			await apiFetch('/apiv1/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, slug, workspaceId: ws.id })
			});

			toasts.add({ title: `Created "${name}"`, color: 'success' });
			newName = '';
			showCreate = false;
			refreshTree();
			fetchWorkspaces();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to create', color: 'error' });
		} finally {
			creating = false;
		}
	}

	async function deleteWorkspace() {
		if (!deleteTarget || deleting) return;
		deleting = true;
		try {
			const res = await apiFetch(`/apiv1/workspaces/${deleteTarget.id}?force=true`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to delete');
			}
			toasts.add({ title: `Deleted "${deleteTarget.name}"`, color: 'success' });
			deleteTarget = null;
			refreshTree();
			fetchWorkspaces();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to delete', color: 'error' });
		} finally {
			deleting = false;
		}
	}

	onMount(fetchWorkspaces);
</script>

<div class="pg">
	<div class="pg-head">
		<div>
			<h1 class="pg-title">Workspaces</h1>
			<p class="pg-sub">Manage your workspaces and their members.</p>
		</div>
		<button class="btn-primary" onclick={() => (showCreate = true)}
			><Plus size={15} /> New Workspace</button
		>
	</div>

	{#if showCreate}
		<div class="create-bar">
			<input
				type="text"
				class="create-input"
				placeholder="Workspace name..."
				bind:value={newName}
				onkeydown={(e) => {
					if (e.key === 'Enter') createWorkspace();
					if (e.key === 'Escape') {
						showCreate = false;
						newName = '';
					}
				}}
			/>
			<button
				class="btn-primary btn-sm"
				onclick={createWorkspace}
				disabled={!newName.trim() || creating}
			>
				{#if creating}<Loader2 size={13} class="spin" />{/if}
				Create
			</button>
			<button
				class="btn-ghost btn-sm"
				onclick={() => {
					showCreate = false;
					newName = '';
				}}>Cancel</button
			>
		</div>
	{/if}

	{#if loading}
		<div class="ws-grid">
			{#each Array(3) as _}
				<div class="ws-card ws-card--skel">
					<div class="sk" style="width:8rem;height:0.875rem"></div>
					<div class="sk" style="width:12rem;height:0.625rem;margin-top:0.5rem"></div>
					<div class="ws-card-foot"><div class="sk" style="width:5rem;height:0.5rem"></div></div>
				</div>
			{/each}
		</div>
	{:else if workspaces.length === 0}
		<div class="empty">
			<Boxes size={28} />
			<p>No workspaces yet. Create one to get started.</p>
		</div>
	{:else}
		<div class="ws-grid">
			{#each workspaces as ws (ws.id)}
				<a href="/{orgSlug}/workspaces/{ws.slug}" class="ws-card">
					<div class="ws-card-top">
						<div class="ws-card-icon"><Boxes size={16} /></div>
						<div class="ws-card-info">
							<span class="ws-card-name">{ws.name}</span>
							{#if ws.description}
								<span class="ws-card-desc">{ws.description}</span>
							{/if}
						</div>
						<button
							class="ws-card-del"
							onclick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								deleteTarget = ws;
							}}
							aria-label="Delete"
						>
							<Trash2 size={13} />
						</button>
					</div>
					<div class="ws-card-foot">
						<span class="ws-card-stat"><Users size={11} /> {ws.members?.length ?? 0} members</span>
						<span class="ws-card-stat">{ws.projects?.length ?? 0} projects</span>
						<ArrowRight size={13} class="ws-card-arrow" />
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>

{#if deleteTarget}
	<ConfirmModal
		bind:open={
			() => !!deleteTarget,
			(v) => {
				if (!v) deleteTarget = null;
			}
		}
		title={`Delete "${deleteTarget.name}"?`}
		description="This will permanently delete this workspace and all its projects, deployments, databases, and ingresses. This cannot be undone."
		confirmLabel="Delete Workspace"
		onconfirm={deleteWorkspace}
		oncancel={() => (deleteTarget = null)}
	/>
{/if}

<style>
	.pg {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 4rem;
	}
	.pg-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 2rem;
	}
	.pg-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
	}
	.pg-sub {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		background: var(--center-channel-color);
		color: var(--center-channel-bg);
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
		white-space: nowrap;
	}
	.btn-primary:hover {
		opacity: 0.85;
	}
	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-ghost {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		background: none;
		color: var(--surface-muted);
		border: none;
		cursor: pointer;
	}
	.btn-ghost:hover {
		color: var(--center-channel-color);
	}
	.btn-sm {
		padding: 0.375rem 0.75rem;
		font-size: 0.75rem;
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
			0 0 0 1px color-mix(in srgb, var(--surface-border) 60%, transparent),
			0 1px 3px rgba(0, 0, 0, 0.04);
	}
	.create-input {
		flex: 1;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.375rem;
		border: 1px solid var(--surface-border);
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}
	.create-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}
	.create-input::placeholder {
		color: var(--surface-muted);
	}

	.ws-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 0.75rem;
	}

	.ws-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: 0.625rem;
		background: var(--center-channel-bg);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--surface-border) 50%, transparent),
			0 1px 3px rgba(0, 0, 0, 0.04);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: box-shadow 0.15s;
		cursor: pointer;
	}
	.ws-card:hover {
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--surface-border) 75%, transparent),
			0 4px 12px rgba(0, 0, 0, 0.07);
	}
	.ws-card--skel {
		pointer-events: none;
		min-height: 7rem;
	}

	.ws-card-top {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
	}
	.ws-card-icon {
		width: 2rem;
		height: 2rem;
		border-radius: 0.375rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.ws-card-info {
		flex: 1;
		min-width: 0;
	}
	.ws-card-name {
		display: block;
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ws-card-desc {
		display: block;
		font-size: 0.6875rem;
		color: var(--surface-muted);
		margin-top: 0.125rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ws-card-del {
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
	.ws-card:hover .ws-card-del {
		opacity: 1;
	}
	.ws-card-del:hover {
		color: var(--error-text-color);
		background: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	.ws-card-foot {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.ws-card-stat {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}
	:global(.ws-card-arrow) {
		margin-left: auto;
		color: var(--surface-muted);
		opacity: 0;
		transition: opacity 0.12s;
	}
	.ws-card:hover :global(.ws-card-arrow) {
		opacity: 1;
	}

	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 4rem 2rem;
		text-align: center;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	:global(.sk) {
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--surface-border) 40%, transparent) 25%,
			color-mix(in srgb, var(--surface-border) 18%, transparent) 50%,
			color-mix(in srgb, var(--surface-border) 40%, transparent) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
		border-radius: 0.25rem;
	}
	:global(.spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>
