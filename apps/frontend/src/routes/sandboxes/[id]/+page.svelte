<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ArrowLeft, PanelLeft, Play, Square, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import {
		Alert,
		Button,
		SegmentedControl,
		Skeleton,
		StatusDot,
		UnderlineTabs,
		sandboxStatus
	} from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { timeAgo } from '$lib/components/org-dashboard/helpers.svelte';
	import {
		SandboxChatPanel,
		SandboxConnectPanel,
		SandboxEditorPane,
		SandboxFileTree,
		SandboxGitPanel,
		SandboxMcpPanel,
		SandboxReposPanel,
		SandboxSettingsCard
	} from '$lib/components/sandbox';
	import { SandboxIde } from '$lib/components/sandbox/ide.svelte';
	import type { IdeChangedFile } from '$lib/components/sandbox/ide';
	import { motionPanel, springWidth } from '$lib/utils/motion.svelte';
	import { sandboxQueryOptions } from '$lib/queries/sandboxes';
	import type { SandboxRepo, SandboxReposResponse } from '$lib/types/sandbox';

	const id = $derived($page.params.id ?? '');
	const sandboxQuery = createQuery(() => sandboxQueryOptions(id));
	const sandbox = $derived(sandboxQuery.data ?? null);
	const m = $derived(sandbox ? sandboxStatus(sandbox.status) : null);
	const imageTag = $derived(sandbox ? (sandbox.image.split('/').pop() ?? sandbox.image) : '');
	const running = $derived(sandbox?.status === 'running');

	let busyAction = $state<string | null>(null);
	let deleteOpen = $state(false);
	let sideTab = $state('git');
	let changesTick = $state(0);

	let repos = $state<SandboxRepo[]>([]);
	let reposLoading = $state(false);
	let selectedRepo = $state<string | null>(null);

	const ide = new SandboxIde('');
	ide.onsaved = () => (changesTick += 1);
	let explorerOpen = $state(true);
	let mainView = $state('chat');
	let changedFiles = $state<IdeChangedFile[]>([]);

	let lastIdeId = '';
	$effect(() => {
		if (id === lastIdeId) return;
		lastIdeId = id;
		ide.sandboxId = id;
		ide.closeAll();
		changedFiles = [];
		mainView = 'chat';
	});

	let lastIdeRepo: string | null = null;
	$effect(() => {
		if (selectedRepo === lastIdeRepo) return;
		lastIdeRepo = selectedRepo;
		ide.closeAll();
		mainView = 'chat';
	});

	const mainViews = $derived([
		{ value: 'chat', label: 'Chat' },
		{ value: 'editor', label: ide.dirtyCount > 0 ? `Editor (${ide.dirtyCount})` : 'Editor' }
	]);

	function openFile(path: string) {
		ide.open(selectedRepo, path);
		mainView = 'editor';
	}

	async function loadRepos() {
		if (!running || reposLoading) return;
		reposLoading = true;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${id}/repos`);
			if (!res.ok) return;
			const data = (await res.json()) as SandboxReposResponse;
			repos = data.repos ?? [];
			if (selectedRepo === null || !repos.some((r) => r.name === selectedRepo)) {
				selectedRepo = repos[0]?.name ?? null;
			}
		} catch {
			return;
		} finally {
			reposLoading = false;
		}
	}

	$effect(() => {
		void changesTick;
		void id;
		if (running) loadRepos();
	});

	const sideTabs = [
		{ id: 'git', label: 'Git' },
		{ id: 'repos', label: 'Repos' },
		{ id: 'mcp', label: 'MCP' },
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
			<button
				type="button"
				class="sbw-back"
				aria-label="Toggle file explorer"
				aria-pressed={explorerOpen}
				onclick={() => (explorerOpen = !explorerOpen)}
			>
				<PanelLeft class="h-4 w-4" />
			</button>
			<h1 class="sbw-title">{sandbox.name}</h1>
			<span class="sbw-status">
				<StatusDot meta={m} size={8} />
				{m.label}
			</span>
			<span class="sbw-meta" title={sandbox.image}>
				{imageTag} · {sandbox.lastActiveAt
					? `active ${timeAgo(sandbox.lastActiveAt)}`
					: 'never active'}
			</span>
			<div class="sbw-actions">
				{#if sandbox.status === 'stopped' || sandbox.status === 'error'}
					<Button
						size="sm"
						variant="ghost"
						loading={busyAction === 'start'}
						onclick={() => lifecycle('start')}
					>
						<Play class="h-3.5 w-3.5" /> Start
					</Button>
				{:else if sandbox.status === 'running'}
					<Button
						size="sm"
						variant="ghost"
						loading={busyAction === 'stop'}
						onclick={() => lifecycle('stop')}
					>
						<Square class="h-3.5 w-3.5" /> Stop
					</Button>
				{/if}
				{#if sandbox.status !== 'deleting'}
					<button
						type="button"
						class="sbw-delete"
						aria-label="Delete sandbox"
						disabled={busyAction === 'delete'}
						onclick={() => (deleteOpen = true)}
					>
						<Trash2 class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>
		</header>

		{#if sandbox.status === 'error' && sandbox.statusMessage}
			<div class="sbw-alert">
				<Alert tone="error" title="Sandbox error">{sandbox.statusMessage}</Alert>
			</div>
		{/if}

		<div class="sbw-body">
			<aside
				class="sbw-explorer"
				aria-label="Files"
				{@attach springWidth(() => explorerOpen, { rest: 0, on: 240 })}
			>
				<SandboxFileTree
					sandboxId={sandbox.id}
					repo={selectedRepo}
					{running}
					changed={changedFiles}
					activePath={ide.active?.path ?? null}
					onopen={openFile}
				/>
			</aside>
			<section class="sbw-main" aria-label="Agent workspace">
				{#if ide.tabs.length > 0}
					<div class="sbw-switch">
						<SegmentedControl options={mainViews} bind:value={mainView} label="Workspace view" />
					</div>
				{/if}
				<div class="sbw-main-body">
					<div
						class="sbw-view"
						class:sbw-view--hidden={ide.tabs.length > 0 && mainView !== 'chat'}
						{@attach motionPanel(() => mainView === 'chat')}
					>
						<SandboxChatPanel
							{sandbox}
							{repos}
							bind:selectedRepo
							starting={busyAction === 'start'}
							onstart={() => lifecycle('start')}
							onturndone={() => (changesTick += 1)}
						/>
					</div>
					{#if ide.tabs.length > 0}
						<div
							class="sbw-view"
							class:sbw-view--hidden={mainView !== 'editor'}
							{@attach motionPanel(() => mainView === 'editor')}
						>
							<SandboxEditorPane {ide} />
						</div>
					{/if}
				</div>
			</section>
			<aside class="sbw-side" aria-label="Inspector">
				<div class="sbw-side-tabs">
					<UnderlineTabs tabs={sideTabs} bind:value={sideTab} label="Inspector" />
				</div>
				<div class="sbw-side-body">
					<div
						class="sbw-pane sbw-pane--fill"
						class:sbw-pane--hidden={sideTab !== 'git'}
						{@attach motionPanel(() => sideTab === 'git')}
					>
						<SandboxGitPanel
							sandboxId={sandbox.id}
							{running}
							refreshKey={changesTick}
							repo={selectedRepo}
							onchanges={(files) => (changedFiles = files)}
						/>
					</div>
					<div
						class="sbw-pane"
						class:sbw-pane--hidden={sideTab !== 'repos'}
						{@attach motionPanel(() => sideTab === 'repos')}
					>
						<SandboxReposPanel
							sandboxId={sandbox.id}
							{running}
							{repos}
							loading={reposLoading}
							{selectedRepo}
							onselect={(name) => (selectedRepo = name)}
							onrefresh={loadRepos}
						/>
					</div>
					<div
						class="sbw-pane"
						class:sbw-pane--hidden={sideTab !== 'mcp'}
						{@attach motionPanel(() => sideTab === 'mcp')}
					>
						<SandboxMcpPanel sandboxId={sandbox.id} {running} />
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
	}

	.sbw-loading {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 56rem;
		margin: 1.5rem auto 0;
		width: 100%;
		padding: 0 1.5rem;
	}

	.sbw-head {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-shrink: 0;
		height: 3rem;
		padding: 0 0.75rem 0 0.5rem;
		border-bottom: 1px solid var(--border-default);
	}

	.sbw-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border-radius: var(--radius-xs);
		color: var(--text-muted);
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}

	.sbw-back:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}

	.sbw-title {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbw-status {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
	}

	.sbw-meta {
		min-width: 0;
		flex: 1;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbw-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.sbw-delete {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.sbw-delete:hover:not(:disabled) {
		background: var(--status-error-bg);
		color: var(--status-error);
	}

	.sbw-delete:disabled {
		cursor: default;
		color: var(--text-faint);
	}

	.sbw-alert {
		flex-shrink: 0;
		padding: 0.5rem 0.75rem 0;
	}

	.sbw-body {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.sbw-explorer {
		flex-shrink: 0;
		min-height: 0;
		overflow: hidden;
	}

	.sbw-main {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--border-default);
	}

	.sbw-switch {
		flex-shrink: 0;
		padding: 0.375rem 0.75rem;
		border-bottom: 1px solid var(--border-default);
	}

	.sbw-main-body {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.sbw-view {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.sbw-view--hidden {
		display: none;
	}

	.sbw-side {
		width: 380px;
		flex-shrink: 0;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--border-default);
	}

	.sbw-side-tabs {
		flex-shrink: 0;
		padding: 0 0.75rem;
	}

	.sbw-side-tabs :global(.ui-tabs) {
		background: none;
		padding: 0;
		border-radius: 0;
		width: 100%;
	}

	.sbw-side-tabs :global(.ui-tab) {
		border-radius: 0;
		background: none;
		box-shadow: none;
	}

	.sbw-side-tabs :global(.ui-tab:hover),
	.sbw-side-tabs :global(.ui-tab:focus-visible) {
		background: none;
	}

	.sbw-side-body {
		display: flex;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.sbw-pane {
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
		padding: 0.625rem 0.75rem 0.75rem;
	}

	.sbw-pane--fill {
		overflow: hidden;
		padding: 0;
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
			flex-direction: column;
		}

		.sbw-explorer {
			display: none;
		}

		.sbw-main {
			height: 65dvh;
			min-height: 24rem;
			border-left: none;
		}

		.sbw-side {
			flex: none;
			width: auto;
			height: 32rem;
			border-left: none;
			border-top: 1px solid var(--border-default);
		}
	}
</style>
