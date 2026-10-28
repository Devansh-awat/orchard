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
		GitBranch,
		Github,
		HardDrive,
		Plus,
		Trash2,
		X
	} from 'lucide-svelte';
	import { rawToEnvVars } from '$lib/utils/format';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import { EnvironmentSwitcher } from '$lib/components/environment';
	import RepoAccountPicker from '$lib/components/deployment/RepoAccountPicker.svelte';
	import GitSourcePane from '$lib/components/deployment/GitSourcePane.svelte';
	import FrameworkIcon from '$lib/components/deployment/FrameworkIcon.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import {
		Alert,
		Badge,
		Breadcrumbs,
		Button,
		Card,
		Combobox,
		Disclosure,
		Dropdown,
		EmptyState,
		EnvVarEditor,
		Field,
		Input,
		Page,
		SectionCard,
		SegmentedControl,
		Select,
		Skeleton,
		Stepper,
		Switch,
		ToggleRow,
		type DropdownOption
	} from '$lib/components/ui';
	import Spinner from '$lib/components/ui/Spinner.svelte';
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
	let branchSearch = $state('');
	let branchQuery = $state('');
	let dockerfileSearch = $state('Dockerfile');
	let dockerfileStages = $state<string[]>([]);
	let loadingStages = $state(false);
	let selectedStage = $state<string>('');
	let dockerfileInputTimeout: ReturnType<typeof setTimeout> | null = null;
	let repoInputTimeout: ReturnType<typeof setTimeout> | null = null;

	let name = $state('');
	let image = $state('');
	let imagePullPolicy = $state<'Always' | 'IfNotPresent' | 'auto'>('auto');
	let imageStartCommand = $state('');
	let repoUrl = $state('');
	let branch = $state('');
	let buildType = $state<'dockerfile' | 'railpack'>('dockerfile');
	let buildTypeTouched = false;
	let buildFoldOpen = $state(false);
	let buildFoldBuildType: string | null = null;

	$effect(() => {
		if (buildType === buildFoldBuildType) return;
		buildFoldBuildType = buildType;
		buildFoldOpen = buildType === 'dockerfile';
	});
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
		if (directLinkMode) clearRepoSelection();
		directLinkMode = false;
		selectedAccount = login;
		if (!selectedRepo) {
			repoSearch = '';
		}
	}

	function useDirectLink() {
		clearRepoSelection();
		directLinkMode = true;
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
		if (repoInputTimeout) clearTimeout(repoInputTimeout);
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
		branchQuery = '';
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

	function handleRepoSearchInput(value: string) {
		if (selectedRepo) return;
		repoSearch = value;

		if (repoInputTimeout) {
			clearTimeout(repoInputTimeout);
		}

		const parsed = parseRepoInput(value.trim());
		if (parsed) {
			repoUrl = parsed.url;
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
		if (selectedRepo) {
			fetchDockerfiles(selectedRepo, b.name);
		}
	}

	function clearBranchSelection() {
		selectedBranch = null;
		branch = '';
		branchSearch = '';
		branchQuery = '';
		dockerfiles = [];
		dockerfilePath = 'Dockerfile';
		dockerfileSearch = 'Dockerfile';
		dockerfileStages = [];
		selectedStage = '';
		buildFromRoot = false;
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
	let directLinkMode = $state(false);
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

	const filteredRepos = $derived(
		repositories.filter((r) => {
			const q = selectedRepo ? '' : repoSearch.toLowerCase();
			const matchesText =
				r.full_name.toLowerCase().includes(q) ||
				r.full_name.split('/')[1].toLowerCase().includes(q);
			if (!matchesText) return false;
			if (q.includes('/')) return true;
			return !selectedAccount || r.full_name.split('/')[0] === selectedAccount;
		})
	);
	const parsedRepoInput = $derived(selectedRepo ? null : parseRepoInput(repoSearch.trim()));
	const parsedRepoIsListed = $derived(
		!!parsedRepoInput &&
			filteredRepos.some(
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
	const customBranch = $derived.by(() => {
		const typed = branchQuery.trim();
		if (!typed || branches.some((b) => b.name === typed)) return null;
		return typed;
	});
	const branchOptions = $derived<DropdownOption[]>([
		...(branch && !branches.some((b) => b.name === branch)
			? [{ value: branch, label: branch, mono: true }]
			: []),
		...branches.map((b) => ({ value: b.name, label: b.name, mono: true }))
	]);

	function onRepoQuery(next: string) {
		if (selectedRepo) {
			repoSearch = next;
			return;
		}
		handleRepoSearchInput(next);
	}

	function pickRepoByName(fullName: string) {
		const repo = repositories.find((r) => r.full_name === fullName);
		if (repo) selectRepo(repo);
	}

	function pickBranchByName(name: string) {
		const match = branches.find((b) => b.name === name);
		if (match) selectBranch(match);
		else useCustomBranch(name);
	}
</script>

{#snippet busy()}<Spinner size={13} />{/snippet}

{#snippet clearDirectLink()}
	<Button
		variant="ghost"
		size="sm"
		icon={X}
		label="Clear repository"
		onclick={clearRepoSelection}
	/>
{/snippet}

{#snippet privateBadge(option: DropdownOption)}
	{#if repositories.find((r) => r.full_name === option.value)?.private}
		<Badge tone="neutral">Private</Badge>
	{/if}
{/snippet}

{#snippet repoEmpty()}
	{#if loadingRepos}
		Loading your repositories
	{:else if reposError}
		{reposError} <a class="text-link" href="/user/settings">Connect GitHub</a>
	{:else if !repoSearch}
		Search your repos, or paste owner/repo or a GitHub URL
	{:else if !parsedRepoInput}
		No matches. Paste owner/repo or a GitHub URL to deploy any public repo.
	{/if}
{/snippet}

<Page title="New app" description="Configure and launch a new service." width="narrow">
	{#snippet eyebrow()}
		<Breadcrumbs
			crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				...(project || projectSlug
					? [{ label: project?.name || projectSlug, href: basePath }]
					: []),
				{ label: 'New app' }
			]}
		/>
	{/snippet}

	{#snippet footer()}
		{#if !loading && (project || pendingProjectName)}
			<Button variant="ghost" href={basePath}>Cancel</Button>
			<Button variant="primary" onclick={submit} loading={submitting}>Deploy</Button>
		{/if}
	{/snippet}

	{#if error}
		<Alert tone="error">{error}</Alert>
	{/if}

	{#if loading}
		<SectionCard>
			<div class="nd-stack">
				<Skeleton width="8rem" height="1rem" />
				<div class="nd-pair">
					<Skeleton height="2rem" rounded="calc(var(--radius-control) * var(--corner-scale))" />
					<Skeleton height="2rem" rounded="calc(var(--radius-control) * var(--corner-scale))" />
				</div>
			</div>
		</SectionCard>
	{:else if project || pendingProjectName}
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

			<div class="nd-stack">
				{#key deploymentSource}
					<div class="nd-stack" {@attach motionStagger({ index: 0, from: { y: 8 } })}>
						{#if deploymentSource === 'image'}
							<Field
								label="Docker image"
								hint="Include the registry and tag. Public images work out of the box."
							>
								<Input bind:value={image} placeholder="ghcr.io/org/app:latest" mono />
							</Field>
							<Field
								label="Pull policy"
								hint={imagePullPolicy === 'auto'
									? isMutableTag(image)
										? 'This tag can move, so pods will re-pull it on every start.'
										: 'Pinned tags reuse the image already on the node. Change the tag and this follows.'
									: imagePullPolicy === 'Always'
										? 'Every pod start fetches the image again.'
										: 'Pods reuse the image already on the node.'}
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
									Pinning to the cached image means pushing over this tag will not show up on a
									restart. Automatic handles this for you.
								</Alert>
							{/if}
							<Field
								label="Start command"
								hint="Runs instead of the image's CMD, like a command passed to docker run. Leave empty to use whatever the image starts."
							>
								<Input
									bind:value={imageStartCommand}
									placeholder="Whatever the image starts"
									mono
								/>
							</Field>
						{:else if deploymentSource === 'git'}
							<GitSourcePane
								onSelect={(sel) => {
									gitSelection = sel;
									if (sel) {
										repoUrl = sel.repoUrl;
										branch = sel.branch;
										if (!name.trim()) name = sel.repoPath.split('/').pop() ?? '';
									}
								}}
								onDetect={(det) => applyDetection(det as DetectionResult)}
							/>
						{:else}
							{#if !githubLinked}
								<Alert tone="warning" title="GitHub not connected">
									You can deploy any public repository by entering its slug (like <code
										class="font-mono">owner/repo</code
									>) or URL below. Connect GitHub to also access your private repos.
									{#snippet actions()}
										<Button variant="secondary" size="sm" href="/user/settings"
											>Connect GitHub</Button
										>
									{/snippet}
								</Alert>
							{:else if !hasGitHubApp && repositories.length === 0 && !loadingRepos}
								<Alert tone="warning" title="Install the GitHub App for better access">
									The GitHub App lets you choose exactly which repos and orgs to grant access to,
									with minimal permissions.
									{#snippet actions()}
										{#if githubAppInstallUrl}
											<Button
												variant="secondary"
												size="sm"
												href={githubAppInstallUrl}
												target="_blank">Install GitHub App</Button
											>
										{/if}
									{/snippet}
								</Alert>
							{/if}
							<Field label="Repository">
								<div class="nd-repo">
									<RepoAccountPicker
										{accounts}
										selected={selectedAccount}
										onSelect={selectAccount}
										installUrl={githubAppInstallUrl}
										directLink={directLinkMode}
										onDirectLink={useDirectLink}
									/>
									{#if directLinkMode}
										<Input
											value={repoSearch}
											oninput={(e: Event) =>
												handleRepoSearchInput((e.target as HTMLInputElement).value)}
											placeholder="https://github.com/owner/repo"
											aria-label="Repository URL"
											class="font-mono"
											suffix={loadingBranches ? busy : repoSearch ? clearDirectLink : undefined}
										/>
									{:else}
										<Combobox
											label="Repository"
											icon={Github}
											value={selectedRepo?.full_name ?? ''}
											bind:query={() => repoSearch, onRepoQuery}
											options={repoOptions}
											loading={loadingRepos || loadingBranches}
											placeholder="Search your repositories"
											creatable={!!parsedRepoInput && !parsedRepoIsListed}
											createLabel={() =>
												parsedRepoInput
													? `Use ${parsedRepoInput.owner}/${parsedRepoInput.repo}`
													: ''}
											oncreate={() => parsedRepoInput && confirmManualRepo(parsedRepoInput)}
											onchange={pickRepoByName}
											onclear={clearRepoSelection}
											trailing={privateBadge}
											empty={repoEmpty}
										/>
									{/if}
								</div>
							</Field>

							{#if selectedRepo || repoUrl}
								<Field label="Branch">
									<Combobox
										label="Branch"
										icon={GitBranch}
										value={branch}
										bind:query={branchQuery}
										options={branchOptions}
										loading={loadingBranches}
										disabled={loadingBranches}
										placeholder="main"
										creatable={!!customBranch}
										createLabel={(q) => `Use ${q}`}
										oncreate={(q) => useCustomBranch(customBranch ?? q)}
										onchange={pickBranchByName}
										onclear={clearBranchSelection}
										empty={branches.length
											? 'No matching branches'
											: 'No branches found. Type a name to use anyway.'}
									/>
								</Field>
							{/if}

							{#if selectedBranch || branch}
								<Field label="Build with" layout="row" for="nd-framework">
									<div class="nd-cfg-val">
										{#if loadingDockerfiles}
											<Skeleton
												height="2rem"
												rounded="calc(var(--radius-control) * var(--corner-scale))"
											/>
										{:else}
											<Dropdown
												id="nd-framework"
												value={frameworkValue}
												options={FRAMEWORK_OPTIONS}
												onchange={onFrameworkPicked}
											>
												{#snippet icon(value)}
													<FrameworkIcon
														framework={value === DOCKERFILE_OPTION ? 'dockerfile' : value}
													/>
												{/snippet}
											</Dropdown>
										{/if}
									</div>
								</Field>

								{#if !loadingDockerfiles}
									{#if buildType === 'railpack' && detectedApps.length > 1}
										<Field label="Root directory" layout="row" for="nd-root">
											<div class="nd-cfg-val">
												<Dropdown
													id="nd-root"
													value={rootDirectory}
													options={rootDirectoryOptions}
													onchange={(dir) => {
														const app = detectedApps.find((a) => a.dir === dir);
														if (app) selectRootDirectory(app);
													}}
												>
													{#snippet icon(dir)}
														<FrameworkIcon framework={frameworkOfDir(dir)} />
													{/snippet}
												</Dropdown>
											</div>
										</Field>
									{/if}

									<Disclosure
										title="Build and output settings"
										note="Optional"
										bind:open={buildFoldOpen}
									>
										<div class="nd-stack">
											{#if buildType === 'dockerfile'}
												<Field label="Dockerfile path">
													{#if dockerfiles.length > 1}
														<Select
															value={dockerfilePath}
															onchange={(e: Event) =>
																selectDockerfile((e.currentTarget as HTMLSelectElement).value)}
														>
															{#each dockerfiles as df (df)}
																<option value={df}>{df}</option>
															{/each}
														</Select>
													{:else}
														<Input
															value={dockerfilePath}
															oninput={(e: Event) =>
																handleDockerfileInput((e.currentTarget as HTMLInputElement).value)}
															placeholder="Dockerfile"
															class="font-mono"
														/>
													{/if}
												</Field>
												{#if dockerfileStages.length > 0}
													<Field
														label="Build stage"
														hint="Which stage to stop at. The final stage is the image the Dockerfile produces on its own."
													>
														<Select bind:value={selectedStage}>
															<option value="">Final stage</option>
															{#each dockerfileStages as stage (stage)}
																<option value={stage}>{stage}</option>
															{/each}
														</Select>
													</Field>
												{/if}
												<ToggleRow
													bind:checked={buildFromRoot}
													onchange={() => (buildFromRootTouched = true)}
													label="Build from the repository root"
													hint="Turn this on if your Dockerfile copies files from outside its own folder."
												/>
											{:else}
												<p class="text-callout text-muted">
													Leave a field empty to use what we detect. Anything you set here overrides
													a
													<code class="font-mono text-fg">railpack.json</code> in the repository.
												</p>
												<Field label="Install command">
													<Input
														value={installCommand}
														oninput={(e: Event) => {
															installCommand = (e.currentTarget as HTMLInputElement).value;
															buildSettingsTouched = true;
														}}
														placeholder="Detected automatically"
														class="font-mono"
													/>
												</Field>
												<Field label="Build command">
													<Input
														value={buildCommand}
														oninput={(e: Event) => {
															buildCommand = (e.currentTarget as HTMLInputElement).value;
															buildSettingsTouched = true;
														}}
														placeholder="Detected automatically"
														class="font-mono"
													/>
												</Field>
												<Field
													label="Output directory"
													hint="Set this to serve the built files as a static site instead of running a server."
												>
													<Input
														value={outputDirectory}
														oninput={(e: Event) => {
															outputDirectory = (e.currentTarget as HTMLInputElement).value;
															buildSettingsTouched = true;
														}}
														placeholder="Detected automatically"
														class="font-mono"
													/>
												</Field>
												<Field label="Start command">
													<Input
														value={startCommand}
														oninput={(e: Event) => {
															startCommand = (e.currentTarget as HTMLInputElement).value;
															buildSettingsTouched = true;
														}}
														placeholder={outputDirectory
															? 'Not used for a static site'
															: 'Detected automatically'}
														disabled={Boolean(outputDirectory)}
														class="font-mono"
													/>
												</Field>
											{/if}
										</div>
									</Disclosure>
								{/if}
							{/if}
						{/if}
					</div>
				{/key}

				{#if detectedScore && deploymentSource !== 'image'}
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
			</div>

			{#snippet footer()}
				<div class="nd-owner">
					<ProjectSwitcher
						currentProjectName={project?.name || projectSlug}
						pathSuffix={`/deployments/new?source=${deploymentSource}`}
						{pendingProjectName}
						onPendingProjectChange={(n) => (pendingProjectName = n)}
					/>
					{#if project?.id && !pendingProjectName}
						<EnvironmentSwitcher projectId={project.id} bind:selectedEnvId />
					{/if}
					<span class="nd-slash" aria-hidden="true">/</span>
					<div class="nd-name font-mono">
						<Input
							bind:value={name}
							oninput={() => (nameTouched = true)}
							placeholder="app-name"
							aria-label="App name"
							size="sm"
						/>
					</div>
				</div>
			{/snippet}
		</SectionCard>

		<SectionCard title="Ports" description="The port your app listens on inside the container.">
			{#snippet actions()}
				<Button size="sm" variant="secondary" icon={Plus} onclick={addPort}>Add port</Button>
			{/snippet}
			<div class="nd-stack">
				{#each ports as port, index (index)}
					<div class="nd-port">
						<div class="nd-port-num">
							<Input
								type="number"
								size="sm"
								bind:value={port.containerPort}
								oninput={() => (portsManuallyEdited = true)}
								min="1"
								placeholder="80"
								aria-label="Container port"
								class="font-mono"
							/>
						</div>
						<SegmentedControl
							label="Protocol"
							size="sm"
							options={PROTOCOL_OPTIONS}
							bind:value={port.protocol}
							onchange={() => (portsManuallyEdited = true)}
						/>
						<Button
							variant="ghost"
							size="sm"
							icon={Trash2}
							label="Remove port"
							disabled={ports.length <= 1}
							onclick={() => removePort(index)}
						/>
					</div>
				{/each}
				<Card padding="sm">
					<ToggleRow
						bind:checked={autoUrl}
						label="Generate a URL"
						hint="An org-only https address, live the moment it deploys. Skip for workers."
					/>
				</Card>
			</div>
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

		<SectionCard
			title="Persistent storage"
			description="Attach storage that persists across restarts."
		>
			{#snippet actions()}
				{#if volumes.length > 0}
					<Button size="sm" variant="secondary" icon={Plus} onclick={addVolume}>Add storage</Button>
				{/if}
			{/snippet}
			{#if volumes.length === 0}
				<EmptyState
					title="No storage attached"
					description="Add persistent storage to keep files across restarts."
				>
					{#snippet icon()}<HardDrive size={18} />{/snippet}
					<Button size="sm" variant="secondary" icon={Plus} onclick={addVolume}>Add storage</Button>
				</EmptyState>
			{:else}
				<div class="nd-stack">
					{#each volumes as volume, index (index)}
						<div class="nd-vol">
							<Input
								size="sm"
								bind:value={volume.pvcName}
								placeholder="Storage name"
								aria-label="Storage name"
							/>
							<ArrowRight size={14} class="text-faint" aria-hidden="true" />
							<Input
								size="sm"
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
				</div>
			{/if}
		</SectionCard>

		<SectionCard
			title="Resources"
			description="Pick a size for the container. Requests = limits, so what you pick is what it gets."
		>
			<ResourcePicker bind:cpuMilli={resourceCpuMilli} bind:memoryBytes={resourceMemoryBytes} />
		</SectionCard>

		<SectionCard>
			<Disclosure title="Advanced" note="Optional">
				<div class="nd-stack">
					<Field label="Replicas" hint="Copies of your app running at once" layout="row">
						<Stepper bind:value={replicas} min={1} max={20} label="Replicas" />
					</Field>
					{#if $isSuperAdmin && deploymentSource === 'github'}
						<ToggleRow
							bind:checked={buildWithDepot}
							label="Orchard's super builds"
							hint="Faster builds on hosted high-performance builders"
						/>
					{/if}
				</div>
			</Disclosure>
		</SectionCard>

		{#if formError}
			<Alert tone="error">{formError}</Alert>
		{/if}
	{/if}
</Page>

<style>
	.nd-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.nd-pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}
	.nd-repo {
		display: grid;
		grid-template-columns: minmax(9rem, 13rem) minmax(0, 1fr);
		gap: 0.5rem;
	}
	.nd-cfg-val {
		width: clamp(12rem, 40vw, 18rem);
	}
	.nd-owner {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.nd-slash {
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.nd-name {
		flex: 1;
		min-width: 0;
	}
	.nd-port {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.nd-port-num {
		width: 7.5rem;
	}
	.nd-vol {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 0.5rem;
	}
	.nd-vol-ro {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding-left: 0.5rem;
	}
	@media (max-width: 640px) {
		.nd-repo,
		.nd-pair {
			grid-template-columns: minmax(0, 1fr);
		}
		.nd-vol {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}
</style>
