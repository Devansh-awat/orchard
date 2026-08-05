<script lang="ts">
	import { ChevronRight, RefreshCw, Search, X } from 'lucide-svelte';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { fade } from '$lib/utils/transitions';
	import {
		ideFindFiles,
		ideListFiles,
		ideLspStatus,
		ideStatusKind,
		type IdeChangedFile,
		type IdeFileNode,
		type IdeLspStatus
	} from './ide';

	let {
		sandboxId,
		repo = null,
		running,
		changed = [],
		activePath = null,
		onopen
	}: {
		sandboxId: string;
		repo?: string | null;
		running: boolean;
		changed?: IdeChangedFile[];
		activePath?: string | null;
		onopen: (path: string) => void;
	} = $props();

	let children = $state<Record<string, IdeFileNode[]>>({});
	let expanded = $state<Record<string, boolean>>({});
	let busy = $state<Record<string, boolean>>({});
	let rootLoaded = $state(false);
	let lsp = $state<IdeLspStatus[]>([]);

	let query = $state('');
	let results = $state<string[]>([]);
	let searching = $state(false);
	let cursor = $state(0);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	const rootLabel = $derived(repo ?? 'home');
	const statusMap = $derived.by(() => {
		const map: Record<string, string> = {};
		for (const file of changed) map[file.path] = file.status;
		return map;
	});
	const changedPaths = $derived(changed.map((f) => f.path));

	function dirStatus(path: string): string | null {
		const prefix = path.endsWith('/') ? path : `${path}/`;
		return changedPaths.some((p) => p.startsWith(prefix)) ? 'M' : null;
	}

	async function loadDir(path: string) {
		if (busy[path]) return;
		busy[path] = true;
		try {
			const nodes = await ideListFiles(sandboxId, repo, path || '.');
			children[path] = nodes.filter((n) => n.name !== '.git');
		} finally {
			busy[path] = false;
		}
	}

	function toggleDir(node: IdeFileNode) {
		const open = !expanded[node.path];
		expanded[node.path] = open;
		if (open && !children[node.path]) loadDir(node.path);
	}

	async function reload() {
		children = {};
		rootLoaded = false;
		await loadDir('');
		rootLoaded = true;
		const open = Object.keys(expanded).filter((k) => expanded[k]);
		for (const path of open) loadDir(path);
		lsp = await ideLspStatus(sandboxId, repo);
	}

	let lastKey = '';
	$effect(() => {
		const key = `${sandboxId}:${repo ?? ''}:${running}`;
		if (key === lastKey) return;
		lastKey = key;
		expanded = {};
		query = '';
		results = [];
		if (running) reload();
	});

	function runSearch() {
		const term = query.trim();
		if (searchTimer) clearTimeout(searchTimer);
		if (!term) {
			results = [];
			searching = false;
			return;
		}
		searching = true;
		searchTimer = setTimeout(async () => {
			const found = await ideFindFiles(sandboxId, repo, term);
			results = found.filter((p) => !p.endsWith('/'));
			cursor = 0;
			searching = false;
		}, 180);
	}

	function pick(path: string) {
		query = '';
		results = [];
		onopen(path);
	}

	function onSearchKey(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			query = '';
			results = [];
			return;
		}
		if (results.length === 0) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			cursor = (cursor + 1) % results.length;
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			cursor = (cursor - 1 + results.length) % results.length;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const path = results[cursor];
			if (path) pick(path);
		}
	}

	const rootNodes = $derived(children[''] ?? []);
</script>

