<script lang="ts">
	import { page } from '$app/stores';
	import { onDestroy, onMount } from 'svelte';
	import { apiFetch, selectedOrganization, toasts, subscribeOrgEvents } from '$lib/stores';
	import { Plus, Users, Boxes, ArrowRight, Trash2 } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Button, Input, EmptyState, Skeleton } from '$lib/components/ui';

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
		if (!workspaces.length) loading = true;
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

			const wsRes = await apiFetch('/apiv1/workspaces', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, slug, organizationId: orgId })
			});
			if (!wsRes.ok) {
				const d = await wsRes.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't create");
			}
			const ws = await wsRes.json();

			const projectRes = await apiFetch('/apiv1/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, slug, workspaceId: ws.id })
			});
			if (!projectRes.ok) {
				const d = await projectRes.json().catch(() => ({}));
				fetchWorkspaces();
				throw new Error(d.message || `Created the workspace, but couldn't create its project`);
			}

			toasts.add({ title: `Created "${name}"`, color: 'success' });
			newName = '';
			showCreate = false;
			fetchWorkspaces();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : "Couldn't create", color: 'error' });
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
				throw new Error(d.message || "Couldn't delete");
			}
			toasts.add({ title: `Deleted "${deleteTarget.name}"`, color: 'success' });
			deleteTarget = null;
			fetchWorkspaces();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : "Couldn't delete", color: 'error' });
		} finally {
			deleting = false;
		}
	}

	let unsub: (() => void) | null = null;
	let subscribedOrgId: string | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const id = $selectedOrganization?.id ?? null;
		if (!id || id === subscribedOrgId) return;
		subscribedOrgId = id;
		unsub?.();
		unsub = subscribeOrgEvents(id, (ev) => {
			if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
			if (refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				fetchWorkspaces();
			}, 2000);
		});
	});

	onDestroy(() => {
		unsub?.();
		if (refreshTimer) clearTimeout(refreshTimer);
	});

	onMount(fetchWorkspaces);
</script>

<div class="pg">
	<div class="pg-head">
		<div>
			<h1 class="pg-title">Workspaces</h1>
			<p class="pg-sub">Manage your workspaces and their members.</p>
		</div>
		<Button variant="primary" onclick={() => (showCreate = true)}>
			<Plus size={15} /> New workspace
		</Button>
	</div>

	{#if showCreate}
		<div class="create-bar">
			<div class="create-input-wrap">
				<Input
					type="text"
					placeholder="Workspace name"
					bind:value={newName}
					onkeydown={(e: KeyboardEvent) => {
						if (e.key === 'Enter') createWorkspace();
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
				onclick={createWorkspace}
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
		<div class="ws-grid">
			{#each Array(3) as _, i (i)}
				<div class="ws-card ws-card--skel">
					<Skeleton width="8rem" height="0.875rem" rounded="0.25rem" />
					<Skeleton width="12rem" height="0.625rem" rounded="0.25rem" />
					<div class="ws-card-foot">
						<Skeleton width="5rem" height="0.5rem" rounded="0.25rem" />
					</div>
				</div>
			{/each}
		</div>
	{:else if workspaces.length === 0}
		<EmptyState title="No workspaces yet" description="Create one to get started.">
			{#snippet icon()}<Boxes size={28} />{/snippet}
		</EmptyState>
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
		description="This permanently deletes this workspace and all its projects, apps, databases and domains. You can't undo this."
		confirmLabel="Delete workspace"
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
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
	}
	.pg-sub {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	.create-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
		padding: 0.75rem;
		border-radius: var(--radius-md);
		background: var(--center-channel-bg);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--surface-border) 60%, transparent),
			0 1px 3px rgba(0, 0, 0, 0.04);
	}
	.create-input-wrap {
		flex: 1;
		min-width: 0;
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
		border-radius: var(--radius-md);
		background: var(--center-channel-bg);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--surface-border) 50%, transparent),
			0 1px 3px rgba(0, 0, 0, 0.04);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: box-shadow var(--dur-fast);
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
		gap: 0.75rem;
	}
	.ws-card-icon {
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-xs);
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
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ws-card-desc {
		display: block;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
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
		border-radius: var(--radius-xs);
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		opacity: 0;
		transition: all var(--dur-fast);
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
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
	}
	:global(.ws-card-arrow) {
		margin-left: auto;
		color: var(--surface-muted);
		opacity: 0;
		transition: opacity var(--dur-fast);
	}
	.ws-card:hover :global(.ws-card-arrow) {
		opacity: 1;
	}
</style>
