<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ArrowLeft, Play, Square, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { Alert, Button, Skeleton, StatusDot, UnderlineTabs, sandboxStatus } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { timeAgo } from '$lib/components/org-dashboard/helpers.svelte';
	import {
		SandboxChangesPanel,
		SandboxChatPanel,
		SandboxConnectPanel,
		SandboxSettingsCard
	} from '$lib/components/sandbox';
	import { motionPanel } from '$lib/utils/motion.svelte';
	import { sandboxQueryOptions } from '$lib/queries/sandboxes';

	const id = $derived($page.params.id ?? '');
	const sandboxQuery = createQuery(() => sandboxQueryOptions(id));
	const sandbox = $derived(sandboxQuery.data ?? null);
	const m = $derived(sandbox ? sandboxStatus(sandbox.status) : null);
	const imageTag = $derived(sandbox ? (sandbox.image.split('/').pop() ?? sandbox.image) : '');

	let busyAction = $state<string | null>(null);
	let deleteOpen = $state(false);
	let sideTab = $state('changes');
	let changesTick = $state(0);

	const sideTabs = [
		{ id: 'changes', label: 'Changes' },
		{ id: 'settings', label: 'Settings' },
		{ id: 'connect', label: 'Connect' }
	];

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

<div class="sbw-page">
	{#if sandboxQuery.isPending}
		<div class="sbw-loading">
			<Skeleton height="3rem" />
			<Skeleton height="24rem" />
		</div>
	{:else if sandboxQuery.isError || !sandbox || !m}
		<div class="sbw-loading">
			<Alert tone="error" title="Failed to load sandbox">
				{sandboxQuery.error instanceof Error ? sandboxQuery.error.message : 'Try again shortly.'}
			</Alert>
		</div>
	{:else}
		<header class="sbw-head">
			<a href="/sandboxes" class="sbw-back" aria-label="Back to Greenhouse">
				<ArrowLeft class="h-4 w-4" />
			</a>
			<div class="sbw-head-text">
				<h1 class="sbw-title">
					<StatusDot meta={m} size={9} />
					{sandbox.name}
				</h1>
				<div class="sbw-meta">
					<span class="sbw-meta-status">{m.label}</span>
					<span class="sbw-meta-sep">·</span>
					<span class="sbw-meta-image" title={sandbox.image}>{imageTag}</span>
					<span class="sbw-meta-sep">·</span>
					<span>
						{sandbox.lastActiveAt ? `active ${timeAgo(sandbox.lastActiveAt)}` : 'never active'}
					</span>
				</div>
			</div>
			<div class="sbw-actions">
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
		</header>

		{#if sandbox.status === 'error' && sandbox.statusMessage}
			<div class="sbw-alert">
				<Alert tone="error" title="Sandbox error">{sandbox.statusMessage}</Alert>
			</div>
		{/if}

		<div class="sbw-body">
			<section class="sbw-main" aria-label="Agent transcript">
				<SandboxChatPanel
					{sandbox}
					starting={busyAction === 'start'}
					onstart={() => lifecycle('start')}
					onturndone={() => (changesTick += 1)}
				/>
			</section>
			<aside class="sbw-side" aria-label="Inspector">
				<UnderlineTabs tabs={sideTabs} bind:value={sideTab} label="Inspector" />
				<div class="sbw-side-body">
					<div
						class="sbw-pane"
						class:sbw-pane--hidden={sideTab !== 'changes'}
						{@attach motionPanel(() => sideTab === 'changes')}
					>
						<SandboxChangesPanel
							sandboxId={sandbox.id}
							running={sandbox.status === 'running'}
							refreshKey={changesTick}
						/>
					</div>
					<div
						class="sbw-pane"
						class:sbw-pane--hidden={sideTab !== 'settings'}
						{@attach motionPanel(() => sideTab === 'settings')}
					>
						<SandboxSettingsCard {sandbox} />
					</div>
					<div
						class="sbw-pane"
						class:sbw-pane--hidden={sideTab !== 'connect'}
						{@attach motionPanel(() => sideTab === 'connect')}
					>
						<SandboxConnectPanel name={sandbox.name} />
					</div>
				</div>
			</aside>
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
	.sbw-page {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		padding: 1rem 1.5rem 1rem;
		gap: 0.75rem;
	}

	.sbw-loading {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 56rem;
		margin: 1rem auto 0;
		width: 100%;
	}

	.sbw-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		flex-shrink: 0;
	}

	.sbw-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		flex-shrink: 0;
		border-radius: var(--radius-pill);
		color: var(--text-muted);
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.sbw-back:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}

	.sbw-head-text {
		min-width: 0;
		flex: 1;
	}

	.sbw-title {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin: 0;
		font-size: var(--text-title-3);
		font-weight: 600;
		line-height: 1.2;
		letter-spacing: var(--track-title);
		color: var(--text-default);
	}

	.sbw-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.125rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		min-width: 0;
	}

	.sbw-meta-status {
		font-weight: 600;
		color: var(--text-default);
	}

	.sbw-meta-sep {
		color: var(--text-faint);
	}

	.sbw-meta-image {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbw-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.sbw-alert {
		flex-shrink: 0;
	}

	.sbw-body {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem);
		gap: 1rem;
		flex: 1;
		min-height: 0;
	}

	.sbw-main {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.sbw-side {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--bg-surface);
		padding: 0.25rem 0.875rem 0.875rem;
	}

	.sbw-side-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-top: 0.75rem;
	}

	.sbw-pane--hidden {
		display: none;
	}

	@media (max-width: 960px) {
		.sbw-page {
			height: auto;
			min-height: 100%;
		}

		.sbw-body {
			display: flex;
			flex-direction: column;
		}

		.sbw-main {
			height: 65dvh;
			min-height: 24rem;
		}

		.sbw-side {
			flex: none;
		}

		.sbw-side-body {
			overflow-y: visible;
		}
	}
</style>
