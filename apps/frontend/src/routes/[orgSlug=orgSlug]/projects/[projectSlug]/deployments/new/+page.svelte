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
		BookMarked,
		Container,
		GitBranch,
		Github,
		Globe,
		Lock,
		Network,
		Radio,
		ShieldCheck
	} from 'lucide-svelte';
	import { rawToEnvVars } from '$lib/utils/format';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import { EnvironmentSwitcher } from '$lib/components/environment';
	import RepoAccountPicker from '$lib/components/deployment/RepoAccountPicker.svelte';
	import GitSourcePane from '$lib/components/deployment/GitSourcePane.svelte';
	import FrameworkIcon from '$lib/components/deployment/FrameworkIcon.svelte';
	import { findProjectByName } from '$lib/components/deployment/project-match';
	import { createQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import {
		defaultAccount,
		githubStatusQueryOptions,
		installationSettingsUrl,
		rememberAccount,
		repoSearchQueryOptions,
		RepoSearchError,
		type GitHubInstallationSummary
	} from '$lib/queries/github';
	import ResourcePicker, {
		quotaMeQuery,
		resourcesNote as describeResources
	} from '$lib/components/ResourcePicker.svelte';
	import ResourceList from '$lib/components/patterns/ResourceList.svelte';
	import SourcePath from '$lib/components/patterns/SourcePath.svelte';
	import {
		Alert,
		Badge,
		Breadcrumbs,
		Button,
		Disclosure,
		DisclosureGroup,
		Divider,
		Dropdown,
		EnvVarEditor,
		Field,
		FieldGrid,
		FormActions,
		Input,
		Page,
		RowList,
		SearchPicker,
		SectionCard,
		SegmentedControl,
		Skeleton,
		Stack,
		Stepper,
		Swap,
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
	const REACH_OPTIONS: DropdownOption[] = [
		{
			value: 'link',
			label: 'Private link',
			description: 'HTTPS ingress behind Orchard sign-in',
			icon: ShieldCheck
		},
		{
			value: 'public-link',
			label: 'Public link',
			description: 'HTTPS ingress, open to anyone',
			icon: Globe
		},
		{
			value: 'port',
			label: 'Public port',
			description: 'Raw TCP or UDP on a node port',
			icon: Radio
		},
		{
			value: 'internal',
			label: 'Internal',
			description: 'ClusterIP, only apps in this project',
			icon: Network
		}
	];
	const REACH_LABEL = Object.fromEntries(REACH_OPTIONS.map((o) => [o.value, o.label]));
	const isLink = (reach: string) => reach === 'link' || reach === 'public-link';
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

	type Reach = 'link' | 'public-link' | 'port' | 'internal';

	let rowSeq = 0;

	type PortRow = {
		id: number;
		name: string;
		containerPort: number;
		servicePort: number;
		protocol: string;
		reach: Reach;
	};

	function portRow(port: number, index: number): PortRow {
		return {
			id: ++rowSeq,
			name: `port-${index + 1}`,
			containerPort: port,
			servicePort: port,
			protocol: 'TCP',
			reach: index === 0 ? 'link' : 'internal'
		};
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
	let githubLinked = $state<boolean | null>(null);
	let installations = $state<GitHubInstallationSummary[]>([]);
	let githubAppInstallUrl = $state<string | null>(null);
	let branches = $state<Branch[]>([]);
	let dockerfiles = $state<string[]>([]);
	let loadingBranches = $state(false);
	let loadingDockerfiles = $state(false);
	let detectRun = 0;

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
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let ports = $state<PortRow[]>([portRow(80, 0)]);
	let portsManuallyEdited = $state(false);
	let envVars = $state<{ key: string; value: string; secret?: boolean }[]>([
		{ key: '', value: '' }
	]);
	let envsManuallyEdited = $state(false);
	let buildWithDepot = $state(false);
	let envViewMode = $state<'grid' | 'raw'>('grid');
	let envRawText = $state('');
	let volumes = $state<
		Array<{
			id: number;
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
		const installEarly = apiFetch('/apiv1/github/app/install').catch(() => null);
		try {
			const status = await queryClient.fetchQuery(githubStatusQueryOptions());
			githubLinked = !!status.linked && !status.tokenExpired;
			installations = status.installations ?? [];
			if (!selectedAccount) selectedAccount = defaultAccount(installations);
		} catch (e) {
			console.error('Failed to check GitHub status:', e);
			githubLinked = false;
		}
		try {
			const installRes = await installEarly;
			if (installRes?.ok) {
				const data = await installRes.json();
				githubAppInstallUrl = data.url;
			}
		} catch (e) {
			console.error('Failed to check GitHub status:', e);
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
				ports = [portRow(preset.port, 0)];
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
			ports = det.ports.map((p, i) => portRow(p, i));
		}
		if (det.env.length > 0 && !envsManuallyEdited) {
			envVars = det.env.map((e) => ({ key: e.key, value: e.value }));
		}
	}

	async function fetchDockerfiles(repo: Pick<Repository, 'full_name'>, branchName: string) {
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
					ports = info.exposedPorts.map((p, i) => portRow(p, i));
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
		rememberAccount(login);
	}

	function selectRepo(repo: Repository) {
		selectedAccount = repo.full_name.split('/')[0];
		rememberAccount(selectedAccount);
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
					detectForBranch(defaultBranch.name);
				}
			}
		} catch (e) {
			console.error('Failed to fetch branches:', e);
		} finally {
			loadingBranches = false;
		}
	}

	function detectForBranch(branchName: string) {
		const ownerRepo = getOwnerRepo();
		if (ownerRepo) {
			fetchDockerfiles({ full_name: `${ownerRepo.owner}/${ownerRepo.repo}` }, branchName);
		}
	}

	function selectBranch(b: Branch) {
		selectedBranch = b;
		branch = b.name;
		branchSearch = b.name;
		detectForBranch(b.name);
	}

	function useCustomBranch(name: string) {
		selectedBranch = null;
		branch = name;
		branchSearch = name;
		detectForBranch(name);
	}

	function addPort() {
		portsManuallyEdited = true;
		ports = [...ports, portRow(ports.length === 0 ? 80 : 8080, ports.length)];
	}

	function setProtocol(index: number, protocol: string) {
		portsManuallyEdited = true;
		const port = ports[index];
		port.protocol = protocol;
		if (protocol === 'UDP' && isLink(port.reach)) port.reach = 'internal';
	}

	function reachOptions(protocol: string): DropdownOption[] {
		return protocol === 'UDP'
			? REACH_OPTIONS.map((o) => (isLink(o.value) ? { ...o, disabled: true } : o))
			: REACH_OPTIONS;
	}

	function removePort(index: number) {
		portsManuallyEdited = true;
		if (ports.length > 1) {
			ports = ports.filter((_, i) => i !== index);
		}
	}

	function addVolume() {
		volumes = [
			...volumes,
			{ id: ++rowSeq, name: '', type: 'pvc', mountPath: '', pvcName: '', readOnly: false }
		];
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
		const listing = await apiFetch(`/apiv1/projects?orgId=${orgId}`);
		if (!listing.ok) throw new Error('Could not load your projects');
		const existing = findProjectByName<{ id: string; name: string; slug: string }>(
			await listing.json(),
			pendingProjectName
		);
		if (existing) return existing;
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
				protocol: p.protocol,
				reach: p.reach
			}));

		if (validPorts.length === 0) {
			formError = 'At least one valid port is required';
			return;
		}

		const secretKeys = new Set(envVars.filter((e) => e.secret).map((e) => e.key.trim()));
		const envSource = envViewMode === 'raw' ? rawToEnvVars(envRawText) : envVars;
		const validEnv = envSource
			.filter((e) => e.key.trim())
			.map((e) => ({
				key: e.key.trim(),
				value: e.value,
				secret: secretKeys.has(e.key.trim())
			}));

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
				exposePublic: validPorts.some((p) => p.reach === 'port'),
				autoUrl: validPorts.some((p) => isLink(p.reach)),
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
	let debouncedQuery = $state('');

	$effect(() => {
		const typed = repoQuery.trim();
		if (!typed) {
			debouncedQuery = '';
			return;
		}
		const timer = setTimeout(() => (debouncedQuery = typed), 200);
		return () => clearTimeout(timer);
	});

	const accounts = $derived(installations.map((i) => ({ login: i.accountLogin })));
	const searchInstallation = $derived(
		installations.find((i) => i.accountLogin === selectedAccount) ??
			installations.find((i) => i.accountLogin === defaultAccount(installations)) ??
			null
	);
	const searchTarget = $derived.by(() => {
		const parsed = parseRepoInput(debouncedQuery);
		if (parsed) {
			const owner = installations.find(
				(i) => i.accountLogin.toLowerCase() === parsed.owner.toLowerCase()
			);
			return owner ? { account: owner.accountLogin, q: parsed.repo } : null;
		}
		return searchInstallation
			? { account: searchInstallation.accountLogin, q: debouncedQuery }
			: null;
	});
	const targetInstallation = $derived(
		installations.find((i) => i.accountLogin === searchTarget?.account) ?? null
	);
	const repoResults = createQuery(() => {
		const options = repoSearchQueryOptions(searchTarget?.account ?? '', searchTarget?.q ?? '');
		return {
			...options,
			enabled: deploymentSource === 'github' && githubLinked === true && !!searchTarget,
			placeholderData: (
				previous: Awaited<ReturnType<typeof options.queryFn>> | undefined,
				previousQuery?: { queryKey: readonly unknown[] }
			) => (previousQuery?.queryKey[1] === options.queryKey[1] ? previous : undefined)
		};
	});

	function matchesTyped(fullName: string, typed: string) {
		const parsed = parseRepoInput(typed);
		const name = fullName.toLowerCase();
		if (parsed) return name.startsWith(`${parsed.owner}/${parsed.repo}`.toLowerCase());
		const words = (name.split('/')[1] ?? name).split(/[^a-z0-9]+/);
		return typed
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean)
			.every((term) => words.some((word) => word.startsWith(term)));
	}

	const typedQuery = $derived(repoQuery.trim());
	const repoSettled = $derived(!repoResults.isPlaceholderData && typedQuery === debouncedQuery);
	const repoSearching = $derived(
		!!typedQuery && !!searchTarget && (!repoSettled || repoResults.isFetching)
	);
	const reposLoading = $derived(
		githubLinked === null || (!repoResults.data && repoResults.isFetching)
	);
	const searchError = $derived(
		repoResults.error instanceof RepoSearchError
			? repoResults.error
			: repoResults.error
				? new RepoSearchError('Could not search your repositories.', null, null)
				: null
	);
	const listedRepos = $derived.by((): Repository[] => {
		const found = searchTarget ? (repoResults.data?.repositories ?? []) : [];
		const list =
			repoSettled || !typedQuery
				? found
				: found.filter((r) => matchesTyped(r.full_name, typedQuery));
		if (
			!typedQuery &&
			selectedRepo &&
			selectedRepo.full_name.split('/')[0] === searchTarget?.account &&
			!list.some((r) => r.full_name === selectedRepo?.full_name)
		) {
			return [selectedRepo, ...list];
		}
		return list;
	});
	const parsedRepoInput = $derived(parseRepoInput(repoQuery.trim()));
	const parsedRepoIsListed = $derived(
		!!parsedRepoInput &&
			listedRepos.some(
				(r) =>
					r.full_name.toLowerCase() ===
					`${parsedRepoInput.owner}/${parsedRepoInput.repo}`.toLowerCase()
			)
	);
	const repoOptions = $derived<DropdownOption[]>(
		listedRepos.map((r) => {
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
		const repo = listedRepos.find((r) => r.full_name === fullName);
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
		...dockerfileStages.map((st) => ({ value: st, label: st, mono: true }))
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
	const quotaMe = createQuery(() => quotaMeQuery($selectedOrganization?.id ?? null));
	const resourcesNote = $derived(
		describeResources(resourceCpuMilli, resourceMemoryBytes, quotaMe.data?.podDefaults?.app)
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
		...ports
			.filter((p) => p.containerPort > 0 && p.reach !== 'internal')
			.map((p) => ({
				name: `Port ${p.containerPort}`,
				type: 'ingress' as const,
				note: REACH_LABEL[p.reach]
			})),
		...volumes
			.filter((v) => v.pvcName?.trim())
			.map((v) => ({ name: v.pvcName!.trim(), type: 'volume' as const }))
	]);
</script>

{#snippet lock(option: DropdownOption)}
	{#if listedRepos.find((r) => r.full_name === option.value)?.private}
		<Lock size={13} class="text-faint" aria-label="Private" />
	{/if}
{/snippet}

{#snippet repoGlyph()}
	<BookMarked size={15} class="text-muted" />
{/snippet}

{#snippet defaultTag(option: DropdownOption)}
	{#if option.value === defaultBranch}<Badge>Default</Badge>{/if}
{/snippet}

{#snippet repoEmpty(typed: string)}
	{#if searchError}
		{searchError.message}
		{#if searchError.code === 'github_reconnect'}
			<a class="text-link" href="/user/settings">Connect GitHub</a>
		{/if}
	{:else}
		{#if repoSearching || reposLoading}
			Searching {searchTarget?.account ?? 'GitHub'}
		{:else if typed}
			No repositories match
		{:else}
			No repositories on {searchTarget?.account ?? 'this account'}
		{/if}
		{#if targetInstallation}
			<a
				class="mt-1 block text-link"
				href={installationSettingsUrl(targetInstallation)}
				target="_blank"
				rel="noopener noreferrer">Configure on GitHub</a
			>
		{/if}
	{/if}
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
			novalidate
			onsubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<Stack gap="lg">
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
						<Swap key={deploymentSource}>
							<Stack gap="md">
								{#if deploymentSource === 'image'}
									<Field label="Image">
										<Input
											bind:value={image}
											size="lg"
											placeholder="ghcr.io/org/app:latest"
											mono
											icon={Container}
										/>
									</Field>
								{:else if deploymentSource === 'git'}
									<GitSourcePane
										onSelect={(sel) => {
											gitSelection = sel;
											if (sel) {
												repoUrl = sel.repoUrl;
												branch = sel.branch;
												if (!nameTouched && !name.trim())
													name = sel.repoPath.split('/').pop() ?? '';
											}
										}}
										onDetect={(det) => applyDetection(det as DetectionResult)}
									/>
								{:else}
									{#if githubLinked === false}
										<Alert tone="warning" title="GitHub not connected">
											Paste owner/repo into the repository search to deploy a public repo.
											{#snippet actions()}
												<Button variant="secondary" size="sm" href="/user/settings"
													>Connect GitHub</Button
												>
											{/snippet}
										</Alert>
									{:else if githubLinked && installations.length === 0}
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
									<Field label="Repository">
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
													loading={reposLoading}
													searching={repoSearching}
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
													optionLeading={repoGlyph}
													empty={repoEmpty}
												/>
											{/snippet}
										</SourcePath>
									</Field>
									<Field label="Branch">
										<SearchPicker
											block
											size="lg"
											mono
											value={branch}
											options={branchOptions}
											loading={loadingBranches}
											disabled={!hasRepo}
											placeholder="main"
											searchPlaceholder="Search or type a branch"
											creatable
											createLabel={(q) => `Use ${q}`}
											onchange={pickBranchByName}
											onclear={() => {
												selectedBranch = null;
												branch = '';
											}}
											trailing={defaultTag}
										>
											{#snippet leading()}<GitBranch size={15} class="text-muted" />{/snippet}
										</SearchPicker>
									</Field>
								{/if}
							</Stack>
						</Swap>

						<Field label="Name" for="nd-name">
							<Input
								id="nd-name"
								size="lg"
								bind:value={name}
								oninput={() => (nameTouched = true)}
								placeholder="app-name"
								mono
							/>
						</Field>

						{#if isRepoSource}
							<Field label="Build with">
								<Dropdown
									size="lg"
									value={frameworkValue}
									options={FRAMEWORK_OPTIONS}
									onchange={onFrameworkPicked}
									loading={loadingDockerfiles}
									ariaLabel="Build with"
								>
									{#snippet icon(value)}
										<FrameworkIcon framework={value === DOCKERFILE_OPTION ? 'dockerfile' : value} />
									{/snippet}
								</Dropdown>
							</Field>
							{#if buildType === 'railpack' && detectedApps.length > 1}
								<Field label="App in this repository">
									<Dropdown
										size="lg"
										mono
										ariaLabel="App in this repository"
										value={rootDirectory}
										options={rootDirectoryOptions}
										onchange={(dir) => {
											const app = detectedApps.find((a) => a.dir === dir);
											if (app) selectRootDirectory(app);
										}}
									>
										{#snippet icon(dir)}<FrameworkIcon framework={frameworkOfDir(dir)} />{/snippet}
									</Dropdown>
								</Field>
							{/if}
						{/if}

						<Divider />

						{#if isRepoSource}
							<Disclosure title="Build and output settings" note={buildNote}>
								{#if buildType === 'dockerfile'}
									<FieldGrid ratio="golden">
										<Field label="Dockerfile">
											{#if dockerfiles.length > 1}
												<SearchPicker
													size="lg"
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
													size="lg"
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
												size="lg"
												bind:value={selectedStage}
												options={stageOptions}
												loading={loadingStages}
												ariaLabel="Stage"
											/>
										</Field>
									</FieldGrid>
									<ToggleRow
										bind:checked={buildFromRoot}
										onchange={() => (buildFromRootTouched = true)}
										label="Build from the repository root"
										hint="For a Dockerfile that copies files from outside its own folder."
									/>
								{:else}
									<FieldGrid ratio="golden">
										<Field label="Install command">
											<Input
												size="lg"
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
												size="lg"
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
												size="lg"
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
												size="lg"
												value={outputDirectory}
												oninput={(e: Event) => {
													outputDirectory = (e.currentTarget as HTMLInputElement).value;
													buildSettingsTouched = true;
												}}
												placeholder="Detected"
												mono
											/>
										</Field>
									</FieldGrid>
								{/if}
							</Disclosure>
						{:else}
							<Disclosure
								title="Run settings"
								note={imageStartCommand.trim() ? 'Custom command' : 'Image defaults'}
							>
								<Field label="Start command">
									<Input
										size="lg"
										bind:value={imageStartCommand}
										placeholder="Image default"
										mono
									/>
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
						secrets
						minRows={1}
						onedit={() => (envsManuallyEdited = true)}
					/>
				</SectionCard>

				<SectionCard title="Networking">
					<RowList
						label="Ports"
						items={ports}
						key={(p) => p.id}
						columns={[
							{ label: 'Port', width: '8rem' },
							{ label: 'Protocol', width: '5.25rem' },
							{ label: 'Reach' }
						]}
						addLabel="Add port"
						onadd={addPort}
						onremove={removePort}
						removeLabel={(p) => `Remove port ${p.containerPort}`}
						minRows={1}
					>
						{#snippet row(port, index)}
							<Input
								type="number"
								bind:value={port.containerPort}
								oninput={() => (portsManuallyEdited = true)}
								min="1"
								placeholder="80"
								aria-label="Port"
								mono
							/>
							<SegmentedControl
								label="Protocol"
								size="sm"
								options={PROTOCOL_OPTIONS}
								bind:value={() => port.protocol, (v) => setProtocol(index, v)}
							/>
							<Dropdown
								bind:value={() => port.reach, (v) => (port.reach = v as Reach)}
								options={reachOptions(port.protocol)}
								ariaLabel="Reach for port {port.containerPort}"
							/>
						{/snippet}
					</RowList>
				</SectionCard>

				<SectionCard title="Advanced">
					<DisclosureGroup>
						<Disclosure
							title="Storage"
							note={volumes.length
								? `${volumes.length} ${volumes.length === 1 ? 'volume' : 'volumes'}`
								: 'None'}
						>
							<RowList
								label="Volumes"
								items={volumes}
								key={(v) => v.id}
								columns={[
									{ label: 'Name' },
									{ label: 'Mount path' },
									{ label: 'Read-only', width: '4rem' }
								]}
								addLabel="Add volume"
								onadd={addVolume}
								onremove={removeVolume}
								removeLabel={(v) => `Remove ${v.pvcName || 'volume'}`}
							>
								{#snippet row(volume)}
									<Input bind:value={volume.pvcName} placeholder="data" aria-label="Volume name" />
									<Input
										bind:value={volume.mountPath}
										placeholder="/data"
										aria-label="Mount path"
										mono
									/>
									<Switch bind:checked={volume.readOnly} label="Read-only" />
								{/snippet}
							</RowList>
						</Disclosure>

						<Disclosure title="Resources" note={resourcesNote}>
							<ResourcePicker
								bind:cpuMilli={resourceCpuMilli}
								bind:memoryBytes={resourceMemoryBytes}
							/>
						</Disclosure>

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
					</DisclosureGroup>
				</SectionCard>

				{#if formError}
					<Alert tone="error">{formError}</Alert>
				{/if}

				<FormActions>
					<Button variant="ghost" href={basePath}>Cancel</Button>
					<Button variant="primary" size="lg" type="submit" loading={submitting}>Deploy</Button>
				</FormActions>
			</Stack>
		</form>
	{/if}
</Page>
