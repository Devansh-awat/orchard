<script lang="ts">
	import { Github, Loader2, Plus, RefreshCw } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, Input, Skeleton } from '$lib/components/ui';
	import { slide } from '$lib/utils/transitions';
	import type { SandboxRepo } from '$lib/types/sandbox';

	interface Repository {
		id: number;
		full_name: string;
		private: boolean;
	}

	let {
		sandboxId,
		running,
		booting = false,
		repos,
		loading = false,
		loaded = false,
		selectedRepo = null,
		onselect,
		onrefresh
	}: {
		sandboxId: string;
		running: boolean;
		booting?: boolean;
		repos: SandboxRepo[];
		loading?: boolean;
		loaded?: boolean;
		selectedRepo?: string | null;
		onselect: (name: string) => void;
		onrefresh: () => void;
	} = $props();

	let addOpen = $state(false);
	let repoUrl = $state('');
	let adding = $state(false);

	let repositories = $state<Repository[]>([]);
	let loadingRepos = $state(false);
	let reposError = $state<string | null>(null);
	let reposFetched = false;
	let pickerOpen = $state(false);

	async function fetchRepositories() {
		if (reposFetched || loadingRepos) return;
		loadingRepos = true;
		reposError = null;
		try {
			const res = await apiFetch('/apiv1/github/repositories');
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				reposError = body?.message || 'Could not load your repositories.';
				return;
			}
			const data = await res.json();
			repositories = Array.isArray(data) ? data : (data.repositories ?? []);
			reposFetched = true;
		} catch {
			reposError = 'Could not load your repositories.';
		} finally {
			loadingRepos = false;
		}
	}

	const repoFilter = $derived(repoUrl.trim().toLowerCase());
	const filteredRepos = $derived(
		repositories
			.filter((r) => !repoFilter || r.full_name.toLowerCase().includes(repoFilter))
			.slice(0, 6)
	);

	function pickRepo(repo: Repository) {
		repoUrl = `https://github.com/${repo.full_name}`;
		pickerOpen = false;
	}

	function onRepoFocus() {
		pickerOpen = true;
		fetchRepositories();
	}

	async function addRepo() {
		const url = repoUrl.trim();
		if (!url || adding) return;
		adding = true;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${sandboxId}/repos`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoUrl: url })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data?.message || 'Failed to add repository');
			const name = typeof data?.name === 'string' ? data.name : url;
			toasts.add({ title: `Cloning ${name}`, color: 'success' });
			repoUrl = '';
			addOpen = false;
			pickerOpen = false;
			setTimeout(() => onrefresh(), 4000);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to add repository',
				color: 'error'
			});
		} finally {
			adding = false;
		}
	}
</script>

<div class="rp-root">
	{#if !running}
		{#if booting}
			<div class="rp-skeletons" aria-hidden="true">
				<Skeleton height="0.75rem" width="55%" />
				<Skeleton height="0.75rem" width="72%" />
			</div>
			<p class="rp-note">Repositories load once the sandbox has finished setting up.</p>
		{:else}
			<p class="rp-note">Start the sandbox to manage repositories.</p>
		{/if}
	{:else}
		<div class="rp-head">
			<span class="rp-count">
				{loaded
					? repos.length === 1
						? '1 repository'
						: `${repos.length} repositories`
					: 'Repositories'}
			</span>
			<button
				type="button"
				class="rp-refresh"
				aria-label="Refresh repositories"
				disabled={loading}
				onclick={onrefresh}
			>
				<RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
			</button>
		</div>
		{#if !loaded}
			<div class="rp-skeletons" aria-hidden="true">
				<Skeleton height="0.75rem" width="62%" />
				<Skeleton height="0.75rem" width="48%" />
				<Skeleton height="0.75rem" width="70%" />
			</div>
		{:else if repos.length === 0}
			<p class="rp-note">No repositories yet. Add one to give the agent code to work on.</p>
		{:else}
			<ul class="rp-list">
				{#each repos as repo (repo.name)}
					<li>
						<button
							type="button"
							class="rp-repo"
							class:rp-repo--selected={selectedRepo === repo.name}
							aria-current={selectedRepo === repo.name}
							onclick={() => onselect(repo.name)}
						>
							<span class="rp-name">{repo.name}</span>
							<span class="rp-branch">{repo.branch}</span>
							{#if repo.dirtyFiles > 0}
								<span class="rp-dirty">{repo.dirtyFiles}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		{#if addOpen}
			<div class="rp-add" transition:slide>
				<Input
					bind:value={repoUrl}
					placeholder="https://github.com/you/repo or search"
					onfocus={onRepoFocus}
					autocomplete="off"
					aria-label="Repository URL"
				/>
				{#if pickerOpen}
					{#if loadingRepos}
						<div class="rp-add-hint">
							<Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading your repositories
						</div>
					{:else if reposError}
						<div class="rp-add-hint">{reposError} You can paste a URL instead.</div>
					{:else if filteredRepos.length > 0}
						<div class="rp-picker" role="listbox" aria-label="Your repositories">
							{#each filteredRepos as repo (repo.id)}
								<button
									type="button"
									class="rp-picker-item"
									role="option"
									aria-selected={repoUrl === `https://github.com/${repo.full_name}`}
									onclick={() => pickRepo(repo)}
								>
									<Github size={12} />
									<span class="rp-picker-name">{repo.full_name}</span>
									{#if repo.private}<span class="rp-picker-private">private</span>{/if}
								</button>
							{/each}
						</div>
					{/if}
				{/if}
				<div class="rp-add-actions">
					<Button size="sm" variant="ghost" onclick={() => (addOpen = false)}>Cancel</Button>
					<Button
						size="sm"
						variant="primary"
						loading={adding}
						disabled={!repoUrl.trim()}
						onclick={addRepo}
					>
						Clone
					</Button>
				</div>
			</div>
		{:else}
			<button type="button" class="rp-add-row" onclick={() => (addOpen = true)}>
				<Plus class="h-3.5 w-3.5" /> Add repository
			</button>
		{/if}
	{/if}
</div>

<style>
	.rp-root {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-height: 0;
	}

	.rp-note {
		margin: 0;
		padding: var(--space-2) var(--space-1);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
	}

	.rp-skeletons {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-1);
	}

	.rp-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		height: 1.75rem;
	}

	.rp-count {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.rp-refresh {
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

	.rp-refresh:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.rp-refresh:disabled {
		cursor: default;
		color: var(--text-faint);
	}

	.rp-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rp-repo {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-width: 0;
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.rp-repo:hover {
		background: var(--bg-hover);
	}

	.rp-repo--selected {
		background: var(--accent-subtle);
	}

	.rp-name {
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
	}

	.rp-branch {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rp-dirty {
		flex-shrink: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--status-warning);
	}

	.rp-add-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		height: 1.75rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		text-align: left;
		cursor: pointer;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast);
	}

	.rp-add-row:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.rp-add {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding-top: 0.25rem;
	}

	.rp-add-hint {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.rp-picker {
		display: flex;
		flex-direction: column;
		max-height: 10rem;
		overflow-y: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
	}

	.rp-picker-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.5rem;
		border: none;
		background: none;
		color: var(--text-default);
		cursor: pointer;
		text-align: left;
		transition: background-color var(--dur-fast);
	}

	.rp-picker-item:hover {
		background: var(--bg-hover);
	}

	.rp-picker-name {
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rp-picker-private {
		margin-left: auto;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-faint);
	}

	.rp-add-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.375rem;
	}
</style>
