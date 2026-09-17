<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		apiFetch,
		toasts,
		fetchProjectContext,
		buildBasePath,
		type ProjectContext
	} from '$lib/stores';
	import { Loader2, FileText, Github, ChevronDown, X } from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import { EnvironmentSwitcher } from '$lib/components/environment';
	import { Button, PopoverPanel, Field, Input, Badge } from '$lib/components/ui';

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
	let reposError = $state<string | null>(null);
	let loadingBranches = $state(false);

	let selectedRepo = $state<Repository | null>(null);
	let selectedBranch = $state<Branch | null>(null);
	let repoSearch = $state('');
	let branchSearch = $state('');
	let branchQuery = $state('');
	let branchPickerOpen = $state(false);

	let name = $state('');
	let composePath = $state('docker-compose.yml');
	let autoDeployEnabled = $state(true);
	// Environment every child deployment lands in. Seeded from ?env= (the env
	// the user was viewing); the switcher falls back to the project default.
	let selectedEnvId = $state($page.url.searchParams.get('env') ?? '');

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
		reposError = null;
		try {
			const response = await apiFetch('/apiv1/github/repositories');
			if (response.ok) {
				const data = await response.json();
				repositories = Array.isArray(data) ? data : (data.repositories ?? []);
			} else {
				const body = await response.json().catch(() => null);
				reposError = body?.message || 'Could not load your repositories.';
			}
		} catch (e) {
			console.error('Failed to fetch repositories:', e);
			reposError = 'Could not load your repositories.';
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
	}

	function clearBranchSelection() {
		selectedBranch = null;
		branchSearch = '';
		branchQuery = '';
	}

	function useCustomBranch(branchName: string) {
		selectedBranch = null;
		branchSearch = branchName;
	}

	const filteredRepos = $derived(
		repositories.filter((r) => r.full_name.toLowerCase().includes(repoSearch.toLowerCase()))
	);
	const filteredBranches = $derived(
		branches.filter((b) => b.name.toLowerCase().includes(branchQuery.toLowerCase()))
	);
	const customBranch = $derived.by(() => {
		const typed = branchQuery.trim();
		if (!typed || branches.some((b) => b.name === typed)) return null;
		return typed;
	});

	$effect(() => {
		if (branchPickerOpen) branchQuery = '';
	});

	onMount(() => {
		fetchProjectData();
		checkGitHubStatus();
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
					...(selectedEnvId ? { environmentId: selectedEnvId } : {})
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create compose stack');
			}

			const stack = await response.json();
			toasts.add({
				title: 'Compose stack created',
				description: 'Services are deploying; builds run in the background',
				color: 'success'
			});
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
		<Breadcrumb
			crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				{ label: project?.name || projectSlug || '', href: basePath },
				{ label: 'New Compose stack' }
			]}
		/>

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
					pathSuffix="/compose-stacks/new"
				/>
				{#if project?.id}
					<EnvironmentSwitcher projectId={project.id} bind:selectedEnvId />
				{/if}
				<span class="cs-slash">/</span>
				<input type="text" bind:value={name} placeholder="my-stack" class="cs-name-input" />
			</div>

			<div class="cs-card-body">
				{#if !githubLinked}
					<div class="cs-warning">
						<p class="cs-warning-title">Sign in with GitHub to continue</p>
						<p class="cs-warning-desc">Required to read your repos and clone the compose file.</p>
						<div style="display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap;">
							<Button variant="primary" size="sm" href="/user/settings">Sign in with GitHub</Button>
							{#if githubAppInstallUrl}
								<Button variant="secondary" size="sm" href={githubAppInstallUrl} target="_blank">
									Install GitHub App
								</Button>
							{/if}
						</div>
					</div>
				{:else}
					<Field label="Repository">
						<PopoverPanel sameWidth>
							{#snippet trigger(attrs, open)}
								<div class="picker-wrap">
									<button type="button" class="picker-trigger" {...attrs}>
										{#if selectedRepo}
											<Github class="h-4 w-4 shrink-0" />
											<span class="picker-value">{selectedRepo.full_name}</span>
										{:else if repoSearch}
											<span class="picker-value">{repoSearch}</span>
										{:else}
											<span class="picker-placeholder">owner/repo</span>
										{/if}
									</button>
									{#if loadingRepos || loadingBranches}
										<span class="picker-suffix"><Loader2 class="h-4 w-4 animate-spin" /></span>
									{:else if selectedRepo}
										<button
											type="button"
											class="picker-suffix picker-clear"
											aria-label="Clear repository"
											onclick={clearRepoSelection}
										>
											<X size={15} />
										</button>
									{:else}
										<span class="picker-suffix picker-chevron" class:picker-chevron--open={open}
											><ChevronDown size={15} /></span
										>
									{/if}
								</div>
							{/snippet}
							{#snippet children({ close })}
								<Input
									bind:value={repoSearch}
									placeholder="owner/repo"
									readonly={selectedRepo !== null}
								/>
								<div class="picker-list">
									{#if loadingRepos}
										<div class="picker-empty">
											<Loader2 class="h-4 w-4 animate-spin" /> Loading repositories
										</div>
									{:else}
										{#each filteredRepos as repo (repo.full_name)}
											<button
												type="button"
												class="picker-option"
												onclick={() => {
													selectRepo(repo);
													close();
												}}
											>
												<Github class="h-4 w-4 shrink-0" />
												<span class="picker-option-text">{repo.full_name}</span>
												{#if repo.private}<Badge tone="neutral">Private</Badge>{/if}
											</button>
										{:else}
											{#if reposError}
												<div class="picker-note">
													{reposError}
													<a href="/user/settings">Connect GitHub</a>
												</div>
											{:else}
												<div class="picker-empty">No matching repositories</div>
											{/if}
										{/each}
									{/if}
								</div>
							{/snippet}
						</PopoverPanel>
					</Field>

					{#if selectedRepo}
						<Field label="Branch">
							<PopoverPanel sameWidth bind:open={branchPickerOpen}>
								{#snippet trigger(attrs, open)}
									<div class="picker-wrap">
										<button
											type="button"
											class="picker-trigger"
											disabled={loadingBranches}
											{...attrs}
										>
											{#if branchSearch}
												<span class="picker-value">{branchSearch}</span>
											{:else}
												<span class="picker-placeholder">main</span>
											{/if}
										</button>
										{#if loadingBranches}
											<span class="picker-suffix"><Loader2 class="h-4 w-4 animate-spin" /></span>
										{:else if selectedBranch}
											<button
												type="button"
												class="picker-suffix picker-clear"
												aria-label="Clear branch"
												onclick={clearBranchSelection}
											>
												<X size={15} />
											</button>
										{:else}
											<span class="picker-suffix picker-chevron" class:picker-chevron--open={open}
												><ChevronDown size={15} /></span
											>
										{/if}
									</div>
								{/snippet}
								{#snippet children({ close })}
									<Input bind:value={branchQuery} placeholder="Search branches" />
									<div class="picker-list">
										{#if customBranch}
											<button
												type="button"
												class="picker-option"
												onclick={() => {
													useCustomBranch(customBranch);
													close();
												}}
											>
												<span class="picker-option-text">Use <strong>{customBranch}</strong></span>
											</button>
										{/if}
										{#each filteredBranches as b (b.name)}
											<button
												type="button"
												class="picker-option"
												onclick={() => {
													selectBranch(b);
													close();
												}}
											>
												<span class="picker-option-text">{b.name}</span>
											</button>
										{:else}
											{#if !customBranch}
												<div class="picker-empty">
													{branches.length
														? 'No matching branches'
														: 'No branches found. Type a name to use anyway.'}
												</div>
											{/if}
										{/each}
									</div>
								{/snippet}
							</PopoverPanel>
						</Field>
					{/if}

					<Field label="Path to docker-compose.yml" for="cs-compose-path">
						<Input
							id="cs-compose-path"
							bind:value={composePath}
							placeholder="docker-compose.yml"
							class="font-mono"
						/>
						<p class="cs-hint">
							Relative to the repo root. Default: <code>docker-compose.yml</code>.
						</p>
					</Field>

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
					<Button variant="secondary" onclick={() => history.back()} disabled={submitting}>
						Cancel
					</Button>
					<Button
						variant="primary"
						onclick={handleSubmit}
						loading={submitting}
						disabled={submitting || !githubLinked || !selectedRepo}
					>
						{#if !submitting}<FileText class="h-3.5 w-3.5" />{/if}
						Deploy stack
					</Button>
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
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.025em;
		background: linear-gradient(
			135deg,
			var(--sidebar-text-active-border),
			color-mix(in srgb, var(--sidebar-text-active-border) 60%, var(--link-color))
		);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.cs-page-subtitle {
		font-size: var(--text-footnote);
		color: var(--surface-muted);
		margin: 0.5rem 0 0;
		line-height: 1.5;
	}

	.cs-page-subtitle code,
	.cs-hint code,
	.cs-toggle-desc code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		padding: 0.0625rem 0.25rem;
		border-radius: var(--radius-xs);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.cs-main-card {
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-lg);
		background-color: var(--surface-bg);
		display: flex;
		flex-direction: column;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.04),
			0 1px 2px rgb(0 0 0 / 0.02);
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
		gap: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
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
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 300;
		color: var(--surface-muted);
		user-select: none;
	}

	.cs-name-input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.cs-name-input:focus {
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

	/* Pickers */
	.picker-wrap {
		position: relative;
	}

	.picker-trigger {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.75rem 2.25rem 0.75rem 0.875rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		font-size: var(--text-callout);
		line-height: 1.5;
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}

	.picker-trigger:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring-color);
		outline-offset: var(--focus-ring-offset);
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
	}

	.picker-trigger:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.picker-value {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.picker-placeholder {
		color: color-mix(in srgb, var(--surface-muted) 65%, transparent);
	}

	.picker-suffix {
		position: absolute;
		right: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		color: var(--surface-muted);
	}

	.picker-clear {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.picker-clear:hover {
		color: var(--center-channel-color);
	}

	.picker-chevron {
		pointer-events: none;
		transition: transform var(--dur-fast) ease;
	}

	.picker-chevron--open {
		transform: translateY(-50%) rotate(180deg);
	}

	.picker-list {
		display: flex;
		flex-direction: column;
		margin-top: 0.5rem;
		max-height: 14rem;
		overflow-y: auto;
	}

	.picker-option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem;
		text-align: left;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		border: none;
		background: none;
		color: var(--center-channel-color);
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.picker-option:hover {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.picker-option-text {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.picker-empty {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
	}

	.picker-note {
		padding: 0.75rem 0.75rem;
		font-size: var(--text-caption);
		line-height: 1.5;
		color: var(--text-muted);
		background-color: var(--status-warning-bg);
		border: 1px solid var(--status-warning-border);
		border-radius: var(--radius-sm);
		margin: 0.25rem;
	}

	.picker-note a {
		color: var(--text-link);
		font-weight: 600;
		text-decoration: underline;
	}

	.cs-hint {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
		margin: 0;
	}

	.cs-toggle {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--surface-border);
		background-color: color-mix(in srgb, var(--surface-border) 12%, transparent);
		cursor: pointer;
	}

	.cs-toggle input {
		margin-top: 0.25rem;
	}

	.cs-toggle-label {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.cs-toggle-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.cs-toggle-desc {
		font-size: var(--text-caption);
		color: var(--surface-muted);
		line-height: 1.45;
	}

	.cs-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.cs-warning {
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 30%, var(--surface-border));
		background-color: color-mix(in srgb, var(--error-text-color) 5%, var(--surface-bg));
	}

	.cs-warning-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		margin: 0 0 0.25rem;
		color: var(--center-channel-color);
	}

	.cs-warning-desc {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
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
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
</style>
