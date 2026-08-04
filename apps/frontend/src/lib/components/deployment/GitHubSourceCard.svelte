<script lang="ts">
	import { Loader2, X, ChevronDown, Github } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		SectionCard,
		Field,
		Input,
		Button,
		Badge,
		PopoverPanel,
		Alert
	} from '$lib/components/ui';

	interface Repository {
		id: number;
		full_name: string;
		default_branch: string;
		private: boolean;
	}

	interface Branch {
		name: string;
		protected: boolean;
	}

	let {
		deployment,
		onUpdated,
		onRebuild,
		rebuilding
	}: {
		deployment: any;
		onUpdated: (updated: any) => void;
		onRebuild: () => void;
		rebuilding: boolean;
	} = $props();

	let editing = $state(false);
	let saving = $state(false);
	let justSaved = $state(false);

	let repositories = $state<Repository[]>([]);
	let loadingRepos = $state(false);
	let reposError = $state<string | null>(null);
	let reposFetched = false;

	let repoSearch = $state('');
	let selectedRepo = $state<Repository | null>(null);
	let manualRepo = $state<{ owner: string; repo: string } | null>(null);

	let branches = $state<Branch[]>([]);
	let loadingBranches = $state(false);
	let branchSearch = $state('');

	let dockerfiles = $state<string[]>([]);
	let loadingDockerfiles = $state(false);
	let dockerfileSearch = $state('Dockerfile');

	const needsDockerfile = $derived(deployment?.buildType !== 'railpack');

	const currentRepoName = $derived(
		String(deployment?.githubRepo || '').replace(/^https?:\/\/github\.com\//, '')
	);

	const filteredRepos = $derived(
		repositories.filter((r) => r.full_name.toLowerCase().includes(repoSearch.toLowerCase()))
	);
	const filteredBranches = $derived(
		branches.filter((b) => b.name.toLowerCase().includes(branchSearch.toLowerCase()))
	);
	const filteredDockerfiles = $derived(
		dockerfiles.filter((d) => d.toLowerCase().includes(dockerfileSearch.toLowerCase()))
	);

	function parseRepoInput(value: string): { owner: string; repo: string } | null {
		const trimmed = value.trim().replace(/\.git$/, '');
		const urlMatch = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
		if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
		const shortMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
		if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
		return null;
	}

	const parsedRepoInput = $derived(selectedRepo || manualRepo ? null : parseRepoInput(repoSearch));
	const parsedRepoIsListed = $derived(
		!!parsedRepoInput &&
			repositories.some(
				(r) =>
					r.full_name.toLowerCase() ===
					`${parsedRepoInput.owner}/${parsedRepoInput.repo}`.toLowerCase()
			)
	);

	const chosenRepo = $derived(
		selectedRepo
			? { owner: selectedRepo.full_name.split('/')[0], repo: selectedRepo.full_name.split('/')[1] }
			: manualRepo
	);

	const canSave = $derived(
		!!chosenRepo && !!branchSearch.trim() && (!needsDockerfile || !!dockerfileSearch.trim())
	);

	async function fetchRepositories() {
		if (reposFetched) return;
		reposFetched = true;
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
		} catch {
			reposError = 'Could not load your repositories.';
		} finally {
			loadingRepos = false;
		}
	}

	async function loadBranches(owner: string, repo: string, preferred?: string) {
		loadingBranches = true;
		branches = [];
		try {
			const response = await apiFetch(`/apiv1/github/repositories/${owner}/${repo}/branches`);
			if (response.ok) {
				branches = await response.json();
				const pick =
					(preferred && branches.find((b) => b.name === preferred)) ||
					branches.find((b) => b.name === 'main') ||
					branches.find((b) => b.name === 'master') ||
					branches[0];
				if (pick) branchSearch = pick.name;
			} else if (preferred) {
				branchSearch = preferred;
			}
		} catch {
			if (preferred) branchSearch = preferred;
		} finally {
			loadingBranches = false;
		}
		if (needsDockerfile && branchSearch) {
			loadDockerfiles(owner, repo, branchSearch);
		}
	}

	async function loadDockerfiles(owner: string, repo: string, branchName: string) {
		loadingDockerfiles = true;
		dockerfiles = [];
		try {
			const response = await apiFetch(
				`/apiv1/github/repositories/${owner}/${repo}/dockerfiles?branch=${encodeURIComponent(branchName)}`
			);
			if (response.ok) {
				dockerfiles = await response.json();
			}
		} catch {
			dockerfiles = [];
		} finally {
			loadingDockerfiles = false;
		}
	}

	function startEditing() {
		editing = true;
		justSaved = false;
		const current = parseRepoInput(currentRepoName);
		selectedRepo = null;
		manualRepo = current;
		repoSearch = currentRepoName;
		branchSearch = deployment?.githubBranch || '';
		dockerfileSearch = deployment?.dockerfilePath || 'Dockerfile';
		fetchRepositories();
		if (current) loadBranches(current.owner, current.repo, branchSearch || undefined);
	}

	function cancelEditing() {
		editing = false;
	}

	function selectRepo(repo: Repository) {
		selectedRepo = repo;
		manualRepo = null;
		repoSearch = repo.full_name;
		dockerfileSearch = 'Dockerfile';
		const [owner, name] = repo.full_name.split('/');
		loadBranches(owner, name, repo.default_branch);
	}

	function useManualRepo(parsed: { owner: string; repo: string }) {
		manualRepo = parsed;
		selectedRepo = null;
		repoSearch = `${parsed.owner}/${parsed.repo}`;
		dockerfileSearch = 'Dockerfile';
		loadBranches(parsed.owner, parsed.repo);
	}

	function selectBranch(name: string) {
		branchSearch = name;
		if (needsDockerfile && chosenRepo) {
			loadDockerfiles(chosenRepo.owner, chosenRepo.repo, name);
		}
	}

	function clearRepoSelection(e: Event) {
		e.stopPropagation();
		selectedRepo = null;
		manualRepo = null;
		repoSearch = '';
		branches = [];
		branchSearch = '';
		dockerfiles = [];
	}

	async function save() {
		if (!chosenRepo || saving) return;
		saving = true;
		try {
			const body: Record<string, string> = {
				repoUrl: `${chosenRepo.owner}/${chosenRepo.repo}`,
				branch: branchSearch.trim()
			};
			if (needsDockerfile) body.dockerfilePath = dockerfileSearch.trim();
			const response = await apiFetch(`/apiv1/deployments/${deployment.id}/github-repo`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update repository');
			}
			const updated = await response.json();
			onUpdated(updated);
			editing = false;
			justSaved = true;
			toasts.add({
				title: 'Repository updated',
				description: 'Future builds will use the new source',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update repository',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}
</script>

<SectionCard title="Source">
	{#snippet actions()}
		{#if editing}
			<Button size="sm" variant="ghost" disabled={saving} onclick={cancelEditing}>Cancel</Button>
			<Button size="sm" variant="primary" loading={saving} disabled={!canSave} onclick={save}>
				Save
			</Button>
		{:else}
			<Button size="sm" variant="secondary" onclick={startEditing}>Change</Button>
		{/if}
	{/snippet}

	{#if !editing}
		<div class="src-row">
			<Github class="h-4 w-4 shrink-0" />
			<a class="src-repo" href={deployment.githubRepo} target="_blank" rel="noopener noreferrer">
				{currentRepoName}
			</a>
			{#if deployment.githubBranch}
				<Badge tone="neutral">{deployment.githubBranch}</Badge>
			{/if}
			{#if needsDockerfile && deployment.dockerfilePath}
				<span class="src-detail">{deployment.dockerfilePath}</span>
			{/if}
		</div>
		{#if justSaved}
			<div class="mt-3">
				<Alert tone="info" title="The app is still running the previous build">
					<div class="src-rebuild">
						<span>Rebuild to deploy from the new source.</span>
						<Button
							size="sm"
							variant="primary"
							loading={rebuilding}
							onclick={() => {
								justSaved = false;
								onRebuild();
							}}
						>
							Rebuild now
						</Button>
					</div>
				</Alert>
			</div>
		{/if}
	{:else}
		<div class="src-form">
			<Field label="Repository">
				<PopoverPanel sameWidth>
					{#snippet trigger(attrs, open)}
						<div class="src-picker-wrap">
							<button type="button" class="src-picker-trigger" {...attrs}>
								<Github class="h-4 w-4 shrink-0" />
								{#if repoSearch}
									<span class="src-picker-value">{repoSearch}</span>
								{:else}
									<span class="src-picker-placeholder">owner/repo or GitHub URL</span>
								{/if}
							</button>
							{#if loadingRepos || loadingBranches}
								<span class="src-picker-suffix"><Loader2 class="h-4 w-4 animate-spin" /></span>
							{:else if selectedRepo || manualRepo}
								<button
									type="button"
									class="src-picker-suffix src-picker-clear"
									aria-label="Clear repository"
									onclick={clearRepoSelection}
								>
									<X size={15} />
								</button>
							{:else}
								<span
									class="src-picker-suffix src-picker-chevron"
									class:src-picker-chevron--open={open}
								>
									<ChevronDown size={15} />
								</span>
							{/if}
						</div>
					{/snippet}
					{#snippet children({ close })}
						<Input
							value={repoSearch}
							oninput={(e: Event) => {
								repoSearch = (e.target as HTMLInputElement).value;
								selectedRepo = null;
								manualRepo = null;
							}}
							placeholder="owner/repo or GitHub URL"
						/>
						<div class="src-picker-list">
							{#if parsedRepoInput && !parsedRepoIsListed}
								<button
									type="button"
									class="src-picker-option"
									onclick={() => {
										useManualRepo(parsedRepoInput);
										close();
									}}
								>
									<Github class="h-4 w-4 shrink-0" />
									<span class="src-picker-option-text">
										Use <strong>{parsedRepoInput.owner}/{parsedRepoInput.repo}</strong>
									</span>
								</button>
							{/if}
							{#if loadingRepos}
								<div class="src-picker-empty">
									<Loader2 class="h-4 w-4 animate-spin" /> Loading your repositories
								</div>
							{:else}
								{#each filteredRepos as repo (repo.full_name)}
									<button
										type="button"
										class="src-picker-option"
										onclick={() => {
											selectRepo(repo);
											close();
										}}
									>
										<Github class="h-4 w-4 shrink-0" />
										<span class="src-picker-option-text">{repo.full_name}</span>
										{#if repo.private}<Badge tone="neutral">Private</Badge>{/if}
									</button>
								{:else}
									{#if reposError}
										<div class="src-picker-empty">{reposError}</div>
									{:else if !parsedRepoInput}
										<div class="src-picker-empty">
											Search your repos, or paste owner/repo or a GitHub URL
										</div>
									{/if}
								{/each}
							{/if}
						</div>
					{/snippet}
				</PopoverPanel>
			</Field>

			<Field label="Branch">
				<PopoverPanel sameWidth>
					{#snippet trigger(attrs, open)}
						<div class="src-picker-wrap">
							<button type="button" class="src-picker-trigger font-mono" {...attrs}>
								{#if branchSearch}
									<span class="src-picker-value">{branchSearch}</span>
								{:else}
									<span class="src-picker-placeholder">main</span>
								{/if}
							</button>
							{#if loadingBranches}
								<span class="src-picker-suffix"><Loader2 class="h-4 w-4 animate-spin" /></span>
							{:else}
								<span
									class="src-picker-suffix src-picker-chevron"
									class:src-picker-chevron--open={open}
								>
									<ChevronDown size={15} />
								</span>
							{/if}
						</div>
					{/snippet}
					{#snippet children({ close })}
						<Input
							value={branchSearch}
							oninput={(e: Event) => (branchSearch = (e.target as HTMLInputElement).value)}
							placeholder="main"
							class="font-mono"
						/>
						<div class="src-picker-list">
							{#each filteredBranches as b (b.name)}
								<button
									type="button"
									class="src-picker-option font-mono"
									onclick={() => {
										selectBranch(b.name);
										close();
									}}
								>
									<span class="src-picker-option-text">{b.name}</span>
								</button>
							{:else}
								<div class="src-picker-empty">No matching branches</div>
							{/each}
						</div>
					{/snippet}
				</PopoverPanel>
			</Field>

			{#if needsDockerfile}
				<Field label="Dockerfile">
					<PopoverPanel sameWidth>
						{#snippet trigger(attrs, open)}
							<div class="src-picker-wrap">
								<button type="button" class="src-picker-trigger font-mono" {...attrs}>
									{#if dockerfileSearch}
										<span class="src-picker-value">{dockerfileSearch}</span>
									{:else}
										<span class="src-picker-placeholder">Dockerfile</span>
									{/if}
								</button>
								{#if loadingDockerfiles}
									<span class="src-picker-suffix"><Loader2 class="h-4 w-4 animate-spin" /></span>
								{:else}
									<span
										class="src-picker-suffix src-picker-chevron"
										class:src-picker-chevron--open={open}
									>
										<ChevronDown size={15} />
									</span>
								{/if}
							</div>
						{/snippet}
						{#snippet children({ close })}
							<Input
								value={dockerfileSearch}
								oninput={(e: Event) => (dockerfileSearch = (e.target as HTMLInputElement).value)}
								placeholder="Dockerfile"
								class="font-mono"
							/>
							<div class="src-picker-list">
								{#each filteredDockerfiles as df (df)}
									<button
										type="button"
										class="src-picker-option font-mono"
										onclick={() => {
											dockerfileSearch = df;
											close();
										}}
									>
										<span class="src-picker-option-text">{df}</span>
									</button>
								{:else}
									<div class="src-picker-empty">
										No Dockerfiles found on this branch. Type a path to use anyway.
									</div>
								{/each}
							</div>
						{/snippet}
					</PopoverPanel>
				</Field>
			{/if}

			<p class="src-note">
				The app keeps running from its current build. Rebuild after saving to deploy from the new
				source. Auto-deploy follows the new repository if the GitHub App has access to it.
			</p>
		</div>
	{/if}
</SectionCard>

<style>
	.src-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--text-default);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}

	.src-repo {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		color: var(--text-default);
	}

	.src-repo:hover {
		color: var(--text-link);
		text-decoration: underline;
	}

	.src-detail {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.src-rebuild {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.src-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.src-note {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		margin: 0;
	}

	.src-picker-wrap {
		position: relative;
	}

	.src-picker-trigger {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.75rem 2.25rem 0.75rem 0.875rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background-color: var(--bg-surface);
		color: var(--text-default);
		font-size: var(--text-callout);
		line-height: 1.5;
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}

	.src-picker-trigger:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring-color);
		outline-offset: var(--focus-ring-offset);
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.src-picker-value {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.src-picker-placeholder {
		color: var(--text-faint);
	}

	.src-picker-suffix {
		position: absolute;
		right: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		color: var(--text-muted);
	}

	.src-picker-clear {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.src-picker-clear:hover {
		color: var(--text-default);
	}

	.src-picker-chevron {
		pointer-events: none;
		transition: transform var(--dur-fast) ease;
	}

	.src-picker-chevron--open {
		transform: translateY(-50%) rotate(180deg);
	}

	.src-picker-list {
		display: flex;
		flex-direction: column;
		margin-top: 0.5rem;
		max-height: 12rem;
		overflow-y: auto;
		scrollbar-gutter: stable;
	}

	.src-picker-option {
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
		color: var(--text-default);
		cursor: pointer;
		transition: background-color var(--dur-fast);
	}

	.src-picker-option:hover {
		background-color: var(--bg-hover);
	}

	.src-picker-option-text {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.src-picker-empty {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
</style>
