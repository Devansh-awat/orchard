<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Star, Trash2, Plus, Pencil, Check, X } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { environmentsQueryOptions } from '$lib/queries/environments';
	import { Modal, Button, Input } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { envBadgeColor } from '$lib/utils/format';
	import type { Environment } from '$lib/types/environments';

	let {
		open = $bindable(false),
		projectId
	}: {
		open?: boolean;
		projectId: string;
	} = $props();

	const envQuery = createQuery(() => ({
		...environmentsQueryOptions(projectId),
		enabled: open && !!projectId
	}));
	const environments = $derived((envQuery.data ?? []) as Environment[]);

	let newName = $state('');
	let creating = $state(false);
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let savingRename = $state(false);

	function invalidate() {
		queryClient.invalidateQueries({ queryKey: ['environments', projectId] });
	}

	async function create() {
		if (!newName.trim() || creating) return;
		creating = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/environments`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newName.trim() })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to create environment');
			}
			toasts.add({ title: `Created "${newName.trim()}"`, color: 'success' });
			newName = '';
			invalidate();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			creating = false;
		}
	}

	function startRename(env: Environment) {
		editingId = env.id;
		editName = env.name;
	}

	async function saveRename(env: Environment) {
		const trimmed = editName.trim();
		if (!trimmed || savingRename) return;
		if (trimmed === env.name) {
			editingId = null;
			return;
		}
		savingRename = true;
		try {
			const res = await apiFetch(`/apiv1/environments/${env.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: trimmed })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to rename environment');
			}
			toasts.add({ title: `Renamed to "${trimmed}"`, color: 'success' });
			editingId = null;
			invalidate();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			savingRename = false;
		}
	}

	async function setDefault(env: Environment) {
		const res = await apiFetch(`/apiv1/environments/${env.id}/set-default`, { method: 'POST' });
		if (res.ok) {
			toasts.add({ title: `${env.name} is now the default`, color: 'success' });
			invalidate();
		}
	}

	let toDelete = $state<Environment | null>(null);
	let showDelete = $state(false);

	function describeContents(env: Environment): string {
		const c = env._count;
		if (!c) return 'everything in it';
		const parts = [
			c.deployments ? `${c.deployments} ${c.deployments === 1 ? 'app' : 'apps'}` : null,
			c.databases
				? `${c.databases} ${c.databases === 1 ? 'database' : 'databases'} with their data and backups`
				: null,
			c.ingresses ? `${c.ingresses} ${c.ingresses === 1 ? 'domain' : 'domains'}` : null
		].filter((p): p is string => p !== null);
		return parts.length ? parts.join(', ') : 'everything in it';
	}

	async function remove() {
		const env = toDelete;
		toDelete = null;
		if (!env) return;
		const res = await apiFetch(`/apiv1/environments/${env.id}`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ confirmName: env.name })
		});
		if (!res.ok) {
			const d = await res.json().catch(() => ({}));
			toasts.add({ title: d.message || 'Failed to delete', color: 'error' });
			return;
		}
		toasts.add({ title: `Deleted ${env.name}`, color: 'success' });
		invalidate();
	}
</script>

<Modal bind:open title="Environments" size="md">
	<div class="env-modal-list">
		{#each environments as env (env.id)}
			<div class="env-row">
				<span class="env-dot" style="background-color: {envBadgeColor(env.slug)}"></span>
				{#if editingId === env.id}
					<span class="env-rename-input">
						<Input
							bind:value={editName}
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Enter') saveRename(env);
								if (e.key === 'Escape') editingId = null;
							}}
						/>
					</span>
					<span class="env-row-actions">
						<button
							class="env-icon-btn"
							title="Save"
							aria-label="Save name"
							disabled={savingRename}
							onclick={() => saveRename(env)}
						>
							<Check size={14} />
						</button>
						<button
							class="env-icon-btn"
							title="Cancel"
							aria-label="Cancel rename"
							disabled={savingRename}
							onclick={() => (editingId = null)}
						>
							<X size={14} />
						</button>
					</span>
				{:else}
					<span class="env-row-name">{env.name}</span>
					{#if env.isDefault}<span class="env-default-pill">default</span>{/if}
					<code class="env-row-ns">{env.namespace}</code>
					<span class="env-row-actions">
						<button
							class="env-icon-btn"
							title="Rename"
							aria-label="Rename"
							onclick={() => startRename(env)}
						>
							<Pencil size={14} />
						</button>
						{#if !env.isDefault}
							<button
								class="env-icon-btn"
								title="Set as default"
								aria-label="Set as default"
								onclick={() => setDefault(env)}
							>
								<Star size={14} />
							</button>
							<button
								class="env-icon-btn env-icon-btn--danger"
								title="Delete"
								aria-label="Delete"
								onclick={() => {
									toDelete = env;
									showDelete = true;
								}}
							>
								<Trash2 size={14} />
							</button>
						{/if}
					</span>
				{/if}
			</div>
		{/each}
	</div>

	{#snippet footer()}
		<div class="env-modal-create">
			<Input
				placeholder="staging"
				bind:value={newName}
				onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && create()}
			/>
			<Button variant="primary" size="sm" loading={creating} onclick={create}>
				<Plus size={14} />
				New environment
			</Button>
		</div>
	{/snippet}
</Modal>

{#if toDelete}
	<ConfirmModal
		bind:open={showDelete}
		title={`Delete "${toDelete.name}"?`}
		description={`This <strong>permanently deletes the environment</strong> and its namespace <code>${toDelete.namespace}</code>: ${describeContents(toDelete)}. There is no undo and no recovery.`}
		html
		confirmText={toDelete.name}
		confirmLabel="Delete environment forever"
		onconfirm={remove}
		oncancel={() => {
			toDelete = null;
		}}
	/>
{/if}

<style>
	.env-modal-list {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.env-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-md);
	}
	.env-dot {
		width: 9px;
		height: 9px;
		border-radius: var(--radius-pill);
		flex-shrink: 0;
	}
	.env-row-name {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.env-default-pill {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		background: var(--control-bg);
		padding: 0.1rem 0.4rem;
		border-radius: var(--radius-pill);
	}
	.env-row-ns {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
		margin-left: auto;
	}
	.env-row-actions {
		display: flex;
		gap: 0.25rem;
		margin-left: auto;
	}
	.env-rename-input {
		flex: 1;
		min-width: 0;
	}
	.env-icon-btn {
		display: inline-flex;
		width: 28px;
		height: 28px;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		color: var(--surface-muted);
	}
	.env-icon-btn:hover {
		background: var(--control-bg);
		color: var(--center-channel-color);
	}
	.env-icon-btn--danger:hover {
		color: var(--error-text-color);
		background: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}
	.env-modal-create {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		width: 100%;
	}
	.env-modal-create :global(.input) {
		flex: 1;
	}
</style>
