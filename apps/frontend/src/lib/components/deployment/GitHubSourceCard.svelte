<script lang="ts">
	import { Github } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { SectionCard, Button, Badge, Alert, SearchPicker } from '$lib/components/ui';

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

	let repoQuery = $state('');
	let selectedRepo = $state<Repository | null>(null);
	let manualRepo = $state<{ owner: string; repo: string } | null>(null);

	let branches = $state<Branch[]>([]);
	let loadingBranches = $state(false);
	let branchQuery = $state('');
	let branchValue = $state('');

	let dockerfiles = $state<string[]>([]);
	let loadingDockerfiles = $state(false);
	let dockerfileQuery = $state('');
	let dockerfileValue = $state('Dockerfile');

	const needsDockerfile = $derived(deployment?.buildType !== 'railpack');

	const currentRepoName = $derived(
		String(deployment?.githubRepo || '').replace(/^https?:\/\/github\.com\//, '')
	);

	function parseRepoInput(value: string): { owner: string; repo: string } | null {
		const trimmed = value.trim().replace(/\.git$/, '');
		const urlMatch = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
		if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
		const shortMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
		if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
		return null;
	}

	const parsedRepoInput = $derived(parseRepoInput(repoQuery));
	const parsedRepoIsListed = $derived(
		!!parsedRepoInput &&
			repositories.some(
				(r) =>
					r.full_name.toLowerCase() ===
					`${parsedRepoInput.owner}/${parsedRepoInput.repo}`.toLowerCase()
			)
	);

	const repoNeedle = $derived(
		(parsedRepoInput
			? `${parsedRepoInput.owner}/${parsedRepoInput.repo}`
			: repoQuery.trim()
		).toLowerCase()
	);
	const repoOptions = $derived(
		repositories
			.filter((r) => r.full_name.toLowerCase().includes(repoNeedle))
			.map((r) => ({ value: r.full_name, label: r.full_name }))
	);
	const privateRepos = $derived(
		new Set(repositories.filter((r) => r.private).map((r) => r.full_name))
	);
	const branchOptions = $derived(branches.map((b) => ({ value: b.name, label: b.name })));
	const dockerfileOptions = $derived(dockerfiles.map((d) => ({ value: d, label: d })));

	const chosenRepo = $derived(
		selectedRepo
			? { owner: selectedRepo.full_name.split('/')[0], repo: selectedRepo.full_name.split('/')[1] }
			: manualRepo
	);

	const repoLabel = $derived(chosenRepo ? `${chosenRepo.owner}/${chosenRepo.repo}` : '');

	const canSave = $derived(
		!!chosenRepo && !!branchValue.trim() && (!needsDockerfile || !!dockerfileValue.trim())
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
				if (pick) branchValue = pick.name;
				else if (preferred) branchValue = preferred;
			} else if (preferred) {
				branchValue = preferred;
			}
		} catch {
			if (preferred) branchValue = preferred;
		} finally {
			loadingBranches = false;
		}
		if (needsDockerfile && branchValue) {
			loadDockerfiles(owner, repo, branchValue);
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
		repoQuery = '';
		branchQuery = '';
		branchValue = deployment?.githubBranch || '';
		dockerfileQuery = '';
		dockerfileValue = deployment?.dockerfilePath || 'Dockerfile';
		fetchRepositories();
		if (current) loadBranches(current.owner, current.repo, branchValue || undefined);
	}

	function cancelEditing() {
		editing = false;
	}

	function selectRepo(repo: Repository) {
		selectedRepo = repo;
		manualRepo = null;
		repoQuery = '';
		dockerfileValue = 'Dockerfile';
		const [owner, name] = repo.full_name.split('/');
		loadBranches(owner, name, repo.default_branch);
	}

	function useManualRepo(parsed: { owner: string; repo: string }) {
		manualRepo = parsed;
		selectedRepo = null;
		repoQuery = '';
		dockerfileValue = 'Dockerfile';
		loadBranches(parsed.owner, parsed.repo);
	}

	function pickRepo(value: string) {
		const listed = repositories.find((r) => r.full_name === value);
		if (listed) {
			selectRepo(listed);
			return;
		}
		const parsed = parseRepoInput(value);
		if (parsed) useManualRepo(parsed);
	}

	function selectBranch(name: string) {
		branchValue = name;
		if (needsDockerfile && chosenRepo) {
			loadDockerfiles(chosenRepo.owner, chosenRepo.repo, name);
		}
	}

	function clearRepoSelection() {
		selectedRepo = null;
		manualRepo = null;
		repoQuery = '';
		branches = [];
		branchQuery = '';
		branchValue = '';
		dockerfiles = [];
		dockerfileQuery = '';
	}

	async function save() {
		if (!chosenRepo || saving) return;
		saving = true;
		try {
			const body: Record<string, string> = {
				repoUrl: `${chosenRepo.owner}/${chosenRepo.repo}`,
				branch: branchValue.trim()
			};
			if (needsDockerfile) body.dockerfilePath = dockerfileValue.trim();
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
			<div class="src-pickers">
				<SearchPicker
					options={repoOptions}
					bind:value={() => repoLabel, pickRepo}
					bind:query={repoQuery}
					prefix="Repository"
					placeholder="owner/repo or GitHub URL"
					searchPlaceholder="Search repos, or paste owner/repo"
					filter={false}
					loading={loadingRepos && !repoQuery.trim()}
					creatable={!!parsedRepoInput && !parsedRepoIsListed}
					createLabel={() => `Use ${parsedRepoInput?.owner}/${parsedRepoInput?.repo}`}
					onclear={clearRepoSelection}
					width="24rem"
				>
					{#snippet leading()}<Github size={15} />{/snippet}
					{#snippet optionLeading()}<Github size={15} />{/snippet}
					{#snippet trailing(option)}
						{#if privateRepos.has(option.value)}<Badge tone="neutral">Private</Badge>{/if}
					{/snippet}
					{#snippet empty()}
						{#if loadingRepos}
							Loading your repositories
						{:else if reposError}
							{reposError}
						{:else}
							Search your repos, or paste owner/repo or a GitHub URL
						{/if}
					{/snippet}
				</SearchPicker>

				<SearchPicker
					options={branchOptions}
					bind:value={() => branchValue, selectBranch}
					bind:query={branchQuery}
					prefix="Branch"
					placeholder="main"
					searchPlaceholder="Search branches"
					width="18rem"
					mono
					creatable
					loading={loadingBranches}
					empty={branches.length
						? 'No matching branches'
						: 'No branches found. Type a name to use anyway.'}
				/>

				{#if needsDockerfile}
					<SearchPicker
						options={dockerfileOptions}
						bind:value={dockerfileValue}
						bind:query={dockerfileQuery}
						prefix="Dockerfile"
						placeholder="Dockerfile"
						searchPlaceholder="Search paths"
						width="18rem"
						mono
						creatable
						loading={loadingDockerfiles}
						empty="No Dockerfiles found on this branch. Type a path to use anyway."
					/>
				{/if}
			</div>

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

	.src-pickers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		min-width: 0;
	}
</style>
