<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		apiFetch,
		toasts,
		isSuperAdmin,
		fetchProjectContext,
		buildBasePath,
		selectedOrganization,
		type ProjectContext
	} from '$lib/stores';
	import {
		ArrowRight,
		Container,
		FolderOpen,
		GitBranch,
		Github,
		Lock,
		Plus,
		Trash2
	} from 'lucide-svelte';
	import { formatCpu, formatMemory, rawToEnvVars } from '$lib/utils/format';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import { EnvironmentSwitcher } from '$lib/components/environment';
	import RepoAccountPicker from '$lib/components/deployment/RepoAccountPicker.svelte';
	import GitSourcePane from '$lib/components/deployment/GitSourcePane.svelte';
	import FrameworkIcon from '$lib/components/deployment/FrameworkIcon.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import ResourceList from '$lib/components/patterns/ResourceList.svelte';
	import SourcePath from '$lib/components/patterns/SourcePath.svelte';
	import {
		Alert,
		Badge,
		Breadcrumbs,
		Button,
		Disclosure,
		Divider,
		Dropdown,
		EnvVarEditor,
		Field,
		FormActions,
		Input,
		Page,
		SearchPicker,
		SectionCard,
		SegmentedControl,
		SelectTrigger,
		Skeleton,
		Stack,
		Stepper,
		Switch,
		ToggleRow,
		type DropdownOption
	} from '$lib/components/ui';
	import {
		frameworkLabel,
		appDirLabel,
		FRAMEWORK_CHOICES,
		FRAMEWORK_PRESETS,
		isMutableTag,
		type DetectedApp
	} from '$lib/components/deployment/deployment-helpers';

	const DOCKERFILE_OPTION = '__dockerfile';
	const FRAMEWORK_OPTIONS = [
		{ value: DOCKERFILE_OPTION, label: 'Dockerfile' },
		...FRAMEWORK_CHOICES.map((fw) => ({ value: fw, label: frameworkLabel(fw) ?? fw }))
	];
	const SOURCE_OPTIONS = [
		{ value: 'image', label: 'Image', icon: Container },
		{ value: 'github', label: 'GitHub', icon: Github },
		{ value: 'git', label: 'Git', icon: GitBranch }
	];
	const PROTOCOL_OPTIONS = [
		{ value: 'TCP', label: 'TCP' },
		{ value: 'UDP', label: 'UDP' }
	];
	const ENV_MODE_OPTIONS = [
		{ value: 'grid', label: 'Editor' },
		{ value: 'raw', label: 'Raw' }
	];

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
	let seededPendingProject = false;

	const initialSource = $derived(
		$page.url.searchParams.get('source') === 'github'
			? ('github' as const)
			: $page.url.searchParams.get('source') === 'git'
				? ('git' as const)
				: ('image' as const)
	);
	let deploymentSource = $state<'image' | 'github' | 'git'>('image');
	let gitSelection = $state<{
		connectionId: string;
		repoUrl: string;
		repoPath: string;
		branch: string;
		externalRepoId: string | null;
	} | null>(null);
	let selectedEnvId = $state($page.url.searchParams.get('env') ?? '');
	let githubLinked = $state(false);
	let hasGitHubApp = $state(false);
	let githubAppInstallUrl = $state<string | null>(null);
	let repositories = $state<Repository[]>([]);
	let branches = $state<Branch[]>([]);
	let dockerfiles = $state<string[]>([]);
	let loadingRepos = $state(false);
	let loadingBranches = $state(false);
	let loadingDockerfiles = $state(false);
	let detectRun = 0;
	let reposError = $state<string | null>(null);

	let selectedRepo = $state<Repository | null>(null);
	let selectedBranch = $state<Branch | null>(null);
	let repoSearch = $state('');
	let repoQuery = $state('');
	let branchSearch = $state('');
	let dockerfileSearch = $state('Dockerfile');
	let dockerfileStages = $state<string[]>([]);
	let loadingStages = $state(false);
	let selectedStage = $state<string>('');
	let dockerfileInputTimeout: ReturnType<typeof setTimeout> | null = null;

	let name = $state('');
	let image = $state('');
	let imagePullPolicy = $state<'Always' | 'IfNotPresent' | 'auto'>('auto');
	let imageStartCommand = $state('');
	let repoUrl = $state('');
	let branch = $state('');
	let buildType = $state<'dockerfile' | 'railpack'>('dockerfile');
	let buildTypeTouched = false;
	let detectedFramework = $state<string | null>(null);
	let detectedApps = $state<DetectedApp[]>([]);
	let isWorkspace = $state(false);
	let detectedScore = $state<{
		file: string;
		name: string;
		ports: number[];
		resources: { name: string; type: string }[];
		domain: string | null;
		warnings: string[];
	} | null>(null);
	let rootDirectory = $state('');
	let rootDirectoryTouched = false;
	let installCommand = $state('');
	let buildCommand = $state('');
	let startCommand = $state('');
	let outputDirectory = $state('');
	let buildSettingsTouched = false;
	let dockerfilePath = $state('Dockerfile');
	let buildFromRoot = $state(false);
	let replicas = $state(1);
	let exposePublic = $state(false);
	let autoUrl = $state(true);
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let ports = $state([{ name: 'http', containerPort: 80, servicePort: 80, protocol: 'TCP' }]);
	let portsManuallyEdited = $state(false);
	let envVars = $state([{ key: '', value: '' }]);
	let envsManuallyEdited = $state(false);
	let buildWithDepot = $state(false);
	let envViewMode = $state<'grid' | 'raw'>('grid');
	let envRawText = $state('');
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
				if (data.source === 'app') {
					hasGitHubApp = true;
				}
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
		dockerfiles = [];
		dockerfilePath = 'Dockerfile';
		dockerfileSearch = 'Dockerfile';
		buildFromRoot = false;

		if (repo.default_branch) fetchDockerfiles(repo, repo.default_branch);

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
					if (!repo.default_branch) fetchDockerfiles(repo, defaultBranch.name);
				}
			}
		} catch (e) {
			console.error('Failed to fetch branches:', e);
		} finally {
			loadingBranches = false;
		}
	}

	const frameworkValue = $derived.by(() => {
		if (buildType === 'dockerfile') return DOCKERFILE_OPTION;
		const fw = detectedFramework ?? 'node';
		return FRAMEWORK_OPTIONS.some((o) => o.value === fw) ? fw : 'node';
	});

	const rootDirectoryOptions = $derived(
		detectedApps.map((app) => ({
			value: app.dir,
			label: appDirLabel(app.dir),
			description: frameworkLabel(app.framework) ?? undefined
		}))
	);

	function frameworkOfDir(dir: string): string | null {
		return detectedApps.find((a) => a.dir === dir)?.framework ?? null;
	}

	function onFrameworkPicked(value: string) {
		buildTypeTouched = true;
		if (value === DOCKERFILE_OPTION) {
			buildType = 'dockerfile';
			if (!dockerfilePath.trim()) {
				dockerfilePath = dockerfiles[0] ?? 'Dockerfile';
				dockerfileSearch = dockerfilePath;
			}
			return;
		}
		buildType = 'railpack';
		detectedFramework = value;
		const preset = FRAMEWORK_PRESETS[value];
		if (preset && !buildSettingsTouched) {
			outputDirectory = preset.outputDirectory ?? '';
			if (!portsManuallyEdited) {
				ports = [
					{ name: 'port-1', containerPort: preset.port, servicePort: preset.port, protocol: 'TCP' }
				];
			}
		}
	}

	function applyDetectedApp(app: DetectedApp | undefined) {
		detectedFramework = app?.framework ?? detectedFramework;
		installCommand = app?.installCommand ?? '';
		buildCommand = app?.buildCommand ?? '';
		startCommand = app?.startCommand ?? '';
		outputDirectory = app?.outputDirectory ?? '';
	}

	function selectRootDirectory(app: DetectedApp) {
		rootDirectory = app.dir;
		rootDirectoryTouched = true;
		if (!buildSettingsTouched) applyDetectedApp(app);
	}

	type DetectionResult = {
		buildType: 'dockerfile' | 'railpack';
		dockerfilePath: string | null;
		dockerfiles: string[];
		stages: string[];
		ports: number[];
		env: { key: string; value: string }[];
		framework: string | null;
		apps?: DetectedApp[];
		workspace?: { isWorkspace: boolean; packageManager: string };
		score?: {
			file: string;
			name: string;
			ports: number[];
			resources: { name: string; type: string }[];
			domain: string | null;
			warnings: string[];
		} | null;
		rootDirectory?: string | null;
	};

	function applyDetection(det: DetectionResult) {
		dockerfiles = det.dockerfiles;
		detectedFramework = det.framework;
		detectedApps = det.apps ?? [];
		isWorkspace = det.workspace?.isWorkspace ?? false;
		detectedScore = det.score ?? null;
		if (!buildTypeTouched) {
			buildType = det.buildType;
		}
		if (!rootDirectoryTouched) {
			rootDirectory = det.rootDirectory ?? '';
		}
		if (!buildSettingsTouched) {
			applyDetectedApp(detectedApps.find((a) => a.dir === rootDirectory));
		}
		if (det.buildType === 'dockerfile' && det.dockerfilePath) {
			dockerfilePath = det.dockerfilePath;
			dockerfileSearch = det.dockerfilePath;
			dockerfileStages = det.stages;
			selectedStage = '';
		}
		if (det.ports.length > 0 && !portsManuallyEdited) {
			ports = det.ports.map((p, i) => ({
				name: `port-${i + 1}`,
				containerPort: p,
				servicePort: p,
				protocol: 'TCP'
			}));
		}
		if (det.env.length > 0 && !envsManuallyEdited) {
			envVars = det.env.map((e) => ({ key: e.key, value: e.value }));
		}
	}

	async function fetchDockerfiles(repo: Repository, branchName: string) {
		const run = ++detectRun;
		loadingDockerfiles = true;
		dockerfiles = [];

		try {
			const [owner, repoName] = repo.full_name.split('/');
			const response = await apiFetch(
				`/apiv1/github/repositories/${owner}/${repoName}/detect?branch=${encodeURIComponent(branchName)}`
			);
			if (!response.ok || run !== detectRun) return;
			applyDetection(await response.json());
		} catch (e) {
			console.error('Failed to detect repo config:', e);
		} finally {
			if (run === detectRun) loadingDockerfiles = false;
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

				dockerfileStages = info.stages;
				selectedStage = '';

				if (info.exposedPorts.length > 0 && !portsManuallyEdited) {
					ports = info.exposedPorts.map((p, i) => ({
						name: `port-${i + 1}`,
						containerPort: p,
						servicePort: p,
						protocol: 'TCP'
					}));
				}

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

	let nameTouched = false;

	function suggestName(repoFullName: string) {
		if (nameTouched || name) return;
		const repoName = repoFullName.split('/').pop() ?? '';
		name = repoName
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}

	function selectAccount(login: string) {
		selectedAccount = login;
	}

	function selectRepo(repo: Repository) {
		selectedAccount = repo.full_name.split('/')[0];
		selectedRepo = repo;
		repoUrl = repo.clone_url;
		repoSearch = repo.full_name;
		suggestName(repo.full_name);
		fetchBranches(repo);
	}

	function confirmManualRepo(parsed: { owner: string; repo: string; url: string }) {
		selectedRepo = null;
		selectedAccount = parsed.owner;
		repoSearch = `${parsed.owner}/${parsed.repo}`;
		repoUrl = parsed.url;
		suggestName(`${parsed.owner}/${parsed.repo}`);
		fetchBranchesManual(parsed.owner, parsed.repo);
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
	}

	function parseRepoInput(value: string): { owner: string; repo: string; url: string } | null {
		const urlMatch = value.match(/(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?.]+)/);
		if (urlMatch) {
			const owner = urlMatch[1];
			const repo = urlMatch[2].replace(/\.git$/, '');
			return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
		}
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
					const defaultBranch =
						branches.find((b) => b.name === 'main') ??
						branches.find((b) => b.name === 'master') ??
						branches[0];
					selectedBranch = defaultBranch;
					branch = defaultBranch.name;
					branchSearch = defaultBranch.name;
					const dfResponse = await apiFetch(
						`/apiv1/github/repositories/${owner}/${repoName}/dockerfiles?branch=${encodeURIComponent(defaultBranch.name)}`
					);
					if (dfResponse.ok) {
						dockerfiles = await dfResponse.json();
					}
				}
			}
		} catch (e) {
			console.error('Failed to fetch branches:', e);
		} finally {
			loadingBranches = false;
		}
	}

	function selectBranch(b: Branch) {
		selectedBranch = b;
		branch = b.name;
		branchSearch = b.name;
		if (selectedRepo) {
			fetchDockerfiles(selectedRepo, b.name);
		}
	}

	function useCustomBranch(name: string) {
		selectedBranch = null;
		branch = name;
		branchSearch = name;
		if (selectedRepo) {
			fetchDockerfiles(selectedRepo, name);
		}
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

		if (deploymentSource === 'git' && !gitSelection) {
			formError = 'Pick a repository and branch';
			return;
		}
		if (deploymentSource === 'github' || deploymentSource === 'git') {
			if (!repoUrl.trim()) {
				formError = 'Repository is required';
				return;
			}
			if (!branch.trim()) {
				formError = 'Branch is required';
				return;
			}
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
			}

			if (!targetProjectId) {
				throw new Error('Project not available');
			}

			const endpoint =
				deploymentSource === 'github' || deploymentSource === 'git'
					? `/apiv1/projects/${targetProjectId}/deployments/from-github`
					: `/apiv1/projects/${targetProjectId}/deployments`;

			const body: Record<string, unknown> = {
				name: name.trim(),
				replicas,
				ports: validPorts,
				env: validEnv,
				exposePublic,
				autoUrl,
				volumes: validVolumes,
				cpuRequestMilli: resourceCpuMilli,
				memoryRequestBytes: resourceMemoryBytes
			};

			if (selectedEnvId) body.environmentId = selectedEnvId;

			if (deploymentSource === 'git') {
				if (!gitSelection) throw new Error('Pick a repository and branch');
				body.gitConnectionId = gitSelection.connectionId;
				body.externalRepoId = gitSelection.externalRepoId;
			}
			if (deploymentSource === 'github' || deploymentSource === 'git') {
				body.repoUrl = deploymentSource === 'git' ? gitSelection!.repoUrl : repoUrl;
				body.branch = deploymentSource === 'git' ? gitSelection!.branch : branch;
				body.buildType = buildType;
				body.buildWithDepot = buildWithDepot;
				if (buildType === 'railpack') {
					if (rootDirectory) body.rootDirectory = rootDirectory;
					if (detectedFramework) body.framework = detectedFramework;
					if (installCommand.trim()) body.installCommand = installCommand.trim();
					if (buildCommand.trim()) body.buildCommand = buildCommand.trim();
					if (outputDirectory.trim()) body.outputDirectory = outputDirectory.trim();
					if (startCommand.trim() && !outputDirectory.trim()) {
						body.startCommand = startCommand.trim();
					}
				}
				if (buildType === 'dockerfile') {
					body.dockerfilePath = dockerfilePath;
					body.buildFromRoot = buildFromRoot;
					if (selectedStage) {
						body.target = selectedStage;
					}
				}
			} else {
				body.image = image.trim();
				if (imageStartCommand.trim()) body.startCommand = imageStartCommand.trim();
				if (imagePullPolicy !== 'auto') body.imagePullPolicy = imagePullPolicy;
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
					deploymentSource === 'image' ? 'Provisioning started' : 'Building from the repository',
				color: 'success'
			});

			if (deploymentSource !== 'image') {
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

	let reposRequested = false;
	$effect(() => {
		if (deploymentSource === 'github' && githubLinked && !reposRequested) {
			reposRequested = true;
			if (repositories.length === 0) fetchRepositories();
		}
	});

	onMount(() => {
		deploymentSource = initialSource;
		checkGitHubStatus();
	});

	$effect(() => {
		orgSlug;
		projectSlug;
		wsSlug;
		if (orgSlug && projectSlug) {
			fetchProjectData();
			return;
		}
		if (!seededPendingProject) {
			seededPendingProject = true;
			pendingProjectName = $page.url.searchParams.get('project');
		}
		loading = false;
	});

	let selectedAccount = $state<string | null>(null);
	let accountAutoSet = false;

	const accounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const r of repositories) {
			const owner = r.full_name.split('/')[0];
			counts.set(owner, (counts.get(owner) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([login, count]) => ({ login, count }))
			.sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
	});

	$effect(() => {
		const first = accounts[0]?.login;
		if (!first || accountAutoSet) return;
		accountAutoSet = true;
		if (!selectedAccount) selectedAccount = first;
	});

	const filteredRepos = $derived.by(() => {
		const q = repoQuery.trim().toLowerCase();
		return repositories.filter((r) => {
			if (q && !r.full_name.toLowerCase().includes(q)) return false;
			if (q.includes('/')) return true;
			return !selectedAccount || r.full_name.split('/')[0] === selectedAccount;
		});
	});
	const parsedRepoInput = $derived(parseRepoInput(repoQuery.trim()));
	const parsedRepoIsListed = $derived(
		!!parsedRepoInput &&
			repositories.some(
				(r) =>
					r.full_name.toLowerCase() ===
					`${parsedRepoInput.owner}/${parsedRepoInput.repo}`.toLowerCase()
			)
	);
	const repoOptions = $derived<DropdownOption[]>(
		filteredRepos.map((r) => {
			const [owner, repoName] = r.full_name.split('/');
			return { value: r.full_name, label: owner === selectedAccount ? repoName : r.full_name };
		})
	);
	const repoValue = $derived(selectedRepo?.full_name ?? (repoUrl ? repoSearch : ''));
	const branchOptions = $derived<DropdownOption[]>([
		...(branch && !branches.some((b) => b.name === branch)
			? [{ value: branch, label: branch }]
			: []),
		...branches.map((b) => ({ value: b.name, label: b.name }))
	]);
	const defaultBranch = $derived(selectedRepo?.default_branch ?? null);

	function pickRepoByName(fullName: string) {
		const repo = repositories.find((r) => r.full_name === fullName);
		if (repo) {
			selectRepo(repo);
			return;
		}
		const parsed = parseRepoInput(fullName);
		if (parsed) confirmManualRepo(parsed);
	}

	function pickBranchByName(name: string) {
		const match = branches.find((b) => b.name === name);
		if (match) selectBranch(match);
		else useCustomBranch(name);
	}

	const isRepoSource = $derived(deploymentSource === 'github' || deploymentSource === 'git');
	const hasRepo = $derived(
		deploymentSource === 'git' ? !!gitSelection : !!(selectedRepo || repoUrl)
	);
	const appName = $derived(name.trim() || 'app');
	const stageOptions = $derived<DropdownOption[]>([
		{ value: '', label: 'Final stage' },
		...dockerfileStages.map((st) => ({ value: st, label: st }))
	]);
	const dockerfileOptions = $derived<DropdownOption[]>(
		dockerfiles.map((df) => ({ value: df, label: df }))
	);
	const envCount = $derived(
		(envViewMode === 'raw' ? rawToEnvVars(envRawText) : envVars).filter((e) => e.key.trim()).length
	);
	const buildNote = $derived(
		buildType === 'dockerfile'
			? `${dockerfilePath || 'Dockerfile'}${selectedStage ? `, ${selectedStage}` : ''}`
			: buildSettingsTouched
				? 'Custom commands'
				: 'Detected'
	);
	const networkNote = $derived(
		[
			ports
				.filter((p) => p.containerPort > 0)
				.map((p) => (p.protocol === 'UDP' ? `${p.containerPort}/udp` : String(p.containerPort)))
				.join(', ') || 'No port',
			autoUrl ? 'URL' : null
		]
			.filter(Boolean)
			.join(' · ')
	);
	const resourcesNote = $derived(
		resourceCpuMilli || resourceMemoryBytes
			? [
					resourceCpuMilli ? formatCpu(resourceCpuMilli) : null,
					resourceMemoryBytes ? formatMemory(resourceMemoryBytes) : null
				]
					.filter(Boolean)
					.join(' · ')
			: 'Org default'
	);
	const created = $derived([
		{
			name: appName,
			type: 'deployment' as const,
			note:
				deploymentSource === 'image'
					? 'Image'
					: buildType === 'dockerfile'
						? 'Dockerfile'
						: (frameworkLabel(detectedFramework) ?? 'App')
		},
		...(autoUrl ? [{ name: 'Org URL', type: 'ingress' as const, note: 'https' }] : []),
		...volumes
			.filter((v) => v.pvcName?.trim())
			.map((v) => ({ name: v.pvcName!.trim(), type: 'volume' as const }))
	]);
