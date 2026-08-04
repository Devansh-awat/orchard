<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ArrowLeft, Play, Square, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { Alert, Button, Skeleton, StatusDot, sandboxStatus } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { timeAgo } from '$lib/components/org-dashboard/helpers.svelte';
	import {
		SandboxChatPanel,
		SandboxConnectPanel,
		SandboxSettingsCard
	} from '$lib/components/sandbox';
	import { sandboxQueryOptions } from '$lib/queries/sandboxes';

	const id = $derived($page.params.id ?? '');
	const sandboxQuery = createQuery(() => sandboxQueryOptions(id));
	const sandbox = $derived(sandboxQuery.data ?? null);
	const m = $derived(sandbox ? sandboxStatus(sandbox.status) : null);
	const imageTag = $derived(sandbox ? (sandbox.image.split('/').pop() ?? sandbox.image) : '');

	let busyAction = $state<string | null>(null);
	let deleteOpen = $state(false);

	async function lifecycle(action: 'start' | 'stop' | 'delete') {
		if (busyAction || !sandbox) return;
		busyAction = action;
		try {
			const res = await apiFetch(
				action === 'delete' ? `/apiv1/sandboxes/${id}` : `/apiv1/sandboxes/${id}/${action}`,
				{ method: action === 'delete' ? 'DELETE' : 'POST' }
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || `Failed to ${action} sandbox`);
			}
			queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			if (action === 'delete') {
				toasts.add({ title: 'Sandbox deleting', color: 'success' });
				goto('/sandboxes');
			}
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : `Failed to ${action} sandbox`,
				color: 'error'
			});
		} finally {
			busyAction = null;
		}
	}
</script>

<svelte:head><title>{sandbox?.name ?? 'Sandbox'} · Orchard</title></svelte:head>

<div class="sbd-page">
	<a href="/sandboxes" class="sbd-back">
		<ArrowLeft class="h-3.5 w-3.5" />
		Greenhouse
	</a>

	{#if sandboxQuery.isPending}
		<div class="sbd-stack">
			<Skeleton height="3rem" />
			<Skeleton height="20rem" />
			<Skeleton height="12rem" />
		</div>
	{:else if sandboxQuery.isError || !sandbox || !m}
		<Alert tone="error" title="Failed to load sandbox">
			{sandboxQuery.error instanceof Error ? sandboxQuery.error.message : 'Try again shortly.'}
		</Alert>
	{:else}
		<div class="sbd-stack">
			<div class="sbd-head">
				<div class="sbd-head-text">
					<h1 class="sbd-title">
						<StatusDot meta={m} size={9} />
						{sandbox.name}
					</h1>
					<div class="sbd-meta">
						<span class="sbd-meta-status">{m.label}</span>
						<span class="sbd-meta-sep">·</span>
						<span class="sbd-meta-image">{imageTag}</span>
						<span class="sbd-meta-sep">·</span>
						<span>
							{sandbox.lastActiveAt ? `active ${timeAgo(sandbox.lastActiveAt)}` : 'never active'}
						</span>
					</div>
				</div>
				<div class="sbd-actions">
					{#if sandbox.status === 'stopped' || sandbox.status === 'error'}
						<Button
							variant="secondary"
							loading={busyAction === 'start'}
							onclick={() => lifecycle('start')}
						>
							<Play class="h-3.5 w-3.5" /> Start
						</Button>
					{:else if sandbox.status === 'running'}
						<Button
							variant="secondary"
							loading={busyAction === 'stop'}
							onclick={() => lifecycle('stop')}
						>
							<Square class="h-3.5 w-3.5" /> Stop
						</Button>
					{/if}
					{#if sandbox.status !== 'deleting'}
						<Button
							variant="danger"
							loading={busyAction === 'delete'}
							onclick={() => (deleteOpen = true)}
						>
							<Trash2 class="h-3.5 w-3.5" /> Delete
						</Button>
					{/if}
				</div>
			</div>

			{#if sandbox.status === 'error' && sandbox.statusMessage}
				<Alert tone="error" title="Sandbox error">{sandbox.statusMessage}</Alert>
			{/if}

			<SandboxChatPanel
				{sandbox}
				starting={busyAction === 'start'}
				onstart={() => lifecycle('start')}
			/>
			<SandboxSettingsCard {sandbox} />
			<SandboxConnectPanel name={sandbox.name} />
		</div>
	{/if}
</div>

<ConfirmModal
	bind:open={deleteOpen}
	title="Delete sandbox?"
	description={`This permanently deletes ${sandbox?.name ?? 'this sandbox'} and its home volume. Anything not pushed to a remote is gone.`}
	confirmLabel="Delete"
	onconfirm={() => lifecycle('delete')}
	oncancel={() => {}}
/>

<style>
	.sbd-page {
		max-width: 56rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	.sbd-back {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.75rem;
		padding: 0 0.75rem 0 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-muted);
		text-decoration: none;
		margin-bottom: var(--space-3);
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.sbd-back:hover {
		color: var(--text-default);
		background-color: var(--fill-soft);
	}

	.sbd-stack {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.sbd-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.sbd-head-text {
		min-width: 0;
	}

	.sbd-title {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin: 0;
		font-size: var(--text-title-2);
		font-weight: 600;
		line-height: 1.2;
		letter-spacing: var(--track-title);
		color: var(--text-default);
	}

	.sbd-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.sbd-meta-status {
		font-weight: 600;
		color: var(--text-default);
	}

	.sbd-meta-sep {
		color: var(--text-faint);
	}

	.sbd-meta-image {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbd-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
</style>
