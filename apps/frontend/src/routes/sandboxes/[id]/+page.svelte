<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ArrowLeft, PanelLeft, Play, Square, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts, user } from '$lib/stores';
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
		SandboxBootProgress,
		SandboxChatPanel,
		SandboxConnectPanel,
		SandboxEditorPane,
		SandboxFileTree,
		SandboxGitPanel,
		SandboxMcpPanel,
		SandboxReposPanel,
		SandboxSettingsCard,
		SandboxTerminalPanel
	} from '$lib/components/sandbox';
	import { SandboxIde } from '$lib/components/sandbox/ide.svelte';
	import type { IdeChangedFile } from '$lib/components/sandbox/ide';
	import { motionPanel, springWidth } from '$lib/utils/motion.svelte';
	import {
		optimisticSandboxStatus,
		sandboxBootQueryOptions,
		sandboxQueryOptions
	} from '$lib/queries/sandboxes';
	import type { SandboxRepo, SandboxReposResponse } from '$lib/types/sandbox';

	const id = $derived($page.params.id ?? '');
	const sandboxQuery = createQuery(() => sandboxQueryOptions(id));
	const sandbox = $derived(sandboxQuery.data ?? null);
	const m = $derived(sandbox ? sandboxStatus(sandbox.status) : null);
	const imageTag = $derived(sandbox ? (sandbox.image.split('/').pop() ?? sandbox.image) : '');
	const owned = $derived(!sandbox?.owner || sandbox.owner.id === $user?.id);
	const live = $derived(sandbox?.status === 'running');

	const bootQuery = createQuery(() =>
		sandboxBootQueryOptions(id, owned && !!sandbox && sandbox.status !== 'stopped')
	);
	const boot = $derived(bootQuery.data ?? null);
	const bootSettled = $derived(bootQuery.isFetched);
	const bootPending = $derived(live && owned && !bootSettled);
	const ready = $derived(
		live && !bootPending && (!bootSettled || bootQuery.isError || boot?.ready === true)
	);
	const booting = $derived(!ready && sandbox?.status !== 'stopped' && sandbox?.status !== 'error');
	const running = $derived(ready && owned);

	let busyAction = $state<string | null>(null);
	let deleteOpen = $state(false);
	let sideTab = $state('git');
	let changesTick = $state(0);

	let repos = $state<SandboxRepo[]>([]);
	let reposLoading = $state(false);
	let reposLoaded = $state(false);
	let selectedRepo = $state<string | null>(null);

	const ide = new SandboxIde('');
	ide.onsaved = () => (changesTick += 1);
	let explorerOpen = $state(true);

	const EXPLORER_MIN = 180;
	const EXPLORER_MAX = 420;
	const EXPLORER_DEFAULT = 240;
	const INSPECTOR_MIN = 300;
	const INSPECTOR_MAX = 560;
	const INSPECTOR_DEFAULT = 380;
	const CENTER_MIN = 360;

	let explorerWidth = $state(EXPLORER_DEFAULT);
	let inspectorWidth = $state(INSPECTOR_DEFAULT);
	let bodyEl = $state<HTMLDivElement | undefined>(undefined);
	let dragging = $state<'explorer' | 'inspector' | null>(null);

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function paneKey(sandboxId: string): string {
		return `sandbox-panes:${sandboxId}`;
	}

	function readPanes(sandboxId: string) {
		if (!sandboxId || typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(paneKey(sandboxId));
			if (!raw) {
				explorerWidth = EXPLORER_DEFAULT;
				inspectorWidth = INSPECTOR_DEFAULT;
				return;
			}
			const saved = JSON.parse(raw) as { explorer?: number; inspector?: number };
			explorerWidth = clamp(saved.explorer ?? EXPLORER_DEFAULT, EXPLORER_MIN, EXPLORER_MAX);
			inspectorWidth = clamp(saved.inspector ?? INSPECTOR_DEFAULT, INSPECTOR_MIN, INSPECTOR_MAX);
		} catch {
			explorerWidth = EXPLORER_DEFAULT;
			inspectorWidth = INSPECTOR_DEFAULT;
		}
	}

	function writePanes() {
		if (!id || typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(
				paneKey(id),
				JSON.stringify({ explorer: explorerWidth, inspector: inspectorWidth })
			);
		} catch {
			return;
		}
	}

	function maxExplorer(): number {
		const total = bodyEl?.clientWidth ?? 0;
		if (total === 0) return EXPLORER_MAX;
		return clamp(total - inspectorWidth - CENTER_MIN, EXPLORER_MIN, EXPLORER_MAX);
	}

	function maxInspector(): number {
		const total = bodyEl?.clientWidth ?? 0;
		if (total === 0) return INSPECTOR_MAX;
		const explorer = explorerOpen ? explorerWidth : 0;
		return clamp(total - explorer - CENTER_MIN, INSPECTOR_MIN, INSPECTOR_MAX);
	}

	function startDrag(which: 'explorer' | 'inspector', event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		dragging = which;
		const startX = event.clientX;
		const startExplorer = explorerWidth;
		const startInspector = inspectorWidth;

		function onMove(move: PointerEvent) {
			const delta = move.clientX - startX;
			if (which === 'explorer') {
				explorerWidth = clamp(startExplorer + delta, EXPLORER_MIN, maxExplorer());
			} else {
				inspectorWidth = clamp(startInspector - delta, INSPECTOR_MIN, maxInspector());
			}
		}

		function onUp(up: PointerEvent) {
			handle.releasePointerCapture(up.pointerId);
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			dragging = null;
			writePanes();
		}

		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
	}

	function resetPane(which: 'explorer' | 'inspector') {
		if (which === 'explorer') explorerWidth = EXPLORER_DEFAULT;
		else inspectorWidth = INSPECTOR_DEFAULT;
		writePanes();
	}

	function nudgePane(which: 'explorer' | 'inspector', delta: number) {
		if (which === 'explorer') {
			explorerWidth = clamp(explorerWidth + delta, EXPLORER_MIN, maxExplorer());
		} else {
			inspectorWidth = clamp(inspectorWidth + delta, INSPECTOR_MIN, maxInspector());
		}
		writePanes();
	}

	function onHandleKey(which: 'explorer' | 'inspector', event: KeyboardEvent) {
		const step = event.shiftKey ? 40 : 12;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			nudgePane(which, which === 'explorer' ? -step : step);
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			nudgePane(which, which === 'explorer' ? step : -step);
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			resetPane(which);
		}
	}
	let mainView = $state('chat');
	let changedFiles = $state<IdeChangedFile[]>([]);

	let lastIdeId = '';
	$effect(() => {
		if (id === lastIdeId) return;
		lastIdeId = id;
		ide.sandboxId = id;
		ide.closeAll();
		changedFiles = [];
		repos = [];
		reposLoaded = false;
		mainView = 'chat';
		readPanes(id);
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
			reposLoaded = true;
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

	const sideTabs = $derived(
		owned
			? [
					{ id: 'git', label: 'Git' },
					{ id: 'terminal', label: 'Terminal' },
					{ id: 'repos', label: 'Repos' },
					{ id: 'mcp', label: 'MCP' },
					{ id: 'settings', label: 'Settings' },
					{ id: 'connect', label: 'Connect' }
				]
			: [{ id: 'settings', label: 'Settings' }]
	);

	let lastOwned = true;
	$effect(() => {
		if (owned === lastOwned) return;
		lastOwned = owned;
		if (!owned) sideTab = 'settings';
	});

	const NEXT_STATUS = {
		start: 'starting',
		stop: 'stopping',
		delete: 'deleting'
	} as const;

	async function lifecycle(action: 'start' | 'stop' | 'delete') {
		if (busyAction || !sandbox) return;
		busyAction = action;
		const previous = sandbox.status;
		optimisticSandboxStatus(queryClient, id, NEXT_STATUS[action]);
		queryClient.removeQueries({ queryKey: ['sandbox-boot', id] });
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
			optimisticSandboxStatus(queryClient, id, previous);
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
			{#if !owned && sandbox.owner}
				<span class="sbw-owner">
					<span class="sbw-owner-av" aria-hidden="true">
						{(sandbox.owner.username ?? sandbox.owner.email ?? '?').charAt(0).toUpperCase()}
					</span>
					{sandbox.owner.username ?? sandbox.owner.email ?? 'another member'}
				</span>
			{/if}
			<div class="sbw-actions">
				{#if !owned}
					<span class="sbw-readonly">View only</span>
				{:else if sandbox.status === 'stopped' || sandbox.status === 'error'}
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
				{#if owned && sandbox.status !== 'deleting'}
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

		<div class="sbw-body" class:sbw-body--dragging={dragging !== null} bind:this={bodyEl}>
			<aside
				class="sbw-explorer"
				aria-label="Files"
				{@attach springWidth(() => explorerOpen, { rest: 0, on: explorerWidth })}
			>
				<SandboxFileTree
					sandboxId={sandbox.id}
					repo={selectedRepo}
					{running}
					{booting}
					changed={changedFiles}
					activePath={ide.active?.path ?? null}
					onopen={openFile}
				/>
			</aside>
			{#if explorerOpen}
				<div
					class="sbw-grip"
					class:sbw-grip--active={dragging === 'explorer'}
					role="separator"
					aria-label="Resize file explorer"
					aria-orientation="vertical"
					aria-valuenow={explorerWidth}
					aria-valuemin={EXPLORER_MIN}
					aria-valuemax={EXPLORER_MAX}
					tabindex="0"
					onpointerdown={(e) => startDrag('explorer', e)}
					ondblclick={() => resetPane('explorer')}
					onkeydown={(e) => onHandleKey('explorer', e)}
				></div>
			{/if}
			<section class="sbw-main" aria-label="Agent workspace">
				<div class="sbw-switch">
					{#if ide.tabs.length > 0}
						<SegmentedControl options={mainViews} bind:value={mainView} label="Workspace view" />
					{:else}
						<span class="sbw-context">{selectedRepo ?? 'home'}</span>
					{/if}
				</div>
				<div class="sbw-main-body">
					<div
						class="sbw-view"
						class:sbw-view--hidden={ide.tabs.length > 0 && mainView !== 'chat'}
						{@attach motionPanel(() => mainView === 'chat')}
					>
						<SandboxChatPanel
							{sandbox}
							{repos}
							{owned}
							{ready}
							{booting}
							{bootPending}
							{boot}
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
			<div
				class="sbw-grip"
				class:sbw-grip--active={dragging === 'inspector'}
				role="separator"
				aria-label="Resize inspector"
				aria-orientation="vertical"
				aria-valuenow={inspectorWidth}
				aria-valuemin={INSPECTOR_MIN}
				aria-valuemax={INSPECTOR_MAX}
				tabindex="0"
				onpointerdown={(e) => startDrag('inspector', e)}
				ondblclick={() => resetPane('inspector')}
				onkeydown={(e) => onHandleKey('inspector', e)}
			></div>
			<aside class="sbw-side" aria-label="Inspector" style="width: {inspectorWidth}px">
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
							{booting}
							refreshKey={changesTick}
							repo={selectedRepo}
							onchanges={(files) => (changedFiles = files)}
						/>
					</div>
					<div
						class="sbw-pane sbw-pane--fill"
						class:sbw-pane--hidden={sideTab !== 'terminal'}
						{@attach motionPanel(() => sideTab === 'terminal')}
					>
						<SandboxTerminalPanel
							sandboxId={sandbox.id}
							name={sandbox.name}
							{running}
							{booting}
							active={sideTab === 'terminal'}
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
							{booting}
							{repos}
							loading={reposLoading}
							loaded={reposLoaded}
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
						<SandboxMcpPanel sandboxId={sandbox.id} {running} {booting} />
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
		gap: var(--space-2);
		flex-shrink: 0;
		height: 3rem;
		padding: 0 var(--space-2);
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
		gap: var(--space-1);
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

	.sbw-owner {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.sbw-owner-av {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: var(--radius-pill);
		background: var(--bg-sunken);
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: 1;
		font-weight: 700;
	}

	.sbw-readonly {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.sbw-actions {
		display: flex;
		align-items: center;
		gap: var(--space-1);
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
		padding: var(--space-2) var(--space-3) 0;
	}

	.sbw-body {
		--sbw-row: 2.25rem;
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
	}

	.sbw-switch {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		height: var(--sbw-row);
		padding: 0 var(--space-2);
		border-bottom: 1px solid var(--border-default);
	}

	.sbw-context {
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
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

	.sbw-grip {
		position: relative;
		width: 5px;
		flex-shrink: 0;
		margin: 0 -2px;
		z-index: 1;
		cursor: col-resize;
		touch-action: none;
		user-select: none;
	}

	.sbw-grip::before {
		content: '';
		position: absolute;
		inset: 0 2px;
		background: var(--border-default);
		transition: background-color var(--dur-fast);
	}

	.sbw-grip:hover::before,
	.sbw-grip:focus-visible::before,
	.sbw-grip--active::before {
		background: var(--accent);
	}

	.sbw-grip:focus-visible {
		outline: none;
	}

	.sbw-body--dragging {
		cursor: col-resize;
		user-select: none;
	}

	.sbw-side {
		flex-shrink: 0;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.sbw-side-tabs {
		display: flex;
		align-items: stretch;
		flex-shrink: 0;
		height: var(--sbw-row);
	}

	.sbw-side-tabs :global(.ui-tabs) {
		background: none;
		padding: 0;
		border-radius: 0;
		width: 100%;
	}

	.sbw-side-tabs :global(.ui-tabs-track) {
		height: 100%;
		padding-block: 0;
	}

	.sbw-side-tabs :global(.ui-tab) {
		border-radius: 0;
		background: none;
		box-shadow: none;
		padding-block: 0;
		padding-inline: var(--space-2);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
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
		padding: var(--space-3);
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

		.sbw-grip {
			display: none;
		}

		.sbw-main {
			height: 65dvh;
			min-height: 24rem;
		}

		.sbw-side {
			flex: none;
			width: auto;
			height: 32rem;
			border-top: 1px solid var(--border-default);
		}
	}
</style>