<div class="ft-root">
	<div class="ft-head">
		<span class="ft-title" title={rootLabel}>{rootLabel}</span>
		<button
			type="button"
			class="ft-icon-btn"
			aria-label="Reload files"
			disabled={!running || busy['']}
			onclick={reload}
		>
			<RefreshCw class={busy[''] ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
		</button>
	</div>

	<div class="ft-search">
		<Search class="h-3 w-3 ft-search-icon" />
		<input
			class="ft-search-input"
			type="text"
			placeholder="Find a file"
			aria-label="Find a file"
			bind:value={query}
			disabled={!running}
			oninput={runSearch}
			onkeydown={onSearchKey}
		/>
		{#if query}
			<button
				type="button"
				class="ft-icon-btn"
				aria-label="Clear search"
				onclick={() => {
					query = '';
					results = [];
				}}
			>
				<X class="h-3 w-3" />
			</button>
		{/if}
	</div>

	<div class="ft-body">
		{#if !running}
			<p class="ft-note">Start the sandbox to browse files.</p>
		{:else if query.trim()}
			{#if searching}
				<p class="ft-note">Searching…</p>
			{:else if results.length === 0}
				<p class="ft-note">No files match.</p>
			{:else}
				<ul class="ft-list" transition:fade>
					{#each results as path, i (path)}
						<li>
							<button
								type="button"
								class="ft-row ft-row--result"
								class:ft-row--cursor={i === cursor}
								title={path}
								onmouseenter={() => (cursor = i)}
								onclick={() => pick(path)}
							>
								<span class="ft-name">{path.split('/').pop()}</span>
								<span class="ft-dir">{path.split('/').slice(0, -1).join('/')}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else if !rootLoaded}
			<p class="ft-note">Loading files…</p>
		{:else if rootNodes.length === 0}
			<p class="ft-note">Nothing here yet.</p>
		{:else}
			<ul class="ft-list">
				{@render level(rootNodes, 0)}
			</ul>
		{/if}
	</div>

	<div class="ft-lsp">
		<span class="ft-lsp-title">Language servers</span>
		{#if lsp.length === 0}
			<span class="ft-lsp-empty">None running</span>
		{:else}
			{#each lsp as server (server.id)}
				<span class="ft-lsp-row">
					<span class="ft-lsp-dot ft-lsp-dot--{server.status}"></span>
					<span class="ft-lsp-name">{server.name}</span>
					<span class="ft-lsp-state">{server.status}</span>
				</span>
			{/each}
		{/if}
	</div>
</div>

{#snippet level(nodes: IdeFileNode[], depth: number)}
	{#each nodes as node (node.path)}
		<li>
			{#if node.type === 'directory'}
				{@const status = dirStatus(node.path)}
				<button
					type="button"
					class="ft-row"
					style="padding-left: {0.375 + depth * 0.625}rem"
					aria-expanded={expanded[node.path] === true}
					title={node.name}
					onclick={() => toggleDir(node)}
				>
					<span
						class="ft-chev"
						{@attach springRotate(() => expanded[node.path] === true, { rest: 0, on: 90 })}
					>
						<ChevronRight class="h-3 w-3" />
					</span>
					<span class="ft-name ft-name--dir">{node.name}</span>
					{#if status}<span class="ft-mark ft-mark--modified"></span>{/if}
				</button>
				{#if expanded[node.path]}
					{#if children[node.path]}
						<ul class="ft-list">
							{@render level(children[node.path], depth + 1)}
						</ul>
					{:else}
						<p class="ft-note ft-note--tight" style="padding-left: {1 + depth * 0.625}rem">
							Loading…
						</p>
					{/if}
				{/if}
			{:else}
				{@const status = statusMap[node.path]}
				<button
					type="button"
					class="ft-row"
					class:ft-row--active={activePath === node.path}
					style="padding-left: {0.375 + depth * 0.625}rem"
					title={node.path}
					onclick={() => onopen(node.path)}
				>
					<span class="ft-chev"></span>
					<span class="ft-name">{node.name}</span>
					{#if status}
						<span class="ft-status ft-status--{ideStatusKind(status)}">{status}</span>
					{/if}
				</button>
			{/if}
		</li>
	{/each}
{/snippet}

<style>
	.ft-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.ft-head {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
		height: 2rem;
		padding: 0 0.375rem 0 0.625rem;
		border-bottom: 1px solid var(--border-default);
	}

	.ft-title {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ft-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.ft-icon-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.ft-icon-btn:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.ft-search {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		height: 1.875rem;
		padding: 0 0.375rem 0 0.625rem;
		border-bottom: 1px solid var(--border-default);
	}

	.ft-search :global(.ft-search-icon) {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.ft-search-input {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		color: var(--text-default);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}

	.ft-search-input::placeholder {
		color: var(--text-faint);
	}

	.ft-search-input:focus {
		outline: none;
	}

	.ft-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 0.25rem 0;
	}

	.ft-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ft-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		width: 100%;
		min-width: 0;
		height: 1.375rem;
		padding-right: 0.5rem;
		border: none;
		background: none;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.ft-row:hover {
		background: var(--bg-hover);
	}

	.ft-row--active {
		background: var(--accent-subtle);
	}

	.ft-row--cursor {
		background: var(--bg-hover);
	}

	.ft-row--result {
		height: auto;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
		padding: 0.1875rem 0.5rem 0.1875rem 0.625rem;
	}

	.ft-chev {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 0.875rem;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.ft-name {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ft-name--dir {
		color: var(--text-muted);
	}

	.ft-dir {
		max-width: 100%;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ft-status {
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
	}

	.ft-status--added {
		color: var(--status-success);
	}

	.ft-status--deleted {
		color: var(--status-error);
	}

	.ft-status--modified {
		color: var(--status-warning);
	}

	.ft-status--renamed {
		color: var(--status-info);
	}

	.ft-status--untracked {
		color: var(--text-faint);
	}

	.ft-mark {
		width: 0.3125rem;
		height: 0.3125rem;
		flex-shrink: 0;
		border-radius: 50%;
	}

	.ft-mark--modified {
		background: var(--status-warning);
	}

	.ft-note {
		padding: 0.75rem 0.625rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.ft-note--tight {
		padding: 0.125rem 0.625rem;
	}

	.ft-lsp {
		display: flex;
		flex-direction: column;
		gap: 0.1875rem;
		flex-shrink: 0;
		padding: 0.5rem 0.625rem;
		border-top: 1px solid var(--border-default);
	}

	.ft-lsp-title {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-faint);
	}

	.ft-lsp-empty {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.ft-lsp-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.ft-lsp-dot {
		width: 0.375rem;
		height: 0.375rem;
		flex-shrink: 0;
		border-radius: 50%;
	}

	.ft-lsp-dot--connected {
		background: var(--status-success);
	}

	.ft-lsp-dot--error {
		background: var(--status-error);
	}

	.ft-lsp-name {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ft-lsp-state {
		flex-shrink: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}
</style>
