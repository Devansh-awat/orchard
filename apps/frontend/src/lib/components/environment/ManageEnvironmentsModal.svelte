<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Star, Trash2, Plus } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { environmentsQueryOptions } from '$lib/queries/environments';
	import { Modal, Button, Input } from '$lib/components/ui';
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

	async function setDefault(env: Environment) {
		const res = await apiFetch(`/apiv1/environments/${env.id}/set-default`, { method: 'POST' });
		if (res.ok) {
			toasts.add({ title: `${env.name} is now the default`, color: 'success' });
			invalidate();
		}
	}

	async function remove(env: Environment) {
		const res = await apiFetch(`/apiv1/environments/${env.id}`, { method: 'DELETE' });
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
				<span class="env-row-name">{env.name}</span>
				{#if env.isDefault}<span class="env-default-pill">default</span>{/if}
				<code class="env-row-ns">{env.namespace}</code>
				<span class="env-row-actions">
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
							onclick={() => remove(env)}
						>
							<Trash2 size={14} />
						</button>
					{/if}
				</span>
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
		padding: 0.55rem 0.7rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.65rem;
	}
	.env-dot {
		width: 9px;
		height: 9px;
		border-radius: 9999px;
		flex-shrink: 0;
	}
	.env-row-name {
		font-size: 0.85rem;
		font-weight: 550;
		color: var(--center-channel-color);
	}
	.env-default-pill {
		font-size: 0.62rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		background: var(--control-bg);
		padding: 0.1rem 0.4rem;
		border-radius: 9999px;
	}
	.env-row-ns {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.68rem;
		color: var(--surface-muted);
		margin-left: auto;
	}
	.env-row-actions {
		display: flex;
		gap: 0.2rem;
	}
	.env-icon-btn {
		display: inline-flex;
		width: 28px;
		height: 28px;
		align-items: center;
		justify-content: center;
		border-radius: 0.45rem;
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
