<script lang="ts">
	import {
		ArrowDown,
		ArrowLeft,
		ArrowUp,
		Check,
		ChevronDown,
		Download,
		FileDiff,
		GitBranch,
		GitPullRequest,
		MoreHorizontal,
		Plus,
		RefreshCw,
		Undo2,
		Upload,
		X
	} from 'lucide-svelte';
	import { toasts } from '$lib/stores';
	import { Button, Menu, MenuItem, Modal } from '$lib/components/ui';
	import { slide } from '$lib/utils/transitions';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import SandboxDiffView from './SandboxDiffView.svelte';
	import {
		ideChanges,
		ideDiff,
		ideGitBranches,
		ideGitCheckout,
		ideGitCommit,
		ideGitDeleteBranch,
		ideGitFetch,
		ideGitPr,
		ideGitPull,
		ideGitPush,
		ideGitUncommit,
		ideMidTruncate,
		ideRemoteBranchName,
		ideStatusKind,
		type IdeBranches,
		type IdeChangedFile,
		type IdeChanges,
		type IdeGitOutput,
		type IdeResult
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
	let branches = $state<IdeBranches | null>(null);
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
	let amend = $state(false);
	let signoff = $state(false);
	let trackedOnly = $state(false);

	let busy = $state<string | null>(null);
	let result = $state<{ kind: string; ok: boolean; output: string } | null>(null);
	let failedDelete = $state<{ branch: string; remote: boolean } | null>(null);

	let branchMenuOpen = $state(false);
	let newBranchOpen = $state(false);
	let newBranchName = $state('');
	let deleteOpen = $state(false);
	let deleteTarget = $state<{ branch: string; remote: boolean } | null>(null);
	let forcePushOpen = $state(false);

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
	const current = $derived(branches?.local.find((b) => b.name === branches?.current) ?? null);
	const canCommit = $derived(
		running && !!repo && busy === null && (amend || (message.trim().length > 0 && files.length > 0))
	);
	const commitLabel = $derived(amend ? 'Amend commit' : 'Commit');

	async function load() {
		if (!running) return;
		loading = true;
		error = null;
		const res = await ideChanges(sandboxId, repo);
		loading = false;
		if (!res.ok || !res.data) {
			error = res.message ?? 'Failed to load changes';
			return;
		}
		changes = res.data;
		branch = res.data.branch;
		const live = new Set(res.data.files.map((f) => f.path));
		for (const path of Object.keys(selected)) if (!live.has(path)) delete selected[path];
		onchanges?.(res.data.files);
	}

	async function loadBranches() {
		if (!running || !repo) {
			branches = null;
			return;
		}
		const res = await ideGitBranches(sandboxId, repo);
		if (res.ok && res.data) {
			branches = res.data;
			if (res.data.current) branch = res.data.current;
		}
	}

	async function runAction(kind: string, fn: () => Promise<IdeResult<IdeGitOutput>>) {
		if (!repo || busy) return;
		busy = kind;
		result = null;
		failedDelete = null;
		const res = await fn();
		busy = null;
		const ok = res.ok && res.data?.ok !== false;
		result = { kind, ok, output: res.data?.output ?? res.message ?? '' };
		await load();
		await loadBranches();
	}

	async function openDiff(file: string | null) {
		view = 'diff';
		diffTitle = file ?? 'All changes';
		diffText = null;
		diffTruncated = false;
		diffError = null;
		diffLoading = true;
		const res = await ideDiff(sandboxId, repo, file);
		diffLoading = false;
		if (!res.ok || !res.data) {
			diffError = res.message ?? 'Failed to load diff';
			return;
		}
		diffText = res.data.diff;
		diffTruncated = res.data.truncated === true;
	}

	function toggleAll() {
		const next = !allSelected;
		for (const file of files) selected[file.path] = next;
	}

	async function commit() {
		if (!canCommit || !repo) return;
		const wasAmend = amend;
		await runAction('commit', () =>
			ideGitCommit(sandboxId, repo, {
				message: message.trim(),
				files: selectedFiles,
				amend: wasAmend,
				signoff,
				trackedOnly
			})
		);
		if (result?.ok) {
			message = '';
			amend = false;
			selected = {};
			toasts.add({
				title: wasAmend ? 'Amended' : 'Committed',
				description: repo,
				color: 'success'
			});
		}
	}

	async function uncommit() {
		if (!repo) return;
		await runAction('uncommit', () => ideGitUncommit(sandboxId, repo));
	}

	async function checkout(name: string) {
		branchMenuOpen = false;
		if (!repo || name === branches?.current) return;
		await runAction('checkout', () => ideGitCheckout(sandboxId, repo, name));
	}

	async function checkoutRemote(ref: string) {
		branchMenuOpen = false;
		if (!repo) return;
		const name = ideRemoteBranchName(ref);
		await runAction('checkout', () =>
			ideGitCheckout(sandboxId, repo, name, { create: true, from: ref })
		);
	}

	async function createBranch() {
		const name = newBranchName.trim();
		if (!name || !repo) return;
		newBranchOpen = false;
		newBranchName = '';
		await runAction('checkout', () => ideGitCheckout(sandboxId, repo, name, { create: true }));
	}

	function askDelete(name: string, remote: boolean) {
		branchMenuOpen = false;
		deleteTarget = { branch: remote ? ideRemoteBranchName(name) : name, remote };
		deleteOpen = true;
	}

	async function deleteBranch(force: boolean) {
		const target = deleteTarget;
		if (!target || !repo) return;
		await runAction('delete', () =>
			ideGitDeleteBranch(sandboxId, repo, target.branch, { remote: target.remote, force })
		);
		failedDelete = result?.ok ? null : target;
	}

	async function createPr() {
		if (!repo || prBusy || !prTitle.trim()) return;
		prBusy = true;
		prError = null;
		const res = await ideGitPr(sandboxId, repo, prTitle.trim(), prBody);
		prBusy = false;
		if (!res.ok || !res.data) {
			prError = res.message ?? 'Could not open the pull request';
			return;
		}
		prUrl = res.data.url;
		prOpen = false;
		prTitle = '';
		prBody = '';
		toasts.add({
			title: 'Pull request opened',
			description: res.data.url,
			color: 'success',
			action: { label: 'Open', onClick: () => window.open(res.data?.url, '_blank') }
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
			result = null;
			failedDelete = null;
			prUrl = null;
			amend = false;
		}
		if (running) {
			load();
			loadBranches();
		}
	});
</script>

<div class="git-root">
	{#if !running}
		<p class="git-note">Start the sandbox to work with git.</p>
	{:else if view === 'diff'}
		<div class="git-head">
			<button
				type="button"
				class="git-icon-btn"
				aria-label="Back to changes"
				onclick={() => (view = 'list')}
			>
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
			{#if changes?.isRepo}
				<Menu placement="bottom-start" bind:open={branchMenuOpen}>
					{#snippet trigger(props, open)}
						<button
							type="button"
							class="git-branch-btn"
							class:git-branch-btn--open={open}
							aria-label="Switch branch"
							{...props}
						>
							<GitBranch class="h-3 w-3" />
							<span class="git-branch-name">{branch ?? 'no branch'}</span>
							{#if current && current.ahead > 0}
								<span class="git-track"><ArrowUp class="h-2.5 w-2.5" />{current.ahead}</span>
							{/if}
							{#if current && current.behind > 0}
								<span class="git-track"><ArrowDown class="h-2.5 w-2.5" />{current.behind}</span>
							{/if}
							<ChevronDown class="h-3 w-3 git-branch-caret" />
						</button>
					{/snippet}
					<div class="git-bmenu">
						<div class="git-bmenu-group">Local</div>
						{#each branches?.local ?? [] as b (b.name)}
							<div class="git-bmenu-row">
								<button type="button" class="git-bmenu-pick" onclick={() => checkout(b.name)}>
									<span class="git-bmenu-check">
										{#if b.name === branches?.current}<Check class="h-3 w-3" />{/if}
									</span>
									<span class="git-bmenu-name">{b.name}</span>
									{#if b.ahead > 0}
										<span class="git-track"><ArrowUp class="h-2.5 w-2.5" />{b.ahead}</span>
									{/if}
									{#if b.behind > 0}
										<span class="git-track"><ArrowDown class="h-2.5 w-2.5" />{b.behind}</span>
									{/if}
								</button>
								<button
									type="button"
									class="git-bmenu-del"
									aria-label={`Delete branch ${b.name}`}
									disabled={b.name === branches?.current}
									onclick={() => askDelete(b.name, false)}
								>
									<X class="h-3 w-3" />
								</button>
							</div>
						{/each}
						{#if (branches?.remote ?? []).length > 0}
							<div class="git-bmenu-group">Remote</div>
							{#each branches?.remote ?? [] as ref (ref)}
								<div class="git-bmenu-row">
									<button type="button" class="git-bmenu-pick" onclick={() => checkoutRemote(ref)}>
										<span class="git-bmenu-check"></span>
										<span class="git-bmenu-name">{ref}</span>
									</button>
									<button
										type="button"
										class="git-bmenu-del"
										aria-label={`Delete remote branch ${ref}`}
										onclick={() => askDelete(ref, true)}
									>
										<X class="h-3 w-3" />
									</button>
								</div>
							{/each}
						{/if}
						<div class="git-bmenu-sep"></div>
						<MenuItem onclick={() => (newBranchOpen = true)}>
							<Plus class="h-3 w-3" />
							<span class="git-bmenu-name">New branch</span>
						</MenuItem>
					</div>
				</Menu>
			{:else}
				<span class="git-branch-btn git-branch-btn--static">
					{changes && !changes.isRepo ? 'Not a git repository' : 'Working tree'}
				</span>
			{/if}
			<button
				type="button"
				class="git-icon-btn"
				aria-label="Refresh changes"
				disabled={loading}
				onclick={() => {
					load();
					loadBranches();
				}}
			>
				<RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
			</button>
		</div>

		{#if changes?.isRepo}
			<div class="git-toolbar">
				<button
					type="button"
					class="git-tool"
					disabled={busy !== null}
					onclick={() => runAction('fetch', () => ideGitFetch(sandboxId, repo ?? ''))}
				>
					<Download class={busy === 'fetch' ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} /> Fetch
				</button>
				<button
					type="button"
					class="git-tool"
					disabled={busy !== null}
					onclick={() => runAction('pull', () => ideGitPull(sandboxId, repo ?? ''))}
				>
					<ArrowDown class={busy === 'pull' ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} /> Pull
				</button>
				<button
					type="button"
					class="git-tool"
					title="Pull with rebase"
					disabled={busy !== null}
					onclick={() => runAction('rebase', () => ideGitPull(sandboxId, repo ?? '', true))}
				>
					<ArrowDown class={busy === 'rebase' ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} /> Rebase
				</button>
				<button
					type="button"
					class="git-tool"
					disabled={busy !== null}
					onclick={() => runAction('push', () => ideGitPush(sandboxId, repo ?? ''))}
				>
					<Upload class={busy === 'push' ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} /> Push
				</button>
				<Menu placement="bottom-end">
					{#snippet trigger(props, open)}
						<button
							type="button"
							class="git-tool git-tool--more"
							class:git-tool--open={open}
							aria-label="More git actions"
							{...props}
						>
							<MoreHorizontal class="h-3.5 w-3.5" />
						</button>
					{/snippet}
					<MenuItem onclick={() => (forcePushOpen = true)} danger>
						<Upload class="h-3 w-3" />
						<span class="git-bmenu-name">Force push with lease</span>
					</MenuItem>
					<MenuItem onclick={() => (prOpen = true)}>
						<GitPullRequest class="h-3 w-3" />
						<span class="git-bmenu-name">Open pull request</span>
					</MenuItem>
				</Menu>
			</div>

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
				{#if files.length > 0}
					<button
						type="button"
						class="git-icon-btn"
						aria-label="View all changes"
						onclick={() => openDiff(null)}
					>
						<FileDiff class="h-3.5 w-3.5" />
					</button>
				{/if}
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
							<button
								type="button"
								class="git-file"
								title={file.path}
								onclick={() => openDiff(file.path)}
							>
								<span class="git-status git-status--{ideStatusKind(file.status)}"
									>{file.status}</span
								>
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
			<a
				class="git-out git-out--link"
				href={prUrl}
				target="_blank"
				rel="noreferrer"
				transition:slide
			>
				<GitPullRequest class="h-3 w-3" /> Pull request opened
			</a>
		{/if}

		{#if result}
			<div class="git-result" class:git-result--error={!result.ok} transition:slide>
				<pre class="git-result-out">{result.output ||
						(result.ok ? 'Done' : 'That git command failed')}</pre>
				{#if result.ok && result.kind === 'commit'}
					<button
						type="button"
						class="git-result-action"
						disabled={busy !== null}
						onclick={uncommit}
					>
						<Undo2 class="h-3 w-3" /> Uncommit
					</button>
				{/if}
				{#if !result.ok && failedDelete}
					<button
						type="button"
						class="git-result-action"
						disabled={busy !== null}
						onclick={() => deleteBranch(true)}
					>
						Force delete
					</button>
				{/if}
			</div>
		{/if}

		{#if changes?.isRepo}
			<div class="git-commit">
				<textarea
					class="git-commit-input"
					rows="2"
					placeholder={amend ? 'Leave empty to keep the previous message' : 'Commit message'}
					aria-label="Commit message"
					bind:value={message}
					onkeydown={onCommitKey}
				></textarea>
				<div class="git-opts">
					<label class="git-opt">
						<input type="checkbox" class="git-check" bind:checked={amend} />
						Amend
					</label>
					<label class="git-opt">
						<input type="checkbox" class="git-check" bind:checked={signoff} />
						Sign off
					</label>
					<label class="git-opt">
						<input type="checkbox" class="git-check" bind:checked={trackedOnly} />
						Tracked only
					</label>
				</div>
				<div class="git-commit-foot">
					<span class="git-hint">
						{#if trackedOnly}
							Stages tracked files
						{:else if selectedFiles.length > 0}
							Commits {selectedFiles.length} selected
						{:else}
							Commits everything
						{/if}
					</span>
					<Button
						size="sm"
						variant="primary"
						disabled={!canCommit}
						loading={busy === 'commit'}
						onclick={commit}
					>
						{commitLabel}
					</Button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<Modal bind:open={newBranchOpen} title="New branch" size="sm">
	<div class="git-pr-form">
		<input
			class="git-pr-input"
			type="text"
			placeholder="Branch name"
			aria-label="Branch name"
			bind:value={newBranchName}
		/>
		<p class="git-pr-hint">Branches from {branch ?? 'the current branch'}.</p>
	</div>
	{#snippet footer()}
		<Button size="sm" variant="ghost" onclick={() => (newBranchOpen = false)}>Cancel</Button>
		<Button size="sm" variant="primary" disabled={!newBranchName.trim()} onclick={createBranch}>
			Create and switch
		</Button>
	{/snippet}
</Modal>

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

<ConfirmModal
	bind:open={deleteOpen}
	title="Delete branch?"
	description={`This deletes ${deleteTarget?.remote ? 'the remote branch' : 'the local branch'} ${deleteTarget?.branch ?? ''}.`}
	confirmLabel="Delete"
	onconfirm={() => deleteBranch(false)}
	oncancel={() => (deleteTarget = null)}
/>

<ConfirmModal
	bind:open={forcePushOpen}
	title="Force push with lease?"
	description="This overwrites the remote branch with your local history. It fails safely if someone else pushed since your last fetch."
	confirmLabel="Force push"
	onconfirm={() => runAction('push', () => ideGitPush(sandboxId, repo ?? '', true))}
	oncancel={() => {}}
/>

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
		gap: 0.25rem;
		flex-shrink: 0;
		height: 2rem;
		padding: 0 0.375rem 0 0.5rem;
		border-bottom: 1px solid var(--border-default);
	}

	.git-branch-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		min-width: 0;
		height: 1.5rem;
		padding: 0 0.375rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-default);
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.git-branch-btn:hover,
	.git-branch-btn--open {
		background: var(--bg-hover);
	}

	.git-branch-btn--static {
		cursor: default;
		color: var(--text-faint);
	}

	.git-branch-name {
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.git-branch-caret {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.git-track {
		display: inline-flex;
		align-items: center;
		gap: 0.0625rem;
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
	}

	.git-bmenu {
		display: flex;
		flex-direction: column;
		min-width: 15rem;
		max-height: 20rem;
		overflow-y: auto;
	}

	.git-bmenu-group {
		padding: 0.375rem 0.625rem 0.1875rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-faint);
	}

	.git-bmenu-row {
		display: flex;
		align-items: center;
		min-width: 0;
		border-radius: var(--radius-xs);
	}

	.git-bmenu-row:hover {
		background: var(--bg-hover);
	}

	.git-bmenu-pick {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		min-width: 0;
		padding: 0.3125rem 0.25rem 0.3125rem 0.375rem;
		border: none;
		background: none;
		text-align: left;
		cursor: pointer;
	}

	.git-bmenu-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 0.875rem;
		flex-shrink: 0;
		color: var(--accent);
	}

	.git-bmenu-name {
		flex: 1;
		min-width: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.git-bmenu-del {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.375rem;
		height: 1.375rem;
		flex-shrink: 0;
		margin-right: 0.25rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity var(--dur-fast),
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.git-bmenu-row:hover .git-bmenu-del {
		opacity: 1;
	}

	.git-bmenu-del:hover:not(:disabled) {
		background: var(--status-error-bg);
		color: var(--status-error);
	}

	.git-bmenu-del:disabled {
		cursor: default;
		opacity: 0;
	}

	.git-bmenu-sep {
		height: 1px;
		margin: 0.25rem 0;
		background: var(--border-default);
	}

	.git-toolbar {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
		height: 1.875rem;
		padding: 0 0.375rem 0 0.5rem;
		border-bottom: 1px solid var(--border-default);
	}

	.git-tool {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.375rem;
		padding: 0 0.3125rem;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.git-tool:hover:not(:disabled),
	.git-tool--open {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.git-tool:disabled {
		cursor: default;
		color: var(--text-faint);
	}

	.git-tool--more {
		margin-left: auto;
		padding: 0 0.1875rem;
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
		min-height: 1.875rem;
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

	.git-out--link {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		border-color: var(--status-success-border);
		background: var(--status-success-bg);
		color: var(--status-success);
		text-decoration: none;
	}

	.git-result {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		flex-shrink: 0;
		margin: 0.5rem 0.75rem 0;
		padding: 0.375rem 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
	}

	.git-result--error {
		border-color: var(--status-error-border);
		background: var(--status-error-bg);
	}

	.git-result-out {
		flex: 1;
		min-width: 0;
		max-height: 6rem;
		margin: 0;
		overflow: auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: 1.5;
		color: var(--text-muted);
		white-space: pre-wrap;
	}

	.git-result--error .git-result-out {
		color: var(--status-error);
	}

	.git-result-action {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
		height: 1.375rem;
		padding: 0 0.375rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xs);
		background: var(--bg-raised);
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.git-result-action:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.git-result-action:disabled {
		cursor: default;
		color: var(--text-faint);
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

	.git-opts {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.git-opt {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		cursor: pointer;
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

	.git-pr-hint {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.git-pr-error {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--status-error);
	}
</style>
