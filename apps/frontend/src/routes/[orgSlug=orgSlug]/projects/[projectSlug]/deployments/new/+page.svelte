<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import {
		apiFetch,
		toasts,
		refreshTree,
		isSuperAdmin,
		fetchProjectContext,
		buildBasePath,
		selectedOrganization,
		type ProjectContext
	} from '$lib/stores';
	import { Loader2, Container, Github, Plus, Trash2, Eye, EyeOff, HardDrive } from 'lucide-svelte';
	import { envVarsToRaw, rawToEnvVars } from '$lib/utils/format';
	import { springHover, motionStagger, springPop } from '$lib/utils/motion.svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';

	function handleClickOutside(event: MouseEvent, dropdownType: 'repo' | 'branch' | 'dockerfile') {
		const target = event.target as HTMLElement;
		if (dropdownType === 'repo' && !target.closest('[data-repo-dropdown]')) {
			showRepoDropdown = false;
		} else if (dropdownType === 'branch' && !target.closest('[data-branch-dropdown]')) {
			showBranchDropdown = false;
		} else if (dropdownType === 'dockerfile' && !target.closest('[data-dockerfile-dropdown]')) {
			showDockerfileDropdown = false;
		}
	}

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
	let pendingProjectName = $state<string | null>(null);

	// Deployment source — read from ?source= query param, default to 'image'
	const initialSource = $derived(
		$page.url.searchParams.get('source') === 'github' ? ('github' as const) : ('image' as const)
	);
	let deploymentSource = $state<'image' | 'github'>('image');
	let githubLinked = $state(false);
	let hasGitHubApp = $state(false);
	let githubAppInstallUrl = $state<string | null>(null);
	let repositories = $state<Repository[]>([]);
	let branches = $state<Branch[]>([]);
	let dockerfiles = $state<string[]>([]);
	let loadingRepos = $state(false);
	let loadingBranches = $state(false);
	let loadingDockerfiles = $state(false);

	let selectedRepo = $state<Repository | null>(null);
	let selectedBranch = $state<Branch | null>(null);
	let repoSearch = $state('');
	let branchSearch = $state('');
	let dockerfileSearch = $state('Dockerfile');
	let dockerfileStages = $state<string[]>([]);
	let loadingStages = $state(false);
	let selectedStage = $state<string>('');
	let dockerfileInputTimeout: ReturnType<typeof setTimeout> | null = null;
	let repoInputTimeout: ReturnType<typeof setTimeout> | null = null;
	let showRepoDropdown = $state(false);
	let showBranchDropdown = $state(false);
	let showDockerfileDropdown = $state(false);

	// Form state
	let name = $state('');
	let image = $state('');
	let repoUrl = $state('');
	let branch = $state('');
	let buildType = $state<'dockerfile' | 'railpack'>('dockerfile');
	let dockerfilePath = $state('Dockerfile');
	let buildFromRoot = $state(false);
	let replicas = $state(1);
	let exposePublic = $state(false);
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let ports = $state([{ name: 'http', containerPort: 80, servicePort: 80, protocol: 'TCP' }]);
	let portsManuallyEdited = $state(false);
	let envVars = $state([{ key: '', value: '' }]);
	let envsManuallyEdited = $state(false);
	let buildWithDepot = $state(false);
	let envViewMode = $state<'ui' | 'raw'>('ui');
	let envRawText = $state('');
	let revealedIndices = $state<Set<number>>(new Set());

	function toggleReveal(index: number) {
		revealedIndices = new Set(revealedIndices);
		if (revealedIndices.has(index)) {
			revealedIndices.delete(index);
		} else {
			revealedIndices.add(index);
		}
	}
	let volumes = $state<
		Array<{
			name: string;
			type: 'pvc' | 'hostPath' | 'emptyDir';
			mountPath: string;
			pvcName?: string;
			hostPath?: string;
			readOnly: boolean;
		}>
	>([]);

	// Smart monorepo detection: a Dockerfile inside a subfolder usually needs the
	// repo root as its build context so it can reach shared files.
	let buildFromRootTouched = false;
	const dockerfileInSubdir = $derived(
		dockerfilePath
			.trim()
			.replace(/^\.?\//, '')
			.includes('/')
	);
	$effect(() => {
		const sub = dockerfileInSubdir;
		if (!buildFromRootTouched) buildFromRoot = sub;
	});

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
				if (status.linked && deploymentSource === 'github') {
					fetchRepositories();
				}
			}
			// Also fetch app install URL for the prompt
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
				// Handle both new format { repositories, installations, source } and legacy array format
				repositories = Array.isArray(data) ? data : (data.repositories ?? []);
				if (data.source === 'app') {
					hasGitHubApp = true;
				}
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
		dockerfiles = [];
		dockerfilePath = 'Dockerfile';
		dockerfileSearch = 'Dockerfile';
		buildFromRoot = false;

		try {
			const [owner, repoName] = repo.full_name.split('/');
			const response = await apiFetch(`/apiv1/github/repositories/${owner}/${repoName}/branches`);
			if (response.ok) {
				branches = await response.json();
				const defaultBranch = branches.find((b) => b.name === repo.default_branch);
				if (defaultBranch) {
					selectedBranch = defaultBranch;
					branch = defaultBranch.name;
					branchSearch = defaultBranch.name;
					fetchDockerfiles(repo, defaultBranch.name);
				}
			}
		} catch (e) {
			console.error('Failed to fetch branches:', e);
		} finally {
			loadingBranches = false;
		}
	}

	async function fetchDockerfiles(repo: Repository, branchName: string) {
		loadingDockerfiles = true;
		dockerfiles = [];

		try {
			const [owner, repoName] = repo.full_name.split('/');
			const response = await apiFetch(
				`/apiv1/github/repositories/${owner}/${repoName}/dockerfiles?branch=${encodeURIComponent(branchName)}`
			);
			if (response.ok) {
				dockerfiles = await response.json();
			}
		} catch (e) {
			console.error('Failed to fetch Dockerfiles:', e);
		} finally {
			loadingDockerfiles = false;
		}
	}

	function getOwnerRepo(): { owner: string; repo: string } | null {
		if (selectedRepo) {
			const [owner, repo] = selectedRepo.full_name.split('/');
			return { owner, repo };
		}
		const parsed = parseRepoInput(repoSearch.trim());
		if (parsed) return { owner: parsed.owner, repo: parsed.repo };
		return null;
	}

	function handleDockerfileInput(value: string) {
		dockerfileSearch = value;
		dockerfilePath = value;
		showDockerfileDropdown = dockerfiles.length > 0;

		if (dockerfileInputTimeout) {
			clearTimeout(dockerfileInputTimeout);
		}

		const ownerRepo = getOwnerRepo();
		if (ownerRepo && branch && value.trim()) {
			dockerfileInputTimeout = setTimeout(() => {
				fetchDockerfileInfo(ownerRepo.owner, ownerRepo.repo, branch, value);
			}, 500);
		} else {
			dockerfileStages = [];
			selectedStage = '';
		}
	}

	function selectDockerfile(df: string) {
		dockerfileSearch = df;
		dockerfilePath = df;
		showDockerfileDropdown = false;
		const ownerRepo = getOwnerRepo();
		if (ownerRepo && branch) {
			fetchDockerfileInfo(ownerRepo.owner, ownerRepo.repo, branch, df);
		}
	}

	async function fetchDockerfileInfo(
		owner: string,
		repo: string,
		branchName: string,
		dockerfile: string
	) {
		if (!dockerfile) return;

		loadingStages = true;

		try {
			const response = await apiFetch(
				`/apiv1/github/repositories/${owner}/${repo}/dockerfile-info?dockerfilePath=${encodeURIComponent(dockerfile)}&branch=${encodeURIComponent(branchName)}`
			);
			if (response.ok) {
				const info: {
					exposedPorts: number[];
					envVars: { key: string; value: string }[];
					stages: string[];
				} = await response.json();

				// Set stages
				dockerfileStages = info.stages;
				if (info.stages.length > 0) {
					selectedStage = info.stages[0];
				} else {
					selectedStage = '';
				}

				// Auto-fill ports from EXPOSE directives (only if user hasn't edited them)
				if (info.exposedPorts.length > 0 && !portsManuallyEdited) {
					ports = info.exposedPorts.map((p, i) => ({
						name: `port-${i + 1}`,
						containerPort: p,
						servicePort: p,
						protocol: 'TCP'
					}));
				}

				// Auto-fill env vars from ENV directives (only if user hasn't edited them)
				if (info.envVars.length > 0 && !envsManuallyEdited) {
					envVars = info.envVars.map((e) => ({ key: e.key, value: e.value }));
				}
			}
		} catch (e) {
			console.error('Failed to fetch Dockerfile info:', e);
		} finally {
			loadingStages = false;
		}
	}

	function selectRepo(repo: Repository) {
		selectedRepo = repo;
		repoUrl = repo.clone_url;
		repoSearch = repo.full_name;
		showRepoDropdown = false;
		fetchBranches(repo);
	}

	function clearRepoSelection() {
		selectedRepo = null;
		repoUrl = '';
		repoSearch = '';
		branches = [];
		selectedBranch = null;
		branch = '';
		branchSearch = '';
		dockerfiles = [];
		dockerfilePath = 'Dockerfile';
		dockerfileSearch = 'Dockerfile';
		dockerfileStages = [];
		selectedStage = '';
		buildFromRoot = false;
		showRepoDropdown = false;
		showBranchDropdown = false;
		showDockerfileDropdown = false;
	}

	function parseRepoInput(value: string): { owner: string; repo: string; url: string } | null {
		// Match full GitHub URL: https://github.com/owner/repo(.git)
		const urlMatch = value.match(/(?:https?:\/\/)?github\.com\/([^\/\s]+)\/([^\/\s#?.]+)/);
		if (urlMatch) {
			const owner = urlMatch[1];
			const repo = urlMatch[2].replace(/\.git$/, '');
			return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
		}
		// Match owner/repo shorthand
		const shortMatch = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
		if (shortMatch) {
			return {
				owner: shortMatch[1],
				repo: shortMatch[2],
				url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git`
			};
		}
		return null;
	}

	async function fetchBranchesManual(owner: string, repoName: string) {
		loadingBranches = true;
		branches = [];
		selectedBranch = null;
		dockerfiles = [];
		dockerfilePath = 'Dockerfile';
		dockerfileSearch = 'Dockerfile';
		buildFromRoot = false;

		try {
			const response = await apiFetch(`/apiv1/github/repositories/${owner}/${repoName}/branches`);
			if (response.ok) {
				branches = await response.json();
				if (branches.length > 0) {
					// Try to find main/master, otherwise use first branch
					const defaultBranch =
						branches.find((b) => b.name === 'main') ??
						branches.find((b) => b.name === 'master') ??
						branches[0];
					selectedBranch = defaultBranch;
					branch = defaultBranch.name;
					branchSearch = defaultBranch.name;
					// Fetch dockerfiles using owner/repo directly
					const dfResponse = await apiFetch(
						`/apiv1/github/repositories/${owner}/${repoName}/dockerfiles?branch=${encodeURIComponent(defaultBranch.name)}`
					);
					if (dfResponse.ok) {
						dockerfiles = await dfResponse.json();
					}
				}
			}
		} catch (e) {
			// Repo doesn't exist or no access — that's fine, user can still proceed with manual branch
			console.error('Failed to fetch branches:', e);
		} finally {
			loadingBranches = false;
		}
	}

	function handleRepoSearchInput(value: string) {
		if (selectedRepo) return;
		repoSearch = value;
		showRepoDropdown = value.length > 0 && repositories.length > 0;

		if (repoInputTimeout) {
			clearTimeout(repoInputTimeout);
		}

		// Set repoUrl from manual input (owner/repo or full URL)
		const parsed = parseRepoInput(value.trim());
		if (parsed) {
			repoUrl = parsed.url;
			// Debounce fetching branches for the manually entered repo
			repoInputTimeout = setTimeout(() => {
				fetchBranchesManual(parsed.owner, parsed.repo);
			}, 500);
		} else {
			repoUrl = '';
		}
	}

	function selectBranch(b: Branch) {
		selectedBranch = b;
		branch = b.name;
		branchSearch = b.name;
		showBranchDropdown = false;
		if (selectedRepo) {
			fetchDockerfiles(selectedRepo, b.name);
		}
	}

	function clearBranchSelection() {
		selectedBranch = null;
		branch = '';
		branchSearch = '';
		dockerfiles = [];
		dockerfilePath = 'Dockerfile';
		dockerfileSearch = 'Dockerfile';
		dockerfileStages = [];
		selectedStage = '';
		buildFromRoot = false;
		showBranchDropdown = false;
		showDockerfileDropdown = false;
	}

	function handleBranchSearchInput(value: string) {
		if (selectedBranch) return;
		branchSearch = value;
		branch = value;
		showBranchDropdown = value.length > 0 && branches.length > 0;
	}

	function addPort() {
		portsManuallyEdited = true;
		ports = [
			...ports,
			{ name: `port-${ports.length + 1}`, containerPort: 80, servicePort: 80, protocol: 'TCP' }
		];
	}

	function removePort(index: number) {
		portsManuallyEdited = true;
		if (ports.length > 1) {
			ports = ports.filter((_, i) => i !== index);
		}
	}

	function addEnvVar() {
		envsManuallyEdited = true;
		envVars = [...envVars, { key: '', value: '' }];
	}

	function removeEnvVar(index: number) {
		envsManuallyEdited = true;
		if (envVars.length > 1) {
			envVars = envVars.filter((_, i) => i !== index);
		}
	}

	function switchEnvView(mode: 'ui' | 'raw') {
		if (mode === envViewMode) return;
		envsManuallyEdited = true;
		if (mode === 'raw') {
			envRawText = envVarsToRaw(envVars);
		} else {
			const parsed = rawToEnvVars(envRawText);
			envVars = parsed.length ? [...parsed, { key: '', value: '' }] : [{ key: '', value: '' }];
		}
		envViewMode = mode;
	}

	function addVolume() {
		volumes = [...volumes, { name: '', type: 'pvc', mountPath: '', pvcName: '', readOnly: false }];
	}

	function removeVolume(index: number) {
		volumes = volumes.filter((_, i) => i !== index);
	}

	async function createPendingProject(): Promise<{
		id: string;
		name: string;
		slug: string;
	} | null> {
		const orgId = $selectedOrganization?.id;
		if (!orgId) {
			formError = 'No organization selected';
			return null;
		}
		const res = await apiFetch('/apiv1/projects', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ organizationId: orgId, name: pendingProjectName })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(data?.message || 'Failed to create project');
		}
		return data;
	}

	async function submit() {
		if (!project && !pendingProjectName) {
			formError = 'Project not loaded';
			return;
		}

		if (!name.trim()) {
			formError = 'App name is required';
			return;
		}

		if (deploymentSource === 'image' && !image.trim()) {
			formError = 'Docker image is required';
			return;
		}

		if (deploymentSource === 'github') {
			if (!repoUrl.trim()) {
				formError = 'Repository is required';
				return;
			}
			if (!branch.trim()) {
				formError = 'Branch is required';
				return;
			}
			// Dockerfile path is only required for dockerfile builds
			if (buildType === 'dockerfile' && !dockerfilePath.trim()) {
				formError = 'Dockerfile path is required for Dockerfile builds';
				return;
			}
		}

		const validPorts = ports
			.filter((p) => p.containerPort > 0)
			.map((p, i) => ({
				name: `port-${i + 1}`,
				containerPort: Number(p.containerPort),
				servicePort: Number(p.containerPort),
				protocol: p.protocol
			}));

		if (validPorts.length === 0) {
			formError = 'At least one valid port is required';
			return;
		}

		const envSource = envViewMode === 'raw' ? rawToEnvVars(envRawText) : envVars;
		const validEnv = envSource
			.filter((e) => e.key.trim())
			.map((e) => ({ key: e.key.trim(), value: e.value }));

		const validVolumes = volumes
			.filter((v) => v.pvcName?.trim() && v.mountPath.trim())
			.map((v) => ({
				name: v.pvcName!.trim(),
				type: 'pvc' as const,
				mountPath: v.mountPath.trim(),
				readOnly: v.readOnly,
				pvcName: v.pvcName!.trim()
			}));

		submitting = true;
		formError = null;

		try {
			// Materialize pending project first, so we don't leave orphan projects
			// behind if the deployment form fails validation. By this point we've
			// already validated every deployment-side field above.
			let targetProjectId = project?.id;
			if (pendingProjectName) {
				const created = await createPendingProject();
				if (!created) {
					submitting = false;
					return;
				}
				targetProjectId = created.id;
				project = {
					...(project ?? {}),
					id: created.id,
					name: created.name,
					slug: created.slug
				} as ProjectContext;
				pendingProjectName = null;
				refreshTree();
			}

			if (!targetProjectId) {
				throw new Error('Project not available');
			}

			const endpoint =
				deploymentSource === 'github'
					? `/apiv1/projects/${targetProjectId}/deployments/from-github`
					: `/apiv1/projects/${targetProjectId}/deployments`;

			const body: Record<string, unknown> = {
				name: name.trim(),
				replicas,
				ports: validPorts,
				env: validEnv,
				exposePublic,
				volumes: validVolumes,
				cpuRequestMilli: resourceCpuMilli,
				memoryRequestBytes: resourceMemoryBytes
			};

			if (deploymentSource === 'github') {
				body.repoUrl = repoUrl;
				body.branch = branch;
				body.buildType = buildType;
				body.buildWithDepot = buildWithDepot;
				if (buildType === 'dockerfile') {
					body.dockerfilePath = dockerfilePath;
					body.buildFromRoot = buildFromRoot;
					if (selectedStage) {
						body.target = selectedStage;
					}
				}
			} else {
				body.image = image.trim();
			}

			const response = await apiFetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create app');
			}

			const deployment = await response.json();

			toasts.add({
				title: 'App created',
				description:
					deploymentSource === 'github' ? 'Building image from GitHub...' : 'Provisioning started',
				color: 'success'
			});

			refreshTree();
			// Redirect to progress page for GitHub deployments, main page for image deployments
			if (deploymentSource === 'github') {
				goto(`/${orgSlug}/deployments/${deployment.id}/progress`);
			} else {
				goto(`/${orgSlug}/deployments/${deployment.id}`);
			}
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Failed to create app';
		} finally {
			submitting = false;
		}
	}

	$effect(() => {
		if (deploymentSource === 'github' && githubLinked && repositories.length === 0) {
			fetchRepositories();
		}
	});

	onMount(() => {
		deploymentSource = initialSource;
		checkGitHubStatus();
	});

	$effect(() => {
		// Re-run whenever the route params change so the UI matches the new project
		orgSlug;
		projectSlug;
		wsSlug;
		if (orgSlug && projectSlug) {
			fetchProjectData();
		}
	});

	$effect(() => {
		const handleClick = (e: MouseEvent) => {
			handleClickOutside(e, 'repo');
			handleClickOutside(e, 'branch');
			handleClickOutside(e, 'dockerfile');
		};

		window.addEventListener('click', handleClick);
		return () => window.removeEventListener('click', handleClick);
	});
</script>

<div class="nd-page">
	{#if error}
		<div class="nd-error">{error}</div>
	{/if}

	{#if loading}
		<!-- Skeleton -->
		<div class="skeleton" style="height: 0.8125rem; width: 6rem; margin-bottom: 1rem;"></div>
		<div class="skeleton" style="height: 1.5rem; width: 12rem; margin-bottom: 1.5rem;"></div>
		<div class="nd-card">
			<div class="skeleton" style="height: 1rem; width: 8rem; margin-bottom: 1rem;"></div>
			<div class="nd-grid-2">
				<div class="skeleton" style="height: 2.25rem; border-radius: 0.5rem;"></div>
				<div class="skeleton" style="height: 2.25rem; border-radius: 0.5rem;"></div>
			</div>
		</div>
	{:else if project}
		<div class="nd-hero" {@attach motionStagger({ index: 0, from: { y: 12 } })}>
			<h1 class="nd-page-title">New App</h1>
			<p class="nd-page-subtitle">Configure and launch a new service.</p>
		</div>

		<!-- ═══ Source card ═══ -->
		<div class="nd-main-card" {@attach motionStagger({ index: 1, from: { y: 14 } })}>
			<div class="nd-source-picker">
				<span class="nd-source-label">Source</span>
				<div class="nd-pill-group">
					<button
						class="nd-pill"
						class:nd-pill-active={deploymentSource === 'image'}
						onclick={() => (deploymentSource = 'image')}
					>
						<Container class="h-3.5 w-3.5" /> Image
					</button>
					<button
						class="nd-pill"
						class:nd-pill-active={deploymentSource === 'github'}
						onclick={() => (deploymentSource = 'github')}
					>
						<Github class="h-3.5 w-3.5" /> GitHub
					</button>
				</div>
			</div>

			<div class="nd-owner-row">
				<ProjectSwitcher
					currentProjectName={project?.name || projectSlug}
					pathSuffix={`/deployments/new?source=${deploymentSource}`}
					{pendingProjectName}
					onPendingProjectChange={(n) => (pendingProjectName = n)}
				/>
				<span class="nd-slash">/</span>
				<input type="text" bind:value={name} placeholder="app-name" class="nd-name-input" />
			</div>

			<div class="nd-card-body">
				{#key deploymentSource}
					<div class="nd-source-pane" {@attach motionStagger({ index: 0, from: { y: 8 } })}>
						<p class="nd-hint nd-source-hint">
							{#if deploymentSource === 'image'}
								Run a prebuilt container image from any registry.
							{:else}
								Build and deploy straight from a Git repository.
							{/if}
						</p>
						{#if deploymentSource === 'image'}
							<div class="nd-field">
								<label class="nd-label">Docker image</label>
								<input
									type="text"
									bind:value={image}
									placeholder="ghcr.io/org/app:latest"
									class="nd-input nd-mono"
								/>
								<p class="nd-hint">
									Include the registry and tag. Public images work out of the box.
								</p>
							</div>
						{:else}
							{#if !githubLinked}
								<div class="nd-warning" style="margin-bottom: 0.75rem;">
									<p class="nd-warning-title">GitHub not connected</p>
									<p class="nd-warning-desc">
										You can deploy any public repository by entering its slug (e.g. <code
											>owner/repo</code
										>) or URL below. <a href="/user/settings">Connect GitHub</a> to also access your private
										repos.
									</p>
								</div>
							{:else if !hasGitHubApp && repositories.length === 0 && !loadingRepos}
								<div class="nd-warning" style="margin-bottom: 0.75rem;">
									<p class="nd-warning-title">Install the GitHub App for better access</p>
									<p class="nd-warning-desc">
										The GitHub App lets you choose exactly which repos and orgs to grant access to,
										with minimal permissions.
									</p>
									{#if githubAppInstallUrl}
										<a
											href={githubAppInstallUrl}
											target="_blank"
											class="nd-btn nd-btn-secondary"
											style="margin-top: 0.5rem;">Install GitHub App</a
										>
									{/if}
								</div>
							{/if}
							<div class="nd-field nd-relative" data-repo-dropdown>
								<label class="nd-label">Repository</label>
								<div class="nd-relative">
									<input
										type="text"
										bind:value={repoSearch}
										oninput={(e) => handleRepoSearchInput((e.target as HTMLInputElement).value)}
										onfocus={() => {
											if (!selectedRepo)
												showRepoDropdown = repoSearch.length > 0 && repositories.length > 0;
										}}
										placeholder="owner/repo or GitHub URL"
										class="nd-input"
										readonly={selectedRepo !== null}
										style={selectedRepo ? 'opacity: 0.7;' : ''}
									/>
									{#if loadingRepos || loadingBranches}
										<div class="nd-input-suffix"><Loader2 class="h-4 w-4 animate-spin" /></div>
									{:else if selectedRepo}
										<button
											onclick={clearRepoSelection}
											class="nd-input-suffix nd-input-clear"
											type="button"
										>
											<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
												><path
													stroke-linecap="round"
													stroke-linejoin="round"
													stroke-width="2"
													d="M6 18L18 6M6 6l12 12"
												/></svg
											>
										</button>
									{/if}
								</div>
								{#if showRepoDropdown && repoSearch && !loadingRepos && !selectedRepo}
									<div class="nd-dropdown">
										{#each repositories.filter((r) => r.full_name
												.toLowerCase()
												.includes(repoSearch.toLowerCase())) as repo}
											<button onclick={() => selectRepo(repo)} class="nd-dropdown-item">
												<div class="nd-dropdown-item-content">
													<Github class="h-4 w-4 shrink-0" />
													<span class="nd-truncate">{repo.full_name}</span>
													{#if repo.private}<span class="nd-badge">Private</span>{/if}
												</div>
											</button>
										{/each}
									</div>
								{/if}
							</div>

							{#if selectedRepo || repoUrl}
								<div class="nd-field nd-relative" data-branch-dropdown>
									<label class="nd-label">Branch</label>
									<div class="nd-relative">
										<input
											type="text"
											bind:value={branchSearch}
											oninput={(e) => handleBranchSearchInput((e.target as HTMLInputElement).value)}
											onfocus={() => {
												if (!selectedBranch)
													showBranchDropdown = branchSearch.length > 0 && branches.length > 0;
											}}
											placeholder="main"
											class="nd-input"
											disabled={loadingBranches}
											readonly={selectedBranch !== null}
											style={selectedBranch ? 'opacity: 0.7;' : ''}
										/>
										{#if selectedBranch}
											<button
												onclick={clearBranchSelection}
												class="nd-input-suffix nd-input-clear"
												type="button"
											>
												<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"
													><path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M6 18L18 6M6 6l12 12"
													/></svg
												>
											</button>
										{/if}
									</div>
									{#if showBranchDropdown && branchSearch && !loadingBranches && !selectedBranch}
										<div class="nd-dropdown">
											{#each branches.filter((b) => b.name
													.toLowerCase()
													.includes(branchSearch.toLowerCase())) as b}
												<button onclick={() => selectBranch(b)} class="nd-dropdown-item"
													><span class="nd-truncate">{b.name}</span></button
												>
											{/each}
										</div>
									{/if}
								</div>
							{/if}

							{#if selectedBranch || branch}
								<div class="nd-field">
									<label class="nd-label">How should we build it?</label>
									<div class="nd-grid-2">
										<button
											type="button"
											onclick={() => {
												buildType = 'dockerfile';
												if (!dockerfilePath.trim()) {
													dockerfilePath = 'Dockerfile';
													dockerfileSearch = 'Dockerfile';
												}
											}}
											class="nd-build-option"
											class:nd-build-active={buildType === 'dockerfile'}
											{@attach springHover({ lift: -2, stiffness: 420, damping: 22 })}
										>
											<span
												class="nd-build-icon"
												{@attach springPop(() => buildType === 'dockerfile')}
											>
												<Container class="h-5 w-5 shrink-0" />
											</span>
											<div>
												<div class="nd-build-label">Dockerfile</div>
												<p class="nd-build-desc">Use your own Dockerfile for full control.</p>
											</div>
										</button>
										<button
											type="button"
											onclick={() => (buildType = 'railpack')}
											class="nd-build-option"
											class:nd-build-active={buildType === 'railpack'}
											{@attach springHover({ lift: -2, stiffness: 420, damping: 22 })}
										>
											<span
												class="nd-build-icon"
												{@attach springPop(() => buildType === 'railpack')}
											>
												<svg
													class="h-5 w-5 shrink-0"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
													><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path
														d="M2 12l10 5 10-5"
													/></svg
												>
											</span>
											<div>
												<div class="nd-build-label">Automatic</div>
												<p class="nd-build-desc">
													No Dockerfile needed — we detect your language and build it for you.
												</p>
											</div>
										</button>
									</div>
								</div>

								{#if buildType === 'dockerfile'}
									<div class="nd-field nd-relative" data-dockerfile-dropdown>
										<label class="nd-label">Dockerfile</label>
										<div class="nd-relative">
											<input
												type="text"
												bind:value={dockerfileSearch}
												oninput={(e) => handleDockerfileInput((e.target as HTMLInputElement).value)}
												onfocus={() => {
													if (dockerfiles.length > 0) showDockerfileDropdown = true;
												}}
												placeholder="Dockerfile"
												class="nd-input nd-mono"
											/>
											{#if loadingDockerfiles}<div class="nd-input-suffix">
													<Loader2 class="h-4 w-4 animate-spin" />
												</div>{/if}
										</div>
										{#if showDockerfileDropdown && !loadingDockerfiles && dockerfiles.length > 0}
											<div class="nd-dropdown">
												{#each dockerfiles.filter((d) => d
														.toLowerCase()
														.includes(dockerfileSearch.toLowerCase())) as df}
													<button
														onclick={() => selectDockerfile(df)}
														class="nd-dropdown-item nd-mono"
														><span class="nd-truncate">{df}</span></button
													>
												{/each}
											</div>
										{/if}
									</div>
									{#if dockerfilePath && dockerfileStages.length > 0}
										<div class="nd-field">
											<label class="nd-label">Build Stage</label>
											<select
												class="nd-input"
												value={selectedStage}
												onchange={(e) => {
													selectedStage = (e.target as HTMLSelectElement).value;
												}}
											>
												{#each dockerfileStages as stage}<option value={stage}>{stage}</option
													>{/each}
											</select>
											<p class="nd-hint">
												Select which stage to build from the multi-stage Dockerfile
											</p>
										</div>
									{/if}

									<label
										class="nd-checkbox-row nd-monorepo"
										class:nd-monorepo--on={dockerfileInSubdir}
									>
										<input
											type="checkbox"
											bind:checked={buildFromRoot}
											onchange={() => (buildFromRootTouched = true)}
											class="nd-checkbox"
										/>
										<div>
											<span class="nd-checkbox-label">Using a monorepo?</span>
											<p class="nd-hint">
												{#if dockerfileInSubdir}Your Dockerfile is in a subfolder — building from
													the repo root lets it reach shared files. We turned this on for you.{:else}Build
													from the repo root instead of the Dockerfile's folder.{/if}
											</p>
										</div>
									</label>
								{/if}
							{/if}
						{/if}
					</div>
				{/key}
			</div>
		</div>

		<!-- ═══ Networking ═══ -->
		<div class="nd-card" {@attach motionStagger({ index: 2, from: { y: 14 } })}>
			<div class="nd-card-header">
				<div>
					<h2 class="nd-card-title">Ports</h2>
					<p class="nd-hint" style="margin-top: 0.125rem;">
						The port your app listens on inside the container.
					</p>
				</div>
				<button onclick={addPort} class="nd-btn nd-btn-secondary nd-btn-sm"
					><Plus class="h-4 w-4" /> Add port</button
				>
			</div>
			<div class="nd-stack">
				{#each ports as port, index}
					<div class="nd-port-row-simple">
						<div class="nd-field" style="flex: 1; min-width: 80px; max-width: 120px;">
							<input
								type="number"
								bind:value={port.containerPort}
								oninput={() => (portsManuallyEdited = true)}
								min="1"
								placeholder="80"
								class="nd-input"
							/>
						</div>
						<div class="nd-protocol-toggle">
							<button
								type="button"
								class="nd-proto-btn"
								class:nd-proto-active={port.protocol === 'TCP'}
								onclick={() => {
									port.protocol = 'TCP';
									portsManuallyEdited = true;
								}}>TCP</button
							>
							<button
								type="button"
								class="nd-proto-btn"
								class:nd-proto-active={port.protocol === 'UDP'}
								onclick={() => {
									port.protocol = 'UDP';
									portsManuallyEdited = true;
								}}>UDP</button
							>
						</div>
						<button
							onclick={() => removePort(index)}
							disabled={ports.length <= 1}
							class="nd-icon-btn nd-icon-btn-danger"
						>
							<Trash2 class="h-4 w-4" />
						</button>
					</div>
				{/each}
			</div>
		</div>

		<!-- ═══ Environment Variables ═══ -->
		<div class="nd-card" {@attach motionStagger({ index: 3, from: { y: 14 } })}>
			<div class="nd-card-header">
				<h2 class="nd-card-title">Environment Variables</h2>
				<div class="nd-pill-group">
					<button
						type="button"
						class="nd-pill"
						class:nd-pill-active={envViewMode === 'ui'}
						onclick={() => switchEnvView('ui')}>Editor</button
					>
					<button
						type="button"
						class="nd-pill"
						class:nd-pill-active={envViewMode === 'raw'}
						onclick={() => switchEnvView('raw')}>Raw</button
					>
				</div>
			</div>

			<div class="env-container">
				{#if envViewMode === 'ui'}
					{#each envVars as env, index (index)}
						{@const isRevealed = revealedIndices.has(index)}
						{@const hasKey = env.key.trim().length > 0}
						<div class="env-row" transition:slide={{ duration: 150 }}>
							<div class="env-row-inner">
								<div class="env-key-col">
									<input
										type="text"
										bind:value={env.key}
										oninput={() => (envsManuallyEdited = true)}
										placeholder="KEY"
										class="env-key-input"
									/>
								</div>
								<div class="env-val-col">
									<input
										type={isRevealed ? 'text' : 'password'}
										bind:value={env.value}
										oninput={() => (envsManuallyEdited = true)}
										placeholder={hasKey ? 'value' : ''}
										class="env-val-input"
									/>
								</div>
								<div class="env-actions">
									<button
										type="button"
										onclick={() => toggleReveal(index)}
										class="env-action-btn"
										aria-label={isRevealed ? 'Hide value' : 'Show value'}
									>
										{#if isRevealed}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye
												class="h-3.5 w-3.5"
											/>{/if}
									</button>
									<button
										type="button"
										onclick={() => removeEnvVar(index)}
										class="env-action-btn env-action-delete"
										aria-label="Remove"
									>
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
							</div>
						</div>
					{/each}
					<button type="button" onclick={addEnvVar} class="env-add-btn">
						<Plus class="h-4 w-4" /> <span>Add variable</span>
					</button>
				{:else}
					<textarea
						bind:value={envRawText}
						oninput={() => (envsManuallyEdited = true)}
						placeholder="KEY1=value1&#10;KEY2=value2&#10;# Comments are ignored"
						class="env-raw-textarea"
					></textarea>
				{/if}
			</div>
		</div>

		<!-- ═══ Storage ═══ -->
		<div class="nd-card" {@attach motionStagger({ index: 4, from: { y: 14 } })}>
			<div class="nd-card-header">
				<div>
					<h2 class="nd-card-title">Persistent Storage</h2>
					<p class="nd-hint" style="margin-top: 0.125rem;">
						Attach storage that persists across restarts.
					</p>
				</div>
				<button onclick={addVolume} class="nd-btn nd-btn-secondary nd-btn-sm"
					><Plus class="h-4 w-4" /> Add Storage</button
				>
			</div>
			<div class="nd-stack">
				{#each volumes as volume, index}
					<div class="nd-vol-card">
						<div class="nd-vol-row">
							<div class="nd-vol-num">{index + 1}</div>
							<div class="nd-vol-fields">
								<div class="nd-vol-field">
									<input
										type="text"
										bind:value={volume.pvcName}
										placeholder="Storage name"
										class="nd-vol-input"
									/>
								</div>
								<span class="nd-vol-arrow">→</span>
								<div class="nd-vol-field">
									<input
										type="text"
										bind:value={volume.mountPath}
										placeholder="/data"
										class="nd-vol-input nd-mono"
									/>
								</div>
							</div>
							<div class="nd-vol-actions">
								<label class="nd-vol-toggle">
									<span class="nd-vol-toggle-label">Read-only</span>
									<input type="checkbox" class="nd-toggle-input" bind:checked={volume.readOnly} />
									<span class="nd-toggle-track"><span class="nd-toggle-thumb"></span></span>
								</label>
								<button onclick={() => removeVolume(index)} class="nd-icon-btn nd-vol-remove"
									><Trash2 class="h-3.5 w-3.5" /></button
								>
							</div>
						</div>
					</div>
				{:else}
					<div class="nd-vol-empty">
						<p class="nd-vol-empty-title">No storage attached</p>
						<p class="nd-hint">Add persistent storage to keep files across restarts.</p>
					</div>
				{/each}
			</div>
		</div>

		<!-- ═══ Resources ═══ -->
		<div class="nd-card" {@attach motionStagger({ index: 5, from: { y: 14 } })}>
			<div class="nd-card-title">Resources</div>
			<p class="nd-hint" style="margin-top:-0.25rem; margin-bottom:0.75rem;">
				Pick a size for the container. Requests = limits, so what you pick is what it gets.
			</p>
			<ResourcePicker bind:cpuMilli={resourceCpuMilli} bind:memoryBytes={resourceMemoryBytes} />
		</div>

		<!-- ═══ Advanced ═══ -->
		<div class="nd-card" {@attach motionStagger({ index: 6, from: { y: 14 } })}>
			<details>
				<summary class="nd-card-title nd-summary">Advanced</summary>
				<div class="nd-advanced-body">
					<div class="nd-grid-2">
						<div class="nd-field">
							<span class="nd-label-sm">Replicas</span>
							<input type="number" bind:value={replicas} min="1" class="nd-input" />
							<p class="nd-hint">Number of pod replicas to run</p>
						</div>
						<div></div>
					</div>
					{#if $isSuperAdmin && deploymentSource === 'github'}
						<label class="nd-checkbox-row">
							<input type="checkbox" bind:checked={buildWithDepot} class="nd-checkbox" />
							<div>
								<span class="nd-checkbox-label">Orchard's Super Builds</span>
								<p class="nd-hint">
									Use Orchard's high-performance hosted builders for faster builds
								</p>
							</div>
						</label>
					{/if}
				</div>
			</details>
		</div>

		{#if formError}
			<div class="nd-error">{formError}</div>
		{/if}

		<div class="nd-actions">
			<a href={basePath} class="nd-btn nd-btn-ghost">Cancel</a>
			<button
				onclick={submit}
				disabled={submitting}
				class="nd-btn nd-btn-primary nd-btn-create"
				{@attach springHover({ lift: -1, stiffness: 480, damping: 26 })}
			>
				{#if submitting}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				Deploy
			</button>
		</div>
	{/if}
</div>

<style>
	.nd-page {
		max-width: 40rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 0;
	}

	/* Hero header */
	.nd-hero {
		padding: 0 0 2rem;
	}

	.nd-page-title {
		font-size: 1.625rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.03em;
		line-height: 1.1;
	}

	.nd-page-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0.375rem 0 0;
	}

	/* Main card */
	.nd-main-card {
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		margin-bottom: 1.5rem;
		display: flex;
		flex-direction: column;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.04),
			0 8px 20px -6px rgb(0 0 0 / 0.06);
	}

	/* Source picker */
	.nd-source-picker {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.875rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.nd-source-label {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.nd-pill-group {
		display: flex;
		border-radius: 0.5rem;
		padding: 0.1875rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}

	.nd-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.75rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		background: transparent;
		color: var(--surface-muted);
		transition: all 0.15s;
	}

	.nd-pill:hover {
		color: var(--center-channel-color);
	}

	.nd-pill-active {
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
	}

	/* Owner / Name row */
	.nd-owner-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1.25rem 1.5rem;
		border-bottom: 1px solid var(--surface-border);
	}

	/* Card body */
	.nd-card-body {
		padding: 1.25rem 1.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.nd-source-pane {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.nd-monorepo {
		padding: 0.75rem 0.875rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--surface-border) 12%, transparent);
		transition:
			border-color 0.2s,
			background-color 0.2s;
	}

	.nd-monorepo--on {
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 45%, transparent);
		background: color-mix(in srgb, var(--sidebar-text-active-border) 7%, transparent);
	}

	.nd-slash {
		font-size: 1.25rem;
		font-weight: 300;
		color: var(--surface-muted);
		user-select: none;
	}

	.nd-name-input {
		flex: 1;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		transition: border-color 0.15s;
	}

	.nd-name-input::placeholder {
		color: var(--surface-muted);
		font-weight: 400;
	}

	.nd-name-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}

	/* Cards */
	.nd-card {
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		border-radius: 0.875rem;
		background-color: var(--surface-bg);
		padding: 1.5rem;
		margin-bottom: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.04),
			0 8px 20px -6px rgb(0 0 0 / 0.06);
	}

	.nd-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.nd-card-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	/* Fields */
	.nd-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.nd-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.nd-label-sm {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
	}

	.nd-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.15s;
	}

	.nd-input::placeholder {
		color: var(--surface-muted);
	}

	.nd-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}

	.nd-input:disabled {
		opacity: 0.5;
	}

	.nd-mono {
		font-family: var(--font-mono);
	}

	.nd-textarea {
		min-height: 6rem;
		resize: vertical;
	}

	.nd-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.nd-source-hint {
		margin-top: -0.25rem;
	}

	/* Grid */
	.nd-grid-2 {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem;
	}

	.nd-relative {
		position: relative;
	}

	.nd-truncate {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Dropdown */
	.nd-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 20;
		margin-top: 0.25rem;
		max-height: 12rem;
		width: 100%;
		overflow-y: auto;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		padding: 0.375rem;
		background-color: var(--surface-bg);
		box-shadow:
			0 4px 16px rgb(0 0 0 / 0.08),
			0 8px 24px rgb(0 0 0 / 0.04);
	}

	.nd-dropdown-item {
		display: flex;
		align-items: center;
		width: 100%;
		border-radius: 0.5rem;
		padding: 0.4375rem 0.75rem;
		text-align: left;
		font-size: 0.8125rem;
		border: none;
		background: none;
		color: var(--center-channel-color);
		cursor: pointer;
		transition: background-color 0.1s;
	}

	.nd-dropdown-item:hover {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.nd-dropdown-item-content {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		flex: 1;
	}

	.nd-badge {
		font-size: 0.6875rem;
		padding: 0.0625rem 0.375rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--surface-muted);
		flex-shrink: 0;
	}

	.nd-input-suffix {
		position: absolute;
		right: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--surface-muted);
		display: flex;
	}

	.nd-input-clear {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.nd-input-clear:hover {
		color: var(--center-channel-color);
	}

	/* Build method cards */
	.nd-build-option {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.875rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background: transparent;
		cursor: pointer;
		text-align: left;
		color: var(--surface-muted);
		transition:
			border-color 0.15s,
			box-shadow 0.15s;
	}

	.nd-build-option:hover {
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.nd-build-active {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent);
		color: var(--sidebar-text-active-border);
		background: color-mix(in srgb, var(--sidebar-text-active-border) 4%, transparent);
	}

	.nd-build-icon {
		display: inline-flex;
		flex-shrink: 0;
	}

	.nd-build-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.nd-build-active .nd-build-label {
		color: var(--sidebar-text-active-border);
	}

	.nd-build-desc {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		margin: 0;
	}

	/* Checkbox */
	.nd-checkbox-row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		cursor: pointer;
	}

	.nd-checkbox {
		margin-top: 0.125rem;
		border-radius: 0.25rem;
	}

	.nd-checkbox-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.nd-checkbox-label-sm {
		font-size: 0.8125rem;
		color: var(--center-channel-color);
	}

	/* Warning */
	.nd-warning {
		padding: 1rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, #f59e0b 8%, transparent);
		border: 1px solid color-mix(in srgb, #f59e0b 25%, transparent);
	}

	.nd-warning-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.nd-warning-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	/* Ports */
	.nd-stack {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.nd-port-row {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr 1fr auto;
		gap: 0.5rem;
		align-items: end;
	}

	.nd-port-row-simple {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.nd-protocol-toggle {
		display: flex;
		border-radius: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--surface-border);
	}

	.nd-proto-btn {
		padding: 0.375rem 0.75rem;
		font-size: 0.75rem;
		font-weight: 500;
		background: transparent;
		color: var(--surface-muted);
		border: none;
		cursor: pointer;
		transition: all 0.15s;
	}

	.nd-proto-btn:first-child {
		border-right: 1px solid var(--surface-border);
	}

	.nd-proto-active {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
	}

	/* Volumes — inline card style */
	.nd-vol-card {
		padding: 0.875rem 1rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--surface-border) 15%, transparent);
		border: 1px solid var(--surface-border);
		transition: border-color 0.15s;
	}

	.nd-vol-card:hover {
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.nd-vol-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.nd-vol-num {
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		background: linear-gradient(
			135deg,
			var(--sidebar-text-active-border),
			color-mix(in srgb, var(--sidebar-text-active-border) 60%, #a855f7)
		);
		color: #fff;
		font-size: 0.6875rem;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.nd-vol-fields {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		flex-wrap: wrap;
	}

	.nd-vol-field {
		flex: 1;
		min-width: 100px;
	}

	.nd-vol-arrow {
		color: var(--surface-muted);
		font-size: 0.875rem;
		flex-shrink: 0;
	}

	.nd-vol-input {
		width: 100%;
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.15s;
		outline: none;
	}

	.nd-vol-input:focus {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}

	.nd-vol-input::placeholder {
		color: var(--surface-muted);
	}

	.nd-vol-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.nd-vol-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		cursor: pointer;
	}

	.nd-vol-toggle-label {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		white-space: nowrap;
	}

	.nd-vol-remove {
		opacity: 0.4;
		transition: opacity 0.15s;
	}

	.nd-vol-card:hover .nd-vol-remove {
		opacity: 1;
	}

	/* Toggle switch */
	.nd-toggle-input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	.nd-toggle-track {
		position: relative;
		flex-shrink: 0;
		width: 2.25rem;
		height: 1.25rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-color));
		transition: background-color 0.2s;
	}

	.nd-toggle-input:checked + .nd-toggle-track {
		background-color: var(--sidebar-text-active-border);
	}

	.nd-toggle-thumb {
		position: absolute;
		top: 0.125rem;
		left: 0.125rem;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background-color: #fff;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
		transition: transform 0.2s;
	}

	.nd-toggle-input:checked + .nd-toggle-track .nd-toggle-thumb {
		transform: translateX(1rem);
	}

	.nd-toggle-input:focus-visible + .nd-toggle-track {
		outline: 2px solid var(--sidebar-text-active-border);
		outline-offset: 2px;
	}

	/* Empty state */
	.nd-vol-empty {
		text-align: center;
		padding: 2rem 0;
	}

	.nd-vol-empty-icon {
		width: 2rem;
		height: 2rem;
		margin: 0 auto 0.5rem;
		color: var(--surface-muted);
	}

	.nd-vol-empty-title {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
		margin: 0 0 0.25rem;
	}

	/* Env editor — matches deployment Environment tab */
	.env-container {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		overflow: hidden;
		background-color: var(--control-bg);
	}

	.env-row {
		border-bottom: 1px solid var(--surface-border);
		transition: background-color 0.12s;
	}

	.env-row:hover,
	.env-row:focus-within {
		background-color: color-mix(in srgb, var(--surface-border) 20%, transparent);
	}

	.env-row-inner {
		display: flex;
		align-items: center;
		gap: 0;
		min-height: 2.75rem;
	}

	.env-key-col {
		flex: 2;
		min-width: 0;
	}

	.env-val-col {
		flex: 3;
		min-width: 0;
		border-left: 1px solid var(--surface-border);
	}

	.env-key-input,
	.env-val-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		background: transparent;
		border: none;
		outline: none;
		color: var(--center-channel-color);
	}

	.env-key-input {
		font-weight: 600;
		letter-spacing: 0.01em;
	}

	.env-val-input {
		color: var(--surface-muted);
	}

	.env-key-input::placeholder {
		color: var(--surface-muted);
		opacity: 0.5;
		font-weight: 400;
	}

	.env-val-input::placeholder {
		color: var(--surface-muted);
		opacity: 0.4;
	}

	.env-actions {
		display: flex;
		align-items: center;
		gap: 0;
		flex-shrink: 0;
		padding-right: 0.25rem;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.env-row:hover .env-actions,
	.env-row:focus-within .env-actions {
		opacity: 1;
	}

	.env-action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.375rem;
		background: transparent;
		border: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition:
			color 0.15s,
			background-color 0.15s;
	}

	.env-action-btn:hover {
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
	}

	.env-action-delete:hover {
		color: var(--error-text-color, #ef4444);
		background-color: color-mix(in srgb, var(--error-text-color, #ef4444) 8%, transparent);
	}

	.env-add-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.625rem 0.75rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--surface-muted);
		background: transparent;
		border: none;
		border-top: 1px dashed var(--surface-border);
		cursor: pointer;
		transition:
			color 0.15s,
			background-color 0.15s;
	}

	.env-add-btn:hover {
		color: var(--sidebar-text-active-border);
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 6%, transparent);
	}

	.env-raw-textarea {
		display: block;
		width: 100%;
		min-height: 220px;
		padding: 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.7;
		color: var(--center-channel-color);
		background: transparent;
		border: none;
		outline: none;
		resize: vertical;
	}

	.env-raw-textarea::placeholder {
		color: var(--surface-muted);
		opacity: 0.5;
	}

	/* Advanced body */
	.nd-advanced-body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	.nd-summary {
		cursor: pointer;
	}

	/* Buttons */
	.nd-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		text-decoration: none;
		transition: opacity 0.15s;
		white-space: nowrap;
	}

	.nd-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.nd-btn-primary {
		background: linear-gradient(
			135deg,
			var(--sidebar-text-active-border),
			color-mix(in srgb, var(--sidebar-text-active-border) 70%, #a855f7)
		);
		color: #fff;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.1),
			0 1px 2px rgb(0 0 0 / 0.06);
	}

	.nd-btn-primary:hover:not(:disabled) {
		opacity: 0.92;
		box-shadow: 0 2px 6px rgb(0 0 0 / 0.15);
	}

	.nd-btn-create {
		padding: 0.5rem 1.5rem;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.nd-btn-secondary {
		background-color: transparent;
		color: var(--surface-muted);
		border: 1px solid var(--surface-border);
	}

	.nd-btn-secondary:hover:not(:disabled) {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
	}

	.nd-btn-ghost {
		background-color: transparent;
		color: var(--surface-muted);
		border: none;
	}

	.nd-btn-ghost:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		color: var(--center-channel-color);
	}

	.nd-btn-sm {
		padding: 0.3125rem 0.625rem;
		font-size: 0.75rem;
	}

	.nd-icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition:
			color 0.15s,
			background-color 0.15s;
		flex-shrink: 0;
	}

	.nd-icon-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.nd-icon-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.nd-icon-btn-danger:hover:not(:disabled) {
		color: var(--error-text-color);
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
	}

	/* Actions footer — sticky so Deploy is always reachable */
	.nd-actions {
		position: sticky;
		bottom: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		margin: 0.5rem -2.5rem 0;
		padding: 1rem 2.5rem;
		background: color-mix(in srgb, var(--center-channel-bg) 88%, transparent);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
	}

	/* Error */
	.nd-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1rem;
	}
</style>
