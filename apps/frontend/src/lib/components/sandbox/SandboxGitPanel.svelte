<script lang="ts">
	import { ArrowLeft, FileDiff, GitBranch, GitPullRequest, RefreshCw, Upload } from 'lucide-svelte';
	import { toasts } from '$lib/stores';
	import { Button, Modal } from '$lib/components/ui';
	import { slide } from '$lib/utils/transitions';
	import SandboxDiffView from './SandboxDiffView.svelte';
	import {
		ideChanges,
		ideDiff,
		ideGitCommit,
		ideGitPr,
		ideGitPush,
		ideMidTruncate,
		ideStatusKind,
		ideVcsBranch,
		type IdeChangedFile,
		type IdeChanges
	} from './ide';

	let {
		sandboxId,
		running,
		repo = null,
		refreshKey = 0,
		onchanges
	}: {
		sandboxId: string;
		running: boolean;
		repo?: string | null;
		refreshKey?: number;
		onchanges?: (files: IdeChangedFile[]) => void;
	} = $props();

	let changes = $state<IdeChanges | null>(null);
	let branch = $state<string | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let selected = $state<Record<string, boolean>>({});

	let view = $state<'list' | 'diff'>('list');
	let diffTitle = $state('');
	let diffText = $state<string | null>(null);
	let diffTruncated = $state(false);
	let diffLoading = $state(false);
	let diffError = $state<string | null>(null);

	let message = $state('');
	let committing = $state(false);
	let commitOutput = $state<{ ok: boolean; output: string } | null>(null);
	let pushing = $state(false);
	let pushOutput = $state<{ ok: boolean; output: string } | null>(null);

	let prOpen = $state(false);
	let prTitle = $state('');
	let prBody = $state('');
	let prBusy = $state(false);
	let prError = $state<string | null>(null);
	let prUrl = $state<string | null>(null);

	const files = $derived(changes?.files ?? []);
	const selectedFiles = $derived(files.filter((f) => selected[f.path]).map((f) => f.path));
	const allSelected = $derived(files.length > 0 && selectedFiles.length === files.length);
	const someSelected = $derived(selectedFiles.length > 0 && !allSelected);
	const canCommit = $derived(
		running && !!repo && message.trim().length > 0 && files.length > 0 && !committing
	);

	async function load() {
		if (!running) return;
		loading = true;
		error = null;
		const result = await ideChanges(sandboxId, repo);
		loading = false;
		if (!result.ok || !result.data) {
			error = result.message ?? 'Failed to load changes';
			return;
		}
		changes = result.data;
		branch = result.data.branch;
		const live = new Set(result.data.files.map((f) => f.path));
		for (const path of Object.keys(selected)) if (!live.has(path)) delete selected[path];
		onchanges?.(result.data.files);
		const vcsBranch = await ideVcsBranch(sandboxId, repo);
		if (vcsBranch) branch = vcsBranch;
	}

	async function openDiff(file: string | null) {
		view = 'diff';
		diffTitle = file ?? 'All changes';
		diffText = null;
		diffTruncated = false;
		diffError = null;
		diffLoading = true;
		const result = await ideDiff(sandboxId, repo, file);
		diffLoading = false;
		if (!result.ok || !result.data) {
			diffError = result.message ?? 'Failed to load diff';
			return;
		}
		diffText = result.data.diff;
		diffTruncated = result.data.truncated === true;
	}

	function toggleAll() {
		const next = !allSelected;
		for (const file of files) selected[file.path] = next;
	}

	async function commit() {
		if (!canCommit || !repo) return;
		committing = true;
		commitOutput = null;
		const picked = selectedFiles;
		const result = await ideGitCommit(sandboxId, repo, message.trim(), picked);
		committing = false;
		if (!result.ok) {
			commitOutput = { ok: false, output: result.message ?? 'Commit failed' };
			return;
		}
		const data = result.data ?? { ok: false, output: '' };
		commitOutput = data;
		if (data.ok) {
			message = '';
			selected = {};
			toasts.add({ title: 'Committed', description: repo, color: 'success' });
			load();
		}
	}

	async function push() {
		if (!running || !repo || pushing) return;
		pushing = true;
		pushOutput = null;
		const result = await ideGitPush(sandboxId, repo);
		pushing = false;
		if (!result.ok) {
			pushOutput = { ok: false, output: result.message ?? 'Push failed' };
			return;
		}
		const data = result.data ?? { ok: false, output: '' };
		pushOutput = data;
		if (data.ok) toasts.add({ title: 'Pushed', description: repo, color: 'success' });
	}

	async function createPr() {
		if (!repo || prBusy || !prTitle.trim()) return;
		prBusy = true;
		prError = null;
		const result = await ideGitPr(sandboxId, repo, prTitle.trim(), prBody);
		prBusy = false;
		if (!result.ok || !result.data) {
			prError = result.message ?? 'Could not open the pull request';
			return;
		}
		const url = result.data.url;
		prUrl = url;
		prOpen = false;
		prTitle = '';
		prBody = '';
		toasts.add({
			title: 'Pull request opened',
			description: url,
			color: 'success',
			action: { label: 'Open', onClick: () => window.open(url, '_blank') }
		});
	}

	function onCommitKey(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			commit();
		}
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
			selected = {};
			commitOutput = null;
			pushOutput = null;
			prUrl = null;
		}
		if (running) load();
	});
