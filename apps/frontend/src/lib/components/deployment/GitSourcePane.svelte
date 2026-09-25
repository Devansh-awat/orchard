<script lang="ts">
	import { Loader2, GitBranch, Lock, Search } from 'lucide-svelte';
	import { Field, Input, Select } from '$lib/components/ui';
	import {
		detectGitRepo,
		fetchGitBranches,
		fetchGitConnections,
		fetchGitRepos,
		providerLabel,
		repoPathOn,
		type GitBranch as Branch,
		type GitConnection,
		type GitRepo
	} from '$lib/components/user-settings/git-connections';

	let {
		onSelect,
		onDetect
	}: {
		onSelect: (
			sel: {
				connectionId: string;
				repoUrl: string;
				repoPath: string;
				branch: string;
				externalRepoId: string | null;
			} | null
		) => void;
		onDetect: (det: Record<string, unknown>) => void;
	} = $props();

	let connections = $state<GitConnection[]>([]);
	let loaded = $state(false);
	let connectionId = $state('');
	let repos = $state<GitRepo[]>([]);
	let loadingRepos = $state(false);
	let repoQuery = $state('');
	let repoUrl = $state('');
	let selectedRepo = $state<GitRepo | null>(null);
	let branches = $state<Branch[]>([]);
	let loadingBranches = $state(false);
	let branch = $state('');
	let detecting = $state(false);
	let detectRun = 0;

	const connection = $derived(connections.find((c) => c.id === connectionId) ?? null);
	const filteredRepos = $derived(
		repoQuery.trim()
			? repos.filter((r) => r.fullName.toLowerCase().includes(repoQuery.trim().toLowerCase()))
			: repos
	);
	const repoPath = $derived(
		connection ? (selectedRepo ? selectedRepo.fullName : repoPathOn(connection, repoUrl)) : null
	);

	$effect(() => {
		fetchGitConnections()
			.then((list) => {
				connections = list;
				if (!connectionId && list[0]) pickConnection(list[0].id);
			})
			.catch(() => {
				connections = [];
			})
			.finally(() => {
				loaded = true;
			});
	});

	async function pickConnection(id: string) {
		connectionId = id;
		selectedRepo = null;
		repos = [];
		branches = [];
		branch = '';
		repoUrl = '';
		repoQuery = '';
		onSelect(null);
		const c = connections.find((x) => x.id === id);
		if (!c?.canList) return;
		loadingRepos = true;
		try {
			repos = await fetchGitRepos(id);
		} catch {
			repos = [];
		} finally {
			loadingRepos = false;
		}
	}

	async function pickRepo(r: GitRepo) {
		selectedRepo = r;
		repoUrl = r.url;
		repoQuery = r.fullName;
		await loadBranches(r.fullName, r.defaultBranch);
	}

	async function loadBranches(path: string, preferred: string | null) {
		if (!connection) return;
		loadingBranches = true;
		branches = [];
		try {
			branches = connection.canList ? await fetchGitBranches(connection.id, path) : [];
		} catch {
			branches = [];
		} finally {
			loadingBranches = false;
		}
		const pick =
			(preferred && branches.find((b) => b.name === preferred)?.name) ||
			branches.find((b) => b.name === 'main' || b.name === 'master')?.name ||
			branches[0]?.name ||
			preferred ||
			'main';
		setBranch(pick);
	}

	function setBranch(name: string) {
		branch = name;
		emit();
		detect();
	}

	function emit() {
		if (!connection || !repoPath || !branch) {
			onSelect(null);
			return;
		}
		onSelect({
			connectionId: connection.id,
			repoUrl: selectedRepo?.url ?? repoUrl.trim().replace(/\.git$/, ''),
			repoPath,
			branch,
			externalRepoId: selectedRepo?.id ?? null
		});
	}

	async function detect() {
		if (!connection?.canList || !repoPath || !branch) return;
		const run = ++detectRun;
		detecting = true;
		try {
			const det = await detectGitRepo(connection.id, repoPath, branch);
			if (run === detectRun) onDetect(det);
		} catch {
			/* detection is a convenience */
		} finally {
			if (run === detectRun) detecting = false;
		}
	}

	let urlTimer: ReturnType<typeof setTimeout> | null = null;
	function onUrlInput() {
		selectedRepo = null;
		if (urlTimer) clearTimeout(urlTimer);
		urlTimer = setTimeout(() => {
			if (connection && repoPathOn(connection, repoUrl)) {
				loadBranches(repoPathOn(connection, repoUrl)!, null);
			} else {
				onSelect(null);
			}
		}, 400);
	}
