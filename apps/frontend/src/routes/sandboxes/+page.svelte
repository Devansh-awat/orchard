<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { Plus, Sprout } from 'lucide-svelte';
	import { apiFetch, selectedOrganization, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { Alert, Button, PageHeader, Skeleton } from '$lib/components/ui';
	import {
		SandboxCard,
		SandboxCreateModal,
		SandboxEmptyState
	} from '$lib/components/sandbox';
	import { SandboxDisabledError, sandboxesQueryOptions } from '$lib/queries/sandboxes';
	import {
		isSandboxTransitional,
		type SandboxCreateInput,
		type SandboxListResponse
	} from '$lib/types/sandbox';

	const sandboxesQuery = createQuery(() => ({
		...sandboxesQueryOptions($selectedOrganization?.id),
		refetchInterval: (query: { state: { data?: SandboxListResponse } }) => {
			const list = query.state.data?.sandboxes ?? [];
			return list.some((s) => isSandboxTransitional(s.status)) ? 5_000 : 30_000;
		}
	}));

	const disabled = $derived(sandboxesQuery.error instanceof SandboxDisabledError);
	const sandboxes = $derived(sandboxesQuery.data?.sandboxes ?? []);
	const maxSandboxes = $derived(sandboxesQuery.data?.maxSandboxes ?? 0);
	const atLimit = $derived(maxSandboxes > 0 && sandboxes.length >= maxSandboxes);

	let createOpen = $state(false);
	let creating = $state(false);

	async function createSandbox(input: SandboxCreateInput) {
		if (creating) return;
		creating = true;
		try {
			const res = await apiFetch('/apiv1/sandboxes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(input)
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to create sandbox');
			}
			createOpen = false;
			queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			toasts.add({ title: 'Sandbox creating', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to create sandbox',
				color: 'error'
			});
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head><title>Greenhouse · Orchard</title></svelte:head>

<div class="sbx-page">
	<PageHeader title="Greenhouse">
		{#snippet icon()}<Sprout size={22} />{/snippet}
		{#snippet meta()}
			<span>Isolated cloud dev sandboxes</span>
			{#if !disabled && sandboxesQuery.data}
				<span class="sbx-count">{sandboxes.length} of {maxSandboxes} used</span>
			{/if}
		{/snippet}
		{#snippet actions()}
			{#if !disabled}
				<Button
					variant="primary"
					disabled={atLimit || sandboxesQuery.isPending}
					title={atLimit ? 'Sandbox limit reached' : undefined}
					onclick={() => (createOpen = true)}
				>
					<Plus class="h-4 w-4" /> New sandbox
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if sandboxesQuery.isPending}
		<div class="sbx-grid">
			<Skeleton height="7.5rem" />
			<Skeleton height="7.5rem" />
		</div>
	{:else if disabled}
		<Alert tone="info" title="Sandboxes are not enabled on this server">
			Ask an admin to enable the sandbox feature.
		</Alert>
	{:else if sandboxesQuery.isError}
		<Alert tone="error" title="Failed to load sandboxes">
			{sandboxesQuery.error instanceof Error ? sandboxesQuery.error.message : 'Try again shortly.'}
		</Alert>
	{:else}
		<div class="sbx-stack">
			{#if sandboxes.length === 0}
				<SandboxEmptyState oncreate={() => (createOpen = true)} />
			{:else}
				<div class="sbx-grid">
					{#each sandboxes as sandbox (sandbox.id)}
						<SandboxCard {sandbox} />
					{/each}
				</div>
			{/if}
			<div class="sbx-user-note">
				<span>Agent credentials and SSH identities are attached to your user account.</span>
				<Button size="sm" variant="secondary" onclick={() => goto('/user/settings?tab=sandbox')}>
					Open user settings
				</Button>
			</div>
		</div>
	{/if}
</div>

<SandboxCreateModal bind:open={createOpen} {creating} oncreate={createSandbox} />

<style>
	.sbx-page {
		max-width: 56rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	.sbx-count {
		font-weight: 600;
		color: var(--text-default);
	}

	.sbx-stack {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.sbx-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.sbx-grid > :global(*) {
		min-width: 0;
	}

	@media (max-width: 640px) {
		.sbx-grid {
			grid-template-columns: 1fr;
		}
	}

	.sbx-user-note {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-surface);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}
</style>