</script>

<div class="git-root">
	{#if !running}
		<p class="git-note">Start the sandbox to work with git.</p>
	{:else if view === 'diff'}
		<div class="git-head">
			<button type="button" class="git-icon-btn" aria-label="Back to changes" onclick={() => (view = 'list')}>
				<ArrowLeft class="h-3.5 w-3.5" />
			</button>
			<span class="git-diff-title" title={diffTitle}>{ideMidTruncate(diffTitle, 38)}</span>
		</div>
		<div class="git-diff-wrap">
			{#if diffLoading}
				<p class="git-note">Loading diff…</p>
			{:else if diffError}
				<p class="git-note git-note--error">{diffError}</p>
			{:else if diffText !== null}
				<SandboxDiffView text={diffText} truncated={diffTruncated} />
			{/if}
		</div>
	{:else}
		<div class="git-head">
			{#if branch}
				<span class="git-branch" title={branch}>
					<GitBranch class="h-3 w-3" />
					{branch}
				</span>
			{:else}
				<span class="git-branch git-branch--none">
					{changes && !changes.isRepo ? 'Not a git repository' : 'Working tree'}
				</span>
			{/if}
			<button
				type="button"
				class="git-icon-btn"
				aria-label="Refresh changes"
				disabled={loading}
				onclick={load}
			>
				<RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
			</button>
		</div>

		{#if changes?.isRepo}
			<div class="git-bar">
				<label class="git-check-label">
					<input
						type="checkbox"
						class="git-check"
						checked={allSelected}
						indeterminate={someSelected}
						disabled={files.length === 0}
						onchange={toggleAll}
					/>
					<span class="git-bar-text">
						{#if selectedFiles.length > 0}
							{selectedFiles.length} of {files.length} selected
						{:else}
							{files.length}
							{files.length === 1 ? 'change' : 'changes'}
						{/if}
					</span>
				</label>
				<div class="git-bar-actions">
					{#if files.length > 0}
						<button type="button" class="git-icon-btn" aria-label="View all changes" onclick={() => openDiff(null)}>
							<FileDiff class="h-3.5 w-3.5" />
						</button>
					{/if}
					<Button size="sm" variant="ghost" loading={pushing} onclick={push}>
						<Upload class="h-3.5 w-3.5" /> Push
					</Button>
					<Button size="sm" variant="ghost" onclick={() => (prOpen = true)}>
						<GitPullRequest class="h-3.5 w-3.5" /> PR
					</Button>
				</div>
			</div>
		{/if}

		<div class="git-list-wrap">
			{#if error}
				<p class="git-note git-note--error">{error}</p>
			{:else if !changes && loading}
				<p class="git-note">Loading changes…</p>
			{:else if changes && !changes.isRepo}
				<p class="git-note">Pick a repo in the Repos tab to use git here.</p>
			{:else if files.length === 0}
				<p class="git-note">No changes yet.</p>
			{:else}
				<ul class="git-list">
					{#each files as file (file.path)}
						<li class="git-row">
							<input
								type="checkbox"
								class="git-check"
								aria-label={`Stage ${file.path}`}
								bind:checked={selected[file.path]}
							/>
							<button type="button" class="git-file" title={file.path} onclick={() => openDiff(file.path)}>
								<span class="git-status git-status--{ideStatusKind(file.status)}">{file.status}</span>
								<span class="git-path">{ideMidTruncate(file.path, 34)}</span>
								<span class="git-stat">
									{#if file.additions}<span class="git-add">+{file.additions}</span>{/if}
									{#if file.deletions}<span class="git-del">-{file.deletions}</span>{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		{#if prUrl}
			<a class="git-out git-out--link" href={prUrl} target="_blank" rel="noreferrer" transition:slide>
				<GitPullRequest class="h-3 w-3" /> Pull request opened
			</a>
		{/if}
		{#if pushOutput}
			<pre class="git-out" class:git-out--error={!pushOutput.ok} transition:slide>{pushOutput.output ||
					(pushOutput.ok ? 'Pushed' : 'Push failed')}</pre>
		{/if}
		{#if commitOutput}
			<pre class="git-out" class:git-out--error={!commitOutput.ok} transition:slide>{commitOutput.output ||
					(commitOutput.ok ? 'Committed' : 'Commit failed')}</pre>
		{/if}

		{#if changes?.isRepo}
			<div class="git-commit">
				<textarea
					class="git-commit-input"
					rows="2"
					placeholder="Commit message"
					aria-label="Commit message"
					bind:value={message}
					onkeydown={onCommitKey}
				></textarea>
				<div class="git-commit-foot">
					<span class="git-hint">
						{selectedFiles.length > 0 ? `Commits ${selectedFiles.length} selected` : 'Commits everything'}
					</span>
					<Button size="sm" variant="primary" disabled={!canCommit} loading={committing} onclick={commit}>
						Commit
					</Button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<Modal bind:open={prOpen} title="Create pull request" size="sm">
	<div class="git-pr-form">
		<input
			class="git-pr-input"
			type="text"
			placeholder="Title"
			aria-label="Pull request title"
			bind:value={prTitle}
		/>
		<textarea
			class="git-pr-input git-pr-input--body"
			rows="4"
			placeholder="Description (optional)"
			aria-label="Pull request description"
			bind:value={prBody}
		></textarea>
		{#if prError}
			<p class="git-pr-error">{prError}</p>
		{/if}
	</div>
	{#snippet footer()}
		<Button size="sm" variant="ghost" onclick={() => (prOpen = false)}>Cancel</Button>
		<Button
			size="sm"
			variant="primary"
			disabled={!prTitle.trim() || prBusy}
			loading={prBusy}
			onclick={createPr}
		>
			Create
		</Button>
	{/snippet}
</Modal>

<style>
	.git-root {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.git-note {
		padding: 1.25rem 0.75rem;
		text-align: center;
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-faint);
	}

	.git-note--error {
		color: var(--status-error);
	}

	.git-head {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		height: 2rem;
		padding: 0 0.375rem 0 0.75rem;
		border-bottom: 1px solid var(--border-default);
	}

	.git-branch {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.git-branch--none {
		font-family: inherit;
		color: var(--text-faint);
	}

	.git-diff-title {
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

	.git-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
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

	.git-icon-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.git-icon-btn:disabled {
		cursor: default;
		color: var(--text-faint);
	}

	.git-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-shrink: 0;
		min-height: 2rem;
		padding: 0 0.375rem 0 0.75rem;
		border-bottom: 1px solid var(--border-default);
	}

	.git-check-label {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		cursor: pointer;
	}

	.git-check {
		width: 0.8125rem;
		height: 0.8125rem;
		flex-shrink: 0;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.git-bar-text {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.git-bar-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
	}

	.git-list-wrap {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.25rem 0;
	}

	.git-diff-wrap {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: 0.5rem 0.75rem 0.75rem;
	}

	.git-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.git-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		padding-left: 0.75rem;
		transition: background-color var(--dur-fast);
	}

	.git-row:hover {
		background: var(--bg-hover);
	}

	.git-file {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
		padding: 0.25rem 0.75rem 0.25rem 0;
		border: none;
		background: none;
		text-align: left;
		cursor: pointer;
	}

	.git-status {
		flex-shrink: 0;
		width: 1rem;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
	}

	.git-status--added {
		color: var(--status-success);
	}

	.git-status--deleted {
		color: var(--status-error);
	}

	.git-status--modified {
		color: var(--status-warning);
	}

	.git-status--renamed {
		color: var(--status-info);
	}

	.git-status--untracked {
		color: var(--text-faint);
	}

	.git-path {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
	}

	.git-stat {
		display: inline-flex;
		gap: 0.375rem;
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
	}

	.git-add {
		color: var(--status-success);
	}

	.git-del {
		color: var(--status-error);
	}

	.git-out {
		flex-shrink: 0;
		max-height: 7rem;
		margin: 0.5rem 0.75rem 0;
		padding: 0.375rem 0.5rem;
		overflow: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.5;
		color: var(--text-muted);
		white-space: pre-wrap;
	}

	.git-out--error {
		border-color: var(--status-error-border);
		background: var(--status-error-bg);
		color: var(--status-error);
	}

	.git-out--link {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		border-color: var(--status-success-border);
		background: var(--status-success-bg);
		color: var(--status-success);
		text-decoration: none;
	}

	.git-commit {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		flex-shrink: 0;
		padding: 0.5rem 0.75rem 0.625rem;
		border-top: 1px solid var(--border-default);
	}

	.git-commit-input {
		width: 100%;
		resize: none;
		padding: 0.375rem 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		color: var(--text-default);
		font-size: var(--text-caption);
		line-height: 1.5;
	}

	.git-commit-input::placeholder {
		color: var(--text-faint);
	}

	.git-commit-input:focus {
		outline: none;
		border-color: var(--focus-ring);
	}

	.git-commit-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.git-hint {
		min-width: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.git-pr-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.git-pr-input {
		width: 100%;
		padding: 0.4375rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: 1.5;
	}

	.git-pr-input--body {
		resize: vertical;
	}

	.git-pr-input::placeholder {
		color: var(--text-faint);
	}

	.git-pr-input:focus {
		outline: none;
		border-color: var(--focus-ring);
	}

	.git-pr-error {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--status-error);
	}
</style>