</script>

{#if !loaded}
	<div class="gs-empty"><Loader2 class="h-4 w-4 animate-spin" data-motion="progress" /></div>
{:else if connections.length === 0}
	<div class="nd-warning">
		<p class="nd-warning-title">No git providers linked</p>
		<p class="nd-warning-desc">
			Link GitLab, Gitea, Codeberg, Bitbucket or any git host with your own token under
			<a href="/user/settings?section=git">your settings</a>. GitHub works from the GitHub tab.
		</p>
	</div>
{:else}
	<Field label="Provider">
		<Select value={connectionId} onchange={(e) => pickConnection(e.currentTarget.value)}>
			{#each connections as c (c.id)}
				<option value={c.id}>{c.name} · {providerLabel(c.provider)}</option>
			{/each}
		</Select>
	</Field>

	{#if connection?.canList}
		<Field label="Repository">
			<div class="gs-search">
				<Search size={14} class="gs-search-icon" />
				<input
					class="gs-search-input"
					bind:value={repoQuery}
					placeholder={loadingRepos ? 'Loading repositories' : 'Search or paste a URL'}
					oninput={() => {
						if (/^https?:\/\//.test(repoQuery)) {
							repoUrl = repoQuery;
							onUrlInput();
						}
					}}
				/>
				{#if loadingRepos}<Loader2 class="h-4 w-4 animate-spin" data-motion="progress" />{/if}
			</div>
			{#if !selectedRepo && filteredRepos.length > 0 && !/^https?:\/\//.test(repoQuery)}
				<ul class="gs-repos">
					{#each filteredRepos.slice(0, 8) as r (r.id)}
						<li>
							<button type="button" class="gs-repo" onclick={() => pickRepo(r)}>
								<span class="gs-repo-name">{r.fullName}</span>
								{#if r.private}<Lock size={12} class="gs-repo-lock" />{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</Field>
	{:else}
		<Field label="Repository URL" hint="On {connection?.host}">
			<Input
				bind:value={repoUrl}
				placeholder="https://{connection?.host}/team/app"
				class="font-mono"
				oninput={onUrlInput}
			/>
		</Field>
	{/if}

	{#if repoPath}
		<Field label="Branch">
			<div class="gs-branch">
				<GitBranch size={14} class="gs-branch-icon" />
				{#if branches.length > 0}
					<Select value={branch} onchange={(e) => setBranch(e.currentTarget.value)}>
						{#each branches as b (b.name)}
							<option value={b.name}>{b.name}</option>
						{/each}
					</Select>
				{:else}
					<Input
						value={branch}
						oninput={(e) => setBranch(e.currentTarget.value)}
						placeholder="main"
						class="font-mono"
					/>
				{/if}
				{#if loadingBranches || detecting}
					<Loader2 class="h-4 w-4 animate-spin" data-motion="progress" />
				{/if}
			</div>
		</Field>
	{/if}
{/if}

<style>
	.gs-empty {
		display: flex;
		align-items: center;
		color: var(--text-faint);
		padding: var(--space-2) 0;
	}
	.gs-search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.625rem;
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		box-shadow: inset 0 0 0 1px var(--rule);
		color: var(--text-faint);
	}
	.gs-search-input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0;
		border: 0;
		background: none;
		outline: none;
		font-size: var(--text-callout);
		color: var(--text-default);
	}
	.gs-repos {
		list-style: none;
		margin: 0.375rem 0 0;
		padding: 0.25rem;
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		box-shadow: var(--elev-1);
		max-height: 16rem;
		overflow: auto;
	}
	.gs-repo {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		text-align: left;
		cursor: pointer;
		color: var(--text-default);
		font-size: var(--text-callout);
	}
	.gs-repo:hover {
		background: var(--fill-quiet);
	}
	.gs-repo-name {
		flex: 1;
		font-family: var(--font-mono);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.gs-branch {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-faint);
	}
	.gs-branch > :global(.ui-select-wrap),
	.gs-branch > :global(.ui-input) {
		flex: 1;
	}
</style>
