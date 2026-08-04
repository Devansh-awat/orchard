<script lang="ts">
	import { ArrowLeft, FileDiff, GitBranch, RefreshCw } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import { Button } from '$lib/components/ui';
	import { springHover } from '$lib/utils/motion.svelte';
	import { fade } from '$lib/utils/transitions';

	type ChangedFile = { path: string; status: string; additions: number; deletions: number };
	type Changes = { isRepo: boolean; branch: string | null; files: ChangedFile[] };

	let {
		sandboxId,
		running,
		refreshKey = 0,
		repo = null
	}: {
		sandboxId: string;
		running: boolean;
		refreshKey?: number;
		repo?: string | null;
	} = $props();

	let loading = $state(false);
	let error = $state<string | null>(null);
	let changes = $state<Changes | null>(null);

	let view = $state<'list' | 'diff'>('list');
	let diffTitle = $state('');
	let diffText = $state<string | null>(null);
	let diffTruncated = $state(false);
	let diffLoading = $state(false);
	let diffError = $state<string | null>(null);

	async function load() {
		if (!running) return;
		loading = true;
		error = null;
		try {
			const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
			const res = await apiFetch(`/apiv1/sandboxes/${sandboxId}/changes${qs}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to load changes');
			}
			changes = (await res.json()) as Changes;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load changes';
		} finally {
			loading = false;
		}
	}

	async function openDiff(file: string | null) {
		view = 'diff';
		diffTitle = file ?? 'Full diff';
		diffText = null;
		diffTruncated = false;
		diffError = null;
		diffLoading = true;
		try {
			const params = new URLSearchParams();
			if (file) params.set('file', file);
			if (repo) params.set('repo', repo);
			const qs = params.size > 0 ? `?${params.toString()}` : '';
			const res = await apiFetch(`/apiv1/sandboxes/${sandboxId}/diff${qs}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to load diff');
			}
			const data = (await res.json()) as { diff: string; truncated?: boolean };
			diffText = data.diff;
			diffTruncated = data.truncated === true;
		} catch (e) {
			diffError = e instanceof Error ? e.message : 'Failed to load diff';
		} finally {
			diffLoading = false;
		}
	}

	function backToList() {
		view = 'list';
		diffText = null;
		diffError = null;
	}

	let lastRepo: string | null = null;
	$effect(() => {
		void refreshKey;
		void sandboxId;
		if (repo !== lastRepo) {
			lastRepo = repo;
			view = 'list';
			diffText = null;
			diffError = null;
		}
		if (running) load();
	});

	function midTruncate(path: string, max = 46): string {
		if (path.length <= max) return path;
		const head = Math.ceil((max - 1) * 0.45);
		return `${path.slice(0, head)}…${path.slice(path.length - (max - 1 - head))}`;
	}

	function lineClass(line: string): string {
		if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line diff-line--meta';
		if (line.startsWith('@@')) return 'diff-line diff-line--hunk';
		if (line.startsWith('+')) return 'diff-line diff-line--add';
		if (line.startsWith('-')) return 'diff-line diff-line--del';
		if (line.startsWith('diff ') || line.startsWith('index ')) return 'diff-line diff-line--meta';
		return 'diff-line';
	}

	const diffLines = $derived(diffText === null ? [] : diffText.split('\n'));

	function statusKind(status: string): string {
		if (status.includes('?')) return 'untracked';
		if (status.includes('A')) return 'added';
		if (status.includes('D')) return 'deleted';
		if (status.includes('R')) return 'renamed';
		return 'modified';
	}
</script>

