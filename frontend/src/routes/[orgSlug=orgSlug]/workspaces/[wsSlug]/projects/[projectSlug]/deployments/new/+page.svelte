<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
	import { ArrowLeft, Loader2, Container, Github, Plus, Trash2, HardDrive, Eye, EyeOff } from 'lucide-svelte';

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

	interface Workspace {
		id: string;
		name: string;
		slug: string;
	}

	interface Project {
		id: string;
		name: string;
		slug: string;
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

	let workspace = $state<Workspace | null>(null);
	let project = $state<Project | null>(null);
	let loading = $state(true);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let formError = $state<string | null>(null);

	// Deployment source
	let deploymentSource = $state<'image' | 'github'>('image');
	let githubLinked = $state(false);
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
	let dockerfileSearch = $state('');
	let dockerfileStages = $state<string[]>([]);
	let loadingStages = $state(false);
	let selectedStage = $state<string>('');
	let dockerfileInputTimeout: ReturnType<typeof setTimeout> | null = null;
	let showRepoDropdown = $state(false);
	let showBranchDropdown = $state(false);
	let showDockerfileDropdown = $state(false);

	// Form state
	let name = $state('');
	let image = $state('');
	let repoUrl = $state('');
	let branch = $state('');
	let buildType = $state<'dockerfile' | 'railpack'>('dockerfile');
	let dockerfilePath = $state('');
	let buildFromRoot = $state(false);
	let replicas = $state(1);
	let exposePublic = $state(false);
	let ports = $state([{ name: 'http', containerPort: 80, servicePort: 80, protocol: 'TCP' }]);
	let envVars = $state([{ key: '', value: '' }]);
	let envPasteText = $state('');
	let revealedIndices = $state<Set<number>>(new Set());

	function toggleReveal(index: number) {
		revealedIndices = new Set(revealedIndices);
		if (revealedIndices.has(index)) {
			revealedIndices.delete(index);
		} else {
			revealedIndices.add(index);
		}
	}
	let volumes = $state<Array<{ name: string; type: 'pvc' | 'hostPath' | 'emptyDir'; mountPath: string; pvcName?: string; hostPath?: string; readOnly: boolean }>>([]);

	const workspaceSlug = $derived($page.params.wsSlug);
	const projectSlug = $derived($page.params.projectSlug);
	const orgSlug = $derived($page.params.orgSlug);

	async function fetchProjectData() {
		loading = true;
		error = null;

		try {
			const wsResponse = await apiFetch(`/apiv1/workspaces/slug/${workspaceSlug}`);
			if (!wsResponse.ok) throw new Error('Failed to fetch workspace');
			workspace = await wsResponse.json();

			const matchedProject = (workspace as any).projects?.find((p: Project) => p.slug === projectSlug);
			if (!matchedProject) throw new Error('Project not found');

			const projResponse = await apiFetch(`/apiv1/projects/${matchedProject.id}`);
			if (!projResponse.ok) throw new Error('Failed to fetch project');
			project = await projResponse.json();
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
				if (status.linked && deploymentSource === 'github') {
					fetchRepositories();
				}
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
				repositories = await response.json();
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
		dockerfilePath = '';
		dockerfileSearch = '';
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

	function handleDockerfileInput(value: string) {
		dockerfileSearch = value;
		dockerfilePath = value;
		showDockerfileDropdown = value.length > 0 && dockerfiles.length > 0;

		if (dockerfileInputTimeout) {
			clearTimeout(dockerfileInputTimeout);
		}

		if (selectedRepo && branch && value.trim()) {
			dockerfileInputTimeout = setTimeout(() => {
				fetchDockerfileStages(selectedRepo, branch, value);
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
		if (selectedRepo) {
			fetchDockerfileStages(selectedRepo, branch, df);
		}
	}

	async function fetchDockerfileStages(repo: Repository, branchName: string, dockerfile: string) {
		if (!dockerfile) return;
		
		loadingStages = true;
		dockerfileStages = [];
		selectedStage = '';

		try {
			const [owner, repoName] = repo.full_name.split('/');
			const response = await apiFetch(
				`/apiv1/github/repositories/${owner}/${repoName}/dockerfile-stages?dockerfilePath=${encodeURIComponent(dockerfile)}&branch=${encodeURIComponent(branchName)}`
			);
			if (response.ok) {
				const stages = await response.json();
				dockerfileStages = stages;
				if (stages.length > 0) {
					selectedStage = stages[0];
				}
			}
		} catch (e) {
			console.error('Failed to fetch Dockerfile stages:', e);
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
		dockerfilePath = '';
		dockerfileSearch = '';
		dockerfileStages = [];
		selectedStage = '';
		buildFromRoot = false;
		showRepoDropdown = false;
		showBranchDropdown = false;
		showDockerfileDropdown = false;
	}

	function handleRepoSearchInput(value: string) {
		if (selectedRepo) return;
		repoSearch = value;
		showRepoDropdown = value.length > 0;
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
		dockerfilePath = '';
		dockerfileSearch = '';
		dockerfileStages = [];
		selectedStage = '';
		buildFromRoot = false;
		showBranchDropdown = false;
		showDockerfileDropdown = false;
	}

	function handleBranchSearchInput(value: string) {
		if (selectedBranch) return;
		branchSearch = value;
		showBranchDropdown = value.length > 0;
	}

	function addPort() {
		ports = [...ports, { name: `port-${ports.length + 1}`, containerPort: 80, servicePort: 80, protocol: 'TCP' }];
	}

	function removePort(index: number) {
		if (ports.length > 1) {
			ports = ports.filter((_, i) => i !== index);
		}
	}

	function addEnvVar() {
		envVars = [...envVars, { key: '', value: '' }];
	}

	function removeEnvVar(index: number) {
		if (envVars.length > 1) {
			envVars = envVars.filter((_, i) => i !== index);
		}
	}

	function parseEnvVars() {
		if (!envPasteText.trim()) return;
		
		const lines = envPasteText.split('\n');
		const parsed: Array<{ key: string; value: string }> = [];
		
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}
			
			const equalIndex = trimmed.indexOf('=');
			if (equalIndex === -1) {
				continue;
			}
			
			const key = trimmed.substring(0, equalIndex).trim();
			const value = trimmed.substring(equalIndex + 1).trim();
			
			if (key) {
				parsed.push({ key, value });
			}
		}
		
		if (parsed.length > 0) {
			envVars = parsed;
			envPasteText = '';
		}
	}

	function addVolume() {
		volumes = [...volumes, { name: `volume-${volumes.length + 1}`, type: 'pvc', mountPath: '', pvcName: '', readOnly: false }];
	}

	function removeVolume(index: number) {
		volumes = volumes.filter((_, i) => i !== index);
	}

	async function submit() {
		if (!project) {
			formError = 'Project not loaded';
			return;
		}

		if (!name.trim()) {
			formError = 'Deployment name is required';
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
				name: p.name.trim() || `port-${i + 1}`,
				containerPort: Number(p.containerPort),
				servicePort: Number(p.servicePort || p.containerPort),
				protocol: p.protocol
			}));

		if (validPorts.length === 0) {
			formError = 'At least one valid port is required';
			return;
		}

		const validEnv = envVars.filter((e) => e.key.trim()).map((e) => ({ key: e.key.trim(), value: e.value }));

		const validVolumes = volumes
			.filter((v) => v.name.trim() && v.mountPath.trim())
			.map((v) => {
				const vol: any = {
					name: v.name.trim(),
					type: v.type,
					mountPath: v.mountPath.trim(),
					readOnly: v.readOnly
				};
				if (v.type === 'pvc' && v.pvcName) {
					vol.pvcName = v.pvcName.trim();
				} else if (v.type === 'hostPath' && v.hostPath) {
					vol.hostPath = v.hostPath.trim();
				}
				return vol;
			})
			.filter((v) => {
				if (v.type === 'pvc' && !v.pvcName) return false;
				if (v.type === 'hostPath' && !v.hostPath) return false;
				return true;
			});

		submitting = true;
		formError = null;

		try {
			const endpoint =
				deploymentSource === 'github'
					? `/apiv1/projects/${project.id}/deployments/from-github`
					: `/apiv1/projects/${project.id}/deployments`;

			const body: Record<string, unknown> = {
				name: name.trim(),
				replicas,
				ports: validPorts,
				env: validEnv,
				exposePublic,
				volumes: validVolumes
			};

			if (deploymentSource === 'github') {
				body.repoUrl = repoUrl;
				body.branch = branch;
				body.buildType = buildType;
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
				throw new Error(data.message || 'Failed to create deployment');
			}

			const deployment = await response.json();

			toasts.add({
				title: 'Deployment created',
				description: deploymentSource === 'github' ? 'Building image from GitHub...' : 'Provisioning started',
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
			formError = e instanceof Error ? e.message : 'Failed to create deployment';
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
		fetchProjectData();
		checkGitHubStatus();
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

<div class="p-6">
	<button
		onclick={() => window.history.back()}
		class="mb-6 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer"
	>
		<ArrowLeft class="h-4 w-4" />
		Back to project
	</button>

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<div class="flex justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin text-primary-600" />
		</div>
	{:else if project}
		<div class="mx-auto max-w-3xl space-y-6">
			<h1 class="text-2xl font-bold">New Deployment</h1>

			<!-- Template banner -->
			<a
				href="/{orgSlug}/workspaces/{$page.params.wsSlug}/projects/{$page.params.projectSlug}/templates"
				style="display: flex; align-items: center; gap: 0.75rem; padding: 0.875rem 1.25rem; border-radius: 0.75rem; background-color: color-mix(in srgb, #ec4899 8%, transparent); border: 1px solid color-mix(in srgb, #ec4899 20%, transparent); text-decoration: none; color: var(--center-channel-color); transition: border-color 0.15s;"
			>
				<span style="font-size: 0.875rem; color: #ec4899; font-weight: 500;">Looking for a complete app setup?</span>
				<span style="font-size: 0.8125rem; color: var(--surface-muted);">Browse Templates to deploy pre-configured stacks with databases and ingresses.</span>
			</a>

			<!-- Deployment Source -->
			<div class="card p-6">
				<h2 class="text-lg font-semibold mb-4">Deployment Source</h2>
				<div class="flex gap-4">
					<button
						onclick={() => (deploymentSource = 'image')}
						class="flex-1 rounded-lg border-2 p-4 text-left transition-all {deploymentSource === 'image'
							? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
							: 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}"
					>
						<div class="flex items-start gap-3">
							<Container class="h-6 w-6 mt-0.5" />
							<div>
								<h3 class="font-semibold">Docker Image</h3>
								<p class="text-sm text-gray-600 dark:text-gray-400">Deploy from a Docker registry</p>
							</div>
						</div>
					</button>
					<button
						onclick={() => (deploymentSource = 'github')}
						class="flex-1 rounded-lg border-2 p-4 text-left transition-all {deploymentSource === 'github'
							? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
							: 'border-gray-200 dark:border-gray-700 hover:border-gray-300'}"
					>
						<div class="flex items-start gap-3">
							<Github class="h-6 w-6 mt-0.5" />
							<div>
								<h3 class="font-semibold">GitHub Repository</h3>
								<p class="text-sm text-gray-600 dark:text-gray-400">Build and deploy from GitHub</p>
							</div>
						</div>
					</button>
				</div>
			</div>

			<!-- Deployment Details -->
			<div class="card p-6 space-y-6">
				<h2 class="text-lg font-semibold">Deployment Details</h2>

				<div class="grid gap-4 md:grid-cols-2">
					<div>
						<label class="block text-sm font-medium mb-2">Deployment name</label>
						<input type="text" bind:value={name} placeholder="backend" class="input" />
					</div>
					<div>
						<label class="block text-sm font-medium mb-2">Replicas</label>
						<input type="number" bind:value={replicas} min="1" class="input" />
					</div>
				</div>

				{#if deploymentSource === 'image'}
					<div>
						<label class="block text-sm font-medium mb-2">Docker image</label>
						<input type="text" bind:value={image} placeholder="ghcr.io/org/app:latest" class="input font-mono" />
					</div>
				{:else}
					{#if !githubLinked}
						<div class="rounded-lg bg-yellow-50 dark:bg-yellow-900/20 p-4 border border-yellow-200 dark:border-yellow-800">
							<p class="font-medium text-yellow-900 dark:text-yellow-100">GitHub account not connected</p>
							<p class="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
								Link your GitHub account to deploy from repositories.
							</p>
							<a href="/user/settings" class="btn btn-secondary mt-2">Connect GitHub</a>
						</div>
					{:else}
						<div class="relative" data-repo-dropdown>
							<label class="block text-sm font-medium mb-2">Repository</label>
							<div class="relative">
								<input
									type="text"
									bind:value={repoSearch}
									oninput={(e) => handleRepoSearchInput((e.target as HTMLInputElement).value)}
									onfocus={() => { if (!selectedRepo) showRepoDropdown = repoSearch.length > 0; }}
									placeholder={loadingRepos ? "Loading repositories..." : selectedRepo ? selectedRepo.full_name : "Search repositories..."}
									class="input"
									disabled={loadingRepos}
									readonly={selectedRepo !== null || loadingRepos}
									style={selectedRepo ? "cursor: not-allowed; opacity: 0.7;" : ""}
								/>
								{#if loadingRepos}
									<div class="absolute right-3 top-1/2 -translate-y-1/2">
										<Loader2 class="h-4 w-4 animate-spin text-primary-600" />
									</div>
								{:else if selectedRepo}
									<button
										onclick={clearRepoSelection}
										class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
										type="button"
									>
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								{/if}
							</div>
							{#if showRepoDropdown && repoSearch && !loadingRepos && !selectedRepo}
								<div
									class="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border p-2 shadow"
									style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
								>
									{#each repositories.filter((r) => r.full_name.toLowerCase().includes(repoSearch.toLowerCase())) as repo}
										<button
											onclick={() => selectRepo(repo)}
											class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
										>
											<div class="flex items-center gap-2 min-w-0 flex-1">
												<Github class="h-4 w-4 shrink-0" />
												<span class="truncate">{repo.full_name}</span>
												{#if repo.private}
													<span class="badge badge-neutral text-xs shrink-0">Private</span>
												{/if}
											</div>
											{#if selectedRepo?.id === repo.id}
												<svg class="h-4 w-4 shrink-0 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
												</svg>
											{/if}
										</button>
									{/each}
								</div>
							{/if}
						</div>

						{#if selectedRepo}
							<div class="relative" data-branch-dropdown>
								<label class="block text-sm font-medium mb-2">Branch</label>
								<div class="relative">
									<input
										type="text"
										bind:value={branchSearch}
										oninput={(e) => handleBranchSearchInput((e.target as HTMLInputElement).value)}
										onfocus={() => { if (!selectedBranch) showBranchDropdown = branchSearch.length > 0; }}
										placeholder={selectedBranch ? selectedBranch.name : "Search branches..."}
										class="input"
										disabled={loadingBranches}
										readonly={selectedBranch !== null}
										style={selectedBranch ? "cursor: not-allowed; opacity: 0.7;" : ""}
									/>
									{#if selectedBranch}
										<button
											onclick={clearBranchSelection}
											class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
											type="button"
										>
											<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
											</svg>
										</button>
									{/if}
								</div>
								{#if showBranchDropdown && branchSearch && !loadingBranches && !selectedBranch}
									<div
										class="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border p-2 shadow"
										style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
									>
										{#each branches.filter((b) => b.name.toLowerCase().includes(branchSearch.toLowerCase())) as b}
											<button
												onclick={() => selectBranch(b)}
												class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
											>
												<span class="truncate">{b.name}</span>
												{#if selectedBranch?.name === b.name}
													<svg class="h-4 w-4 shrink-0 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
													</svg>
												{/if}
											</button>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						{#if selectedBranch}
							<!-- Build Type Selector -->
							<div>
								<label class="block text-sm font-medium mb-2">Build Method</label>
								<div class="grid grid-cols-2 gap-3">
									<button
										type="button"
										onclick={() => buildType = 'dockerfile'}
										class="flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all {buildType === 'dockerfile' ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/20' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'}"
									>
										<Container class="h-6 w-6 {buildType === 'dockerfile' ? 'text-primary-600' : 'text-gray-400'}" />
										<div class="text-center">
											<div class="font-medium text-sm {buildType === 'dockerfile' ? 'text-primary-700 dark:text-primary-400' : ''}">Dockerfile</div>
											<p class="text-xs text-gray-500 mt-0.5">Build from a Dockerfile</p>
										</div>
									</button>
									<button
										type="button"
										onclick={() => buildType = 'railpack'}
										class="flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all {buildType === 'railpack' ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/20' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'}"
									>
										<svg class="h-6 w-6 {buildType === 'railpack' ? 'text-primary-600' : 'text-gray-400'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M12 2L2 7l10 5 10-5-10-5z" />
											<path d="M2 17l10 5 10-5" />
											<path d="M2 12l10 5 10-5" />
										</svg>
										<div class="text-center">
											<div class="font-medium text-sm {buildType === 'railpack' ? 'text-primary-700 dark:text-primary-400' : ''}">Railpack</div>
											<p class="text-xs text-gray-500 mt-0.5">Auto-detect & build</p>
										</div>
									</button>
								</div>
								{#if buildType === 'railpack'}
									<p class="text-xs text-gray-500 mt-2">Railpack automatically detects your app's language and framework to build an optimized container image.</p>
								{/if}
							</div>

							<!-- Dockerfile-specific fields -->
							{#if buildType === 'dockerfile'}
								<div class="relative" data-dockerfile-dropdown>
									<label class="block text-sm font-medium mb-2">Dockerfile</label>
									<div class="relative">
										<input
											type="text"
											bind:value={dockerfileSearch}
											oninput={(e) => handleDockerfileInput((e.target as HTMLInputElement).value)}
											placeholder="Dockerfile"
											class="input font-mono"
										/>
										{#if loadingDockerfiles}
											<div class="absolute right-3 top-1/2 -translate-y-1/2">
												<Loader2 class="h-4 w-4 animate-spin text-primary-600" />
											</div>
										{/if}
									</div>
									{#if showDockerfileDropdown && dockerfileSearch && !loadingDockerfiles && dockerfiles.length > 0}
										<div
											class="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border p-2 shadow"
											style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
										>
											{#each dockerfiles.filter((d) => d.toLowerCase().includes(dockerfileSearch.toLowerCase())) as df}
												<button
													onclick={() => selectDockerfile(df)}
													class="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)] font-mono"
												>
													<span class="truncate">{df}</span>
												</button>
											{/each}
										</div>
									{/if}
								</div>
								{#if dockerfilePath && dockerfileStages.length > 0}
									<div>
										<label class="block text-sm font-medium mb-2">Build Stage</label>
										<select class="input" value={selectedStage} onchange={(e) => { selectedStage = (e.target as HTMLSelectElement).value; }}>
											{#each dockerfileStages as stage}
												<option value={stage}>{stage}</option>
											{/each}
										</select>
										<p class="text-xs text-gray-500 mt-1">Select which stage to build from the multi-stage Dockerfile</p>
									</div>
								{/if}
								{#if dockerfilePath}
									<label class="flex items-center gap-3">
										<input type="checkbox" bind:checked={buildFromRoot} class="rounded" />
										<div>
											<span class="font-medium">Build from root</span>
											<p class="text-xs text-gray-500">Build from the repository root instead of the Dockerfile directory</p>
										</div>
									</label>
								{/if}
							{/if}
						{/if}
					{/if}
				{/if}

				<label class="flex items-center gap-3">
					<input type="checkbox" bind:checked={exposePublic} class="rounded" />
					<div>
						<span class="font-medium">Expose service publicly</span>
						<p class="text-xs text-gray-500">Creates a NodePort service for external access</p>
					</div>
				</label>
			</div>

			<!-- Ports -->
			<div class="card p-6">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold">Ports</h2>
					<button onclick={addPort} class="btn btn-secondary btn-sm">
						<Plus class="h-4 w-4" />
						Add port
					</button>
				</div>
				<div class="space-y-3">
					{#each ports as port, index}
						<div class="grid gap-3 md:grid-cols-5 items-end">
							<div>
								<label class="block text-xs font-medium text-gray-500 mb-1">Name</label>
								<input type="text" bind:value={port.name} placeholder="http" class="input" />
							</div>
							<div>
								<label class="block text-xs font-medium text-gray-500 mb-1">Container</label>
								<input type="number" bind:value={port.containerPort} min="1" class="input" />
							</div>
							<div>
								<label class="block text-xs font-medium text-gray-500 mb-1">Service</label>
								<input type="number" bind:value={port.servicePort} min="1" class="input" />
							</div>
							<div>
								<label class="block text-xs font-medium text-gray-500 mb-1">Protocol</label>
								<select bind:value={port.protocol} class="input">
									<option value="TCP">TCP</option>
									<option value="UDP">UDP</option>
								</select>
							</div>
							<button onclick={() => removePort(index)} disabled={ports.length <= 1} class="btn btn-ghost">
								<Trash2 class="h-4 w-4" />
							</button>
						</div>
					{/each}
				</div>
			</div>

			<!-- Volumes -->
			<div class="card p-6">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold flex items-center gap-2">
						<HardDrive class="h-5 w-5" />
						Volumes
					</h2>
					<button onclick={addVolume} class="btn btn-secondary btn-sm">
						<Plus class="h-4 w-4" />
						Add volume
					</button>
				</div>
				<div class="space-y-4">
					{#each volumes as volume, index}
						<div class="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
							<div class="flex items-center justify-between">
								<h3 class="font-medium text-sm">Volume {index + 1}</h3>
								<button onclick={() => removeVolume(index)} class="btn btn-ghost btn-sm">
									<Trash2 class="h-4 w-4" />
								</button>
							</div>
							<div class="grid gap-3 md:grid-cols-2">
								<div>
									<label class="block text-xs font-medium text-gray-500 mb-1">Name</label>
									<input type="text" bind:value={volume.name} placeholder="data" class="input" />
								</div>
								<div>
									<label class="block text-xs font-medium text-gray-500 mb-1">Type</label>
									<select bind:value={volume.type} class="input">
										<option value="pvc">Persistent Volume Claim (PVC)</option>
										<option value="hostPath">Host Path</option>
										<option value="emptyDir">Empty Directory</option>
									</select>
								</div>
								<div class="md:col-span-2">
									<label class="block text-xs font-medium text-gray-500 mb-1">Mount Path</label>
									<input type="text" bind:value={volume.mountPath} placeholder="/data" class="input font-mono" />
								</div>
								{#if volume.type === 'pvc'}
									<div class="md:col-span-2">
										<label class="block text-xs font-medium text-gray-500 mb-1">PVC Name</label>
										<input type="text" bind:value={volume.pvcName} placeholder="my-pvc" class="input font-mono" />
									</div>
								{:else if volume.type === 'hostPath'}
									<div class="md:col-span-2">
										<label class="block text-xs font-medium text-gray-500 mb-1">Host Path</label>
										<input type="text" bind:value={volume.hostPath} placeholder="/host/path" class="input font-mono" />
									</div>
								{/if}
								<div class="md:col-span-2">
									<label class="flex items-center gap-2">
										<input type="checkbox" bind:checked={volume.readOnly} class="rounded" />
										<span class="text-sm">Read-only</span>
									</label>
								</div>
							</div>
						</div>
					{:else}
						<p class="text-sm text-gray-500 text-center py-4">No volumes configured</p>
					{/each}
				</div>
			</div>

			<!-- Environment Variables -->
			<div class="card p-6">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold">Environment Variables</h2>
					<button onclick={addEnvVar} class="btn btn-secondary btn-sm">
						<Plus class="h-4 w-4" />
						Add variable
					</button>
				</div>
				<div class="mb-4 max-w-2xl">
					<details class="group">
						<summary class="cursor-pointer text-sm text-gray-600 hover:text-gray-900 mb-2">
							Paste from file (key=value format)
						</summary>
						<div class="mt-2 space-y-2">
							<textarea
								bind:value={envPasteText}
								placeholder="KEY1=value1&#10;KEY2=value2&#10;# Comments are ignored"
								class="input font-mono text-sm min-h-[100px]"
							></textarea>
							<div class="flex items-center justify-between">
								<p class="text-xs text-gray-500">Paste your .env file content here. Each line should be in KEY=value format.</p>
								<button onclick={parseEnvVars} disabled={!envPasteText.trim()} class="btn btn-secondary btn-sm">
									Parse
								</button>
							</div>
						</div>
					</details>
				</div>
				<div class="space-y-2 max-h-64 overflow-y-auto max-w-2xl">
					{#each envVars as env, index}
						{@const isRevealed = revealedIndices.has(index)}
						<div class="grid gap-2 grid-cols-[140px_1fr_auto]">
							<input type="text" bind:value={env.key} placeholder="KEY" class="input font-mono min-w-0" />
							<div class="flex gap-2 min-w-0">
								<input
									type={isRevealed ? 'text' : 'password'}
									bind:value={env.value}
									placeholder="value"
									class="input font-mono flex-1 min-w-0"
								/>
								<button
									type="button"
									onclick={() => toggleReveal(index)}
									class="btn btn-ghost shrink-0"
									aria-label={isRevealed ? 'Hide value' : 'Show value'}
								>
									{#if isRevealed}
										<EyeOff class="h-4 w-4" />
									{:else}
										<Eye class="h-4 w-4" />
									{/if}
								</button>
							</div>
							<button onclick={() => removeEnvVar(index)} disabled={envVars.length <= 1} class="btn btn-ghost shrink-0">
								<Trash2 class="h-4 w-4" />
							</button>
						</div>
					{/each}
				</div>
			</div>

			{#if formError}
				<div class="alert alert-error">{formError}</div>
			{/if}

			<div class="flex justify-end gap-3">
				<a href="/{orgSlug}/workspaces/{workspaceSlug}/projects/{projectSlug}" class="btn btn-secondary">Cancel</a>
				<button onclick={submit} disabled={submitting} class="btn btn-primary">
					{#if submitting}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Create deployment
				</button>
			</div>
		</div>
	{/if}
</div>
