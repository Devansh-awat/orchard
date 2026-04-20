<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree, isSuperAdmin, fetchProjectContext, buildBasePath, type ProjectContext } from '$lib/stores';
	import { Loader2, Container, Github, Plus, Trash2, Eye, EyeOff } from 'lucide-svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';

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

	// Deployment source — read from ?source= query param, default to 'image'
	const initialSource = $derived(($page.url.searchParams.get('source') === 'github') ? 'github' as const : 'image' as const);
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
	let buildWithDepot = $state(false);
	let envPasteText = $state('');
	let envPasteMode = $state(false);
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
			const repo = selectedRepo;
			dockerfileInputTimeout = setTimeout(() => {
				fetchDockerfileStages(repo, branch, value);
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
		deploymentSource = initialSource;
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
		<h1 class="nd-page-title">New Deployment</h1>

		<!-- ═══ Source card ═══ -->
		<div class="nd-main-card">
			<div class="nd-tabs">
				<button class="nd-tab" class:nd-tab-active={deploymentSource === 'image'} onclick={() => (deploymentSource = 'image')}>
					<Container class="h-4 w-4" /> Docker Image
				</button>
				<button class="nd-tab" class:nd-tab-active={deploymentSource === 'github'} onclick={() => (deploymentSource = 'github')}>
					<Github class="h-4 w-4" /> GitHub
				</button>
			</div>

			<div class="nd-owner-row">
				<ProjectSwitcher currentProjectName={project?.name || projectSlug} pathSuffix={`/deployments/new?source=${deploymentSource}`} />
				<span class="nd-slash">/</span>
				<input type="text" bind:value={name} placeholder="deployment-name" class="nd-name-input" />
			</div>

			<div class="nd-card-body">
				{#if deploymentSource === 'image'}
					<div class="nd-field">
						<label class="nd-label">Docker image</label>
						<input type="text" bind:value={image} placeholder="ghcr.io/org/app:latest" class="nd-input nd-mono" />
					</div>
				{:else}
					{#if !githubLinked}
						<div class="nd-warning">
							<p class="nd-warning-title">GitHub account not connected</p>
							<p class="nd-warning-desc">Link your GitHub account to deploy from repositories.</p>
							<a href="/user/settings" class="nd-btn nd-btn-secondary" style="margin-top: 0.5rem;">Connect GitHub</a>
						</div>
					{:else}
						<div class="nd-field nd-relative" data-repo-dropdown>
							<label class="nd-label">Repository</label>
							<div class="nd-relative">
								<input type="text" bind:value={repoSearch}
									oninput={(e) => handleRepoSearchInput((e.target as HTMLInputElement).value)}
									onfocus={() => { if (!selectedRepo) showRepoDropdown = repoSearch.length > 0; }}
									placeholder={loadingRepos ? "Loading repositories..." : selectedRepo ? selectedRepo.full_name : "Search repositories..."}
									class="nd-input" disabled={loadingRepos} readonly={selectedRepo !== null || loadingRepos}
									style={selectedRepo ? "opacity: 0.7;" : ""} />
								{#if loadingRepos}
									<div class="nd-input-suffix"><Loader2 class="h-4 w-4 animate-spin" /></div>
								{:else if selectedRepo}
									<button onclick={clearRepoSelection} class="nd-input-suffix nd-input-clear" type="button">
										<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
									</button>
								{/if}
							</div>
							{#if showRepoDropdown && repoSearch && !loadingRepos && !selectedRepo}
								<div class="nd-dropdown">
									{#each repositories.filter((r) => r.full_name.toLowerCase().includes(repoSearch.toLowerCase())) as repo}
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

						{#if selectedRepo}
							<div class="nd-field nd-relative" data-branch-dropdown>
								<label class="nd-label">Branch</label>
								<div class="nd-relative">
									<input type="text" bind:value={branchSearch}
										oninput={(e) => handleBranchSearchInput((e.target as HTMLInputElement).value)}
										onfocus={() => { if (!selectedBranch) showBranchDropdown = branchSearch.length > 0; }}
										placeholder={selectedBranch ? selectedBranch.name : "Search branches..."}
										class="nd-input" disabled={loadingBranches} readonly={selectedBranch !== null}
										style={selectedBranch ? "opacity: 0.7;" : ""} />
									{#if selectedBranch}
										<button onclick={clearBranchSelection} class="nd-input-suffix nd-input-clear" type="button">
											<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
										</button>
									{/if}
								</div>
								{#if showBranchDropdown && branchSearch && !loadingBranches && !selectedBranch}
									<div class="nd-dropdown">
										{#each branches.filter((b) => b.name.toLowerCase().includes(branchSearch.toLowerCase())) as b}
											<button onclick={() => selectBranch(b)} class="nd-dropdown-item"><span class="nd-truncate">{b.name}</span></button>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						{#if selectedBranch}
							<div class="nd-field">
								<label class="nd-label">Build Method</label>
								<div class="nd-grid-2">
									<button type="button" onclick={() => buildType = 'dockerfile'} class="nd-build-option" class:nd-build-active={buildType === 'dockerfile'}>
										<Container class="h-5 w-5" />
										<div><div class="nd-build-label">Dockerfile</div><p class="nd-build-desc">Build from a Dockerfile</p></div>
									</button>
									<button type="button" onclick={() => buildType = 'railpack'} class="nd-build-option" class:nd-build-active={buildType === 'railpack'}>
										<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>
										<div><div class="nd-build-label">Railpack</div><p class="nd-build-desc">Auto-detect & build</p></div>
									</button>
								</div>
								{#if buildType === 'railpack'}
									<p class="nd-hint" style="margin-top: 0.5rem;">Railpack automatically detects your app's language and framework to build an optimized container image.</p>
								{/if}
							</div>

							{#if buildType === 'dockerfile'}
								<div class="nd-field nd-relative" data-dockerfile-dropdown>
									<label class="nd-label">Dockerfile</label>
									<div class="nd-relative">
										<input type="text" bind:value={dockerfileSearch} oninput={(e) => handleDockerfileInput((e.target as HTMLInputElement).value)} placeholder="Dockerfile" class="nd-input nd-mono" />
										{#if loadingDockerfiles}<div class="nd-input-suffix"><Loader2 class="h-4 w-4 animate-spin" /></div>{/if}
									</div>
									{#if showDockerfileDropdown && dockerfileSearch && !loadingDockerfiles && dockerfiles.length > 0}
										<div class="nd-dropdown">
											{#each dockerfiles.filter((d) => d.toLowerCase().includes(dockerfileSearch.toLowerCase())) as df}
												<button onclick={() => selectDockerfile(df)} class="nd-dropdown-item nd-mono"><span class="nd-truncate">{df}</span></button>
											{/each}
										</div>
									{/if}
								</div>
								{#if dockerfilePath && dockerfileStages.length > 0}
									<div class="nd-field">
										<label class="nd-label">Build Stage</label>
										<select class="nd-input" value={selectedStage} onchange={(e) => { selectedStage = (e.target as HTMLSelectElement).value; }}>
											{#each dockerfileStages as stage}<option value={stage}>{stage}</option>{/each}
										</select>
										<p class="nd-hint">Select which stage to build from the multi-stage Dockerfile</p>
									</div>
								{/if}
							{/if}
						{/if}
					{/if}
				{/if}
			</div>
		</div>

		<!-- ═══ Networking ═══ -->
		<div class="nd-card">
			<div class="nd-card-header">
				<h2 class="nd-card-title">Networking</h2>
				<button onclick={addPort} class="nd-btn nd-btn-secondary nd-btn-sm"><Plus class="h-4 w-4" /> Add port</button>
			</div>
			<div class="nd-stack">
				{#each ports as port, index}
					<div class="nd-port-row">
						<div class="nd-field">
							<label class="nd-label-sm">Name</label>
							<input type="text" bind:value={port.name} placeholder="http" class="nd-input" />
						</div>
						<div class="nd-field">
							<label class="nd-label-sm">Container</label>
							<input type="number" bind:value={port.containerPort} min="1" class="nd-input" />
						</div>
						<div class="nd-field">
							<label class="nd-label-sm">Service</label>
							<input type="number" bind:value={port.servicePort} min="1" class="nd-input" />
						</div>
						<div class="nd-field">
							<label class="nd-label-sm">Protocol</label>
							<select bind:value={port.protocol} class="nd-input">
								<option value="TCP">TCP</option>
								<option value="UDP">UDP</option>
							</select>
						</div>
						<button onclick={() => removePort(index)} disabled={ports.length <= 1} class="nd-icon-btn nd-icon-btn-danger">
							<Trash2 class="h-4 w-4" />
						</button>
					</div>
				{/each}
			</div>
		</div>

		<!-- ═══ Environment Variables ═══ -->
		<div class="nd-card">
			<div class="nd-card-header">
				<h2 class="nd-card-title">Environment Variables</h2>
			</div>

			<!-- Env mode tabs -->
			<div class="nd-env-tabs">
				<button class="nd-env-tab" class:nd-env-tab-active={!envPasteMode} onclick={() => envPasteMode = false}>Editor</button>
				<button class="nd-env-tab" class:nd-env-tab-active={envPasteMode} onclick={() => envPasteMode = true}>Paste .env</button>
			</div>

			{#if envPasteMode}
				<div class="nd-env-paste-area">
					<textarea
						bind:value={envPasteText}
						placeholder={"# Paste your .env file here\nDATABASE_URL=postgres://...\nSECRET_KEY=abc123"}
						class="nd-input nd-mono nd-textarea"
					></textarea>
					<button onclick={parseEnvVars} disabled={!envPasteText.trim()} class="nd-btn nd-btn-primary nd-btn-sm" style="align-self: flex-end;">
						Import variables
					</button>
				</div>
			{:else}
				<div class="nd-env-list">
					{#each envVars as env, index}
						{@const isRevealed = revealedIndices.has(index)}
						<div class="nd-env-row">
							<input type="text" bind:value={env.key} placeholder="KEY" class="nd-input nd-mono nd-env-key" />
							<div class="nd-env-value-wrap">
								<input type={isRevealed ? 'text' : 'password'} bind:value={env.value} placeholder="value" class="nd-input nd-mono" />
								<button type="button" onclick={() => toggleReveal(index)} class="nd-icon-btn" aria-label={isRevealed ? 'Hide value' : 'Show value'}>
									{#if isRevealed}<EyeOff class="h-4 w-4" />{:else}<Eye class="h-4 w-4" />{/if}
								</button>
							</div>
							<button onclick={() => removeEnvVar(index)} disabled={envVars.length <= 1} class="nd-icon-btn nd-icon-btn-danger">
								<Trash2 class="h-4 w-4" />
							</button>
						</div>
					{/each}
				</div>
				<button onclick={addEnvVar} class="nd-btn nd-btn-secondary nd-btn-sm" style="align-self: flex-start;">
					<Plus class="h-4 w-4" /> Add variable
				</button>
			{/if}
		</div>

		<!-- ═══ Storage ═══ -->
		<div class="nd-card">
			<div class="nd-card-header">
				<h2 class="nd-card-title">Storage</h2>
				<button onclick={addVolume} class="nd-btn nd-btn-secondary nd-btn-sm"><Plus class="h-4 w-4" /> Add volume</button>
			</div>
			<div class="nd-stack">
				{#each volumes as volume, index}
					<div class="nd-volume-item">
						<div class="nd-volume-header">
							<span class="nd-volume-num">Volume {index + 1}</span>
							<button onclick={() => removeVolume(index)} class="nd-icon-btn nd-icon-btn-danger"><Trash2 class="h-4 w-4" /></button>
						</div>
						<div class="nd-grid-2">
							<div class="nd-field">
								<label class="nd-label-sm">Name</label>
								<input type="text" bind:value={volume.name} placeholder="data" class="nd-input" />
							</div>
							<div class="nd-field">
								<label class="nd-label-sm">Type</label>
								<select bind:value={volume.type} class="nd-input">
									<option value="pvc">Persistent Volume Claim</option>
									<option value="hostPath">Host Path</option>
									<option value="emptyDir">Empty Directory</option>
								</select>
							</div>
						</div>
						<div class="nd-field">
							<label class="nd-label-sm">Mount Path</label>
							<input type="text" bind:value={volume.mountPath} placeholder="/data" class="nd-input nd-mono" />
						</div>
						{#if volume.type === 'pvc'}
							<div class="nd-field">
								<label class="nd-label-sm">PVC Name</label>
								<input type="text" bind:value={volume.pvcName} placeholder="my-pvc" class="nd-input nd-mono" />
							</div>
						{:else if volume.type === 'hostPath'}
							<div class="nd-field">
								<label class="nd-label-sm">Host Path</label>
								<input type="text" bind:value={volume.hostPath} placeholder="/host/path" class="nd-input nd-mono" />
							</div>
						{/if}
						<label class="nd-checkbox-row">
							<input type="checkbox" bind:checked={volume.readOnly} class="nd-checkbox" />
							<span class="nd-checkbox-label-sm">Read-only</span>
						</label>
					</div>
				{:else}
					<p class="nd-empty-text">No volumes configured</p>
				{/each}
			</div>
		</div>

		<!-- ═══ Advanced ═══ -->
		<div class="nd-card">
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
					<label class="nd-checkbox-row">
						<input type="checkbox" bind:checked={exposePublic} class="nd-checkbox" />
						<div>
							<span class="nd-checkbox-label">Expose service publicly</span>
							<p class="nd-hint">Creates a NodePort service for external access</p>
						</div>
					</label>
					{#if deploymentSource === 'github' && dockerfilePath}
						<label class="nd-checkbox-row">
							<input type="checkbox" bind:checked={buildFromRoot} class="nd-checkbox" />
							<div>
								<span class="nd-checkbox-label">Build from root</span>
								<p class="nd-hint">Build from the repository root instead of the Dockerfile directory</p>
							</div>
						</label>
					{/if}
					{#if $isSuperAdmin && deploymentSource === 'github'}
						<label class="nd-checkbox-row">
							<input type="checkbox" bind:checked={buildWithDepot} class="nd-checkbox" />
							<div>
								<span class="nd-checkbox-label">Orchard's Super Builds</span>
								<p class="nd-hint">Use Orchard's high-performance hosted builders for faster builds</p>
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
			<a href={basePath} class="nd-btn nd-btn-secondary">Cancel</a>
			<button onclick={submit} disabled={submitting} class="nd-btn nd-btn-primary">
				{#if submitting}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				Create deployment
			</button>
		</div>
	{/if}
</div>

<style>
	.nd-page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	/* Page title */
	.nd-page-title {
		font-size: 1.375rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0 0 1.25rem;
		letter-spacing: -0.02em;
	}

	/* Main card — contains tabs, owner row, form */
	.nd-main-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		margin-bottom: 1.25rem;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* Tabs inside card */
	.nd-tabs {
		display: flex;
		background-color: color-mix(in srgb, var(--surface-border) 20%, transparent);
		border-bottom: 1px solid var(--surface-border);
	}

	.nd-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.6875rem 1.25rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		background: transparent;
		color: var(--surface-muted);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition: color 0.15s, background-color 0.15s;
	}

	.nd-tab:hover {
		color: var(--center-channel-color);
	}

	.nd-tab-active {
		color: var(--sidebar-text-active-border);
		border-bottom-color: var(--sidebar-text-active-border);
		background-color: var(--surface-bg);
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
	}

	/* Cards */
	.nd-card {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		padding: 1.25rem;
		margin-bottom: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
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
		z-index: 20;
		margin-top: 0.25rem;
		max-height: 12rem;
		width: 100%;
		overflow-y: auto;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		padding: 0.375rem;
		background-color: var(--surface-bg);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.12);
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
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background: transparent;
		cursor: pointer;
		text-align: left;
		color: var(--surface-muted);
		transition: border-color 0.15s, box-shadow 0.15s;
	}

	.nd-build-option:hover {
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.nd-build-active {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent);
		color: var(--sidebar-text-active-border);
	}

	.nd-build-label {
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

	/* Volumes */
	.nd-volume-item {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.nd-volume-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.nd-volume-num {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.nd-empty-text {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		text-align: center;
		padding: 1rem 0;
		margin: 0;
	}

	/* Env tabs */
	.nd-env-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--surface-border);
		margin-bottom: 0.25rem;
	}

	.nd-env-tab {
		padding: 0.375rem 0.75rem;
		font-size: 0.75rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		background: transparent;
		color: var(--surface-muted);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition: color 0.15s;
	}

	.nd-env-tab:hover {
		color: var(--center-channel-color);
	}

	.nd-env-tab-active {
		color: var(--sidebar-text-active-border);
		border-bottom-color: var(--sidebar-text-active-border);
	}

	.nd-env-paste-area {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
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

	.nd-env-list {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		max-height: 16rem;
		overflow-y: auto;
	}

	.nd-env-row {
		display: grid;
		grid-template-columns: 9rem 1fr auto;
		gap: 0.375rem;
		align-items: center;
	}

	.nd-env-key {
		min-width: 0;
	}

	.nd-env-value-wrap {
		display: flex;
		gap: 0.375rem;
		min-width: 0;
	}

	.nd-env-value-wrap .nd-input {
		flex: 1;
		min-width: 0;
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
		background-color: var(--sidebar-text-active-border);
		color: #fff;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.08), 0 1px 1px rgb(0 0 0 / 0.04);
	}

	.nd-btn-primary:hover:not(:disabled) {
		opacity: 0.95;
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
		transition: color 0.15s, background-color 0.15s;
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

	/* Actions footer */
	.nd-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.5rem;
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