<div class="chg-root">
	{#if !running}
		<p class="chg-note">Start the sandbox to inspect changes.</p>
	{:else if view === 'diff'}
		<div class="chg-diff-head">
			<button type="button" class="chg-back" onclick={backToList}>
				<ArrowLeft class="h-3.5 w-3.5" />
			</button>
			<span class="chg-diff-title" title={diffTitle}>{midTruncate(diffTitle)}</span>
		</div>
		{#if diffLoading}
			<p class="chg-note">Loading diff…</p>
		{:else if diffError}
			<p class="chg-note chg-note--error">{diffError}</p>
		{:else if diffText !== null}
			{#if diffTruncated}
				<p class="chg-truncated">Diff truncated. Pull the branch to see everything.</p>
			{/if}
			{#if diffLines.length === 0 || diffText.trim() === ''}
				<p class="chg-note">No diff to show.</p>
			{:else}
				<div class="chg-diff" transition:fade>
					{#each diffLines as line, i (i)}
						<div class={lineClass(line)}>{line || ' '}</div>
					{/each}
				</div>
			{/if}
		{/if}
	{:else}
		<div class="chg-head">
			{#if changes?.isRepo && changes.branch}
				<span class="chg-branch" title={changes.branch}>
					<GitBranch class="h-3 w-3" />
					{changes.branch}
				</span>
			{:else}
				<span class="chg-branch chg-branch--none">Working tree</span>
			{/if}
			<div class="chg-head-actions">
				{#if changes?.isRepo && (changes.files?.length ?? 0) > 0}
					<Button size="sm" variant="ghost" onclick={() => openDiff(null)}>
						<FileDiff class="h-3.5 w-3.5" /> Full diff
					</Button>
				{/if}
				<button
					type="button"
					class="chg-refresh"
					aria-label="Refresh changes"
					disabled={loading}
					onclick={load}
				>
					<RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
				</button>
			</div>
		</div>
		{#if error}
			<p class="chg-note chg-note--error">{error}</p>
		{:else if !changes && loading}
			<p class="chg-note">Loading changes…</p>
		{:else if changes && !changes.isRepo}
			<p class="chg-note">No git repository in this sandbox.</p>
		{:else if changes && changes.files.length === 0}
			<p class="chg-note">No changes yet.</p>
		{:else if changes}
			<ul class="chg-list">
				{#each changes.files as file (file.path)}
					<li>
						<button
							type="button"
							class="chg-file"
							title={file.path}
							onclick={() => openDiff(file.path)}
							{@attach springHover({ lift: 0 })}
						>
							<span class="chg-status chg-status--{statusKind(file.status)}">{file.status}</span>
							<span class="chg-path">{midTruncate(file.path)}</span>
							<span class="chg-stat">
								{#if file.additions > 0}<span class="chg-add">+{file.additions}</span>{/if}
								{#if file.deletions > 0}<span class="chg-del">-{file.deletions}</span>{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

<style>
	.chg-root {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
	}

	.chg-note {
		padding: 1.25rem 0.5rem;
		text-align: center;
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-faint);
	}

	.chg-note--error {
		color: var(--status-error);
	}

	.chg-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-height: 1.75rem;
	}

	.chg-branch {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.chg-branch--none {
		color: var(--text-faint);
		font-family: inherit;
	}

	.chg-head-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.chg-refresh {
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

	.chg-refresh:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.chg-refresh:disabled {
		cursor: default;
		color: var(--text-faint);
	}

	.chg-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chg-file {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-width: 0;
		padding: 0.3125rem 0.375rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.chg-file:hover {
		background: var(--bg-hover);
	}

	.chg-status {
		flex-shrink: 0;
		width: 1.25rem;
		text-align: center;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
	}

	.chg-status--added {
		color: var(--status-success);
	}

	.chg-status--deleted {
		color: var(--status-error);
	}

	.chg-status--modified {
		color: var(--status-warning);
	}

	.chg-status--renamed {
		color: var(--status-info);
	}

	.chg-status--untracked {
		color: var(--text-faint);
	}

	.chg-path {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
	}

	.chg-stat {
		display: inline-flex;
		gap: 0.375rem;
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
	}

	.chg-add {
		color: var(--status-success);
	}

	.chg-del {
		color: var(--status-error);
	}

	.chg-diff-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 1.75rem;
	}

	.chg-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.chg-back:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.chg-diff-title {
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

	.chg-truncated {
		padding: 0.375rem 0.625rem;
		border: 1px solid var(--status-warning-border);
		border-radius: var(--radius-sm);
		background: var(--status-warning-bg);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
	}

	.chg-diff {
		min-height: 0;
		overflow: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		padding: 0.5rem 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.5;
	}

	.diff-line {
		padding: 0 0.625rem;
		white-space: pre;
		color: var(--text-default);
	}

	.diff-line--add {
		background: var(--status-success-bg);
		color: var(--status-success);
	}

	.diff-line--del {
		background: var(--status-error-bg);
		color: var(--status-error);
	}

	.diff-line--hunk {
		color: var(--accent);
		opacity: 0.75;
	}

	.diff-line--meta {
		color: var(--text-faint);
	}
</style>
