<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Plus, Sprout } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { Alert, Button, PageHeader, Skeleton } from '$lib/components/ui';
	import {
		SandboxConnectPanel,
		SandboxCreateModal,
		SandboxCredentialsPanel,
		SandboxEmptyState,
		SandboxList
	} from '$lib/components/sandbox';
	import { SandboxDisabledError, sandboxesQueryOptions } from '$lib/queries/sandboxes';
	import {
		isSandboxTransitional,
		type Sandbox,
		type SandboxCreateInput,
		type SandboxListResponse
	} from '$lib/types/sandbox';

	const sandboxesQuery = createQuery(() => ({
		...sandboxesQueryOptions(),
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
	let busyId = $state<string | null>(null);

	function invalidate() {
		queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
	}

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
			invalidate();
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

	async function lifecycle(sandbox: Sandbox, action: 'start' | 'stop' | 'delete') {
		if (busyId) return;
		busyId = sandbox.id;
		try {
			const res = await apiFetch(
				action === 'delete'
					? `/apiv1/sandboxes/${sandbox.id}`
					: `/apiv1/sandboxes/${sandbox.id}/${action}`,
				{ method: action === 'delete' ? 'DELETE' : 'POST' }
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || `Failed to ${action} sandbox`);
			}
			invalidate();
			if (action === 'delete') toasts.add({ title: 'Sandbox deleting', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : `Failed to ${action} sandbox`,
				color: 'error'
			});
		} finally {
			busyId = null;
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
		<div class="sbx-stack">
			<Skeleton height="10rem" />
			<Skeleton height="10rem" />
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
				<SandboxList
					{sandboxes}
					{busyId}
					onstart={(s) => lifecycle(s, 'start')}
					onstop={(s) => lifecycle(s, 'stop')}
					ondelete={(s) => lifecycle(s, 'delete')}
				/>
				<SandboxConnectPanel name={sandboxes[0].name} />
			{/if}
			<SandboxCredentialsPanel />
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
</style>