</script>

{#snippet lock(option: DropdownOption)}
	{#if repositories.find((r) => r.full_name === option.value)?.private}
		<Lock size={13} class="text-faint" aria-label="Private" />
	{/if}
{/snippet}

{#snippet defaultTag(option: DropdownOption)}
	{#if option.value === defaultBranch}<Badge>Default</Badge>{/if}
{/snippet}

{#snippet repoEmpty(typed: string)}
	{#if reposError}
		{reposError} <a class="text-link" href="/user/settings">Connect GitHub</a>
	{:else if typed}
		No match. Paste owner/repo or a GitHub URL.
	{:else}
		No repositories on this account
	{/if}
{/snippet}

{#snippet frameworkPicker(
	props: Record<string, unknown>,
	open: boolean,
	picked: DropdownOption | null
)}
	<SelectTrigger
		{...props}
		{open}
		value={loadingDockerfiles ? null : picked?.label}
		placeholder="Detecting"
		loading={loadingDockerfiles}
		aria-label="Build with"
	>
		{#snippet leading()}
			<FrameworkIcon
				framework={picked?.value === DOCKERFILE_OPTION ? 'dockerfile' : (picked?.value ?? null)}
			/>
		{/snippet}
	</SelectTrigger>
{/snippet}

{#snippet directoryPicker(
	props: Record<string, unknown>,
	open: boolean,
	picked: DropdownOption | null
)}
	<SelectTrigger
		{...props}
		{open}
		mono
		value={picked?.label}
		placeholder="Root"
		aria-label="App in this repository"
	>
		{#snippet leading()}<FolderOpen size={15} class="text-muted" />{/snippet}
	</SelectTrigger>
{/snippet}

{#snippet buildDetails()}
	<Dropdown
		value={frameworkValue}
		options={FRAMEWORK_OPTIONS}
		onchange={onFrameworkPicked}
		trigger={frameworkPicker}
	>
		{#snippet icon(value)}
			<FrameworkIcon framework={value === DOCKERFILE_OPTION ? 'dockerfile' : value} />
		{/snippet}
	</Dropdown>
	{#if buildType === 'railpack' && detectedApps.length > 1}
		<Dropdown
			value={rootDirectory}
			options={rootDirectoryOptions}
			onchange={(dir) => {
				const app = detectedApps.find((a) => a.dir === dir);
				if (app) selectRootDirectory(app);
			}}
			trigger={directoryPicker}
		>
			{#snippet icon(dir)}<FrameworkIcon framework={frameworkOfDir(dir)} />{/snippet}
		</Dropdown>
	{/if}
{/snippet}

{#snippet stagePicker(props: Record<string, unknown>, open: boolean, picked: DropdownOption | null)}
	<SelectTrigger
		{...props}
		{open}
		block
		mono={!!selectedStage}
		value={picked?.label}
		loading={loadingStages}
	/>
{/snippet}

<svelte:head><title>New app</title></svelte:head>

<Page title="New app" width="default">
	{#snippet eyebrow()}
		<Breadcrumbs
			crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				{
					label: 'New',
					href: `/${orgSlug}/new${projectSlug ? `?projectSlug=${projectSlug}` : ''}`
				},
				{ label: 'App' }
			]}
		/>
	{/snippet}

	{#snippet aside()}
		{#if !loading && (project || pendingProjectName)}
			<Stack sticky>
				<SectionCard title="Deploy into">
					<Stack gap="sm">
						<ProjectSwitcher
							block
							currentProjectName={project?.name || projectSlug}
							pathSuffix={`/deployments/new?source=${deploymentSource}`}
							{pendingProjectName}
							onPendingProjectChange={(n) => (pendingProjectName = n)}
						/>
						{#if project?.id && !pendingProjectName}
							<EnvironmentSwitcher block projectId={project.id} bind:selectedEnvId />
						{/if}
					</Stack>
				</SectionCard>
				<SectionCard title="What gets created">
					<ResourceList items={created} />
				</SectionCard>
			</Stack>
		{/if}
	{/snippet}

	{#if error}
		<Alert tone="error">{error}</Alert>
	{/if}

	{#if loading}
		<Stack gap="lg">
			<Skeleton height="14rem" rounded="1.125rem" />
			<Skeleton height="18rem" rounded="1.125rem" />
		</Stack>
	{:else if project || pendingProjectName}
		<form
			class="nd-form"
			novalidate
			onsubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<SectionCard title="Source">
				{#snippet actions()}
					<SegmentedControl
						label="Source"
						size="sm"
						options={SOURCE_OPTIONS}
						bind:value={
							() => deploymentSource, (v) => (deploymentSource = v as typeof deploymentSource)
						}
					/>
				{/snippet}

				<Stack gap="md">
					{#key deploymentSource}
						<div {@attach motionStagger({ index: 0, from: { y: 6 } })}>
							{#if deploymentSource === 'image'}
								<Input
									bind:value={image}
									size="lg"
									placeholder="ghcr.io/org/app:latest"
									mono
									icon={Container}
									aria-label="Image"
								/>
							{:else if deploymentSource === 'git'}
								<GitSourcePane
									onSelect={(sel) => {
										gitSelection = sel;
										if (sel) {
											repoUrl = sel.repoUrl;
											branch = sel.branch;
											if (!nameTouched && !name.trim()) name = sel.repoPath.split('/').pop() ?? '';
										}
									}}
									onDetect={(det) => applyDetection(det as DetectionResult)}
									details={buildDetails}
								/>
							{:else}
								<Stack gap="md">
									{#if !githubLinked}
										<Alert tone="warning" title="GitHub not connected">
											Paste owner/repo into the repository search to deploy a public repo.
											{#snippet actions()}
												<Button variant="secondary" size="sm" href="/user/settings"
													>Connect GitHub</Button
												>
											{/snippet}
										</Alert>
									{:else if !hasGitHubApp && repositories.length === 0 && !loadingRepos}
										<Alert tone="warning" title="Install the GitHub App to list your repositories">
											{#snippet actions()}
												{#if githubAppInstallUrl}
													<Button
														variant="secondary"
														size="sm"
														href={githubAppInstallUrl}
														target="_blank">Install</Button
													>
												{/if}
											{/snippet}
										</Alert>
									{/if}
									<SourcePath>
										{#snippet owner()}
											<RepoAccountPicker
												size="lg"
												block={false}
												{accounts}
												selected={selectedAccount}
												onSelect={selectAccount}
												installUrl={githubAppInstallUrl}
											/>
										{/snippet}
										{#snippet repo()}
											<SearchPicker
												block
												size="lg"
												value={repoValue}
												bind:query={repoQuery}
												options={repoOptions}
												filter={false}
												loading={loadingRepos}
												placeholder="Choose a repository"
												searchPlaceholder="Search, or paste owner/repo"
												creatable={!!parsedRepoInput && !parsedRepoIsListed}
												createLabel={() =>
													parsedRepoInput
														? `Use ${parsedRepoInput.owner}/${parsedRepoInput.repo}`
														: ''}
												onchange={pickRepoByName}
												onclear={clearRepoSelection}
												trailing={lock}
												empty={repoEmpty}
											/>
										{/snippet}
										{#snippet details()}
											{#if hasRepo}
												<SearchPicker
													mono
													value={branch}
													options={branchOptions}
													loading={loadingBranches}
													placeholder="main"
													searchPlaceholder="Search or type a branch"
													creatable
													createLabel={(q) => `Use ${q}`}
													onchange={pickBranchByName}
													trailing={defaultTag}
												>
													{#snippet leading()}<GitBranch size={15} class="text-muted" />{/snippet}
												</SearchPicker>
												{@render buildDetails()}
											{/if}
										{/snippet}
									</SourcePath>
								</Stack>
							{/if}
						</div>
					{/key}

					{#if detectedScore && isRepoSource}
						<Alert tone="info" title="Configured by {detectedScore.file}">
							{#if detectedScore.resources.filter((r) => r.type === 'postgres').length > 0}
								Provisions {detectedScore.resources
									.filter((r) => r.type === 'postgres')
									.map((r) => `Postgres “${r.name}”`)
									.join(', ')} and connects it.
							{/if}
							{#if detectedScore.ports.length > 0}
								Ports {detectedScore.ports.join(', ')}.
							{/if}
							{#if detectedScore.domain}
								Routes {detectedScore.domain}.
							{/if}
							{#if detectedScore.warnings.length > 0}
								<p class="text-warning">{detectedScore.warnings[0]}</p>
							{/if}
						</Alert>
					{/if}

					<Field label="Name" for="nd-name">
						<Input
							id="nd-name"
							bind:value={name}
							oninput={() => (nameTouched = true)}
							placeholder="app-name"
							mono
						/>
					</Field>
				</Stack>
			</SectionCard>

			<SectionCard title="Environment variables">
				{#snippet actions()}
					<SegmentedControl
						label="Editor mode"
						size="sm"
						options={ENV_MODE_OPTIONS}
						bind:value={() => envViewMode, (v) => (envViewMode = v as typeof envViewMode)}
						onchange={() => (envsManuallyEdited = true)}
					/>
				{/snippet}
				<EnvVarEditor
					bind:rows={envVars}
					bind:mode={envViewMode}
					bind:raw={envRawText}
					minRows={1}
					onedit={() => (envsManuallyEdited = true)}
				/>
			</SectionCard>

			<SectionCard title="Networking">
				<Stack gap="lg">
					<Field label={ports.length > 1 ? 'Ports' : 'Port'}>
						<Stack gap="sm">
							{#each ports as port, index (index)}
								<div class="nd-port">
									<div class="nd-port-num">
										<Input
											type="number"
											bind:value={port.containerPort}
											oninput={() => (portsManuallyEdited = true)}
											min="1"
											placeholder="80"
											aria-label="Port"
											mono
										/>
									</div>
									<SegmentedControl
										label="Protocol"
										size="sm"
										options={PROTOCOL_OPTIONS}
										bind:value={port.protocol}
										onchange={() => (portsManuallyEdited = true)}
									/>
									{#if ports.length > 1}
										<Button
											variant="ghost"
											size="sm"
											icon={Trash2}
											label="Remove port"
											onclick={() => removePort(index)}
										/>
									{/if}
									{#if index === ports.length - 1}
										<Button size="sm" variant="ghost" icon={Plus} onclick={addPort}>Add port</Button
										>
									{/if}
								</div>
							{/each}
						</Stack>
					</Field>
					<ToggleRow
						bind:checked={autoUrl}
						label="Generate a URL"
						hint="Only people in your org can open it."
					/>
				</Stack>
			</SectionCard>

			<SectionCard title="Advanced">
				<div class="nd-folds">
					{#if isRepoSource}
						<Disclosure title="Build" note={buildNote}>
							{#if buildType === 'dockerfile'}
								<div class="nd-grid">
									<Field label="Dockerfile">
										{#if dockerfiles.length > 1}
											<SearchPicker
												block
												mono
												value={dockerfilePath}
												options={dockerfileOptions}
												searchPlaceholder="Search or type a path"
												creatable
												createLabel={(q) => `Use ${q}`}
												onchange={selectDockerfile}
											/>
										{:else}
											<Input
												value={dockerfilePath}
												oninput={(e: Event) =>
													handleDockerfileInput((e.currentTarget as HTMLInputElement).value)}
												placeholder="Dockerfile"
												mono
											/>
										{/if}
									</Field>
									<Field label="Stage">
										<Dropdown
											bind:value={selectedStage}
											options={stageOptions}
											trigger={stagePicker}
										/>
									</Field>
								</div>
								<ToggleRow
									bind:checked={buildFromRoot}
									onchange={() => (buildFromRootTouched = true)}
									label="Build from the repository root"
									hint="For a Dockerfile that copies files from outside its own folder."
								/>
							{:else}
								<div class="nd-grid">
									<Field label="Install command">
										<Input
											value={installCommand}
											oninput={(e: Event) => {
												installCommand = (e.currentTarget as HTMLInputElement).value;
												buildSettingsTouched = true;
											}}
											placeholder="Detected"
											mono
										/>
									</Field>
									<Field label="Build command">
										<Input
											value={buildCommand}
											oninput={(e: Event) => {
												buildCommand = (e.currentTarget as HTMLInputElement).value;
												buildSettingsTouched = true;
											}}
											placeholder="Detected"
											mono
										/>
									</Field>
									<Field label="Start command">
										<Input
											value={startCommand}
											oninput={(e: Event) => {
												startCommand = (e.currentTarget as HTMLInputElement).value;
												buildSettingsTouched = true;
											}}
											placeholder={outputDirectory ? 'Not used for a static site' : 'Detected'}
											disabled={Boolean(outputDirectory)}
											mono
										/>
									</Field>
									<Field label="Output directory" hint="Serves the files as a static site.">
										<Input
											value={outputDirectory}
											oninput={(e: Event) => {
												outputDirectory = (e.currentTarget as HTMLInputElement).value;
												buildSettingsTouched = true;
											}}
											placeholder="Detected"
											mono
										/>
									</Field>
								</div>
							{/if}
						</Disclosure>
					{:else}
						<Disclosure
							title="Run"
							note={imageStartCommand.trim() ? 'Custom command' : 'Image defaults'}
						>
							<Field label="Start command">
								<Input bind:value={imageStartCommand} placeholder="Image default" mono />
							</Field>
							<Field
								label="Pull policy"
								hint={imagePullPolicy === 'auto'
									? isMutableTag(image)
										? 'This tag can move, so every start re-pulls it.'
										: 'Pinned tags reuse the copy already on the node.'
									: imagePullPolicy === 'Always'
										? 'Every start fetches the image again.'
										: 'Starts reuse the copy already on the node.'}
							>
								<SegmentedControl
									label="Image pull policy"
									bind:value={imagePullPolicy}
									options={[
										{ value: 'auto', label: 'Automatic' },
										{ value: 'IfNotPresent', label: 'Use cached' },
										{ value: 'Always', label: 'Always re-pull' }
									]}
								/>
							</Field>
							{#if imagePullPolicy === 'IfNotPresent' && isMutableTag(image)}
								<Alert tone="warning" title="This tag can move">
									Pushing over it will not show up on a restart. Automatic handles this.
								</Alert>
							{/if}
						</Disclosure>
					{/if}

					<Divider />

					<Disclosure
						title="Storage"
						note={volumes.length
							? `${volumes.length} ${volumes.length === 1 ? 'volume' : 'volumes'}`
							: 'None'}
					>
						{#each volumes as volume, index (index)}
							<div class="nd-vol">
								<Input bind:value={volume.pvcName} placeholder="Name" aria-label="Storage name" />
								<ArrowRight size={14} class="text-faint" aria-hidden="true" />
								<Input
									bind:value={volume.mountPath}
									placeholder="/data"
									aria-label="Mount path"
									mono
								/>
								<div class="nd-vol-ro">
									<span class="text-callout text-muted">Read-only</span>
									<Switch bind:checked={volume.readOnly} label="Read-only" />
								</div>
								<Button
									variant="ghost"
									size="sm"
									icon={Trash2}
									label="Remove storage"
									onclick={() => removeVolume(index)}
								/>
							</div>
						{/each}
						<div>
							<Button size="sm" variant="tinted" icon={Plus} onclick={addVolume}>Add volume</Button>
						</div>
					</Disclosure>

					<Divider />

					<Disclosure title="Resources" note={resourcesNote}>
						<ResourcePicker
							bind:cpuMilli={resourceCpuMilli}
							bind:memoryBytes={resourceMemoryBytes}
						/>
					</Disclosure>

					<Divider />

					<Disclosure
						title="Scaling"
						note={`${replicas} ${replicas === 1 ? 'replica' : 'replicas'}`}
					>
						<Field label="Replicas" layout="row">
							<Stepper bind:value={replicas} min={1} max={20} label="Replicas" />
						</Field>
						{#if $isSuperAdmin && isRepoSource}
							<ToggleRow bind:checked={buildWithDepot} label="Orchard's super builds" />
						{/if}
					</Disclosure>
				</div>
			</SectionCard>

			{#if formError}
				<Alert tone="error">{formError}</Alert>
			{/if}

			<FormActions>
				<Button variant="ghost" href={basePath}>Cancel</Button>
				<Button variant="primary" size="lg" type="submit" loading={submitting}>Deploy</Button>
			</FormActions>
		</form>
	{/if}
</Page>

<style>
	.nd-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	.nd-grid {
		display: grid;
		grid-template-columns: minmax(0, 38.2fr) minmax(0, 61.8fr);
		gap: var(--space-4) var(--space-3);
	}
	.nd-folds {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.nd-port {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.nd-port-num {
		width: 9rem;
	}
	.nd-vol {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto auto;
		align-items: center;
		gap: var(--space-2);
	}
	.nd-vol-ro {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding-left: var(--space-2);
	}
	@media (max-width: 640px) {
		.nd-grid {
			grid-template-columns: minmax(0, 1fr);
		}
		.nd-vol {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}
</style>
