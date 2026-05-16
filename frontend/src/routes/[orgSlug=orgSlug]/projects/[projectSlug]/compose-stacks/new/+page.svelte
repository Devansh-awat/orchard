<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		apiFetch,
		toasts,
		refreshTree,
		fetchProjectContext,
		buildBasePath,
		type ProjectContext,
	} from '$lib/stores';
	import { Loader2, FileText, Github } from 'lucide-svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';

	interface Repository {
		id: number;
		full_name: string;
		clone_url: string;
		default_branch: string;
		private: boolean;
	}
	interface Branch {
		name: string;
		protected: boolean;
	}

	let project = $state<ProjectContext | null>(null);
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let formError = $state<string | null>(null);

	let githubLinked = $state(false);
	let hasGitHubApp = $state(false);
	let githubAppInstallUrl = $state<string | null>(null);
	let repositories = $state<Repository[]>([]);
	let branches = $state<Branch[]>([]);
	let loadingRepos = $state(false);
	let loadingBranches = $state(false);

	let selectedRepo = $state<Repository | null>(null);
	let selectedBranch = $state<Branch | null>(null);
	let repoSearch = $state('');
	let branchSearch = $state('');
	let showRepoDropdown = $state(false);
	let showBranchDropdown = $state(false);

	let name = $state('');
	let composePath = $state('docker-compose.yml');
	let autoDeployEnabled = $state(true);

	const projectSlug = $derived($page.params.projectSlug ?? '');
	const orgSlug = $derived($page.params.orgSlug ?? '');
	const wsSlug = $derived($page.params.wsSlug);
	const basePath = $derived(buildBasePath({ orgSlug, projectSlug, wsSlug }));

	async function fetchProjectData() {
		loading = true;
		error = null;
		try {
			project = await fetchProjectContext({ orgSlug, projectSlug, wsSlug });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load project';
		} finally {
			loading = false;
		}
	}

	async function checkGitHubStatus() {
		try {
			const response = await apiFetch('/apiv1/github/status');
			if (response.ok) {
				const status = await response.json();
				githubLinked = status.linked;
				hasGitHubApp = (status.installations?.length ?? 0) > 0;
				if (status.linked) fetchRepositories();
			}
			const installRes = await apiFetch('/apiv1/github/app/install');
			if (installRes.ok) {
				const data = await installRes.json();
				githubAppInstallUrl = data.url;
			}
		} catch (e) {
			console.error('Failed to check GitHub status:', e);
		}
	}

	async function fetchRepositories() {
		loadingRepos = true;
		try {
			const response = await apiFetch('/apiv1/github/repositories');
			if (response.ok) {
				const data = await response.json();
				repositories = Array.isArray(data) ? data : (data.repositories ?? []);
			}
		} catch (e) {
			console.error('Failed to fetch repositories:', e);
		} finally {
			loadingRepos = false;
		}
	}

	async function fetchBranches(repo: Repository) {
		loadingBranches = true;
		branches = [];
		selectedBranch = null;
		branchSearch = '';
		try {
			const [owner, repoName] = repo.full_name.split('/');
			const response = await apiFetch(`/apiv1/github/repositories/${owner}/${repoName}/branches`);
			if (response.ok) {
				branches = await response.json();
				const defaultBranch = branches.find((b) => b.name === repo.default_branch);
				if (defaultBranch) {
					selectedBranch = defaultBranch;
					branchSearch = defaultBranch.name;
				}
			}
		} catch (e) {
			console.error('Failed to fetch branches:', e);
		} finally {
			loadingBranches = false;
		}
	}

	function selectRepo(repo: Repository) {
		selectedRepo = repo;
		repoSearch = repo.full_name;
		showRepoDropdown = false;
		if (!name) name = repo.full_name.split('/')[1] ?? '';
		fetchBranches(repo);
	}

	function clearRepoSelection() {
		selectedRepo = null;
		repoSearch = '';
		branches = [];
		selectedBranch = null;
	}

	function selectBranch(b: Branch) {
		selectedBranch = b;
		branchSearch = b.name;
		showBranchDropdown = false;
	}

	function clearBranchSelection() {
		selectedBranch = null;
		branchSearch = '';
	}

	function handleClickOutside(event: MouseEvent, type: 'repo' | 'branch') {
		const target = event.target as HTMLElement;
		if (type === 'repo' && !target.closest('[data-repo-dropdown]')) showRepoDropdown = false;
		if (type === 'branch' && !target.closest('[data-branch-dropdown]')) showBranchDropdown = false;
	}

	onMount(() => {
		fetchProjectData();
		checkGitHubStatus();
		const onClick = (e: MouseEvent) => {
			handleClickOutside(e, 'repo');
			handleClickOutside(e, 'branch');
		};
		document.addEventListener('click', onClick);
		return () => document.removeEventListener('click', onClick);
	});

	async function handleSubmit() {
		formError = null;
		if (!project?.id) {
			formError = 'Project not loaded';
			return;
		}
		if (!name.trim()) {
			formError = 'Stack name is required';
			return;
		}
		if (!selectedRepo) {
			formError = 'Pick a repository';
			return;
		}
		const branch = selectedBranch?.name || branchSearch.trim();
		if (!branch) {
			formError = 'Pick a branch';
			return;
		}

		submitting = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/compose-stacks/from-github`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					repoUrl: selectedRepo.clone_url,
					branch,
					composePath: composePath.trim() || 'docker-compose.yml',
					autoDeployEnabled,
				}),
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create compose stack');
			}

			const stack = await response.json();
			toasts.add({
				title: 'Compose stack created',
				description: 'Services are deploying — builds run in the background',
				color: 'success',
			});
			refreshTree();
			goto(`/${orgSlug}/compose-stacks/${stack.id}`);
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Failed to create compose stack';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="cs-page">
	{#if loading}
		<div class="cs-loader"><Loader2 class="h-5 w-5 animate-spin" /> Loading project…</div>
	{:else if error}
		<div class="cs-warning">
			<p class="cs-warning-title">Could not load project</p>
			<p class="cs-warning-desc">{error}</p>
		</div>
	{:else if project}
		<div class="cs-hero">
			<h1 class="cs-page-title">Deploy Compose from GitHub</h1>
			<p class="cs-page-subtitle">
				Point Orchard at a <code>docker-compose.yml</code> in a repo. Services with
				<code>build:</code> are built into images automatically; services with <code>image:</code>
				are pulled as-is.
			</p>
		</div>

		<div class="cs-main-card">
			<div class="cs-source-row">
				<span class="cs-source-label"><Github class="h-3.5 w-3.5" /> GitHub source</span>
			</div>

			<div class="cs-owner-row">
				<ProjectSwitcher
					currentProjectName={project?.name || projectSlug}
					pathSuffix={`/compose-stacks/new`}
				/>
				<span class="cs-slash">/</span>
				<input type="text" bind:value={name} placeholder="my-stack" class="cs-name-input" />
			</div>

			<div class="cs-card-body">
				{#if !githubLinked}
					<div class="cs-warning">
						<p class="cs-warning-title">Sign in with GitHub to continue</p>
						<p class="cs-warning-desc">Required to read your repos and clone the compose file.</p>
						<div style="display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap;">
							<a href="/user/settings" class="cs-btn cs-btn-primary">Sign in with GitHub</a>
							{#if githubAppInstallUrl}
								<a href={githubAppInstallUrl} target="_blank" class="cs-btn cs-btn-secondary">
									Install GitHub App
								</a>
							{/if}
						</div>
					</div>
				{:else}
					<div class="cs-field" data-repo-dropdown>
						<label class="cs-label" for="cs-repo-input">Repository</label>
						<div class="cs-relative">
							<input
								id="cs-repo-input"
								type="text"
								bind:value={repoSearch}
								oninput={() => {
									showRepoDropdown = repoSearch.length > 0 && repositories.length > 0;
									if (selectedRepo) selectedRepo = null;
								}}
								onfocus={() => {
									if (!selectedRepo) showRepoDropdown = repositories.length > 0;
								}}
								placeholder="owner/repo"
								class="cs-input"
								readonly={selectedRepo !== null}
								style={selectedRepo ? 'opacity: 0.7;' : ''}
							/>
							{#if loadingRepos || loadingBranches}
								<div class="cs-input-suffix"><Loader2 class="h-4 w-4 animate-spin" /></div>
							{:else if selectedRepo}
								<button onclick={clearRepoSelection} class="cs-input-suffix cs-input-clear" type="button">
									✕
								</button>
							{/if}
						</div>
						{#if showRepoDropdown && repoSearch && !loadingRepos && !selectedRepo}
							<div class="cs-dropdown">
								{#each repositories.filter((r) => r.full_name.toLowerCase().includes(repoSearch.toLowerCase())) as repo}
									<button
										type="button"
										onclick={() => selectRepo(repo)}
										class="cs-dropdown-item"
									>
										<Github class="h-4 w-4" />
										<span class="cs-truncate">{repo.full_name}</span>
										{#if repo.private}<span class="cs-badge">Private</span>{/if}
									</button>
								{/each}
							</div>
						{/if}
					</div>

					{#if selectedRepo}
						<div class="cs-field" data-branch-dropdown>
							<label class="cs-label" for="cs-branch-input">Branch</label>
							<div class="cs-relative">
								<input
									id="cs-branch-input"
									type="text"
									bind:value={branchSearch}
									oninput={() => {
										showBranchDropdown = branchSearch.length > 0 && branches.length > 0;
										if (selectedBranch) selectedBranch = null;
									}}
									onfocus={() => {
										if (!selectedBranch) showBranchDropdown = branches.length > 0;
									}}
									placeholder="main"
									class="cs-input"
									disabled={loadingBranches}
									readonly={selectedBranch !== null}
									style={selectedBranch ? 'opacity: 0.7;' : ''}
								/>
								{#if selectedBranch}
									<button onclick={clearBranchSelection} class="cs-input-suffix cs-input-clear" type="button">
										✕
									</button>
								{/if}
							</div>
							{#if showBranchDropdown && branchSearch && !loadingBranches && !selectedBranch}
								<div class="cs-dropdown">
									{#each branches.filter((b) => b.name.toLowerCase().includes(branchSearch.toLowerCase())) as b}
										<button type="button" onclick={() => selectBranch(b)} class="cs-dropdown-item">
											<span class="cs-truncate">{b.name}</span>
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{/if}

					<div class="cs-field">
						<label class="cs-label" for="cs-compose-path">Path to docker-compose.yml</label>
						<input
							id="cs-compose-path"
							type="text"
							bind:value={composePath}
							placeholder="docker-compose.yml"
							class="cs-input cs-mono"
						/>
						<p class="cs-hint">Relative to the repo root. Default: <code>docker-compose.yml</code>.</p>
					</div>

					<label class="cs-toggle">
						<input type="checkbox" bind:checked={autoDeployEnabled} />
						<span class="cs-toggle-label">
							<span class="cs-toggle-title">Auto-deploy on push</span>
							<span class="cs-toggle-desc">
								Rebuild every <code>build:</code> service when a commit lands on this branch.
							</span>
						</span>
					</label>
				{/if}

				{#if formError}
					<div class="cs-warning">
						<p class="cs-warning-desc">{formError}</p>
					</div>
				{/if}

				<div class="cs-actions">
					<button type="button" class="cs-btn cs-btn-secondary" onclick={() => history.back()} disabled={submitting}>
						Cancel
					</button>
					<button
						type="button"
						class="cs-btn cs-btn-primary"
						onclick={handleSubmit}
						disabled={submitting || !githubLinked || !selectedRepo}
					>
						{#if submitting}
							<Loader2 class="h-3.5 w-3.5 animate-spin" /> Deploying…
						{:else}
							<FileText class="h-3.5 w-3.5" /> Deploy stack
						{/if}
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.cs-page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1.5rem 2.5rem 3rem;
	}

	.cs-hero {
		padding: 2rem 0 1.75rem;
	}

	.cs-page-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.025em;
		background: linear-gradient(135deg, var(--sidebar-text-active-border), color-mix(in srgb, var(--sidebar-text-active-border) 60%, #0db7ed));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.cs-page-subtitle {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0.5rem 0 0;
		line-height: 1.5;
	}

	.cs-page-subtitle code,
	.cs-hint code,
	.cs-toggle-desc code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.6875rem;
		padding: 0.0625rem 0.25rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.cs-main-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		display: flex;
		flex-direction: column;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.04), 0 1px 2px rgb(0 0 0 / 0.02);
	}

	.cs-source-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.875rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.cs-source-label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.cs-owner-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1.25rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.cs-slash {
		font-size: 1.25rem;
		font-weight: 300;
		color: var(--surface-muted);
		user-select: none;
	}

	.cs-name-input {
		flex: 1;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.cs-name-input:focus,
	.cs-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}

	.cs-card-body {
		padding: 1.25rem 1.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.cs-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		position: relative;
	}

	.cs-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.cs-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}

	.cs-mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	.cs-relative {
		position: relative;
	}

	.cs-input-suffix {
		position: absolute;
		right: 0.5rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		color: var(--surface-muted);
	}

	.cs-input-clear {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.875rem;
	}

	.cs-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		margin-top: 0.25rem;
		max-height: 16rem;
		overflow-y: auto;
		background-color: var(--center-channel-bg);
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
		z-index: 10;
		display: flex;
		flex-direction: column;
	}

	.cs-dropdown-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: none;
		border: none;
		color: var(--center-channel-color);
		text-align: left;
		cursor: pointer;
		font-size: 0.8125rem;
	}

	.cs-dropdown-item:hover {
		background-color: color-mix(in srgb, var(--surface-border) 35%, transparent);
	}

	.cs-truncate {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}

	.cs-badge {
		font-size: 0.625rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--surface-muted);
	}

	.cs-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.cs-toggle {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background-color: color-mix(in srgb, var(--surface-border) 12%, transparent);
		cursor: pointer;
	}

	.cs-toggle input {
		margin-top: 0.1875rem;
	}

	.cs-toggle-label {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.cs-toggle-title {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.cs-toggle-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		line-height: 1.45;
	}

	.cs-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.cs-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
		text-decoration: none;
		transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
	}

	.cs-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.cs-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: white;
	}

	.cs-btn-primary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 85%, black);
	}

	.cs-btn-secondary {
		border-color: var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
	}

	.cs-btn-secondary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}

	.cs-warning {
		padding: 0.75rem 0.875rem;
		border-radius: 0.5rem;
		border: 1px solid color-mix(in srgb, #ef4444 30%, var(--surface-border));
		background-color: color-mix(in srgb, #ef4444 5%, var(--surface-bg));
	}

	.cs-warning-title {
		font-size: 0.8125rem;
		font-weight: 600;
		margin: 0 0 0.25rem;
		color: var(--center-channel-color);
	}

	.cs-warning-desc {
		font-size: 0.75rem;
		margin: 0;
		color: var(--surface-muted);
	}

	.cs-loader {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 4rem 0;
		justify-content: center;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}
</style>
