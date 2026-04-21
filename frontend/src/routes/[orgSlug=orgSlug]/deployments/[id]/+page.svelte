<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { Tabs } from 'melt/builders';
	import { apiFetch, toasts, refreshTree, isSuperAdmin } from '$lib/stores';
	import { AnsiUp } from 'ansi_up';
	import {
		ArrowLeft,
		Loader2,
		RefreshCw,
		Trash2,
		Play,
		Scale,
		Settings,
		Terminal,
		Globe,
		History,
		Plus,
		X,
		Server,
		Container,
		ExternalLink,
		Copy,
		Check,
		HardDrive,
		ChevronDown,
		Eye,
		EyeOff,
		Lock,
		Webhook,
		Bell,
		AlertTriangle,
		CircleX
	} from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import { scale, fade, slide } from 'svelte/transition';
	import { Clock, Minimize2, Maximize2, Cpu, MemoryStick } from 'lucide-svelte';
	import { browser } from '$app/environment';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';

	let Line: any = $state(null);

	if (browser) {
		import('chart.js').then(({ Chart, LinearScale, PointElement, LineElement, Filler, Tooltip }) => {
			Chart.register(LinearScale, PointElement, LineElement, Filler, Tooltip);
		});
		import('svelte5-chartjs').then((mod) => {
			Line = mod.Line;
		});
	}
	import DeploymentProgress from '$lib/components/DeploymentProgress.svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';

	interface Pod {
		name: string;
		status: string;
		ip?: string;
		startTime?: string;
		cpuUsage?: number | null;
		memoryUsage?: number | null;
		containers?: Array<{ name: string; image: string; ready: boolean }>;
	}

	function formatCpu(millicores: number | null | undefined): string {
		if (millicores == null) return 'N/A';
		if (millicores >= 1000) return `${(millicores / 1000).toFixed(1)} cores`;
		return `${millicores}m`;
	}

	function formatMemory(bytes: number | null | undefined): string {
		if (bytes == null) return 'N/A';
		if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
		if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
		if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${bytes} B`;
	}

	function formatRelativeTime(date: Date): string {
		const now = Date.now();
		const diffMs = now - date.getTime();
		const diffS = Math.floor(diffMs / 1000);
		if (diffS < 5) return 'just now';
		if (diffS < 60) return `${diffS}s ago`;
		const diffM = Math.floor(diffS / 60);
		if (diffM < 60) return `${diffM}m ago`;
		const diffH = Math.floor(diffM / 60);
		if (diffH < 24) return `${diffH}h ${diffM % 60}m ago`;
		const diffD = Math.floor(diffH / 24);
		return `${diffD}d ago`;
	}

	const ansi = new AnsiUp();
	ansi.use_classes = false;

	// ANSI escape code → HTML with color spans
	function ansiToHtml(text: string): string {
		if (!text) return '';

		// Strip lines that contain only a timestamp (and optional whitespace/ANSI codes)
		// The raw format has alternating lines: "TIMESTAMP \n" then "TIMESTAMP <content>\n"
		let cleaned = text.replace(/\r/g, '').split('\n').filter(line => {
			// Remove ANSI codes and ISO timestamps, then check if anything visible remains
			const stripped = line
				.replace(/\x1b\[[0-9;]*m/g, '')
				.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '')
				.trim();
			return stripped.length > 0;
		}).join('\n');

		// Convert ANSI to HTML (ansi_up handles escaping and all ANSI codes)
		let result = ansi.ansi_to_html(cleaned);

		// Replace ISO timestamps with compact local-time pills with rich tooltip
		// Matches: 2026-03-25T04:26:10.578977993Z or 2026-03-25T04:26:10Z or 2026-03-25T04:26:10.578Z
		result = result.replace(
			/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
			(ts) => {
				try {
					const d = new Date(ts);
					const h = d.getHours().toString().padStart(2, '0');
					const m = d.getMinutes().toString().padStart(2, '0');
					const s = d.getSeconds().toString().padStart(2, '0');
					const ms = d.getMilliseconds().toString().padStart(3, '0');

					// Tooltip data
					const fullLocal = d.toLocaleString(undefined, {
						weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
						hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3
					});
					const utcStr = d.toLocaleString(undefined, {
						hour: '2-digit', minute: '2-digit', second: '2-digit',
						timeZone: 'UTC', timeZoneName: 'short'
					});
					const ago = formatRelativeTime(d);
					const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

					return `<span class="log-ts" data-tooltip-local="${fullLocal}" data-tooltip-utc="${utcStr}" data-tooltip-ago="${ago}" data-tooltip-tz="${tz}" data-tooltip-raw="${ts}">${h}:${m}:${s}<span class="log-ts-ms">.${ms}</span></span>`;
				} catch {
					return ts;
				}
			}
		);

		return result;
	}

	interface ServicePortConfig {
		name?: string;
		port: number;
		targetPort: number;
		protocol: string;
		nodePort?: number | null;
	}

	interface Service {
		id: string;
		name: string;
		port: number;
		targetPort: number;
		protocol: string;
		nodePort?: number;
		type?: string;
		externalIp?: string | null;
		domain?: string | null;
		ports?: ServicePortConfig[];
		internalUrl?: string;
		internalUrls?: string[];
	}

	interface IngressRoute {
		path: string;
		serviceName: string;
		servicePort: number;
	}

	interface Ingress {
		id: string;
		name: string;
		host: string;
		path: string;
		tlsEnabled: boolean;
		address?: string;
		annotations?: Record<string, any>;
		routes?: IngressRoute[];
		service?: {
			id: string;
			name: string;
			port: number;
		};
	}

	interface ImageHistory {
		id: string;
		image: string;
		branch?: string;
		commitSha?: string;
		commitMessage?: string;
		createdAt: string;
		isActive: boolean;
		triggerType?: string;
		triggeredBy?: {
			id: string;
			username: string;
			firstName?: string;
			lastName?: string;
		};
	}

	interface Volume {
		id: string;
		name: string;
		type: 'pvc' | 'hostPath' | 'emptyDir';
		mountPath: string;
		pvcName?: string | null;
		storageSize?: string | null;
		hostPath?: string | null;
		readOnly: boolean;
	}

	interface Deployment {
		id: string;
		name: string;
		status: string;
		buildStatus?: string;
		buildStep?: string | null;
		replicas: number;
		availableReplicas: number;
		image?: string;
		namespace?: string;
		env?: Array<{ key: string; value: string }>;
		volumes?: Volume[];
		pods?: Pod[];
		services?: Service[];
		ingresses?: Ingress[];
		imageHistory?: ImageHistory[];
		githubRepo?: string;
		githubBranch?: string;
		buildType?: 'dockerfile' | 'railpack';
		dockerfilePath?: string;
		buildFromRoot?: boolean;
		buildWithDepot?: boolean;
		buildLogs?: string;
		buildError?: string;
		buildStepTimestamps?: Record<string, number> | null;
		autoDeployEnabled?: boolean;
		autoDeployBranch?: string;
		healthCheckEnabled?: boolean;
		healthCheckPath?: string;
		healthCheckPort?: number;
		healthCheckType?: string;
		healthCheckCommand?: string;
		livenessEnabled?: boolean;
		readinessEnabled?: boolean;
		startupEnabled?: boolean;
		healthCheckInterval?: number;
		healthCheckTimeout?: number;
		healthCheckRetries?: number;
		startupFailureThreshold?: number;
		totalCpuUsage?: number | null;
		totalMemoryUsage?: number | null;
		warnings?: Array<{ podName: string; message: string; timestamp: string }>;
		project?: {
			id: string;
			name: string;
			slug: string;
			backgroundImage?: string | null;
		};
	}

	interface AutoDeployStatus {
		enabled: boolean;
		branch: string;
		appInstalled: boolean;
	}

	interface GitHubAppInstallation {
		id: string;
		installationId: string;
		accountLogin: string;
		accountType: string;
	}

	interface GitHubDeploymentRecord {
		id: string;
		githubDeploymentId: string;
		owner: string;
		repo: string;
		ref: string;
		commitSha: string;
		environment: string;
		status: string;
		logUrl?: string;
		environmentUrl?: string;
		createdAt: string;
	}

	type ServicePortForm = {
		name: string;
		containerPort: number;
		servicePort: number;
		protocol: string;
		nodePort?: number | null;
	};

	type ServiceFormState = {
		name: string;
		exposePublic: boolean;
		ports: ServicePortForm[];
	};

	const tabSections = [
		{
			id: 'overview',
			label: 'Overview',
			description: 'Console, status & pods',
			icon: Server
		},
		{
			id: 'environment',
			label: 'Environment',
			description: 'Config & secrets',
			icon: Settings
		},
		{
			id: 'volumes',
			label: 'Storage',
			description: 'Persistent storage',
			icon: HardDrive
		},
		{
			id: 'network',
			label: 'Network',
			description: 'Ports & domains',
			icon: Globe
		},
		{
			id: 'history',
			label: 'Build History',
			description: 'Builds & rollbacks',
			icon: History
		},
		{
			id: 'webhooks',
			label: 'Webhooks',
			description: 'Deploy triggers & tokens',
			icon: Webhook
		},
		{
			id: 'advanced',
			label: 'Advanced',
			description: 'Build options & settings',
			icon: Settings
		}
	] as const;

	type TabId = (typeof tabSections)[number]['id'];

	// Docker image deployments (no githubRepo) get the webhooks tab
	const isDockerImageDeployment = $derived(!deployment?.githubRepo);
	const visibleTabs = $derived(
		tabSections.filter((tab) => tab.id !== 'webhooks' || isDockerImageDeployment)
	);

	const tabs = new Tabs<TabId>({
		value: 'overview',
		loop: true
	});

	let deployment = $state<Deployment | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let projectBgImage = $derived(deployment?.project?.backgroundImage ?? null);

	let deletingIngressId = $state<string | null>(null);
	let projectIngresses = $state<Array<{ id: string; host: string; path?: string; deploymentId?: string | null }>>([]);

	let showDomainForm = $state(false);
	let newDomainHost = $state('');
	let newDomainPath = $state('/');
	let newDomainTlsEnabled = $state(true);
	let newDomainServiceKey = $state('');
	let showDomainAdvanced = $state(false);
	let creatingDomain = $state(false);
	let domainFormError = $state<string | null>(null);

	const domainServiceOptions = $derived.by(() => {
		const opts: Array<{ key: string; label: string; serviceName: string; port: number }> = [];
		for (const s of deployment?.services ?? []) {
			opts.push({ key: `${s.id}::${s.port}`, label: `Port ${s.port}`, serviceName: s.name, port: s.port });
		}
		return opts;
	});

	const newDomainNormalizedHost = $derived(newDomainHost.trim().toLowerCase());
	const newDomainNormalizedPath = $derived.by(() => {
		const p = newDomainPath.trim() || '/';
		return p.startsWith('/') ? p : `/${p}`;
	});

	const newDomainConflict = $derived.by(() => {
		if (!newDomainNormalizedHost) return null;
		const sameHost = projectIngresses.filter((i) => i.host === newDomainNormalizedHost);
		if (sameHost.length === 0) return null;
		const otherDeployment = sameHost.find((i) => i.deploymentId !== deployment?.id);
		const pathCollision = sameHost.find((i) => (i.path || '/') === newDomainNormalizedPath);
		return { otherDeployment: !!otherDeployment, pathCollision: !!pathCollision };
	});

	// Metrics history for time-series charts
	let metricsHistory = $state<Array<{ time: Date; cpu: number | null; memory: number | null }>>([]);
	let metricsTimeRange = $state<'5m' | '15m' | '30m' | '1h'>('30m');

	const timeRangeMs = $derived({
		'5m': 5 * 60 * 1000,
		'15m': 15 * 60 * 1000,
		'30m': 30 * 60 * 1000,
		'1h': 60 * 60 * 1000,
	}[metricsTimeRange]);

	const filteredMetrics = $derived(
		metricsHistory.filter(p => p.time.getTime() > Date.now() - timeRangeMs)
	);

	// Build chart data with numeric X timestamps so we can set min/max on the axis
	const cpuChartData = $derived({
		labels: filteredMetrics.map(p => p.time.getTime()),
		datasets: [{
			label: 'CPU (millicores)',
			data: filteredMetrics.map(p => p.cpu),
			borderColor: '#b33346',
			backgroundColor: 'rgba(179, 51, 70, 0.15)',
			fill: true,
		}],
	});

	const memoryChartData = $derived({
		labels: filteredMetrics.map(p => p.time.getTime()),
		datasets: [{
			label: 'Memory (MB)',
			data: filteredMetrics.map(p => p.memory != null ? p.memory / (1024 * 1024) : null),
			borderColor: '#e87485',
			backgroundColor: 'rgba(232, 116, 133, 0.15)',
			fill: true,
		}],
	});

	function getThemeColors() {
		if (typeof document === 'undefined') return { muted: '#888', gridLine: 'rgba(128,128,128,0.1)' };
		const style = getComputedStyle(document.documentElement);
		const muted = style.getPropertyValue('--surface-muted').trim() || '#888';
		const border = style.getPropertyValue('--surface-border').trim() || 'rgba(128,128,128,0.1)';
		return { muted, gridLine: border };
	}

	function makeChartOptions(yTickSuffix: string) {
		const now = Date.now();
		const theme = getThemeColors();
		return {
			responsive: true,
			maintainAspectRatio: false,
			animation: { duration: 0 } as const,
			scales: {
				x: {
					type: 'linear' as const,
					display: true,
					min: now - timeRangeMs,
					max: now,
					ticks: {
						maxTicksToShow: 6,
						maxRotation: 0,
						font: { size: 10 },
						color: theme.muted,
						callback: (value: number) => {
							const d = new Date(value);
							return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
						},
					},
					grid: { display: false },
					border: { display: false },
				},
				y: {
					display: true,
					beginAtZero: true,
					ticks: { font: { size: 10 }, color: theme.muted, callback: (v: number) => v + yTickSuffix },
					grid: { color: theme.gridLine },
					border: { display: false },
				},
			},
			plugins: {
				tooltip: {
					mode: 'index' as const,
					intersect: false,
					backgroundColor: 'rgba(0,0,0,0.8)',
					titleFont: { size: 11 },
					bodyFont: { size: 11 },
					padding: 8,
					callbacks: {
						title: (items: any[]) => {
							if (!items.length) return '';
							const d = new Date(items[0].parsed.x);
							return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
						},
					},
				},
			},
			elements: {
				point: { radius: 0, hoverRadius: 4 },
				line: { tension: 0.3, borderWidth: 2 },
			},
		};
	}

	const cpuChartOptions = $derived(makeChartOptions('m'));
	const memoryChartOptions = $derived(makeChartOptions(' MB'));

	// Computed properties for template compatibility with API field names
	const repoUrl = $derived(deployment?.githubRepo);
	const branch = $derived(deployment?.githubBranch);

	let notificationsOpen = $state(false);
	let notifBtnEl: HTMLButtonElement | undefined = $state();
	let notifPanelPos = $derived.by(() => {
		if (!notificationsOpen || !notifBtnEl) return { top: 0, left: 0 };
		const rect = notifBtnEl.getBoundingClientRect();
		return { top: rect.bottom, left: Math.max(8, rect.right - 380) };
	});
	const notificationCount = $derived(
		(deployment?.warnings?.length ?? 0) +
		(deployment?.buildStatus === 'failed' && (deployment?.buildError || deployment?.buildLogs) ? 1 : 0)
	);

	let restarting = $state(false);
	let scaling = $state(false);
	let deleting = $state(false);
	let showDeleteModal = $state(false);
	let rebuilding = $state(false);
	let savingEnv = $state(false);
	let savingVolumes = $state(false);
	let savingAdvanced = $state(false);
	let savingService = $state(false);
	let buildFromRoot = $state(false);
	let buildWithDepot = $state(false);

	// Auto-deploy state
	let autoDeployStatus = $state<AutoDeployStatus | null>(null);
	let autoDeployLoading = $state(false);
	let autoDeployBranch = $state('');
	let enablingAutoDeploy = $state(false);
	let disablingAutoDeploy = $state(false);
	let githubDeployments = $state<GitHubDeploymentRecord[]>([]);
	let githubAppInstallUrl = $state<string | null>(null);
	let loadingAppInstallUrl = $state(false);

	// Health check state
	let healthCheckEnabled = $state(false);
	let healthCheckType = $state('http');
	let healthCheckPath = $state('/');
	let healthCheckPort = $state(80);
	let healthCheckCommand = $state('');
	let livenessEnabled = $state(true);
	let readinessEnabled = $state(true);
	let startupEnabled = $state(false);
	let healthCheckInterval = $state(30);
	let healthCheckTimeout = $state(5);
	let healthCheckRetries = $state(3);
	let startupFailureThreshold = $state(30);
	let savingHealthCheck = $state(false);
	let isEditingHealthCheck = $state(false);

	let selectedPod = $state<string>('');
	let selectedContainer = $state<string>('');
	let manualPodSelection = $state(false);
	let tailLines = $state(100);
	let logs = $state<string>('');
	let logsLoading = $state(false);
	let logsOutputRef = $state<HTMLPreElement | null>(null);
	let buildLogs = $state<string>('');
	let buildLogsLoading = $state(false);
	let podDropdownOpen = $state(false);
	let containerDropdownOpen = $state(false);

	// Console tab management: 'logs' or a terminal tab id
	let activeConsoleTab = $state<string>('logs');
	let showNewShellMenu = $state(false);
	let showLogsPodMenu = $state(false);

	interface TerminalTabInfo {
		id: string;
		podName: string;
		container: string;
		label: string;
	}
	let terminalTabs = $state<TerminalTabInfo[]>([]);
	let terminalCounter = 0;

	function podLabel(podName: string): string {
		// "backend-cb974cb4c-vjvfb" → "vjvfb"
		const parts = podName.split('-');
		return parts.length >= 2 ? parts[parts.length - 1] : podName;
	}

	function handleNewShell() {
		const allCombos: { podName: string; container: string }[] = [];
		for (const pod of deployment?.pods ?? []) {
			for (const c of pod.containers ?? []) {
				allCombos.push({ podName: pod.name, container: c.name });
			}
		}
		if (allCombos.length === 0) return;
		if (allCombos.length === 1) {
			openShell(allCombos[0].podName, allCombos[0].container);
			return;
		}
		showNewShellMenu = !showNewShellMenu;
	}

	function openShell(podName: string, container: string) {
		terminalCounter++;
		const id = `term-${Date.now()}`;
		const label = `Shell ${terminalCounter}`;
		terminalTabs = [...terminalTabs, { id, podName, container, label }];
		activeConsoleTab = id;
		showNewShellMenu = false;
	}

	function closeTerminalTab(id: string) {
		terminalTabs = terminalTabs.filter((t) => t.id !== id);
		if (activeConsoleTab === id) {
			activeConsoleTab = terminalTabs.length > 0 ? terminalTabs[terminalTabs.length - 1].id : 'logs';
		}
	}

	function selectLogsPod(podName: string, containerName?: string) {
		selectedPod = podName;
		const pod = (deployment?.pods ?? []).find((p) => p.name === podName);
		selectedContainer = containerName || pod?.containers?.[0]?.name || '';
		manualPodSelection = true;
		showLogsPodMenu = false;
		fetchLogs();
	}

	function getNewestPod(pods: Pod[]): Pod | null {
		if (!pods.length) return null;
		return pods.reduce((newest, pod) => {
			if (!newest.startTime) return pod;
			if (!pod.startTime) return newest;
			return new Date(pod.startTime) > new Date(newest.startTime) ? pod : newest;
		});
	}

	function scrollLogsToBottom() {
		if (logsOutputRef) {
			logsOutputRef.scrollTop = logsOutputRef.scrollHeight;
		}
	}
	let protocolDropdownOpen = $state<string | null>(null);
	let serviceDropdownOpen = $state(false);
	let scaleReplicas = $state(1);
	let sliderRef = $state<HTMLDivElement | null>(null);
	let isDragging = $state(false);
	let dragStartX = $state(0);
	let dragStartValue = $state(0);
	
	$effect(() => {
		if (deployment?.replicas !== undefined && deployment.replicas !== null && !isDragging) {
			scaleReplicas = deployment.replicas;
		}
	});
	
	function getValueFromPosition(clientX: number): number {
		if (!sliderRef) return scaleReplicas;
		const rect = sliderRef.getBoundingClientRect();
		const percentage = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		return Math.round(percentage * 20);
	}
	
	function handlePointerDown(event: PointerEvent) {
		if (!sliderRef) return;
		isDragging = true;
		dragStartX = event.clientX;
		dragStartValue = scaleReplicas;
		sliderRef.setPointerCapture(event.pointerId);
		scaleReplicas = getValueFromPosition(event.clientX);
	}
	
	function handlePointerMove(event: PointerEvent) {
		if (!isDragging || !sliderRef) return;
		scaleReplicas = getValueFromPosition(event.clientX);
	}
	
	function handlePointerUp(event: PointerEvent) {
		if (!sliderRef) return;
		isDragging = false;
		sliderRef.releasePointerCapture(event.pointerId);
	}
	
	function handlePointerCancel(event: PointerEvent) {
		if (!sliderRef) return;
		isDragging = false;
		sliderRef.releasePointerCapture(event.pointerId);
		scaleReplicas = dragStartValue;
	}
	
	function handleTrackClick(event: MouseEvent) {
		if (!sliderRef || isDragging) return;
		scaleReplicas = getValueFromPosition(event.clientX);
	}
	
	const sliderPercentage = $derived((scaleReplicas / 20) * 100);

	let envVars = $state<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);
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
	let volumes = $state<Array<{ name: string; type: 'pvc' | 'hostPath' | 'emptyDir'; mountPath: string; pvcName?: string; storageSize?: string; hostPath?: string; readOnly: boolean }>>([]);
	let showServiceForm = $state(false);
	let newServiceForm = $state<ServiceFormState>({
		name: '',
		exposePublic: false,
		ports: [
			{
				name: '',
				containerPort: 80,
				servicePort: 80,
				protocol: 'TCP',
				nodePort: null
			}
		]
	});
	let serviceFormError = $state<string | null>(null);
	let serviceEditForms = $state<Record<string, ServiceFormState>>({});
	let serviceEditErrors = $state<Record<string, string | null>>({});
	let creatingService = $state(false);
	let serviceSavingId = $state<string | null>(null);
	let serviceDeletingId = $state<string | null>(null);
	let copiedUrlId = $state<string | null>(null);
	let isEditingEnv = $state(false);
	let isEditingServices = $state(false);

	// Build modal state
	let showBuildModal = $state(false);
	let expandedBuildLogId = $state<string | null>(null);
	let buildLogCache = $state<Record<string, string>>({});
	let buildLogLoading = $state<string | null>(null);
	let consoleExpanded = $state(false);
	let consoleAnimating = $state(false);
	let consoleRef = $state<HTMLDivElement | null>(null);
	let consoleInlineRect = $state<{ top: number; left: number; width: number; height: number } | null>(null);

	function toggleConsoleExpand() {
		if (consoleAnimating) return;

		if (!consoleExpanded) {
			// Expanding: capture current inline rect, then animate to fullscreen
			if (consoleRef) {
				const r = consoleRef.getBoundingClientRect();
				consoleInlineRect = { top: r.top, left: r.left, width: r.width, height: r.height };
			}
			consoleAnimating = true;
			// Force a frame so the starting position renders before we transition
			requestAnimationFrame(() => {
				consoleExpanded = true;
				// Clear animating after transition ends
				setTimeout(() => { consoleAnimating = false; }, 300);
			});
		} else {
			// Collapsing: animate back to inline rect, then remove fixed
			consoleAnimating = true;
			consoleExpanded = false;
			setTimeout(() => {
				consoleInlineRect = null;
				consoleAnimating = false;
			}, 300);
		}
	}
	let showBuildCard = $state(false);
	let buildStartTime = $state<number>(0);
	let buildElapsed = $state(0);
	let accumulatedBuildLogs = $state<string | null>(null);
	let buildPollInterval: ReturnType<typeof setInterval> | null = null;
	let buildElapsedInterval: ReturnType<typeof setInterval> | null = null;
	let buildModalStatus = $state<string>('pending');
	let buildModalStep = $state<string | null>(null);
	let buildModalError = $state<string | null>(null);
	let buildModalWarnings = $state<Array<{ podName: string; message: string; timestamp: string }>>([]);
	let buildModalTimestamps = $state<Record<string, number> | null>(null);
	let cancelingBuild = $state(false);

	// Webhook state
	interface WebhookToken {
		id: string;
		label: string | null;
		createdAt: string;
		lastUsedAt: string | null;
		token?: string; // Only present on creation
	}
	let webhookTokens = $state<WebhookToken[]>([]);
	let webhookTokensLoading = $state(false);
	let webhookTokensFetched = $state(false);
	let creatingWebhookToken = $state(false);
	let deletingWebhookTokenId = $state<string | null>(null);
	let newWebhookLabel = $state('');
	let newlyCreatedToken = $state<string | null>(null);
	let copiedWebhookToken = $state(false);
	let copiedWebhookUrl = $state(false);

	function formatBuildElapsed(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		if (m > 0) return `${m}m ${s}s`;
		return `${s}s`;
	}

	function startBuildPolling() {
		buildStartTime = Date.now();
		buildElapsed = 0;
		accumulatedBuildLogs = null;
		buildModalStatus = 'pending';
		buildModalStep = null;
		buildModalError = null;
		buildModalWarnings = [];
		buildModalTimestamps = null;

		buildElapsedInterval = setInterval(() => {
			buildElapsed = Math.floor((Date.now() - buildStartTime) / 1000);
		}, 1000);

		buildPollInterval = setInterval(async () => {
			try {
				const response = await apiFetch(`/apiv1/deployments/${deploymentId}`);
				if (!response.ok) return;
				const data = await response.json();

				buildModalStatus = data.buildStatus ?? data.status;
				buildModalStep = data.buildStep ?? null;
				buildModalError = data.buildError ?? null;
				buildModalWarnings = data.warnings ?? [];
				buildModalTimestamps = data.buildStepTimestamps ?? null;
				if (data.buildLogs) {
					accumulatedBuildLogs = data.buildLogs;
				}

				if (data.buildStatus === 'succeeded') {
					stopBuildPolling();
					// Brief delay to show completion state
					setTimeout(() => {
						showBuildModal = false;
						showBuildCard = false;
						fetchDeployment();
					}, 1500);
				} else if (data.buildStatus === 'failed') {
					if (buildElapsedInterval) {
						clearInterval(buildElapsedInterval);
						buildElapsedInterval = null;
					}
				}
			} catch {}
		}, 2000);
	}

	function stopBuildPolling() {
		if (buildPollInterval) {
			clearInterval(buildPollInterval);
			buildPollInterval = null;
		}
		if (buildElapsedInterval) {
			clearInterval(buildElapsedInterval);
			buildElapsedInterval = null;
		}
	}

	function minimizeBuildModal() {
		showBuildModal = false;
		showBuildCard = true;
	}

	function expandBuildCard() {
		showBuildCard = false;
		showBuildModal = true;
	}

	async function cancelBuildFromModal() {
		if (cancelingBuild) return;
		cancelingBuild = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/cancel`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to cancel build');
			}
			toasts.add({
				title: 'Build cancelled',
				description: 'The build has been cancelled successfully',
				color: 'success'
			});
			stopBuildPolling();
			showBuildModal = false;
			showBuildCard = false;
			
			await new Promise(resolve => setTimeout(resolve, 1000));
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to cancel build',
				color: 'error'
			});
		} finally {
			cancelingBuild = false;
		}
	}

	const buildProgressValue = $derived(() => {
		const steps = ['cloning', 'building', 'pushing', 'deploying', 'complete'];
		if (buildModalStatus === 'running' || buildModalStep === 'complete') return 100;
		if (!buildModalStep) return 0;
		const idx = steps.indexOf(buildModalStep);
		if (idx < 0) return 0;
		if (buildModalStatus === 'failed') return ((idx + 1) / steps.length) * 100;
		return ((idx + 0.5) / steps.length) * 100;
	});

	const canCancelBuild = $derived(buildModalStatus === 'building' || buildModalStatus === 'pending');

	const deploymentId = $derived($page.params.id);
	const orgSlug = $derived($page.params.orgSlug);

	function createPortRow(overrides?: Partial<ServicePortForm>): ServicePortForm {
		return {
			name: '',
			containerPort: 80,
			servicePort: 80,
			protocol: 'TCP',
			nodePort: null,
			...overrides
		};
	}

	function resetNewServiceForm() {
		newServiceForm = {
			name: '',
			exposePublic: false,
			ports: [createPortRow()]
		};
		serviceFormError = null;
	}

	function updateNewServicePort(index: number, changes: Partial<ServicePortForm>) {
		newServiceForm = {
			...newServiceForm,
			ports: newServiceForm.ports.map((port, idx) =>
				idx === index ? { ...port, ...changes } : port
			)
		};
	}

	function addNewServicePortRow() {
		newServiceForm = {
			...newServiceForm,
			ports: [...newServiceForm.ports, createPortRow()]
		};
	}

	function removeNewServicePortRow(index: number) {
		if (newServiceForm.ports.length === 1) {
			updateNewServicePort(0, createPortRow());
			return;
		}
		newServiceForm = {
			...newServiceForm,
			ports: newServiceForm.ports.filter((_, idx) => idx !== index)
		};
	}

	function mapServiceToForm(service: Service): ServiceFormState {
		const sourcePorts =
			service.ports && service.ports.length > 0
				? service.ports
				: [
						{
							name: service.name,
							port: service.port,
							targetPort: service.targetPort,
							protocol: service.protocol,
							nodePort: service.nodePort ?? null
						}
				  ];

		return {
			name: service.name,
			exposePublic: service.type === 'external',
			ports: sourcePorts.map((entry) =>
				createPortRow({
					name: entry.name ?? '',
					containerPort: entry.targetPort,
					servicePort: entry.port,
					protocol: entry.protocol ?? 'TCP',
					nodePort: entry.nodePort ?? null
				})
			)
		};
	}

	function toggleServiceEdit(service: Service) {
		if (serviceEditForms[service.id]) {
			const { [service.id]: _removedForm, ...restForms } = serviceEditForms;
			serviceEditForms = restForms;
			const { [service.id]: _removedError, ...restErrors } = serviceEditErrors;
			serviceEditErrors = restErrors;
			if (Object.keys(serviceEditForms).length === 0 && !showServiceForm) {
				isEditingServices = false;
			}
			return;
		}

		isEditingServices = true;
		serviceEditForms = {
			...serviceEditForms,
			[service.id]: mapServiceToForm(service)
		};
		serviceEditErrors = {
			...serviceEditErrors,
			[service.id]: null
		};
	}

	async function copyInternalUrl(url: string | undefined, serviceId: string) {
		if (!url) {
			toasts.add({
				title: 'Error',
				description: 'No internal URL available',
				color: 'error'
			});
			return;
		}

		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(url);
			} else {
				const textArea = document.createElement('textarea');
				textArea.value = url;
				textArea.style.position = 'fixed';
				textArea.style.left = '-999999px';
				textArea.style.top = '-999999px';
				document.body.appendChild(textArea);
				textArea.focus();
				textArea.select();
				const successful = document.execCommand('copy');
				document.body.removeChild(textArea);
				if (!successful) {
					throw new Error('execCommand failed');
				}
			}
			copiedUrlId = serviceId;
			setTimeout(() => {
				copiedUrlId = null;
			}, 2000);
			toasts.add({
				title: 'Copied',
				description: 'Internal URL copied to clipboard',
				color: 'success'
			});
		} catch (error) {
			console.error('Copy failed:', error);
			toasts.add({
				title: 'Error',
				description: 'Failed to copy URL. Please select and copy manually.',
				color: 'error'
			});
		}
	}

	function updateServiceEditPort(
		serviceId: string,
		index: number,
		changes: Partial<ServicePortForm>
	) {
		const form = serviceEditForms[serviceId];
		if (!form) return;

		serviceEditForms = {
			...serviceEditForms,
			[serviceId]: {
				...form,
				ports: form.ports.map((port, idx) =>
					idx === index ? { ...port, ...changes } : port
				)
			}
		};
	}

	function addServiceEditPortRow(serviceId: string) {
		const form = serviceEditForms[serviceId];
		if (!form) return;

		serviceEditForms = {
			...serviceEditForms,
			[serviceId]: {
				...form,
				ports: [...form.ports, createPortRow()]
			}
		};
	}

	function removeServiceEditPortRow(serviceId: string, index: number) {
		const form = serviceEditForms[serviceId];
		if (!form) return;

		if (form.ports.length === 1) {
			updateServiceEditPort(serviceId, 0, createPortRow());
			return;
		}

		serviceEditForms = {
			...serviceEditForms,
			[serviceId]: {
				...form,
				ports: form.ports.filter((_, idx) => idx !== index)
			}
		};
	}

	function buildPortPayloadFromForm(form: ServiceFormState) {
		const payload: Array<{
			name?: string;
			containerPort: number;
			servicePort: number;
			protocol: string;
			nodePort?: number;
		}> = [];

		for (let index = 0; index < form.ports.length; index += 1) {
			const port = form.ports[index];
			const containerPort = Number(port.containerPort);
			const servicePort = Number(port.servicePort);

			if (!Number.isInteger(containerPort) || containerPort <= 0) {
				return { error: `Port ${index + 1}: Container port must be a positive integer` };
			}

			if (!Number.isInteger(servicePort) || servicePort <= 0) {
				return { error: `Port ${index + 1}: Service port must be a positive integer` };
			}

			const protocol =
				typeof port.protocol === 'string' && port.protocol.trim().length > 0
					? port.protocol.trim().toUpperCase()
					: 'TCP';

			const nodePortValue =
				port.nodePort === undefined || port.nodePort === null
					? undefined
					: Number(port.nodePort);

			const nodePort =
				nodePortValue !== undefined && Number.isInteger(nodePortValue) && nodePortValue > 0
					? nodePortValue
					: undefined;

			payload.push({
				name: port.name?.trim() || undefined,
				containerPort,
				servicePort,
				protocol,
				nodePort
			});
		}

		if (payload.length === 0) {
			return { error: 'Add at least one valid port' };
		}

		return { payload };
	}

	let deploymentInterval: ReturnType<typeof setInterval>;
	let podInterval: ReturnType<typeof setInterval>;
	let buildLogsInterval: ReturnType<typeof setInterval> | null = null;

	async function fetchDeployment() {
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}`);
			if (!response.ok) {
				throw new Error('Failed to fetch deployment');
			}
			const data = await response.json();

			// If deployment is building and modal/card isn't already showing, open the build modal
			// (The full-screen progress page is only used for first-time builds via the new deployment flow)
			if (data.buildStatus === 'building' && data.githubRepo && !showBuildModal && !showBuildCard) {
				showBuildModal = true;
				showBuildCard = false;
				stopBuildPolling();
				startBuildPolling();
			}

			deployment = data;

			// Seed metrics history from DB on first load, then append from polls
			if (data.metricsHistory?.length && metricsHistory.length === 0) {
				metricsHistory = data.metricsHistory.map((p: any) => ({
					time: new Date(p.time),
					cpu: p.cpu,
					memory: p.memory,
				}));
			} else if (data.totalCpuUsage != null || data.totalMemoryUsage != null) {
				metricsHistory = [
					...metricsHistory,
					{ time: new Date(), cpu: data.totalCpuUsage, memory: data.totalMemoryUsage }
				].slice(-360); // keep max 1 hour at 10s intervals
			}

			// Skip overwriting form state while a build is in progress so the user can
			// keep editing settings. Form state will refresh when the build finishes.
			const buildActive = showBuildModal || showBuildCard;

			if (!buildActive) {
				if (data.replicas !== undefined && data.replicas !== null) {
					scaleReplicas = data.replicas;
				} else {
					scaleReplicas = 1;
				}
				if (!showServiceForm) {
					resetNewServiceForm();
				}

				if (!isEditingEnv) {
					revealedIndices = new Set();
					if (data.envVars && Array.isArray(data.envVars) && data.envVars.length > 0) {
						envVars = [
							...data.envVars.map((ev: { key: string; value: string }) => ({
								key: ev.key || '',
								value: ev.value || ''
							})),
							{ key: '', value: '' }
						];
					} else {
						envVars = [{ key: '', value: '' }];
					}
				}

				if (data.volumes && Array.isArray(data.volumes) && data.volumes.length > 0) {
					volumes = data.volumes.map((vol: Volume) => ({
						name: vol.name || '',
						type: vol.type || 'pvc',
						mountPath: vol.mountPath || '',
						pvcName: vol.pvcName || '',
						storageSize: vol.storageSize || '1Gi',
						hostPath: vol.hostPath || '',
						readOnly: vol.readOnly || false
					}));
				} else {
					volumes = [];
				}

				if (data.buildFromRoot !== undefined) {
					buildFromRoot = data.buildFromRoot;
				}
				buildWithDepot = data.buildWithDepot ?? false;

				// Initialize health check state from deployment data
				if (data.healthCheckEnabled !== undefined && !isEditingHealthCheck) {
					healthCheckEnabled = data.healthCheckEnabled;
					healthCheckType = data.healthCheckType || 'http';
					healthCheckPath = data.healthCheckPath || '/';
					healthCheckPort = data.healthCheckPort || 80;
					healthCheckCommand = data.healthCheckCommand || '';
					livenessEnabled = data.livenessEnabled ?? true;
					readinessEnabled = data.readinessEnabled ?? true;
					startupEnabled = data.startupEnabled ?? false;
					healthCheckInterval = data.healthCheckInterval ?? 30;
					healthCheckTimeout = data.healthCheckTimeout ?? 5;
					healthCheckRetries = data.healthCheckRetries ?? 3;
					startupFailureThreshold = data.startupFailureThreshold ?? 30;
				}
			}

			if (data.pods?.length) {
				if (!manualPodSelection) {
					const newest = getNewestPod(data.pods);
					if (newest && newest.name !== selectedPod) {
						selectedPod = newest.name;
						selectedContainer = newest.containers?.[0]?.name || '';
					}
				} else if (!selectedPod) {
					// First load, no manual selection yet
					const newest = getNewestPod(data.pods);
					if (newest) {
						selectedPod = newest.name;
						selectedContainer = newest.containers?.[0]?.name || '';
					}
				} else if (!data.pods.find((p: Pod) => p.name === selectedPod)) {
					// Selected pod was deleted, fall back to newest
					manualPodSelection = false;
					const newest = getNewestPod(data.pods);
					if (newest) {
						selectedPod = newest.name;
						selectedContainer = newest.containers?.[0]?.name || '';
					}
				}
			}
		} catch (e) {
			if (!deployment) {
				error = e instanceof Error ? e.message : 'Failed to fetch deployment';
			}
		} finally {
			loading = false;

			// Load auto-deploy status if GitHub deployment
			if (deployment?.githubRepo && !autoDeployStatus) {
				loadAutoDeployStatus();
				loadGitHubDeployments();
			}
		}
	}

	async function fetchLogs() {
		if (!selectedPod || !selectedContainer) return;

		logsLoading = true;
		try {
			const response = await apiFetch(
				`/apiv1/pods/${selectedPod}/logs?namespace=${deployment?.namespace}&container=${selectedContainer}&tailLines=${tailLines}`
			);
			if (response.ok) {
				const data = await response.json();
				console.log('[RAW LOGS]', data.logs);
				logs = data.logs || '';
			}
		} catch (e) {
		} finally {
			logsLoading = false;
		}
	}

	function sanitizeLogs(logs: string): string {
		if (!logs) return logs;
		
		let sanitized = logs;
		
		sanitized = sanitized.replace(/(x-access-token:|ghs_|ghp_|github_pat_)[a-zA-Z0-9_]+/gi, '***REDACTED***');
		
		sanitized = sanitized.replace(/https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi, 'https://***@github.com');
		
		sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');
		
		sanitized = sanitized.replace(/(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-\.]+/gi, '$1 ***REDACTED***');
		
		sanitized = sanitized.replace(/(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi, '$1=***REDACTED***');
		
		return sanitized;
	}

	async function fetchBuildLogs() {
		if (!deployment || deployment.status !== 'building') return;

		buildLogsLoading = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/build-logs`);
			if (response.ok) {
				const data = await response.json();
				buildLogs = sanitizeLogs(data.logs || '');
			}
		} catch (e) {
			console.error('Failed to fetch build logs:', e);
		} finally {
			buildLogsLoading = false;
		}
	}

	async function restart() {
		restarting = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/restart`, {
				method: 'POST'
			});
			if (!response.ok) {
				throw new Error('Failed to restart deployment');
			}
			toasts.add({
				title: 'Deployment restarting',
				description: 'Rolling restart initiated',
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to restart',
				color: 'error'
			});
		} finally {
			restarting = false;
		}
	}

	async function scaleDeployment() {
		scaling = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/scale`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ replicas: scaleReplicas })
			});
			if (!response.ok) {
				throw new Error('Failed to scale deployment');
			}
			toasts.add({
				title: 'Deployment scaled',
				description: `Scaled to ${scaleReplicas} replica(s)`,
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to scale',
				color: 'error'
			});
		} finally {
			scaling = false;
		}
	}

	async function rebuild() {
		rebuilding = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/rebuild`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to rebuild deployment');
			}
			toasts.add({
				title: 'Rebuild started',
				description: 'Building new image from repository',
				color: 'success'
			});
			
			accumulatedBuildLogs = '';
			buildModalStatus = 'building';
			buildModalStep = null;
			buildModalError = null;
			buildModalWarnings = [];
			buildModalTimestamps = null;
			buildStartTime = Date.now();
			
			showBuildModal = true;
			showBuildCard = false;
			startBuildPolling();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to rebuild',
				color: 'error'
			});
		} finally {
			rebuilding = false;
		}
	}

	async function deleteDeployment() {
		if (!deployment) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to delete deployment');
			}
			toasts.add({
				title: 'Deployment deleted',
				color: 'success'
			});
			refreshTree();
			if (deployment.project?.slug) {
				goto(`/${orgSlug}/projects/${deployment.project.slug}`);
			} else {
				goto(`/${orgSlug}`);
			}
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete',
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}

	async function saveEnv() {
		savingEnv = true;
		isEditingEnv = false;
		try {
			if (envViewMode === 'raw') {
				const parsed = rawToEnvVars(envRawText);
				envVars = [...parsed, { key: '', value: '' }];
			}
			const filteredEnv = envVars.filter((e) => e.key.trim());
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/env`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ env: filteredEnv })
			});
			if (!response.ok) {
				throw new Error('Failed to update environment variables');
			}
			toasts.add({
				title: 'Environment updated',
				description: 'Pods will restart with new variables',
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			isEditingEnv = true;
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update env',
				color: 'error'
			});
		} finally {
			savingEnv = false;
		}
	}

	async function createService() {
		const { payload, error } = buildPortPayloadFromForm(newServiceForm);
		if (error) {
			serviceFormError = error;
			return;
		}

		// Auto-generate service name from first port
		const firstPort = newServiceForm.ports[0]?.containerPort ?? 80;
		const existingNames = new Set((deployment?.services ?? []).map((s: Service) => s.name));
		let serviceName = `port-${firstPort}`;
		let suffix = 2;
		while (existingNames.has(serviceName)) {
			serviceName = `port-${firstPort}-${suffix}`;
			suffix++;
		}

		serviceFormError = null;
		creatingService = true;

		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/services`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: serviceName,
					ports: payload,
					exposePublic: newServiceForm.exposePublic
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to create service');
			}

			const updated = await response.json();
			deployment = updated;

			toasts.add({
				title: 'Port added',
				description: `Port ${newServiceForm.ports[0]?.containerPort ?? ''} is now routing traffic`,
				color: 'success'
			});

			showServiceForm = false;
			resetNewServiceForm();
			if (Object.keys(serviceEditForms).length === 0) {
				isEditingServices = false;
			}
		} catch (e) {
			serviceFormError = e instanceof Error ? e.message : 'Failed to create service';
		} finally {
			creatingService = false;
		}
	}

	async function saveServicePorts(serviceId: string) {
		const form = serviceEditForms[serviceId];
		if (!form) {
			return;
		}

		const { payload, error } = buildPortPayloadFromForm(form);
		if (error) {
			serviceEditErrors = { ...serviceEditErrors, [serviceId]: error };
			return;
		}

		serviceEditErrors = { ...serviceEditErrors, [serviceId]: null };
		serviceSavingId = serviceId;

		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/services/${serviceId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ports: payload })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update service');
			}

			const updated = await response.json();
			deployment = updated;

			const { [serviceId]: _removedForm, ...restForms } = serviceEditForms;
			serviceEditForms = restForms;
			const { [serviceId]: _removedError, ...restErrors } = serviceEditErrors;
			serviceEditErrors = restErrors;

			if (Object.keys(serviceEditForms).length === 0 && !showServiceForm) {
				isEditingServices = false;
			}

			toasts.add({
				title: 'Port updated',
				description: 'Port configuration saved',
				color: 'success'
			});
		} catch (e) {
			serviceEditErrors = {
				...serviceEditErrors,
				[serviceId]: e instanceof Error ? e.message : 'Failed to update service'
			};
		} finally {
			serviceSavingId = null;
		}
	}

	async function deleteService(serviceId: string) {
		serviceDeletingId = serviceId;

		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/services/${serviceId}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to delete service');
			}

			const updated = await response.json();
			deployment = updated;

			toasts.add({
				title: 'Port removed',
				color: 'success'
			});

			const { [serviceId]: _removedForm, ...restForms } = serviceEditForms;
			serviceEditForms = restForms;
			const { [serviceId]: _removedError, ...restErrors } = serviceEditErrors;
			serviceEditErrors = restErrors;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove port',
				color: 'error'
			});
		} finally {
			serviceDeletingId = null;
		}
	}

	async function fetchProjectIngresses() {
		if (!deployment?.project?.id) return;
		try {
			const response = await apiFetch(`/apiv1/projects/${deployment.project.id}`);
			if (!response.ok) return;
			const projectData = await response.json();
			const deploymentIngresses = (projectData.deployments ?? []).flatMap(
				(d: { id: string; ingresses?: Array<{ id: string; host: string; path?: string }> }) =>
					(d.ingresses ?? []).map((i) => ({
						id: i.id,
						host: i.host,
						path: i.path ?? '/',
						deploymentId: d.id
					}))
			);
			projectIngresses = deploymentIngresses;
		} catch {
			/* silent */
		}
	}

	async function deleteIngress(ingressId: string) {
		if (!deployment?.project?.id) return;
		if (!confirm('Remove this domain? This cannot be undone.')) return;

		deletingIngressId = ingressId;
		try {
			const response = await apiFetch(
				`/apiv1/projects/${deployment.project.id}/ingresses/${ingressId}`,
				{ method: 'DELETE' }
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to remove domain');
			}
			toasts.add({ title: 'Domain removed', color: 'success' });
			await fetchDeployment();
			await fetchProjectIngresses();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove domain',
				color: 'error'
			});
		} finally {
			deletingIngressId = null;
		}
	}

	function resetDomainForm() {
		newDomainHost = '';
		newDomainPath = '/';
		newDomainTlsEnabled = true;
		newDomainServiceKey = domainServiceOptions[0]?.key ?? '';
		showDomainAdvanced = false;
		domainFormError = null;
	}

	function generateRandomDomainForNew() {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let randomPart = '';
		for (let i = 0; i < 6; i++) {
			randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		newDomainHost = `${randomPart}.a.lfdl.ink`;
	}

	async function createDomain() {
		if (!deployment?.project?.id) return;
		if (!newDomainNormalizedHost) {
			domainFormError = 'Domain is required';
			return;
		}
		if (newDomainConflict?.pathCollision) {
			domainFormError = `${newDomainNormalizedHost}${newDomainNormalizedPath} is already in use. Use a different path.`;
			return;
		}
		const option = domainServiceOptions.find((o) => o.key === newDomainServiceKey);
		if (!option) {
			domainFormError = 'Select a service';
			return;
		}

		creatingDomain = true;
		domainFormError = null;

		try {
			const response = await apiFetch(`/apiv1/projects/${deployment.project.id}/ingresses`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					host: newDomainNormalizedHost,
					tlsEnabled: newDomainTlsEnabled,
					routes: [
						{ path: newDomainNormalizedPath, serviceName: option.serviceName, servicePort: option.port }
					]
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to add domain');
			}

			toasts.add({
				title: newDomainConflict ? 'Route added' : 'Domain added',
				description: `${newDomainNormalizedHost}${newDomainNormalizedPath === '/' ? '' : newDomainNormalizedPath}`,
				color: 'success'
			});

			showDomainForm = false;
			resetDomainForm();
			await fetchDeployment();
			await fetchProjectIngresses();
		} catch (e) {
			domainFormError = e instanceof Error ? e.message : 'Failed to add domain';
		} finally {
			creatingDomain = false;
		}
	}

	let logModalId = $state<string | null>(null);
	let logModalContent = $state<string | null>(null);
	let logModalLoading = $state(false);

	async function openLogModal(historyId: string) {
		logModalId = historyId;
		logModalContent = buildLogCache[historyId] ?? null;
		if (logModalContent) return;
		logModalLoading = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/image-history/${historyId}/logs`);
			if (!response.ok) throw new Error('Failed to fetch build logs');
			const data = await response.json();
			const logs = data.logs || 'No logs available.';
			buildLogCache[historyId] = logs;
			logModalContent = logs;
		} catch {
			const fallback = 'Failed to load build logs.';
			buildLogCache[historyId] = fallback;
			logModalContent = fallback;
		} finally {
			logModalLoading = false;
		}
	}

	function closeLogModal() {
		logModalId = null;
		logModalContent = null;
		logModalLoading = false;
	}

	async function rollbackToImage(historyId: string) {
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/rollback/${historyId}`, {
				method: 'POST'
			});
			if (!response.ok) {
				throw new Error('Failed to rollback');
			}
			toasts.add({
				title: 'Rollback initiated',
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to rollback',
				color: 'error'
			});
		}
	}

	function addEnvRow() {
		isEditingEnv = true;
		envVars = [...envVars, { key: '', value: '' }];
	}

	function removeEnvRow(index: number) {
		isEditingEnv = true;
		envVars = envVars.filter((_, i) => i !== index);
	}

	function envVarsToRaw(vars: Array<{ key: string; value: string }>): string {
		return vars.filter((e) => e.key.trim()).map((e) => `${e.key}=${e.value}`).join('\n');
	}

	function rawToEnvVars(raw: string): Array<{ key: string; value: string }> {
		const lines = raw.split('\n');
		const parsed: Array<{ key: string; value: string }> = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const equalIndex = trimmed.indexOf('=');
			if (equalIndex === -1) continue;
			const key = trimmed.substring(0, equalIndex).trim();
			const value = trimmed.substring(equalIndex + 1).trim();
			if (key) parsed.push({ key, value });
		}
		return parsed;
	}

	function switchEnvView(mode: 'ui' | 'raw') {
		if (mode === envViewMode) return;
		isEditingEnv = true;
		if (mode === 'raw') {
			envRawText = envVarsToRaw(envVars);
		} else {
			const parsed = rawToEnvVars(envRawText);
			envVars = [...parsed, { key: '', value: '' }];
		}
		envViewMode = mode;
	}

	function addVolume() {
		volumes = [...volumes, { name: '', type: 'pvc', mountPath: '', pvcName: '', storageSize: '1Gi', readOnly: false }];
	}

	function removeVolume(index: number) {
		volumes = volumes.filter((_, i) => i !== index);
	}

	async function saveAdvanced() {
		if (!deployment) return;

		savingAdvanced = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/build-from-root`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ buildFromRoot, buildWithDepot })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update build settings');
			}

			const updated = await response.json();
			deployment = updated;

			toasts.add({
				title: 'Settings updated',
				description: 'Build from root setting has been updated',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update build settings',
				color: 'error'
			});
		} finally {
			savingAdvanced = false;
		}
	}

	async function saveHealthCheck() {
		if (!deployment) return;

		savingHealthCheck = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/health-check`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					healthCheckEnabled,
					healthCheckType,
					healthCheckPath,
					healthCheckPort,
					healthCheckCommand,
					livenessEnabled,
					readinessEnabled,
					startupEnabled,
					healthCheckInterval,
					healthCheckTimeout,
					healthCheckRetries,
					startupFailureThreshold
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update health check settings');
			}

			const updated = await response.json();
			deployment = updated;

			toasts.add({
				title: 'Settings updated',
				description: 'Health check configuration has been updated',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update health check settings',
				color: 'error'
			});
		} finally {
			savingHealthCheck = false;
			isEditingHealthCheck = false;
		}
	}

	async function loadAutoDeployStatus() {
		if (!deployment?.githubRepo) return;

		autoDeployLoading = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy`);
			if (response.ok) {
				autoDeployStatus = await response.json();
				autoDeployBranch = autoDeployStatus?.branch || deployment.githubBranch || '';

				// If app is not installed, get the install URL
				if (!autoDeployStatus?.appInstalled && !githubAppInstallUrl) {
					loadGitHubAppInstallUrl();
				}
			}
		} catch (e) {
			console.error('Failed to load auto-deploy status:', e);
		} finally {
			autoDeployLoading = false;
		}
	}

	async function loadGitHubAppInstallUrl() {
		if (loadingAppInstallUrl) return;

		loadingAppInstallUrl = true;
		try {
			const response = await apiFetch('/apiv1/github/app/install');
			if (response.ok) {
				const data = await response.json();
				githubAppInstallUrl = data.url;
			}
		} catch (e) {
			console.error('Failed to load GitHub App install URL:', e);
		} finally {
			loadingAppInstallUrl = false;
		}
	}

	async function loadGitHubDeployments() {
		if (!deployment?.githubRepo) return;

		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/github-deployments`);
			if (response.ok) {
				githubDeployments = await response.json();
			}
		} catch (e) {
			console.error('Failed to load GitHub deployments:', e);
		}
	}

	async function enableAutoDeploy() {
		if (!deployment || !autoDeployBranch) return;

		enablingAutoDeploy = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy/enable`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ branch: autoDeployBranch })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to enable auto-deploy');
			}

			const result = await response.json();
			deployment = result;

			toasts.add({
				title: 'Auto-deploy enabled',
				description: `Deployments will be triggered on push to ${autoDeployBranch}`,
				color: 'success'
			});

			await loadAutoDeployStatus();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to enable auto-deploy',
				color: 'error'
			});
		} finally {
			enablingAutoDeploy = false;
		}
	}

	async function disableAutoDeploy() {
		if (!deployment) return;

		disablingAutoDeploy = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy/disable`, {
				method: 'POST'
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to disable auto-deploy');
			}

			deployment = await response.json();
			autoDeployStatus = null;

			toasts.add({
				title: 'Auto-deploy disabled',
				description: 'Automatic deployments have been disabled',
				color: 'success'
			});

			await loadAutoDeployStatus();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to disable auto-deploy',
				color: 'error'
			});
		} finally {
			disablingAutoDeploy = false;
		}
	}

	function openGitHubAppInstall() {
		if (githubAppInstallUrl) {
			window.open(githubAppInstallUrl, '_blank');
		}
	}

	async function saveVolumes() {
		savingVolumes = true;
		try {
			const filteredVolumes = volumes
				.filter((v) => v.pvcName?.trim() && v.mountPath.trim())
				.map((v) => ({
					name: v.pvcName!.trim(),
					type: 'pvc' as const,
					mountPath: v.mountPath.trim(),
					readOnly: v.readOnly,
					pvcName: v.pvcName!.trim(),
					storageSize: v.storageSize?.trim() || '1Gi'
				}));

			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/volumes`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ volumes: filteredVolumes })
			});

			if (!response.ok) {
				throw new Error('Failed to update volumes');
			}

			toasts.add({
				title: 'Storage updated',
				description: 'Your app will restart with the new storage configuration.',
				color: 'success'
			});

			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Failed to update storage',
				description: e instanceof Error ? e.message : 'Failed to update storage',
				color: 'error'
			});
		} finally {
			savingVolumes = false;
		}
	}

	function getStatusColor(status: string) {
		switch (status?.toLowerCase()) {
			case 'ready':
			case 'running':
				return 'badge-success';
			case 'scheduled':
			case 'scaling':
			case 'restarting':
			case 'pending':
				return 'badge-warning';
			case 'unhealthy':
				return 'badge-warning';
			case 'stopped':
			case 'failed':
			case 'error':
				return 'badge-error';
			default:
				return 'badge-neutral';
		}
	}

	function getDeploymentStatusLabel(status: string) {
		switch (status?.toLowerCase()) {
			case 'running': return 'Running';
			case 'restarting': return 'Restarting';
			case 'scaling': return 'Scaling';
			case 'failed': return 'Failed';
			case 'stopped': return 'Stopped';
			case 'unhealthy': return 'Unhealthy';
			case 'pending': return 'Pending';
			default: return status || 'Unknown';
		}
	}

	function getBuildStatusColor(buildStatus: string) {
		switch (buildStatus?.toLowerCase()) {
			case 'succeeded':
				return 'badge-success';
			case 'building':
				return 'badge-warning';
			case 'failed':
				return 'badge-error';
			default:
				return 'badge-neutral';
		}
	}

	function formatBuildDuration(seconds: number): string {
		if (seconds < 60) {
			return `${seconds}s`;
		}
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = Math.floor(seconds % 60);
		return `${minutes}m ${remainingSeconds}s`;
	}

	function getBuildDuration(): string | null {
		const ts = deployment?.buildStepTimestamps as Record<string, number> | null;
		if (!ts) return null;
		const keys = Object.keys(ts);
		if (keys.length === 0) return null;
		const startTime = Math.min(...keys.map(k => ts[k]));
		const endTime = ts['complete'];
		if (!endTime) return null;
		return formatBuildDuration(Math.max(0, Math.floor((endTime - startTime) / 1000)));
	}

	function getBuildStatusLabel(buildStatus: string) {
		switch (buildStatus?.toLowerCase()) {
			case 'succeeded': {
				const dur = getBuildDuration();
				return dur ? `Completed in ${dur}` : 'Succeeded';
			}
			case 'building':
				return 'Building';
			case 'failed':
				return 'Failed';
			default:
				return 'None';
		}
	}

	$effect(() => {
		if (selectedPod && selectedContainer) {
			fetchLogs();
		}
	});

	// Auto-scroll logs to bottom when they change
	$effect(() => {
		if (logs) {
			requestAnimationFrame(scrollLogsToBottom);
		}
	});

	$effect(() => {
		if (deployment?.buildStatus === 'building') {
			if (!buildLogsInterval) {
				fetchBuildLogs();
				buildLogsInterval = setInterval(fetchBuildLogs, 5000);
			}
		} else if (buildLogsInterval) {
			clearInterval(buildLogsInterval);
			buildLogsInterval = null;
		}
	});

	$effect(() => {
		const projectId = deployment?.project?.id;
		if (!projectId) return;
		fetchProjectIngresses();
	});

	$effect(() => {
		if (showDomainForm && !newDomainServiceKey) {
			newDomainServiceKey = domainServiceOptions[0]?.key ?? '';
		}
	});

	$effect(() => {
		if (deploymentId) {
			loading = true;
			error = null;
			deployment = null;
			selectedPod = '';
			selectedContainer = '';
			manualPodSelection = false;
			logs = '';
			buildLogs = '';
			accumulatedBuildLogs = null;

			if (deploymentInterval) {
				clearInterval(deploymentInterval);
			}
			if (podInterval) {
				clearInterval(podInterval);
			}
			if (buildLogsInterval) {
				clearInterval(buildLogsInterval);
			}

			fetchDeployment();
			deploymentInterval = setInterval(fetchDeployment, 10000);
			podInterval = setInterval(() => {
				if (selectedPod && selectedContainer) {
					fetchLogs();
				}
			}, 5000);
		}
	});

	onMount(() => {
		function handleClickOutside(event: MouseEvent) {
			const target = event.target as HTMLElement;
			if (!target.closest('.custom-dropdown-container')) {
				podDropdownOpen = false;
				containerDropdownOpen = false;
				protocolDropdownOpen = null;
				serviceDropdownOpen = false;
				showNewShellMenu = false;
				showLogsPodMenu = false;
			}
		}

		document.addEventListener('click', handleClickOutside);

		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape' && consoleExpanded) {
				toggleConsoleExpand();
			}
		}
		document.addEventListener('keydown', handleKeydown);

		// Position timestamp tooltips using fixed positioning to escape overflow:auto
		function handleTsPointer(event: Event) {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const ts = target.closest('.log-ts') as HTMLElement | null;
			if (!ts) return;
			const rect = ts.getBoundingClientRect();
			ts.style.setProperty('--tt-x', `${rect.left + rect.width / 2 - 130}px`);
			ts.style.setProperty('--tt-y', `${rect.top - 8}px`);
		}
		document.addEventListener('mouseover', handleTsPointer, true);

		return () => {
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleKeydown);
			document.removeEventListener('mouseover', handleTsPointer, true);
		};
	});

	onDestroy(() => {
		clearInterval(deploymentInterval);
		clearInterval(podInterval);
		if (buildLogsInterval) {
			clearInterval(buildLogsInterval);
		}
		stopBuildPolling();
	});

	$effect(() => {
		if (deploymentId) {
			webhookTokens = [];
			webhookTokensFetched = false;
		}
	});

	$effect(() => {
		if (tabs.value === 'webhooks' && !webhookTokensFetched) {
			fetchWebhookTokens();
		}
	});

	async function fetchWebhookTokens() {
		webhookTokensLoading = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/webhook-tokens`);
			if (response.ok) {
				webhookTokens = await response.json();
			}
		} catch {
			// silent
		} finally {
			webhookTokensLoading = false;
			webhookTokensFetched = true;
		}
	}

	async function createWebhookToken() {
		creatingWebhookToken = true;
		newlyCreatedToken = null;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/webhook-tokens`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label: newWebhookLabel || undefined })
			});
			if (response.ok) {
				const data = await response.json();
				newlyCreatedToken = data.token;
				newWebhookLabel = '';
				await fetchWebhookTokens();
				toasts.add({ title: 'Webhook token created', color: 'success' });
			} else {
				toasts.add({ title: 'Failed to create webhook token', color: 'error' });
			}
		} catch {
			toasts.add({ title: 'Failed to create webhook token', color: 'error' });
		} finally {
			creatingWebhookToken = false;
		}
	}

	async function deleteWebhookToken(tokenId: string) {
		deletingWebhookTokenId = tokenId;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/webhook-tokens/${tokenId}`, {
				method: 'DELETE'
			});
			if (response.ok) {
				await fetchWebhookTokens();
				toasts.add({ title: 'Webhook token deleted', color: 'success' });
			} else {
				toasts.add({ title: 'Failed to delete webhook token', color: 'error' });
			}
		} catch {
			toasts.add({ title: 'Failed to delete webhook token', color: 'error' });
		} finally {
			deletingWebhookTokenId = null;
		}
	}

	function copyToClipboard(text: string, type: 'token' | 'url') {
		navigator.clipboard.writeText(text);
		if (type === 'token') {
			copiedWebhookToken = true;
			setTimeout(() => (copiedWebhookToken = false), 2000);
		} else {
			copiedWebhookUrl = true;
			setTimeout(() => (copiedWebhookUrl = false), 2000);
		}
	}

	function getWebhookUrl(token: string): string {
		const base = window.location.origin;
		return `${base}/apiv1/webhooks/deploy/${token}`;
	}

	const webhookExamples = {
		restart: `curl -X POST YOUR_WEBHOOK_URL`,
		updateTag: `curl -X POST YOUR_WEBHOOK_URL \\
  -H "Content-Type: application/json" \\
  -d '{"tag": "v1.2.3"}'`,
		updateImage: `curl -X POST YOUR_WEBHOOK_URL \\
  -H "Content-Type: application/json" \\
  -d '{"image": "ghcr.io/org/app", "tag": "sha-abc123"}'`,
		githubActions: `# .github/workflows/deploy.yml
- name: Trigger deploy
  run: |
    curl -s -X POST \\
      \${{ secrets.WEBHOOK_URL }} \\
      -H "Content-Type: application/json" \\
      -d '{"tag": "\${{ github.sha }}"}'`
	};
</script>

<div class="deployment-page p-6 max-w-[100rem] mx-auto">
	{#if deployment?.project?.slug}
		<div class="mb-4">
			<Breadcrumb crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				{ label: deployment.project.name || deployment.project.slug, href: `/${orgSlug}/projects/${deployment.project.slug}` },
				{ label: deployment.name }
			]} />
		</div>
	{:else}
		<div class="mb-4">
			<Breadcrumb crumbs={[
				{ label: 'Home', href: `/${orgSlug}` },
				{ label: deployment?.name || 'Deployment' }
			]} />
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<!-- Skeleton -->
		<div class="space-y-6 animate-pulse">
			<section class="card rounded-3xl p-6 shadow-sm">
				<div class="flex flex-wrap items-start justify-between gap-6">
					<div class="flex-1">
						<div class="flex items-center gap-3">
							<div class="h-8 w-48 rounded" style="background-color: var(--surface-border);"></div>
							<div class="h-6 w-16 rounded-full" style="background-color: var(--surface-border);"></div>
						</div>
						<div class="mt-3 flex flex-wrap items-center gap-3">
							<div class="h-5 w-24 rounded-full" style="background-color: var(--surface-border);"></div>
							<div class="h-4 w-40 rounded" style="background-color: var(--surface-border);"></div>
							<div class="h-5 w-16 rounded-full" style="background-color: var(--surface-border);"></div>
						</div>
						<div class="mt-4 flex gap-6">
							{#each Array(4) as _}
								<div class="flex items-center gap-2">
									<div class="h-3 w-16 rounded" style="background-color: var(--surface-border);"></div>
									<div class="h-5 w-8 rounded" style="background-color: var(--surface-border);"></div>
								</div>
							{/each}
						</div>
					</div>
					<div class="flex gap-2">
						<div class="h-9 w-24 rounded-lg" style="background-color: var(--surface-border);"></div>
						<div class="h-9 w-24 rounded-lg" style="background-color: var(--surface-border);"></div>
					</div>
				</div>
			</section>
			<section class="card rounded-3xl p-2 shadow-sm">
				<div class="flex gap-1 overflow-x-auto p-1">
					{#each Array(6) as _}
						<div class="h-10 w-28 shrink-0 rounded-xl" style="background-color: var(--surface-border);"></div>
					{/each}
				</div>
			</section>
		</div>
	{:else if deployment}
		<div class="space-y-5">
			<!-- Header: deployment identity + status + actions -->
			<section class="dep-header dep-header-card" class:dep-header-card--hasbg={!!projectBgImage}>
				{#if projectBgImage}
					<div class="dep-header-backdrop" aria-hidden="true">
						<div class="dep-header-bg dep-header-bg--1" style="background-image: url({JSON.stringify(projectBgImage)});"></div>
						<div class="dep-header-bg dep-header-bg--2" style="background-image: url({JSON.stringify(projectBgImage)});"></div>
						<div class="dep-header-bg dep-header-bg--3" style="background-image: url({JSON.stringify(projectBgImage)});"></div>
						<div class="dep-header-veil"></div>
					</div>
				{/if}
				<div class="dep-header-top">
					<div class="dep-header-identity">
						<div class="dep-header-title-row">
							<h1 class="dep-header-name">{deployment.name}</h1>
						</div>
						<div class="dep-header-badges">
							<span class="badge {getStatusColor(deployment.status)} text-[10px]">{getDeploymentStatusLabel(deployment.status)}</span>
							{#if deployment.buildStatus && deployment.buildStatus !== 'none'}
								<span class="badge {getBuildStatusColor(deployment.buildStatus)} text-[10px]">Build: {getBuildStatusLabel(deployment.buildStatus)}</span>
							{/if}
						</div>
						{#if notificationCount > 0}
							<div class="relative">
								<button
									bind:this={notifBtnEl}
									class="dep-notif-btn"
									onclick={() => notificationsOpen = !notificationsOpen}
								>
									<Bell class="h-3.5 w-3.5" />
									<span class="notification-badge">{notificationCount}</span>
								</button>

								{#if notificationsOpen}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div class="notification-backdrop" onclick={() => notificationsOpen = false}></div>
									<div class="notification-panel" style="top: {notifPanelPos.top}px; left: {notifPanelPos.left}px;" transition:fade={{ duration: 150 }}>
										<div class="flex items-center justify-between px-4 py-3" style="border-bottom: 1px solid var(--surface-border);">
											<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Notifications</p>
											<button class="btn-icon rounded-md p-1" onclick={() => notificationsOpen = false}>
												<X class="h-3.5 w-3.5" />
											</button>
										</div>
										<div class="notification-scroll">
											{#if deployment.buildStatus === 'failed' && (deployment.buildError || deployment.buildLogs)}
												<div class="notification-item">
													<div class="flex items-start gap-3">
														<div class="notification-icon notification-icon-error">
															<CircleX class="h-4 w-4" />
														</div>
														<div class="flex-1 min-w-0">
															<p class="text-xs font-semibold" style="color: var(--error-text-color);">Build failed</p>
															{#if deployment.buildError}
																<p class="mt-1 text-xs font-mono truncate" style="color: var(--surface-muted);">{sanitizeLogs(deployment.buildError).split('\n')[0]}</p>
															{/if}
															{#if deployment.buildLogs}
																<button
																	class="mt-1.5 text-[11px] font-medium hover:underline"
																	style="color: var(--primary-color);"
																	onclick={() => {
																		notificationsOpen = false;
																		buildModalStatus = 'failed';
																		buildModalError = deployment.buildError ?? null;
																		accumulatedBuildLogs = deployment.buildLogs ?? null;
																		buildModalStep = null;
																		buildModalWarnings = [];
																		buildModalTimestamps = deployment.buildStepTimestamps ?? null;
																		showBuildModal = true;
																	}}
																>View build logs</button>
															{/if}
														</div>
													</div>
												</div>
											{/if}
											{#if deployment.warnings?.length}
												{#each deployment.warnings as warning}
													<div class="notification-item">
														<div class="flex items-start gap-3">
															<div class="notification-icon notification-icon-warning">
																<AlertTriangle class="h-4 w-4" />
															</div>
															<div class="flex-1 min-w-0">
																<p class="text-xs font-semibold" style="color: var(--warning-text);">Pod warning</p>
																<p class="mt-0.5 font-mono text-xs font-medium" style="color: var(--surface-muted);">{warning.podName}</p>
																<p class="mt-0.5 text-xs" style="color: var(--center-channel-color); opacity: 0.75;">{warning.message}</p>
																{#if warning.timestamp}
																	<p class="mt-1 text-[10px]" style="color: var(--surface-muted);">{new Date(warning.timestamp).toLocaleTimeString()}</p>
																{/if}
															</div>
														</div>
													</div>
												{/each}
											{/if}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</div>
					<div class="dep-header-actions">
						{#if repoUrl}
							<button onclick={rebuild} disabled={rebuilding} class="btn btn-secondary btn-sm">
								{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
								<span>Rebuild</span>
							</button>
						{/if}
						<button onclick={restart} disabled={restarting} class="btn btn-secondary btn-sm">
							{#if restarting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play class="h-3.5 w-3.5" />{/if}
							<span>Restart</span>
						</button>
						<button onclick={() => (showDeleteModal = true)} disabled={deleting} class="btn btn-sm dep-delete-btn">
							{#if deleting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				</div>
				<!-- Context line: source + replicas + key info without labels -->
				<div class="dep-header-meta">
					{#if deployment.githubRepo}
						<a href={deployment.githubRepo} target="_blank" class="dep-meta-source">
							{deployment.githubRepo.replace('https://github.com/', '')}
							<ExternalLink class="h-2.5 w-2.5" />
						</a>
					{:else if deployment.image}
						<span class="dep-meta-source">{deployment.image}</span>
					{/if}
					{#if branch}
						<span class="dep-meta-pill">{branch}</span>
					{/if}
					{#if deployment.ingresses?.length}
						{#each deployment.ingresses.slice(0, 2) as ingress}
							<a
								href="{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}"
								target="_blank"
								rel="noopener noreferrer"
								class="dep-meta-domain"
							>
								<Globe class="h-3 w-3" />
								{ingress.host}
							</a>
						{/each}
					{/if}
				</div>
			</section>

			<!-- Tab nav -->
			<nav class="dep-tabs" {...tabs.triggerList}>
				<div class="dep-tabs-inner">
					{#each visibleTabs as tab}
						{@const Icon = tab.icon}
						<button class="tabs-trigger dep-tab" {...tabs.getTrigger(tab.id)}>
							<Icon class="h-3.5 w-3.5" />
							<span>{tab.label}</span>
						</button>
					{/each}
				</div>
			</nav>

{#each visibleTabs as tab}
	<section {...tabs.getContent(tab.id)} hidden={undefined} class="tab-panel">
					{#if tab.id === 'overview'}
						<div class="grid gap-5 lg:grid-cols-[1fr_280px] items-start">
							<!-- Left: Console (hero) -->
							<div class="flex flex-col gap-5 min-w-0">
								<!-- Console / Logs + Terminal -->
								<div
									bind:this={consoleRef}
									class="console-panel"
									class:console-expanded={consoleExpanded || consoleAnimating}
									class:console-animating={consoleAnimating}
									class:console-at-fullscreen={consoleExpanded}
									style={consoleInlineRect && !consoleExpanded
										? `top:${consoleInlineRect.top}px;left:${consoleInlineRect.left}px;width:${consoleInlineRect.width}px;height:${consoleInlineRect.height}px;`
										: consoleInlineRect && consoleExpanded
										? ''
										: ''}
								>
								<!-- Console toolbar -->
									<div class="console-toolbar">
										<div class="console-toolbar-left">
											<!-- Logs tab with source picker -->
											<button
												class="console-tab-btn"
												class:console-tab-btn--active={activeConsoleTab === 'logs'}
												onclick={() => (activeConsoleTab = 'logs')}
											>Logs</button>

											<!-- Terminal tabs -->
											{#each terminalTabs as ttab (ttab.id)}
												<button
													class="console-tab-btn"
													class:console-tab-btn--active={activeConsoleTab === ttab.id}
													onclick={() => (activeConsoleTab = ttab.id)}
												>
													{ttab.label}
													<span
														class="console-tab-close"
														role="button"
														tabindex="-1"
														onclick={(e) => { e.stopPropagation(); closeTerminalTab(ttab.id); }}
														onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeTerminalTab(ttab.id); } }}
													>
														<X class="h-2.5 w-2.5" />
													</span>
												</button>
											{/each}
										</div>

										<div class="console-toolbar-right">
											{#if activeConsoleTab === 'logs'}
												<!-- Pod / container picker -->
												<div class="relative custom-dropdown-container">
													<button
														class="console-source-btn"
														onclick={() => (showLogsPodMenu = !showLogsPodMenu)}
													>
														<Container class="h-3 w-3 opacity-40" />
														<span>{podLabel(selectedPod)}{selectedContainer ? ` / ${selectedContainer}` : ''}</span>
														<ChevronDown class="h-2.5 w-2.5 opacity-40" />
													</button>
													{#if showLogsPodMenu}
														<div class="console-compact-menu" transition:scale={{ duration: 150, start: 0.96 }}>
															{#each deployment.pods ?? [] as pod}
																{#each pod.containers ?? [] as cont}
																	<button type="button" onclick={() => selectLogsPod(pod.name, cont.name)}
																		class="console-compact-item"
																		class:console-compact-item--active={selectedPod === pod.name && selectedContainer === cont.name}>
																		<Container class="h-2.5 w-2.5 shrink-0 opacity-30" />
																		{podLabel(pod.name)}<span class="console-compact-sep">/</span><span class="console-compact-hl">{cont.name}</span>
																	</button>
																{/each}
															{/each}
														</div>
													{/if}
												</div>

												<button onclick={fetchLogs} disabled={logsLoading}
													class="console-icon-btn" title="Refresh">
													{#if logsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
												</button>
											{/if}

											<!-- New shell -->
											<div class="relative custom-dropdown-container">
												<button class="console-action-btn" onclick={handleNewShell} title="Open shell in pod">
													<Terminal class="h-3 w-3" />
													Shell
												</button>
												{#if showNewShellMenu}
													<div class="console-compact-menu" transition:scale={{ duration: 150, start: 0.96 }}>
														{#each deployment.pods ?? [] as pod}
															{#each pod.containers ?? [] as cont}
																<button type="button" onclick={() => openShell(pod.name, cont.name)}
																	class="console-compact-item">
																	<Terminal class="h-2.5 w-2.5 shrink-0 opacity-40" />
																	{podLabel(pod.name)}<span class="console-compact-sep">/</span><span class="console-compact-hl">{cont.name}</span>
																</button>
															{/each}
														{/each}
													</div>
												{/if}
											</div>

											<button
												onclick={toggleConsoleExpand}
												class="console-icon-btn"
												title={consoleExpanded ? 'Collapse' : 'Expand'}
											>
												{#if consoleExpanded}<Minimize2 class="h-3.5 w-3.5" />{:else}<Maximize2 class="h-3.5 w-3.5" />{/if}
											</button>
										</div>
									</div>

									<!-- Console body -->
									<div class="console-body">
										{#if activeConsoleTab === 'logs'}
											{#if logsLoading && !logs}
												<div class="console-empty">
													<Loader2 class="h-4 w-4 animate-spin" />
													<span>Loading logs...</span>
												</div>
											{:else if logs}
												<pre class="console-output" bind:this={logsOutputRef}>{@html ansiToHtml(logs)}</pre>
											{:else}
												<div class="console-empty">
													<Terminal class="h-4 w-4 opacity-30" />
													<span>{selectedPod ? 'No output yet' : 'Select a pod to view logs'}</span>
												</div>
											{/if}
										{:else}
											{#each terminalTabs as ttab (ttab.id)}
												<PodTerminal
													podName={ttab.podName}
													namespace={deployment.namespace || 'default'}
													container={ttab.container}
													visible={activeConsoleTab === ttab.id}
												/>
											{/each}
										{/if}
									</div>
								</div>

								<!-- Pods -->
								<div class="card rounded-2xl p-4">
									<div class="flex flex-wrap items-center justify-between gap-2 mb-2.5">
										<div class="flex items-center gap-2">
											<p class="text-xs font-semibold uppercase tracking-wide" style="color: var(--surface-muted);">Pods</p>
											<span class="text-xs font-mono" style="color: var(--surface-muted);">{deployment.pods?.length ?? 0}</span>
										</div>
										<div class="flex gap-2.5 text-[11px]" style="color: var(--surface-muted);">
											<span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>{deployment.pods?.filter((pod) => pod.status?.toLowerCase() === 'ready').length ?? 0} ready</span>
											{#if (deployment.pods?.filter((pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')).length ?? 0) > 0}
												<span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-yellow-500"></span>{deployment.pods?.filter((pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')).length ?? 0} other</span>
											{/if}
										</div>
									</div>
									{#if deployment.pods?.length}
										<div class="space-y-1">
											{#each deployment.pods as pod}
												<button
													class="console-pod-row"
													class:console-pod-row--active={selectedPod === pod.name}
													onclick={() => { selectedPod = pod.name; if (pod.containers?.length) selectedContainer = pod.containers[0].name; manualPodSelection = true; }}
												>
													<div class="flex items-center gap-2 min-w-0">
														<span class="h-1.5 w-1.5 rounded-full shrink-0 {pod.status?.toLowerCase() === 'ready' ? 'bg-green-500' : pod.status?.toLowerCase() === 'scheduled' ? 'bg-yellow-500' : 'bg-gray-400'}"></span>
														<span class="font-mono text-xs truncate">{podLabel(pod.name)}</span>
													</div>
													<div class="flex items-center gap-3 shrink-0 text-xs font-mono" style="color: var(--surface-muted);">
														{#if pod.startTime}<span>{formatRelativeTime(new Date(pod.startTime))}</span>{/if}
														{#if pod.cpuUsage != null}<span>{formatCpu(pod.cpuUsage)}</span>{/if}
														{#if pod.memoryUsage != null}<span>{formatMemory(pod.memoryUsage)}</span>{/if}
														<span class="badge {getStatusColor(pod.status)} text-[10px] px-1.5 py-0.5">{pod.status}</span>
													</div>
												</button>
											{/each}
										</div>
									{:else}
										<p class="text-xs text-center py-3" style="color: var(--surface-muted);">No pods reporting yet</p>
									{/if}
								</div>
							</div>

							<!-- Right sidebar: stats + scale -->
							<div class="flex flex-col gap-4">
								<!-- Resource stats as compact cards -->
								<div class="stat-card">
									<div class="stat-card-header">
										<Cpu class="h-3.5 w-3.5" style="color: #b33346;" />
										<span class="stat-card-label">CPU</span>
									</div>
									<p class="stat-card-value">{formatCpu(deployment.totalCpuUsage)}</p>
									{#if filteredMetrics.length > 1}
										<div class="stat-card-chart">
											{#if Line}
												<svelte:component this={Line} data={cpuChartData} options={cpuChartOptions} />
											{/if}
										</div>
									{/if}
								</div>

								<div class="stat-card">
									<div class="stat-card-header">
										<MemoryStick class="h-3.5 w-3.5" style="color: #e87485;" />
										<span class="stat-card-label">Memory</span>
									</div>
									<p class="stat-card-value">{formatMemory(deployment.totalMemoryUsage)}</p>
									{#if filteredMetrics.length > 1}
										<div class="stat-card-chart">
											{#if Line}
												<svelte:component this={Line} data={memoryChartData} options={memoryChartOptions} />
											{/if}
										</div>
									{/if}
								</div>

								<!-- Time range selector -->
								{#if filteredMetrics.length > 1}
									<div class="flex justify-center gap-0.5 rounded-lg p-0.5" style="background-color: var(--control-bg);">
										{#each ['5m', '15m', '30m', '1h'] as range}
											<button
												class="px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors flex-1"
												style={metricsTimeRange === range
													? 'background-color: var(--button-bg); color: var(--button-color);'
													: 'color: var(--surface-muted);'}
												onclick={() => { metricsTimeRange = range as any; }}
											>{range}</button>
										{/each}
									</div>
								{/if}

								<!-- Scale -->
								<div class="card rounded-2xl p-4">
									<div class="flex items-center justify-between mb-2">
										<p class="text-xs font-semibold uppercase tracking-wide" style="color: var(--surface-muted);">Replicas</p>
										<span class="text-lg font-bold font-mono" style="color: var(--center-channel-color);">{scaleReplicas}</span>
									</div>
									<div class="slider-container" style="padding: 4px 0;">
										<div
										bind:this={sliderRef}
										class="slider-wrapper"
										class:dragging={isDragging}
										role="slider"
										tabindex="0"
										aria-valuemin="0"
										aria-valuemax="20"
										aria-valuenow={scaleReplicas}
										aria-label="Desired replicas"
										onpointerdown={handlePointerDown}
										onpointermove={handlePointerMove}
										onpointerup={handlePointerUp}
										onpointercancel={handlePointerCancel}
										onclick={handleTrackClick}
										onkeydown={(e) => {
											if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
												e.preventDefault();
												scaleReplicas = Math.max(0, scaleReplicas - 1);
											} else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
												e.preventDefault();
												scaleReplicas = Math.min(20, scaleReplicas + 1);
											}
										}}
									>
										<div class="slider-track">
											<div class="slider-range" style="width: {sliderPercentage}%;"></div>
										</div>
										<div
											class="slider-thumb"
											class:dragging={isDragging}
											style="left: {sliderPercentage}%;"
										></div>
									</div>
								</div>
								<div class="flex items-center justify-between text-[10px]" style="color: var(--surface-muted);">
									<span>0</span>
									<span>20</span>
								</div>
								{#if scaleReplicas !== deployment.replicas}
									<div class="flex items-center justify-end pt-2.5 mt-2.5 border-t" style="border-color: var(--surface-border);">
										<button onclick={scaleDeployment} disabled={scaling} class="btn btn-primary btn-sm w-full">
											{#if scaling}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
											Scale to {scaleReplicas}
										</button>
									</div>
								{/if}
								</div>
							</div>
						</div>
					{:else if tab.id === 'environment'}
						<div class="card rounded-2xl p-5">
							<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
								<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Environment variables</p>
								<div class="relative flex rounded-lg p-0.5" style="background-color: var(--control-bg);">
									<div
										class="absolute top-0.5 bottom-0.5 rounded-md shadow-sm transition-all duration-200 ease-in-out"
										style="background-color: var(--surface-bg); width: calc(50% - 2px); left: {envViewMode === 'ui' ? '2px' : 'calc(50% + 0px)'};"
									></div>
									<button
										onclick={() => switchEnvView('ui')}
										class="relative z-10 px-3 py-1 text-xs font-medium rounded-md transition-colors duration-200"
										style="color: {envViewMode === 'ui' ? 'var(--center-channel-color)' : 'var(--surface-muted)'};"
									>UI</button>
									<button
										onclick={() => switchEnvView('raw')}
										class="relative z-10 px-3 py-1 text-xs font-medium rounded-md transition-colors duration-200"
										style="color: {envViewMode === 'raw' ? 'var(--center-channel-color)' : 'var(--surface-muted)'};"
									>Raw</button>
								</div>
							</div>
							<div class="env-container">
								{#if envViewMode === 'ui'}
									{#each envVars as env, index}
										{@const isRevealed = revealedIndices.has(index)}
										{@const hasKey = env.key.trim().length > 0}
										<div class="env-row" transition:slide={{ duration: 150 }}>
											<div class="env-row-inner">
												<div class="env-key-col">
													<input
														type="text"
														bind:value={env.key}
														placeholder="KEY"
														class="env-key-input"
														onfocus={() => isEditingEnv = true}
													/>
												</div>
												<div class="env-val-col">
													<input
														type={isRevealed ? 'text' : 'password'}
														bind:value={env.value}
														placeholder={hasKey ? 'value' : ''}
														class="env-val-input"
														onfocus={() => isEditingEnv = true}
													/>
												</div>
												<div class="env-actions">
													<button type="button" onclick={() => toggleReveal(index)} class="env-action-btn" aria-label={isRevealed ? 'Hide' : 'Show'}>
														{#if isRevealed}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
													</button>
													<button onclick={() => removeEnvRow(index)} class="env-action-btn env-action-delete" aria-label="Remove">
														<Trash2 class="h-3.5 w-3.5" />
													</button>
												</div>
											</div>
										</div>
									{/each}
									<button onclick={addEnvRow} class="env-add-btn">
										<Plus class="h-4 w-4" />
										<span>Add variable</span>
									</button>
								{:else}
									<textarea
										bind:value={envRawText}
										placeholder="KEY1=value1&#10;KEY2=value2&#10;# Comments are ignored"
										class="env-raw-textarea"
										onfocus={() => isEditingEnv = true}
									></textarea>
								{/if}
							</div>
							<div class="env-footer">
								<p class="env-footer-hint">Saving will restart pods with new variables.</p>
								<button onclick={saveEnv} disabled={savingEnv} class="btn btn-primary">
									{#if savingEnv}<Loader2 class="h-4 w-4 animate-spin" />{/if}
									<span>Save</span>
								</button>
							</div>
						</div>
					{:else if tab.id === 'volumes'}
						<div class="card rounded-2xl p-5">
							<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
								<div>
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Persistent Storage</p>
									<p class="text-xs mt-0.5" style="color: var(--surface-muted);">Attach storage that persists across restarts and redeployments.</p>
								</div>
								<button onclick={addVolume} class="btn btn-secondary btn-sm">
									<Plus class="h-4 w-4" />
									<span>Add Storage</span>
								</button>
							</div>
							<div class="space-y-3">
								{#each volumes as volume, index}
									<div class="vol-card" transition:slide={{ duration: 200 }}>
										<div class="vol-card-header">
											<div class="vol-card-number">{index + 1}</div>
											<div class="vol-card-fields">
												<div class="vol-field">
													<input type="text" bind:value={volume.pvcName} placeholder="Storage name" class="vol-input" />
												</div>
												<span class="vol-arrow">→</span>
												<div class="vol-field">
													<input type="text" bind:value={volume.mountPath} placeholder="/data" class="vol-input vol-input-mono" />
												</div>
												<div class="vol-field vol-field--size">
													<input type="text" bind:value={volume.storageSize} placeholder="1Gi" class="vol-input" />
												</div>
											</div>
											<div class="vol-card-actions">
												<label class="dm-toggle-row vol-toggle">
													<span class="vol-toggle-label">Read-only</span>
													<input type="checkbox" class="dm-toggle-input" bind:checked={volume.readOnly} />
													<span class="dm-toggle-track"><span class="dm-toggle-thumb"></span></span>
												</label>
												<button onclick={() => removeVolume(index)} class="btn btn-ghost btn-sm vol-remove"><Trash2 class="h-3.5 w-3.5" /></button>
											</div>
										</div>
									</div>
								{:else}
									<div class="text-center py-8" transition:fade={{ duration: 150 }}>
										<HardDrive class="h-8 w-8 mx-auto mb-2" style="color: var(--surface-muted);" />
										<p class="text-sm font-medium" style="color: var(--center-channel-color);">No storage attached</p>
										<p class="text-xs mt-1" style="color: var(--surface-muted);">Add persistent storage to keep files across restarts.</p>
									</div>
								{/each}
							</div>
							<div class="mt-4 flex items-center justify-between">
								<p class="text-xs" style="color: var(--surface-muted);">Saving will restart your app with the new storage config.</p>
								<button onclick={saveVolumes} disabled={savingVolumes} class="btn btn-primary">
									{#if savingVolumes}<Loader2 class="h-4 w-4 animate-spin" />{/if}
									<span>Save</span>
								</button>
							</div>
						</div>
					{:else if tab.id === 'network'}
						<div class="space-y-5">
							<!-- Ports -->
							<div class="card rounded-2xl p-5">
								<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Ports</p>
									<button
										type="button"
										class="btn btn-secondary btn-sm"
										onclick={() => {
											showServiceForm = !showServiceForm;
											isEditingServices = showServiceForm;
											if (!showServiceForm) {
												resetNewServiceForm();
												if (Object.keys(serviceEditForms).length === 0) {
													isEditingServices = false;
												}
											}
										}}
									>
										{#if showServiceForm}
											<X class="h-4 w-4" />
											<span>Close</span>
										{:else}
											<Plus class="h-4 w-4" />
											<span>Add</span>
										{/if}
									</button>
								</div>

								{#if showServiceForm}
									<div class="surface-form rounded-xl border border-dashed p-4 mb-4" transition:slide={{ duration: 200 }}>
										<div class="flex items-center gap-2">
											<div style="flex: 1; min-width: 80px; max-width: 120px;">
												<input type="number" min="1" class="input text-sm" placeholder="80" value={newServiceForm.ports[0].containerPort}
													oninput={(event) => {
														const val = Number((event.currentTarget as HTMLInputElement).value);
														updateNewServicePort(0, { containerPort: val, servicePort: val });
													}} />
											</div>
											<div class="svc-protocol-toggle">
												<button type="button" class="svc-proto-btn" class:svc-proto-active={newServiceForm.ports[0].protocol === 'TCP'}
													onclick={() => updateNewServicePort(0, { protocol: 'TCP' })}>TCP</button>
												<button type="button" class="svc-proto-btn" class:svc-proto-active={newServiceForm.ports[0].protocol === 'UDP'}
													onclick={() => updateNewServicePort(0, { protocol: 'UDP' })}>UDP</button>
											</div>
											<div class="flex-1"></div>
											<button type="button" class="btn btn-secondary btn-sm" onclick={() => { showServiceForm = false; resetNewServiceForm(); }}>Cancel</button>
											<button type="button" class="btn btn-primary btn-sm" onclick={createService} disabled={creatingService}>
												{#if creatingService}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
												Add
											</button>
										</div>

										{#if serviceFormError}
											<div class="alert alert-error mt-2">{serviceFormError}</div>
										{/if}
									</div>
								{/if}

								<div class="space-y-2">
									{#if deployment.services?.length}
										{#each deployment.services as service}
											{@const displayedPorts =
												service.ports && service.ports.length
													? service.ports
													: [{ name: service.name, port: service.port, targetPort: service.targetPort, protocol: service.protocol, nodePort: service.nodePort ?? null }]}
											{#each displayedPorts as port, portIndex}
												<div class="svc-port-row flex items-center gap-2 rounded-xl px-4 py-3" class:svc-port-editing={serviceEditForms[service.id]} style="background-color: var(--control-bg); border: 1px solid var(--surface-border);">
													{#if serviceEditForms[service.id]}
														<div style="flex: 1; min-width: 80px; max-width: 120px;">
															<input type="number" min="1" class="input text-sm" placeholder="80"
																value={serviceEditForms[service.id].ports[portIndex]?.containerPort ?? port.targetPort}
																oninput={(event) => {
																	const val = Number((event.currentTarget as HTMLInputElement).value);
																	updateServiceEditPort(service.id, portIndex, { containerPort: val, servicePort: val });
																}} />
														</div>
														<div class="svc-protocol-toggle">
															<button type="button" class="svc-proto-btn" class:svc-proto-active={(serviceEditForms[service.id].ports[portIndex]?.protocol ?? port.protocol) === 'TCP'}
																onclick={() => updateServiceEditPort(service.id, portIndex, { protocol: 'TCP' })}>TCP</button>
															<button type="button" class="svc-proto-btn" class:svc-proto-active={(serviceEditForms[service.id].ports[portIndex]?.protocol ?? port.protocol) === 'UDP'}
																onclick={() => updateServiceEditPort(service.id, portIndex, { protocol: 'UDP' })}>UDP</button>
														</div>
													{:else}
														<span class="text-sm font-mono font-medium" style="color: var(--center-channel-color);">{port.targetPort}</span>
														<span class="surface-pill rounded-full px-1.5 py-0.5 text-[10px]">{port.protocol}</span>
													{/if}
													<div class="flex-1"></div>
													{#if !serviceEditForms[service.id]}
														<button type="button" class="btn btn-ghost btn-sm" onclick={() => toggleServiceEdit(service)}>
															<Settings class="h-3.5 w-3.5" />
														</button>
													{/if}
													<button type="button" class="btn btn-ghost btn-sm text-red-500" onclick={() => deleteService(service.id)} disabled={serviceDeletingId === service.id}>
														{#if serviceDeletingId === service.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
													</button>
												</div>
											{/each}
											{#if serviceEditForms[service.id]}
												<div class="flex justify-end gap-2 pb-1" transition:slide={{ duration: 150 }}>
													<button type="button" class="btn btn-secondary btn-sm" onclick={() => toggleServiceEdit(service)}>Cancel</button>
													<button type="button" class="btn btn-primary btn-sm" onclick={() => saveServicePorts(service.id)} disabled={serviceSavingId === service.id}>
														{#if serviceSavingId === service.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
														Save
													</button>
												</div>
												{#if serviceEditErrors[service.id]}
													<div class="alert alert-error">{serviceEditErrors[service.id]}</div>
												{/if}
											{/if}
										{/each}
									{:else}
										<p class="text-sm text-center py-4" style="color: var(--surface-muted);">No ports configured</p>
									{/if}
								</div>
							</div>

							<!-- Domains -->
							<div class="card rounded-2xl p-5">
								<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Domains</p>
									{#if deployment.project?.id}
										<button
											type="button"
											class="btn btn-secondary btn-sm"
											onclick={() => {
												showDomainForm = !showDomainForm;
												if (!showDomainForm) resetDomainForm();
											}}
										>
											{#if showDomainForm}
												<X class="h-4 w-4" />
												<span>Close</span>
											{:else}
												<Plus class="h-4 w-4" />
												<span>Add</span>
											{/if}
										</button>
									{/if}
								</div>

								{#if showDomainForm}
									<div class="surface-form rounded-xl border border-dashed p-4 mb-4" transition:slide={{ duration: 200 }}>
										<div class="flex flex-wrap gap-2 items-end">
											<div class="flex-[2] min-w-[160px]">
												<p class="text-xs mb-1" style="color: var(--surface-muted);">Domain</p>
												<input
													type="text"
													class="input text-sm"
													placeholder="example.com"
													bind:value={newDomainHost}
													oninput={() => (domainFormError = null)}
												/>
											</div>
											<button
												type="button"
												class="btn btn-secondary btn-sm"
												onclick={generateRandomDomainForNew}
												title="Generate a free *.a.lfdl.ink domain"
											>
												<RefreshCw class="h-3.5 w-3.5" />
												Auto
											</button>
										</div>
										<p class="text-xs mt-1" style="color: var(--surface-muted);">
											For custom domains, point a CNAME record to <code>ingress.lfdl.ink</code>.
										</p>

										{#if domainServiceOptions.length > 1}
											<div class="mt-3">
												<p class="text-xs mb-1" style="color: var(--surface-muted);">Forward to</p>
												<select
													class="input text-sm"
													bind:value={newDomainServiceKey}
												>
													{#each domainServiceOptions as option}
														<option value={option.key}>{option.label}</option>
													{/each}
												</select>
											</div>
										{/if}

										<label class="dm-toggle-row">
											<div class="dm-toggle-text">
												<span class="dm-toggle-label">Enable SSL</span>
												<span class="dm-toggle-hint">Automatically provisions a Let's Encrypt certificate</span>
											</div>
											<input type="checkbox" class="dm-toggle-input" bind:checked={newDomainTlsEnabled} />
											<span class="dm-toggle-track"><span class="dm-toggle-thumb"></span></span>
										</label>

										<button
											type="button"
											class="mt-3 text-xs font-medium inline-flex items-center gap-1"
											style="color: var(--surface-muted); background: none; border: none; cursor: pointer; padding: 0;"
											onclick={() => (showDomainAdvanced = !showDomainAdvanced)}
										>
											<ChevronDown class="h-3 w-3" style={showDomainAdvanced ? '' : 'transform: rotate(-90deg);'} />
											Advanced
										</button>

										{#if showDomainAdvanced}
											<div class="mt-2" transition:slide={{ duration: 150 }}>
												<p class="text-xs mb-1" style="color: var(--surface-muted);">Path</p>
												<input
													type="text"
													class="input text-sm font-mono"
													placeholder="/"
													bind:value={newDomainPath}
													oninput={() => (domainFormError = null)}
												/>
												<p class="text-xs mt-1" style="color: var(--surface-muted);">
													Route a specific path here (e.g. <code>/api</code>). Leave as <code>/</code> to catch all traffic.
												</p>
											</div>
										{/if}

										{#if newDomainConflict}
											<div
												class="mt-3 p-2 rounded-lg text-xs border"
												style="background-color: color-mix(in srgb, {newDomainConflict.pathCollision ? 'var(--error-text-color)' : 'var(--sidebar-text-active-border)'} 10%, transparent); border-color: color-mix(in srgb, {newDomainConflict.pathCollision ? 'var(--error-text-color)' : 'var(--sidebar-text-active-border)'} 25%, transparent); color: var(--center-channel-color);"
											>
												{#if newDomainConflict.pathCollision}
													<strong>Path in use.</strong>
													<code>{newDomainNormalizedHost}{newDomainNormalizedPath}</code> is already routed. Choose a different path under Advanced.
												{:else if newDomainConflict.otherDeployment}
													<strong>Sharing domain.</strong>
													{newDomainNormalizedHost} already routes to another deployment. Traffic to <code>{newDomainNormalizedPath}</code> will be added to the existing ingress.
												{:else}
													Adding <code>{newDomainNormalizedPath}</code> to the existing {newDomainNormalizedHost} ingress.
												{/if}
											</div>
										{/if}

										{#if domainFormError}
											<div class="alert alert-error mt-3">{domainFormError}</div>
										{/if}

										<div class="mt-3 flex justify-end gap-2">
											<button
												type="button"
												class="btn btn-secondary btn-sm"
												onclick={() => { showDomainForm = false; resetDomainForm(); }}
											>
												Cancel
											</button>
											<button
												type="button"
												class="btn btn-primary btn-sm"
												onclick={createDomain}
												disabled={creatingDomain || !newDomainNormalizedHost || !newDomainServiceKey || newDomainConflict?.pathCollision}
											>
												{#if creatingDomain}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
												Create
											</button>
										</div>
									</div>
								{/if}
								<div class="space-y-2">
									{#if deployment.ingresses?.length}
										{#each deployment.ingresses as ingress}
											<div
												class="svc-port-row flex w-full items-center justify-between gap-3 rounded-xl p-3 text-left"
												style="background-color: var(--control-bg); border: 1px solid var(--surface-border);"
											>
												<a
													href="{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}"
													target="_blank"
													rel="noopener noreferrer"
													class="flex-1 min-w-0 text-left no-underline transition hover:opacity-80"
												>
													{#if ingress.annotations?.['traefik.ingress.kubernetes.io/router.middlewares']?.includes('auth@kubernetescrd')}
														<p class="text-xs text-amber-500 mb-1">
															<Lock class="inline h-3 w-3 mr-1" />
															Auth
														</p>
													{/if}
													<p class="text-sm font-medium" style="color: var(--center-channel-color);">
														{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}
													</p>
													{#if ingress.address}
														<p class="text-xs mt-0.5" style="color: var(--surface-muted);">{ingress.address}</p>
													{/if}
												</a>
												<button
													type="button"
													onclick={(e) => { e.stopPropagation(); deleteIngress(ingress.id); }}
													disabled={deletingIngressId === ingress.id}
													class="btn btn-sm"
													style="background-color: transparent; border: 1px solid var(--surface-border); color: var(--surface-muted);"
													aria-label="Remove domain"
												>
													{#if deletingIngressId === ingress.id}
														<Loader2 class="h-4 w-4 animate-spin" />
													{:else}
														<Trash2 class="h-4 w-4" />
													{/if}
												</button>
											</div>
										{/each}
									{:else}
										<p class="text-sm text-center py-4" style="color: var(--surface-muted);">No domains configured</p>
									{/if}
								</div>
							</div>
						</div>
					{:else if tab.id === 'history'}
						<div class="card rounded-2xl p-5">
							<p class="text-sm font-semibold mb-4" style="color: var(--center-channel-color);">Build History</p>
							{#if (deployment.imageHistory?.length ?? 0) > 0 || deployment.buildStatus === 'failed'}
								<div class="space-y-2">
									{#if deployment.buildStatus === 'failed'}
										<div class="bh-card bh-card-fail" transition:slide={{ duration: 150 }}>
											<div class="bh-card-left">
												<div class="bh-status-dot bh-dot-red"></div>
											</div>
											<div class="bh-card-body">
												<div class="bh-card-top">
													<span class="bh-card-title" style="color: #ef4444;">Build failed</span>
												</div>
												{#if deployment.buildError}
													<p class="bh-card-sub" style="color: color-mix(in srgb, #ef4444 60%, var(--surface-muted));">{deployment.buildError}</p>
												{/if}
											</div>
										</div>
									{/if}
									{#each deployment.imageHistory as history}
										{@const timeAgo = (() => {
											const diff = Date.now() - new Date(history.createdAt).getTime();
											const mins = Math.floor(diff / 60000);
											if (mins < 1) return 'just now';
											if (mins < 60) return `${mins}m ago`;
											const hrs = Math.floor(mins / 60);
											if (hrs < 24) return `${hrs}h ago`;
											const days = Math.floor(hrs / 24);
											if (days < 30) return `${days}d ago`;
											return new Date(history.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
										})()}
										<div class="bh-card" class:bh-card-active={history.isActive} transition:slide={{ duration: 150 }}>
											<div class="bh-card-left">
												<div class="bh-status-dot bh-dot-green" class:bh-dot-glow={history.isActive}></div>
											</div>
											<div class="bh-card-body">
												<div class="bh-card-top">
													<div class="bh-card-info">
														{#if history.commitSha}
															<code class="bh-card-sha">{history.commitSha.slice(0, 7)}</code>
														{/if}
														{#if history.branch}
															<span class="bh-card-branch">{history.branch}</span>
														{/if}
														{#if history.isActive}
															<span class="bh-card-live">Live</span>
														{/if}
													</div>
													<div class="bh-card-actions">
														<button onclick={() => openLogModal(history.id)} class="btn btn-ghost btn-sm" title="View logs">
															<Terminal class="h-3.5 w-3.5" />
														</button>
														{#if !history.isActive}
															<button onclick={() => rollbackToImage(history.id)} class="btn btn-ghost btn-sm" title="Rollback">
																<RefreshCw class="h-3.5 w-3.5" />
															</button>
														{/if}
													</div>
												</div>
												{#if history.commitMessage}
													<p class="bh-card-commit-msg">{history.commitMessage}</p>
												{/if}
												<p class="bh-card-sub">
													{#if history.triggerType === 'manual' && history.triggeredBy}
														Deployed manually by <span class="bh-card-user">@{history.triggeredBy.username}</span>
													{:else if history.triggerType === 'auto'}
														Auto-deployed from GitHub
													{:else}
														Deployed
													{/if}
													<span class="bh-card-time">&middot; {timeAgo}</span>
												</p>
											</div>
										</div>
									{/each}
								</div>
							{:else}
								<div class="text-center py-8">
									<History class="h-8 w-8 mx-auto mb-2" style="color: var(--surface-muted);" />
									<p class="text-sm font-medium" style="color: var(--center-channel-color);">No builds yet</p>
									<p class="text-xs mt-1" style="color: var(--surface-muted);">Builds will appear here after your first deploy.</p>
								</div>
							{/if}
						</div>
					{:else if tab.id === 'webhooks'}
						<div class="space-y-5">
							<!-- Intro + Create -->
							<div class="card rounded-2xl overflow-hidden">
								<div class="p-5">
									<div class="flex items-start gap-3 mb-4">
										<div class="wh-icon-wrap">
											<Webhook class="h-5 w-5" />
										</div>
										<div>
											<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Deploy with webhooks</p>
											<p class="text-xs mt-0.5" style="color: var(--surface-muted);">Trigger deployments from CI/CD pipelines, GitHub Actions, or any HTTP client. Create a token, then POST to the webhook URL to deploy.</p>
										</div>
									</div>

									<!-- Create token -->
									<div class="wh-create-row">
										<input type="text" class="input text-sm flex-1" placeholder="Label this token (e.g. github-actions, ci-prod)" bind:value={newWebhookLabel} />
										<button class="btn btn-primary btn-sm" onclick={createWebhookToken} disabled={creatingWebhookToken}>
											{#if creatingWebhookToken}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if}
											<span>Create token</span>
										</button>
									</div>
								</div>

								<!-- Newly created token banner -->
								{#if newlyCreatedToken}
									<div class="wh-new-token-banner" transition:slide={{ duration: 150 }}>
										<div class="wh-new-token-header">
											<div class="wh-new-token-alert">
												<AlertTriangle class="h-4 w-4" />
												<span class="text-sm font-semibold">Save your token now</span>
											</div>
											<p class="text-xs mt-0.5" style="opacity: 0.85;">This is the only time the token value will be shown. Copy it somewhere safe.</p>
										</div>
										<div class="wh-new-token-fields">
											<div>
												<p class="wh-new-token-label">Token</p>
												<div class="wh-new-token-value-row">
													<code class="wh-new-token-code">{newlyCreatedToken}</code>
													<button class="btn btn-ghost btn-sm wh-copy-btn" onclick={() => copyToClipboard(newlyCreatedToken!, 'token')}>
														{#if copiedWebhookToken}<Check class="h-3.5 w-3.5" /><span>Copied</span>{:else}<Copy class="h-3.5 w-3.5" /><span>Copy</span>{/if}
													</button>
												</div>
											</div>
											<div>
												<p class="wh-new-token-label">Webhook URL</p>
												<div class="wh-new-token-value-row">
													<code class="wh-new-token-code">{getWebhookUrl(newlyCreatedToken)}</code>
													<button class="btn btn-ghost btn-sm wh-copy-btn" onclick={() => copyToClipboard(getWebhookUrl(newlyCreatedToken!), 'url')}>
														{#if copiedWebhookUrl}<Check class="h-3.5 w-3.5" /><span>Copied</span>{:else}<Copy class="h-3.5 w-3.5" /><span>Copy</span>{/if}
													</button>
												</div>
											</div>
										</div>
										<button class="btn btn-ghost btn-sm wh-dismiss-btn" onclick={() => (newlyCreatedToken = null)}>
											<X class="h-3.5 w-3.5" />
											<span>Dismiss</span>
										</button>
									</div>
								{/if}

								<!-- Token list -->
								<div class="adv-divider"></div>
								<div class="p-5">
									{#if webhookTokensLoading}
										<div class="flex items-center justify-center py-8">
											<Loader2 class="h-5 w-5 animate-spin" style="color: var(--surface-muted);" />
										</div>
									{:else if webhookTokens.length === 0 && !newlyCreatedToken}
										<div class="wh-empty-state">
											<div class="wh-empty-icon">
												<Lock class="h-5 w-5" />
											</div>
											<p class="text-sm font-medium" style="color: var(--center-channel-color);">No tokens yet</p>
											<p class="text-xs" style="color: var(--surface-muted);">Create a token above to get started with webhook deploys.</p>
										</div>
									{:else}
										<div class="space-y-2">
											{#each webhookTokens as token}
												<div class="wh-token-card" transition:slide={{ duration: 120 }}>
													<div class="wh-token-icon">
														<Lock class="h-3.5 w-3.5" />
													</div>
													<div class="wh-token-info">
														<p class="wh-token-name">{token.label || 'Unnamed token'}</p>
														<p class="wh-token-meta">
															Created {new Date(token.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
															{#if token.lastUsedAt}
																<span class="wh-token-sep">&middot;</span> Last used {new Date(token.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
															{:else}
																<span class="wh-token-sep">&middot;</span> <span class="wh-token-unused">Never used</span>
															{/if}
														</p>
													</div>
													<button class="btn btn-ghost btn-sm wh-delete-btn" onclick={() => deleteWebhookToken(token.id)} disabled={deletingWebhookTokenId === token.id} title="Delete token">
														{#if deletingWebhookTokenId === token.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
													</button>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							</div>

							<!-- Quick reference -->
							<div class="card rounded-2xl overflow-hidden">
								<div class="p-5 pb-0">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Quick reference</p>
									<p class="text-xs mt-0.5 mb-4" style="color: var(--surface-muted);">Replace <code class="wh-inline-code">YOUR_WEBHOOK_URL</code> with the URL from your token above.</p>
								</div>

								<div class="wh-examples">
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<details class="wh-example-item" open>
										<summary class="wh-example-summary">
											<div class="wh-example-summary-left">
												<RefreshCw class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
												<span class="wh-example-title">Restart deployment</span>
											</div>
											<span class="wh-example-method">POST</span>
										</summary>
										<pre class="wh-code-block"><code>{webhookExamples.restart}</code></pre>
									</details>

									<details class="wh-example-item">
										<summary class="wh-example-summary">
											<div class="wh-example-summary-left">
												<RefreshCw class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
												<span class="wh-example-title">Update to a specific tag</span>
											</div>
											<span class="wh-example-method">POST + JSON</span>
										</summary>
										<pre class="wh-code-block"><code>{webhookExamples.updateTag}</code></pre>
									</details>

									<details class="wh-example-item">
										<summary class="wh-example-summary">
											<div class="wh-example-summary-left">
												<Container class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
												<span class="wh-example-title">Update image and tag</span>
											</div>
											<span class="wh-example-method">POST + JSON</span>
										</summary>
										<pre class="wh-code-block"><code>{webhookExamples.updateImage}</code></pre>
									</details>
								</div>

								<!-- GitHub Actions highlight -->
								<div class="wh-gh-actions-section">
									<div class="wh-gh-actions-header">
										<ExternalLink class="h-3.5 w-3.5" />
										<span class="text-xs font-semibold">GitHub Actions</span>
									</div>
									<p class="text-xs mb-3" style="color: var(--surface-muted);">Add this step to your workflow. Store the webhook URL as a repository secret named <code class="wh-inline-code">WEBHOOK_URL</code>.</p>
									<pre class="wh-code-block"><code>{webhookExamples.githubActions}</code></pre>
								</div>
							</div>
						</div>
					{:else if tab.id === 'advanced'}
						<div class="space-y-5">
							<!-- Build Options -->
							<div class="card rounded-2xl p-5">
								<div class="flex items-center justify-between mb-3">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Build</p>
									{#if deployment.githubRepo}
										<button onclick={saveAdvanced} disabled={savingAdvanced} class="btn btn-primary btn-sm">
											{#if savingAdvanced}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
											<span>Save</span>
										</button>
									{/if}
								</div>
								{#if deployment.githubRepo}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="adv-toggle-row"
										onclick={() => { buildFromRoot = !buildFromRoot; }}
									>
										<div class="adv-toggle-info">
											<span class="adv-toggle-label">Build from repository root</span>
											<span class="adv-toggle-desc">Use the repo root as Docker build context instead of the Dockerfile directory</span>
										</div>
										<label class="adv-switch" onclick={(e) => e.stopPropagation()}>
											<input type="checkbox" bind:checked={buildFromRoot} />
											<span class="adv-switch-track"></span>
										</label>
									</div>
									{#if $isSuperAdmin}
										<!-- svelte-ignore a11y_click_events_have_key_events -->
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<div
											class="adv-toggle-row"
											onclick={() => { buildWithDepot = !buildWithDepot; }}
										>
											<div class="adv-toggle-info">
												<span class="adv-toggle-label">Orchard's Super Builds</span>
												<span class="adv-toggle-desc">Use Orchard's high-performance hosted builders for faster builds</span>
											</div>
											<label class="adv-switch" onclick={(e) => e.stopPropagation()}>
												<input type="checkbox" bind:checked={buildWithDepot} />
												<span class="adv-switch-track"></span>
											</label>
										</div>
									{/if}
								{:else}
									<p class="text-xs" style="color: var(--surface-muted);">Build settings are only available for GitHub deployments.</p>
								{/if}
							</div>

							<!-- Auto-deploy -->
							<div class="card rounded-2xl p-5">
								<div class="flex items-center justify-between mb-3">
									<div class="flex items-center gap-2">
										<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Auto-Deploy</p>
										{#if deployment.githubRepo && autoDeployStatus?.enabled}
											<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400">
												<span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>
												Active
											</span>
										{/if}
									</div>
									{#if deployment.githubRepo && autoDeployStatus?.enabled}
										<button onclick={disableAutoDeploy} disabled={disablingAutoDeploy} class="btn btn-ghost btn-sm" style="color: var(--error-text-color);">
											{#if disablingAutoDeploy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
											<span>Disable</span>
										</button>
									{/if}
								</div>
								{#if deployment.githubRepo}
									{#if autoDeployLoading}
										<div class="flex items-center justify-center py-4">
											<Loader2 class="h-4 w-4 animate-spin" style="color: var(--surface-muted);" />
										</div>
									{:else if autoDeployStatus?.enabled}
										<p class="text-sm" style="color: var(--surface-muted);">
											Pushes to <code class="font-mono rounded px-1.5 py-0.5 text-xs" style="background-color: var(--control-bg); color: var(--center-channel-color);">{autoDeployStatus.branch}</code> trigger a new deployment automatically.
										</p>
									{:else if !autoDeployStatus?.appInstalled}
										<div class="flex items-center justify-between gap-3 rounded-xl p-4" style="background-color: var(--control-bg); border: 1px dashed var(--surface-border);">
											<div>
												<p class="text-sm font-medium" style="color: var(--center-channel-color);">GitHub App required</p>
												<p class="text-xs mt-0.5" style="color: var(--surface-muted);">Install it on your repository to enable automatic deployments.</p>
											</div>
											<button onclick={openGitHubAppInstall} disabled={!githubAppInstallUrl || loadingAppInstallUrl} class="btn btn-primary btn-sm shrink-0">
												{#if loadingAppInstallUrl}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
												<ExternalLink class="h-3.5 w-3.5" />
												<span>Install</span>
											</button>
										</div>
									{:else}
										<div class="flex gap-2 items-end">
											<div class="flex-1">
												<p class="text-xs mb-1.5 font-medium" style="color: var(--surface-muted);">Deploy on push to branch</p>
												<input type="text" bind:value={autoDeployBranch} placeholder={deployment.githubBranch || 'main'} class="input text-sm font-mono" />
											</div>
											<button onclick={enableAutoDeploy} disabled={enablingAutoDeploy || !autoDeployBranch} class="btn btn-primary btn-sm">
												{#if enablingAutoDeploy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
												<span>Enable</span>
											</button>
										</div>
									{/if}

									{#if githubDeployments.length > 0}
										<details class="mt-4 group">
											<summary class="cursor-pointer text-xs font-medium" style="color: var(--surface-muted);">
												Recent deployments ({githubDeployments.length})
											</summary>
											<div class="mt-2 space-y-1">
												{#each githubDeployments.slice(0, 5) as ghDeployment}
													<div class="flex items-center justify-between rounded-lg px-2.5 py-1.5" style="background-color: var(--control-bg);">
														<div class="flex items-center gap-2">
															{#if ghDeployment.status === 'success'}
																<div class="h-1.5 w-1.5 rounded-full bg-green-500"></div>
															{:else if ghDeployment.status === 'failure' || ghDeployment.status === 'error'}
																<div class="h-1.5 w-1.5 rounded-full bg-red-500"></div>
															{:else if ghDeployment.status === 'in_progress'}
																<div class="h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse"></div>
															{:else}
																<div class="h-1.5 w-1.5 rounded-full" style="background-color: var(--surface-muted);"></div>
															{/if}
															<code class="text-[11px] font-mono">{ghDeployment.commitSha.substring(0, 7)}</code>
															<span class="text-[11px]" style="color: var(--surface-muted);">{ghDeployment.ref}</span>
														</div>
														<div class="flex items-center gap-1.5 text-[11px]" style="color: var(--surface-muted);">
															<span>{new Date(ghDeployment.createdAt).toLocaleDateString()}</span>
															{#if ghDeployment.logUrl}
																<a href={ghDeployment.logUrl} class="text-blue-500 hover:underline" target="_blank"><ExternalLink class="h-2.5 w-2.5" /></a>
															{/if}
														</div>
													</div>
												{/each}
											</div>
										</details>
									{/if}
								{:else}
									<p class="text-xs" style="color: var(--surface-muted);">Only available for GitHub deployments.</p>
								{/if}
							</div>

							<!-- Health Checks -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="card rounded-2xl overflow-hidden" onchange={() => isEditingHealthCheck = true} oninput={() => isEditingHealthCheck = true}>
								<div class="p-5">
									<div class="flex items-center justify-between mb-1">
										<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Health Checks</p>
										<button onclick={saveHealthCheck} disabled={savingHealthCheck} class="btn btn-primary btn-sm">
											{#if savingHealthCheck}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
											<span>Save</span>
										</button>
									</div>
									<p class="text-xs mb-4" style="color: var(--surface-muted);">Automatically restart your app if it becomes unresponsive.</p>

									<!-- Master toggle -->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="hc-toggle-card"
										class:hc-toggle-card--on={healthCheckEnabled}
										onclick={() => { healthCheckEnabled = !healthCheckEnabled; isEditingHealthCheck = true; }}
									>
										<div class="hc-toggle-icon-wrap" class:hc-toggle-icon-wrap--on={healthCheckEnabled}>
											{#if healthCheckEnabled}
												<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
											{:else}
												<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-20"/></svg>
											{/if}
										</div>
										<div class="hc-toggle-text">
											<span class="hc-toggle-title">{healthCheckEnabled ? 'Health checks are on' : 'Health checks are off'}</span>
											<span class="hc-toggle-subtitle">
												{#if healthCheckEnabled}
													Your app will be automatically restarted if it stops responding
												{:else}
													Turn on to automatically detect and recover from crashes
												{/if}
											</span>
										</div>
										<label class="adv-switch" onclick={(e) => e.stopPropagation()}>
											<input type="checkbox" bind:checked={healthCheckEnabled} onchange={() => isEditingHealthCheck = true} />
											<span class="adv-switch-track"></span>
										</label>
									</div>
								</div>

								{#if healthCheckEnabled}
									<div class="adv-divider"></div>

									<div class="p-5 space-y-5">
										<!-- How to check -->
										<div>
											<p class="text-xs font-semibold mb-1" style="color: var(--center-channel-color);">How should we check your app?</p>
											<p class="text-xs mb-3" style="color: var(--surface-muted);">Pick the method that matches your app setup.</p>
											<div class="hc-method-grid">
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="hc-method-card"
													class:hc-method-card--active={healthCheckType === 'http'}
													onclick={() => { healthCheckType = 'http'; isEditingHealthCheck = true; }}
												>
													<div class="hc-method-top">
														<span class="hc-method-icon"><Globe class="h-5 w-5" /></span>
														<span class="hc-method-badge">Recommended</span>
													</div>
													<span class="hc-method-label">Web endpoint</span>
													<span class="hc-method-desc">Ping a URL path on your app</span>
												</div>
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="hc-method-card"
													class:hc-method-card--active={healthCheckType === 'tcp'}
													onclick={() => { healthCheckType = 'tcp'; isEditingHealthCheck = true; }}
												>
													<div class="hc-method-top">
														<span class="hc-method-icon"><Server class="h-5 w-5" /></span>
													</div>
													<span class="hc-method-label">Port check</span>
													<span class="hc-method-desc">Check if a port is accepting connections</span>
												</div>
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="hc-method-card"
													class:hc-method-card--active={healthCheckType === 'exec'}
													onclick={() => { healthCheckType = 'exec'; isEditingHealthCheck = true; }}
												>
													<div class="hc-method-top">
														<span class="hc-method-icon"><Terminal class="h-5 w-5" /></span>
													</div>
													<span class="hc-method-label">Custom command</span>
													<span class="hc-method-desc">Run a command inside your container</span>
												</div>
											</div>
										</div>

										<!-- Endpoint config based on type -->
										<div class="hc-config-section">
											{#if healthCheckType === 'http'}
												<div class="hc-config-row">
													<div class="flex-[3] min-w-[140px]">
														<label class="hc-field-label" for="hc-path">URL path to check</label>
														<div class="hc-input-with-hint">
															<input id="hc-path" type="text" bind:value={healthCheckPath} placeholder="/health" class="input text-sm font-mono" />
															<span class="hc-input-hint">We'll send a GET request here to see if your app is alive</span>
														</div>
													</div>
													<div class="w-24">
														<label class="hc-field-label" for="hc-port">Port</label>
														<input id="hc-port" type="number" bind:value={healthCheckPort} placeholder="80" class="input text-sm font-mono" />
													</div>
												</div>
											{:else if healthCheckType === 'tcp'}
												<div class="hc-config-row">
													<div class="w-28">
														<label class="hc-field-label" for="hc-tcp-port">Port to check</label>
														<div class="hc-input-with-hint">
															<input id="hc-tcp-port" type="number" bind:value={healthCheckPort} placeholder="80" class="input text-sm font-mono" />
															<span class="hc-input-hint">We'll try to open a connection to this port</span>
														</div>
													</div>
												</div>
											{:else}
												<div class="hc-config-row">
													<div class="flex-1 min-w-[200px]">
														<label class="hc-field-label" for="hc-cmd">Command to run</label>
														<div class="hc-input-with-hint">
															<input id="hc-cmd" type="text" bind:value={healthCheckCommand} placeholder="cat /tmp/healthy" class="input text-sm font-mono" />
															<span class="hc-input-hint">Should exit with code 0 when healthy</span>
														</div>
													</div>
												</div>
											{/if}
										</div>

										<!-- What should happen — friendly probe toggles -->
										<div>
											<p class="text-xs font-semibold mb-1" style="color: var(--center-channel-color);">What should happen when the check fails?</p>
											<p class="text-xs mb-3" style="color: var(--surface-muted);">Choose the recovery behaviors you want.</p>
											<div class="hc-behavior-list">
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="hc-behavior-item"
													class:hc-behavior-item--active={livenessEnabled}
													onclick={() => { livenessEnabled = !livenessEnabled; isEditingHealthCheck = true; }}
												>
													<div class="hc-behavior-check" class:hc-behavior-check--on={livenessEnabled}>
														{#if livenessEnabled}
															<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
														{/if}
													</div>
													<div class="hc-behavior-text">
														<span class="hc-behavior-title">Restart if unhealthy</span>
														<span class="hc-behavior-desc">Automatically restart the container if it stops responding</span>
													</div>
												</div>
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="hc-behavior-item"
													class:hc-behavior-item--active={readinessEnabled}
													onclick={() => { readinessEnabled = !readinessEnabled; isEditingHealthCheck = true; }}
												>
													<div class="hc-behavior-check" class:hc-behavior-check--on={readinessEnabled}>
														{#if readinessEnabled}
															<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
														{/if}
													</div>
													<div class="hc-behavior-text">
														<span class="hc-behavior-title">Stop sending traffic if failing</span>
														<span class="hc-behavior-desc">Temporarily stop routing requests to this container while it recovers</span>
													</div>
												</div>
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="hc-behavior-item"
													class:hc-behavior-item--active={startupEnabled}
													onclick={() => { startupEnabled = !startupEnabled; isEditingHealthCheck = true; }}
												>
													<div class="hc-behavior-check" class:hc-behavior-check--on={startupEnabled}>
														{#if startupEnabled}
															<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
														{/if}
													</div>
													<div class="hc-behavior-text">
														<span class="hc-behavior-title">Allow extra time on startup</span>
														<span class="hc-behavior-desc">Give your app more time to start up before checking its health</span>
													</div>
												</div>
											</div>
										</div>

										<!-- Timing — collapsible advanced -->
										<details class="hc-advanced-details">
											<summary class="hc-advanced-summary">
												<Settings class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
												<span>Advanced timing settings</span>
												<ChevronDown class="h-3.5 w-3.5 hc-advanced-chevron" style="color: var(--surface-muted);" />
											</summary>
											<div class="hc-timing-grid">
												<div class="hc-timing-card">
													<label class="hc-timing-card-label" for="hc-interval">Check every</label>
													<div class="hc-timing-input-wrap">
														<input id="hc-interval" type="number" bind:value={healthCheckInterval} min="1" class="input text-sm font-mono hc-timing-input" />
														<span class="hc-timing-suffix">seconds</span>
													</div>
													<span class="hc-timing-card-hint">How often to run the health check</span>
												</div>
												<div class="hc-timing-card">
													<label class="hc-timing-card-label" for="hc-timeout">Wait up to</label>
													<div class="hc-timing-input-wrap">
														<input id="hc-timeout" type="number" bind:value={healthCheckTimeout} min="1" class="input text-sm font-mono hc-timing-input" />
														<span class="hc-timing-suffix">seconds</span>
													</div>
													<span class="hc-timing-card-hint">Max time to wait for a response</span>
												</div>
												<div class="hc-timing-card">
													<label class="hc-timing-card-label" for="hc-retries">Fail after</label>
													<div class="hc-timing-input-wrap">
														<input id="hc-retries" type="number" bind:value={healthCheckRetries} min="1" class="input text-sm font-mono hc-timing-input" />
														<span class="hc-timing-suffix">failures</span>
													</div>
													<span class="hc-timing-card-hint">Consecutive failures before taking action</span>
												</div>
												{#if startupEnabled}
													<div class="hc-timing-card">
														<label class="hc-timing-card-label" for="hc-startup-retries">Startup grace</label>
														<div class="hc-timing-input-wrap">
															<input id="hc-startup-retries" type="number" bind:value={startupFailureThreshold} min="1" class="input text-sm font-mono hc-timing-input" />
															<span class="hc-timing-suffix">attempts</span>
														</div>
														<span class="hc-timing-card-hint">Extra attempts allowed during startup</span>
													</div>
												{/if}
											</div>
										</details>
									</div>
								{/if}
							</div>
						</div>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</div>

<!-- Build Progress Modal -->
{#if showBuildModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		transition:fade={{ duration: 150 }}
		role="dialog"
		aria-modal="true"
		aria-label="Build progress"
		onclick={(e) => { if (e.target === e.currentTarget) minimizeBuildModal(); }}
		onkeydown={(e) => { if (e.key === 'Escape') minimizeBuildModal(); }}
	>
		<div
			class="build-modal card w-full max-w-2xl rounded-2xl shadow-2xl"
			transition:scale={{ duration: 150, start: 0.95 }}
		>
			<div class="flex items-center justify-between border-b px-6 py-4" style="border-color: var(--surface-border);">
				<div class="flex items-center gap-3">
					<h2 class="text-lg font-semibold">Rebuilding {deployment?.name ?? 'deployment'}</h2>
					<div class="flex items-center gap-1.5 text-sm" style="color: var(--surface-muted);">
						<Clock class="h-3.5 w-3.5" />
						<span class="font-mono">{formatBuildElapsed(buildElapsed)}</span>
					</div>
				</div>
				<button
					onclick={minimizeBuildModal}
					class="btn-icon rounded-lg p-1.5 transition-colors"
					title="Minimize"
				>
					<Minimize2 class="h-4 w-4" />
				</button>
			</div>

			<div class="p-6">
				<DeploymentProgress
					status={deployment?.status ?? 'pending'}
					buildStatus={buildModalStatus}
					buildStep={buildModalStep}
					buildLogs={accumulatedBuildLogs}
					buildError={buildModalError}
					isGitHubDeploy={true}
					warnings={buildModalWarnings}
					buildStepTimestamps={buildModalTimestamps}
				/>
			</div>

			<div class="flex justify-end gap-3 border-t px-6 py-4" style="border-color: var(--surface-border);">
				{#if buildModalStatus === 'failed'}
					<button
						onclick={() => { showBuildModal = false; showBuildCard = false; stopBuildPolling(); }}
						class="btn btn-secondary text-sm"
					>
						Close
					</button>
				{:else if canCancelBuild}
					<button
						onclick={cancelBuildFromModal}
						disabled={cancelingBuild}
						class="btn btn-danger text-sm"
					>
						{#if cancelingBuild}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
							Cancelling...
						{:else}
							<X class="h-3.5 w-3.5" />
							Cancel build
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Floating Build Card -->
{#if showBuildCard && !showBuildModal}
	<button
		class="build-card fixed bottom-6 right-6 z-40 w-72 cursor-pointer rounded-xl shadow-lg transition-all hover:shadow-xl"
		transition:scale={{ duration: 200, start: 0.9 }}
		onclick={expandBuildCard}
	>
		<div class="flex items-center justify-between px-4 py-3">
			<div class="flex items-center gap-2 min-w-0">
				{#if buildModalStatus === 'building' || buildModalStatus === 'pending'}
					<Loader2 class="h-4 w-4 animate-spin shrink-0 text-primary-500" />
				{:else if buildModalStatus === 'failed'}
					<X class="h-4 w-4 shrink-0 text-red-500" />
				{:else if buildModalStatus === 'running'}
					<Check class="h-4 w-4 shrink-0 text-green-500" />
				{/if}
				<span class="truncate text-sm font-medium">{deployment?.name ?? 'Build'}</span>
			</div>
			<div class="flex items-center gap-2 shrink-0">
				<div class="flex items-center gap-1 text-xs font-mono" style="color: var(--surface-muted);">
					<Clock class="h-3 w-3" />
					{formatBuildElapsed(buildElapsed)}
				</div>
				<Maximize2 class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
			</div>
		</div>
		<div class="px-4 pb-3">
			<div class="build-card-track h-1.5 w-full overflow-hidden rounded-full">
				<div
					class="h-full transition-all duration-500 ease-out rounded-full {buildModalStatus === 'failed' ? 'bg-red-500' : buildModalStatus === 'running' ? 'bg-green-500' : 'bg-primary-500'}"
					style="width: {buildProgressValue()}%"
				></div>
			</div>
			<p class="mt-1.5 text-xs" style="color: var(--surface-muted);">
				{#if buildModalStatus === 'building'}
					{buildModalStep === 'cloning' ? 'Cloning repository...' :
					 buildModalStep === 'building' ? 'Building image...' :
					 buildModalStep === 'pushing' ? 'Pushing image...' :
					 buildModalStep === 'deploying' ? 'Creating deployment...' :
					 'Building...'}
				{:else if buildModalStatus === 'pending'}
					Starting build...
				{:else if buildModalStatus === 'failed'}
					Build failed
				{:else if buildModalStatus === 'running'}
					Build complete
				{/if}
			</p>
		</div>
	</button>
{/if}

{#if deployment}
	<ConfirmModal
		bind:open={showDeleteModal}
		title='Delete "{deployment.name}"?'
		description='This will permanently <strong>delete this deployment</strong> and all its associated services and ingresses. This cannot be undone.'
		confirmLabel="Delete Deployment"
		onconfirm={deleteDeployment}
		oncancel={() => {}}
	/>
{/if}

{#if logModalId}
	<div class="log-modal-backdrop" onclick={closeLogModal} transition:fade={{ duration: 150 }}>
		<div class="log-modal" onclick={(e) => e.stopPropagation()} transition:scale={{ duration: 200, start: 0.96 }}>
			<div class="log-modal-header">
				<div class="log-modal-header-left">
					<Terminal class="h-4 w-4" style="color: var(--sidebar-text, #e0e0e0); opacity: 0.5;" />
					<p class="log-modal-title">Build Logs</p>
				</div>
				<button class="log-modal-close" onclick={closeLogModal}>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="log-modal-body">
				{#if logModalLoading}
					<div class="log-modal-loading">
						<Loader2 class="h-5 w-5 animate-spin" style="color: rgba(255,255,255,0.3);" />
					</div>
				{:else if logModalContent}
					<pre class="log-modal-pre">{logModalContent}</pre>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.dm-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.75rem;
		padding: 0.5rem 0.625rem;
		border-radius: 0.5rem;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.dm-toggle-row:hover {
		background-color: color-mix(in srgb, var(--surface-border) 25%, transparent);
	}

	.dm-toggle-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.dm-toggle-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.dm-toggle-hint {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	.dm-toggle-input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	.dm-toggle-track {
		position: relative;
		flex-shrink: 0;
		width: 2.25rem;
		height: 1.25rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-color));
		transition: background-color 0.2s;
	}

	.dm-toggle-input:checked + .dm-toggle-track {
		background-color: var(--sidebar-text-active-border);
	}

	.dm-toggle-thumb {
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

	.dm-toggle-input:checked + .dm-toggle-track .dm-toggle-thumb {
		transform: translateX(1rem);
	}

	.dm-toggle-input:focus-visible + .dm-toggle-track {
		outline: 2px solid var(--sidebar-text-active-border);
		outline-offset: 2px;
	}

	.tabs-trigger {
		border: 1px solid transparent;
		background-color: transparent;
		color: var(--surface-muted);
		transition:
			background-color 150ms ease,
			border-color 150ms ease,
			color 150ms ease,
			box-shadow 150ms ease;
	}

	.tabs-trigger[data-active] {
		background-color: var(--surface-bg);
		border-color: var(--surface-border);
		color: var(--center-channel-color);
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.1);
	}

	:global(:root.dark) .tabs-trigger[data-active] {
		box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
	}

	.tabs-trigger:hover,
	.tabs-trigger:focus-visible {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
	}

	.tab-panel {
		display: none;
		color: var(--center-channel-color);
	}

	.tab-panel[data-active] {
		display: block;
		animation: tab-panel-in 320ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@keyframes tab-panel-in {
		from {
			opacity: 0;
			transform: translateY(1.25rem) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.surface-pill {
		background-color: var(--control-bg);
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		color: var(--control-text);
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.2rem 0.65rem;
		border-radius: 999px;
	}

	.surface-icon {
		background-color: color-mix(in srgb, var(--control-bg) 90%, transparent);
		border: 1px solid color-mix(in srgb, var(--surface-border) 65%, transparent);
		color: var(--control-text);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.surface-tile {
		background-color: var(--surface-bg);
		border: 1px solid color-mix(in srgb, var(--surface-border) 85%, transparent);
		color: var(--center-channel-color);
		transition:
			border-color 150ms ease,
			box-shadow 150ms ease,
			transform 150ms ease;
	}

	.surface-tile:hover {
		border-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-color));
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.08);
		transform: translateY(-1px);
	}

	.surface-muted-panel {
		background-color: color-mix(in srgb, var(--control-bg) 80%, transparent);
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		color: var(--surface-muted);
	}

	.surface-form {
		background-color: color-mix(in srgb, var(--control-bg) 85%, transparent);
		border-color: color-mix(in srgb, var(--surface-border) 80%, transparent);
		color: var(--center-channel-color);
	}

	.surface-checkbox {
		border: 1px solid var(--surface-border);
		background-color: var(--control-bg);
		color: var(--control-text);
	}

	.slider-container {
		width: 100%;
		position: relative;
	}

	.slider-wrapper {
		position: relative;
		width: 100%;
		height: 40px;
		padding: 16px 0;
		cursor: pointer;
		outline: none;
		touch-action: none;
		user-select: none;
	}

	.slider-track {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 6px;
		background-color: var(--control-bg);
		border-radius: 999px;
		transform: translateY(-50%);
	}

	.slider-range {
		position: absolute;
		height: 100%;
		background-color: var(--sidebar-text-active-bg);
		border-radius: 999px;
		transition: width 100ms ease;
	}

	.slider-wrapper.dragging .slider-range {
		transition: none;
	}

	.slider-thumb {
		position: absolute;
		width: 18px;
		height: 18px;
		background-color: var(--center-channel-bg);
		border: 2px solid var(--sidebar-text-active-bg);
		border-radius: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		cursor: grab;
		transition: transform 100ms ease, box-shadow 100ms ease;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
		outline: none;
		pointer-events: none;
	}

	.slider-thumb:hover {
		transform: translate(-50%, -50%) scale(1.1);
		box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
	}

	.slider-thumb.dragging {
		cursor: grabbing;
		transform: translate(-50%, -50%) scale(1.15);
		box-shadow: 0 6px 12px rgba(0, 0, 0, 0.2);
		transition: none;
	}

	.slider-wrapper:focus-visible .slider-thumb {
		outline: 2px solid var(--sidebar-text-active-bg);
		outline-offset: 2px;
	}

	.log-panel {
		background-color: #1a1a2e;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: #e0e0e8;
		font-weight: 400;
	}

	:global(:root:not(.dark)) .log-panel {
		background-color: #fafafa;
		border: 1px solid var(--surface-border);
		color: #2a2a3a;
	}

	.log-toolbar {
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		color: inherit;
	}

	:global(:root:not(.dark)) .log-toolbar {
		border-bottom-color: rgba(0, 0, 0, 0.08);
	}

	.log-lines-input {
		background-color: transparent;
		color: inherit;
		border-color: rgba(255, 255, 255, 0.15);
	}

	:global(:root:not(.dark)) .log-lines-input {
		border-color: rgba(0, 0, 0, 0.15);
	}

	.advanced-divider {
		height: 1px;
		background-color: var(--surface-border);
		opacity: 0.5;
		margin: 0 1.25rem;
	}

	.deployment-page {
		color: var(--center-channel-color);
	}

	.deployment-page :global(.text-gray-900),
	.deployment-page :global(.text-gray-800),
	.deployment-page :global(.text-gray-700) {
		color: var(--center-channel-color);
	}

	.deployment-page :global(.text-gray-600),
	.deployment-page :global(.text-gray-500),
	.deployment-page :global(.text-gray-400) {
		color: var(--surface-muted);
	}

	/* ===== Deployment header ===== */
	.dep-header {
		padding: 0.25rem 0;
	}

	.dep-header-card {
		position: relative;
		padding: 1.5rem 1.75rem 0.75rem;
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		overflow: hidden;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}
	.dep-header-card--hasbg {
		border-color: transparent;
		background: none;
	}
	.dep-header-card--hasbg .dep-header-top,
	.dep-header-card--hasbg .dep-header-meta {
		position: relative; z-index: 1; color: #fff;
	}
	.dep-header-card--hasbg .dep-header-name { color: #fff; }
	.dep-header-card--hasbg .dep-meta-source,
	.dep-header-card--hasbg .dep-meta-pill,
	.dep-header-card--hasbg .dep-meta-domain { color: rgba(255,255,255,0.8); }
	.dep-header-card--hasbg .dep-meta-domain:hover { color: #fff; }
	.dep-header-card--hasbg .dep-header-meta { border-top-color: rgba(255,255,255,0.15); }
	.dep-header-card--hasbg .badge { border-color: rgba(255,255,255,0.25); }
	.dep-header-card--hasbg .dep-meta-pill {
		background: rgba(255,255,255,0.18);
		color: rgba(255,255,255,0.9);
	}

	.dep-header-backdrop {
		position: absolute; inset: 0;
		overflow: hidden; pointer-events: none;
		border-radius: inherit;
	}
	.dep-header-bg {
		position: absolute; inset: -40%;
		background-size: cover; background-position: center;
		filter: blur(48px) saturate(1.6);
		transform-origin: 50% 50%;
	}
	.dep-header-bg--1 { transform: scale(1.6); opacity: 0.9; }
	.dep-header-bg--2 { transform: scale(2.1) translate(8%, -6%) rotate(70deg); opacity: 0.55; }
	.dep-header-bg--3 { transform: scale(2.6) translate(-10%, 9%) rotate(140deg); opacity: 0.4; }
	.dep-header-veil {
		position: absolute; inset: 0;
		background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.35) 100%);
	}

	.dep-header-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.dep-header-identity {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
		flex-wrap: wrap;
	}

	.dep-header-title-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}

	.dep-header-badges {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.dep-header-name {
		font-size: 1.375rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}

	.dep-header-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.dep-delete-btn {
		color: #ef4444 !important;
		border: 1px solid #ef4444 !important;
		background-color: rgba(239, 68, 68, 0.1) !important;
		opacity: 1 !important;
		transition: background-color 0.15s;
	}
	.dep-delete-btn:hover {
		background-color: rgba(239, 68, 68, 0.2) !important;
		color: #ef4444 !important;
	}

	.dep-notif-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem;
		border-radius: 0.5rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}
	.dep-notif-btn:hover {
		background: var(--control-hover-bg);
		color: var(--center-channel-color);
	}

	.dep-header-meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-top: 1.5rem;
		padding-top: 0.625rem;
		border-top: 1px solid var(--surface-border);
		font-size: 0.6875rem;
	}

	.dep-meta-source {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--surface-muted);
		text-decoration: none;
		transition: color 0.12s;
	}
	a.dep-meta-source:hover {
		color: var(--link-color);
	}

	.dep-meta-pill {
		display: inline-flex;
		padding: 0.0625rem 0.375rem;
		border-radius: 9999px;
		font-size: 0.625rem;
		font-weight: 550;
		background-color: var(--sidebar-text-active-bg);
		color: var(--sidebar-text-active-color);
	}

	.dep-meta-item {
		color: var(--surface-muted);
		font-size: 0.75rem;
	}
	.dep-meta-item::before {
		content: '·';
		margin-right: 0.5rem;
		opacity: 0.4;
	}

	.dep-meta-domain {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--link-color);
		text-decoration: none;
		font-size: 0.6875rem;
		font-weight: 500;
		transition: opacity 0.12s;
	}
	.dep-meta-domain:hover {
		opacity: 0.8;
	}

	/* ===== Tab nav ===== */
	.dep-tabs {
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		position: relative;
	}

	.dep-tabs-inner {
		display: flex;
		gap: 0.125rem;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.dep-tabs-inner::-webkit-scrollbar {
		display: none;
	}

	.dep-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.625rem 0.875rem;
		font-size: 0.8125rem;
		font-weight: 500;
		white-space: nowrap;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		position: relative;
		transition: color 0.12s;
	}

	.dep-tab:hover {
		color: var(--center-channel-color);
		background: transparent;
	}

	.dep-tab[data-active] {
		color: var(--center-channel-color);
		background: transparent;
		border: none;
		box-shadow: none;
	}
	.dep-tab[data-active]::after {
		content: '';
		position: absolute;
		bottom: -1px;
		left: 0.5rem;
		right: 0.5rem;
		height: 2px;
		border-radius: 2px 2px 0 0;
		background-color: var(--sidebar-text-active-border);
	}

	.build-modal {
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		max-height: 85vh;
		overflow-y: auto;
	}

	.btn-icon {
		color: var(--surface-muted);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.btn-icon:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.build-card {
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.03), 0 1px 2px rgb(0 0 0 / 0.02);
	}

	.build-card:hover {
		border-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-color));
	}

	.build-card-track {
		background-color: var(--surface-border);
	}

	@media (prefers-reduced-motion: reduce) {
		.tab-panel[data-active] {
			animation: none;
		}
		.surface-tile:hover {
			transform: none;
			box-shadow: none;
		}
	}

	.notification-badge {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 9999px;
		background-color: var(--error-text-color);
		color: #fff;
		font-size: 10px;
		font-weight: 600;
		line-height: 16px;
		text-align: center;
	}

	.notification-backdrop {
		position: fixed;
		inset: 0;
		z-index: 40;
	}

	.notification-panel {
		position: fixed;
		z-index: 50;
		width: 360px;
		max-height: 420px;
		border-radius: 1rem;
		border: 1px solid var(--surface-border);
		background-color: var(--card-bg);
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.notification-scroll {
		overflow-y: auto;
		flex: 1;
	}

	.notification-item {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.notification-item:last-child {
		border-bottom: none;
	}

	.notification-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		flex-shrink: 0;
	}

	.notification-icon-error {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.notification-icon-warning {
		background-color: color-mix(in srgb, var(--warning-text) 12%, transparent);
		color: var(--warning-text);
	}

	/* ===== Log timestamp pills ===== */
	.console-output :global(.log-ts) {
		display: inline-block;
		padding: 0 0.375rem;
		border-radius: 0.25rem;
		font-size: 0.625rem;
		font-weight: 500;
		line-height: 1.6;
		letter-spacing: 0.01em;
		background: rgba(255, 255, 255, 0.06);
		color: rgba(255, 255, 255, 0.4);
		vertical-align: baseline;
		user-select: none;
		margin-right: 0.125rem;
		position: relative;
		cursor: default;
		transition: background 0.1s, color 0.1s;
	}
	.console-output :global(.log-ts:hover) {
		background: rgba(255, 255, 255, 0.12);
		color: rgba(255, 255, 255, 0.7);
	}
	.console-output :global(.log-ts-ms) {
		opacity: 0.5;
		font-size: 0.5625rem;
	}

	/* Tooltip — built from data attributes via ::after.
	   Uses position:fixed computed by JS to escape overflow:auto parents. */
	.console-output :global(.log-ts::after) {
		content: attr(data-tooltip-local) '\A' 'UTC: ' attr(data-tooltip-utc) '\A' attr(data-tooltip-ago) ' · ' attr(data-tooltip-tz) '\A\A' attr(data-tooltip-raw);
		white-space: pre-wrap;
		position: fixed;
		padding: 0.5rem 0.625rem;
		border-radius: 0.5rem;
		font-size: 0.6875rem;
		font-weight: 400;
		font-family: var(--font-mono);
		line-height: 1.55;
		color: #e6edf3;
		background: #1c2128;
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.12s, transform 0.12s;
		z-index: 9999;
		min-width: 220px;
		max-width: 320px;
		/* Positioned by JS via custom props; top is the pill's top edge */
		left: var(--tt-x, -9999px);
		top: var(--tt-y, -9999px);
		transform: translateY(-100%) scale(0.96);
	}
	.console-output :global(.log-ts:hover::after) {
		opacity: 1;
		transform: translateY(-100%) scale(1);
	}

	/* ===== ANSI color classes ===== */
	.console-output :global(.ansi-bold) { font-weight: 700; }
	.console-output :global(.ansi-dim) { opacity: 0.6; }
	.console-output :global(.ansi-italic) { font-style: italic; }
	.console-output :global(.ansi-underline) { text-decoration: underline; }
	.console-output :global(.ansi-strike) { text-decoration: line-through; }

	/* Standard colors — tuned for dark terminal background */
	.console-output :global(.ansi-black) { color: #586069; }
	.console-output :global(.ansi-red) { color: #f97583; }
	.console-output :global(.ansi-green) { color: #85e89d; }
	.console-output :global(.ansi-yellow) { color: #ffea7f; }
	.console-output :global(.ansi-blue) { color: #79b8ff; }
	.console-output :global(.ansi-magenta) { color: #b392f0; }
	.console-output :global(.ansi-cyan) { color: #73e3ff; }
	.console-output :global(.ansi-white) { color: #d1d5da; }

	/* Bright / high-intensity */
	.console-output :global(.ansi-bright-black) { color: #6a737d; }
	.console-output :global(.ansi-bright-red) { color: #fdaeb7; }
	.console-output :global(.ansi-bright-green) { color: #bef5cb; }
	.console-output :global(.ansi-bright-yellow) { color: #fff5b1; }
	.console-output :global(.ansi-bright-blue) { color: #c8e1ff; }
	.console-output :global(.ansi-bright-magenta) { color: #d2b3ff; }
	.console-output :global(.ansi-bright-cyan) { color: #a5f3fc; }
	.console-output :global(.ansi-bright-white) { color: #fafbfc; }

	/* Background colors */
	.console-output :global(.ansi-bg-black) { background-color: #24292e; }
	.console-output :global(.ansi-bg-red) { background-color: rgba(249, 117, 131, 0.2); }
	.console-output :global(.ansi-bg-green) { background-color: rgba(133, 232, 157, 0.2); }
	.console-output :global(.ansi-bg-yellow) { background-color: rgba(255, 234, 127, 0.2); }
	.console-output :global(.ansi-bg-blue) { background-color: rgba(121, 184, 255, 0.2); }
	.console-output :global(.ansi-bg-magenta) { background-color: rgba(179, 146, 240, 0.2); }
	.console-output :global(.ansi-bg-cyan) { background-color: rgba(115, 227, 255, 0.2); }
	.console-output :global(.ansi-bg-white) { background-color: rgba(209, 213, 218, 0.15); }

	/* ===== Console (Pterodactyl-style) ===== */
	.console-panel {
		position: relative;
		border-radius: 0.875rem;
		overflow: visible;
		border: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
		background-color: #0d1117;
		color: #c9d1d9;
		display: flex;
		flex-direction: column;
		height: 510px;
		transition: none;
	}


	:global(:root:not(.dark)) .console-panel {
		background-color: #1b1f27;
		color: #d0d7de;
	}

	/* Expanded: fixed fullscreen overlay with animation */
	.console-panel.console-expanded {
		position: fixed;
		z-index: 100;
		border: none;
		transition: top 0.3s cubic-bezier(0.4, 0, 0.2, 1),
					left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
					width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
					height 0.3s cubic-bezier(0.4, 0, 0.2, 1),
					border-radius 0.3s cubic-bezier(0.4, 0, 0.2, 1);
	}
	.console-panel.console-at-fullscreen {
		top: 0 !important;
		left: 0 !important;
		width: 100vw !important;
		height: 100vh !important;
		border-radius: 0;
	}
	.console-panel.console-expanded .console-body {
		flex: 1;
		min-height: 0;
	}
	.console-panel.console-expanded .console-output {
		max-height: none;
		height: 100%;
	}

	@media (prefers-reduced-motion: reduce) {
		.console-panel.console-expanded {
			transition: none;
		}
	}

	.console-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.375rem 0.5rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		background: rgba(255, 255, 255, 0.02);
	}

	.console-toolbar-left {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}

	.console-tab-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3rem 0.5rem;
		border: none;
		background: transparent;
		color: rgba(201, 209, 217, 0.5);
		font-size: 0.6875rem;
		font-family: var(--font-mono);
		cursor: pointer;
		border-radius: 0.375rem;
		transition: background 0.1s, color 0.1s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.console-tab-btn:hover {
		background: rgba(255, 255, 255, 0.06);
		color: rgba(201, 209, 217, 0.8);
	}
	.console-tab-btn--active {
		background: rgba(255, 255, 255, 0.08);
		color: #c9d1d9;
	}

	.console-source-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border: none;
		background: transparent;
		color: rgba(201, 209, 217, 0.5);
		font-size: 0.625rem;
		font-family: var(--font-mono);
		cursor: pointer;
		border-radius: 0.375rem;
		transition: background 0.1s, color 0.1s;
		white-space: nowrap;
	}
	.console-source-btn:hover {
		background: rgba(255, 255, 255, 0.06);
		color: rgba(201, 209, 217, 0.8);
	}

	.console-action-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: rgba(255, 255, 255, 0.03);
		color: rgba(201, 209, 217, 0.6);
		font-size: 0.625rem;
		font-family: var(--font-mono);
		cursor: pointer;
		border-radius: 0.375rem;
		transition: background 0.1s, color 0.1s, border-color 0.1s;
		white-space: nowrap;
	}
	.console-action-btn:hover {
		background: rgba(255, 255, 255, 0.06);
		color: #c9d1d9;
		border-color: rgba(255, 255, 255, 0.15);
	}

	.console-dropdown--right {
		right: 0;
		left: auto;
	}

	.console-compact-menu {
		position: absolute;
		right: 0;
		z-index: 30;
		margin-top: 0.25rem;
		border-radius: 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		background: #161b22;
		padding: 0.25rem;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		min-width: 0;
		white-space: nowrap;
	}

	.console-compact-item {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		width: 100%;
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		font-size: 0.625rem;
		font-family: var(--font-mono);
		color: rgba(201, 209, 217, 0.7);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
		text-align: left;
	}
	.console-compact-item:hover {
		background: rgba(255, 255, 255, 0.06);
		color: #c9d1d9;
	}
	.console-compact-item--active {
		background: rgba(255, 255, 255, 0.05);
		color: #c9d1d9;
	}

	.console-compact-sep {
		opacity: 0.25;
		margin: 0 0.125rem;
	}

	.console-compact-hl {
		color: #58a6ff;
	}

	.console-dropdown-item--active {
		background: rgba(255, 255, 255, 0.06);
	}

	.console-tab-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 1px;
		border-radius: 3px;
		opacity: 0.4;
		cursor: pointer;
		transition: opacity 0.1s, background 0.1s;
	}
	.console-tab-close:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 0.1);
	}

	.console-toolbar-right {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	.console-dropdown-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-family: var(--font-mono);
		color: inherit;
		background: transparent;
		border: none;
		cursor: pointer;
		transition: background 0.1s;
	}
	.console-dropdown-btn:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.console-dropdown {
		position: absolute;
		z-index: 20;
		margin-top: 0.25rem;
		min-width: 200px;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		padding: 0.375rem;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
	}

	.console-dropdown-item {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		padding: 0.375rem 0.625rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-family: var(--font-mono);
		text-align: left;
		color: var(--center-channel-color);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: background 0.1s;
	}
	.console-dropdown-item:hover {
		background: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.console-separator {
		font-size: 0.75rem;
		opacity: 0.2;
		user-select: none;
	}

	.console-lines-input {
		width: 3.5rem;
		padding: 0.25rem 0.375rem;
		border-radius: 0.375rem;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: transparent;
		color: inherit;
		font-size: 0.6875rem;
		font-family: var(--font-mono);
		text-align: center;
		outline: none;
	}
	.console-lines-input:focus {
		border-color: rgba(255, 255, 255, 0.25);
	}

	.console-icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem;
		border-radius: 0.375rem;
		background: transparent;
		border: none;
		color: inherit;
		cursor: pointer;
		opacity: 0.6;
		transition: opacity 0.1s, background 0.1s;
	}
	.console-icon-btn:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 0.08);
	}

	.console-body {
		flex: 1;
		min-height: 0;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.console-output {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-all;
		font-size: 0.6875rem;
		line-height: 1.65;
		font-family: var(--font-mono);
		font-weight: 400;
		margin: 0;
		color: inherit;
	}

	/* Scrollbar inside console */
	.console-output::-webkit-scrollbar {
		width: 6px;
	}
	.console-output::-webkit-scrollbar-track {
		background: transparent;
	}
	.console-output::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.15);
		border-radius: 3px;
	}
	.console-output::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.25);
	}

	.console-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 3rem 1rem;
		font-size: 0.75rem;
		opacity: 0.4;
	}

	/* Pod rows — clickable to select for console */
	.console-pod-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		background: transparent;
		border: 1px solid transparent;
		color: var(--center-channel-color);
		cursor: pointer;
		text-align: left;
		transition: background 0.1s, border-color 0.1s;
	}
	.console-pod-row:hover {
		background: var(--control-bg);
	}
	.console-pod-row--active {
		background: var(--control-bg);
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 40%, transparent);
	}

	/* Sidebar stat cards */
	.stat-card {
		border-radius: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		background: var(--surface-bg);
		padding: 0.875rem;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.02);
	}

	.stat-card-header {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-bottom: 0.25rem;
	}

	.stat-card-label {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.stat-card-value {
		font-size: 1.25rem;
		font-weight: 700;
		font-family: var(--font-mono);
		color: var(--center-channel-color);
		line-height: 1.2;
		letter-spacing: -0.02em;
		margin: 0;
	}

	.stat-card-chart {
		margin-top: 0.625rem;
		height: 64px;
	}

	/* ===== Advanced tab ===== */

	/* Toggle row — clickable row with label + switch */
	.adv-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1rem;
		border-radius: 0.75rem;
		background-color: var(--control-bg);
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		cursor: pointer;
		transition: border-color 0.12s;
	}
	.adv-toggle-row:hover {
		border-color: var(--surface-border);
	}

	.adv-toggle-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.adv-toggle-label {
		font-size: 0.875rem;
		font-weight: 550;
		color: var(--center-channel-color);
	}

	.adv-toggle-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		line-height: 1.4;
	}

	/* Toggle switch */
	.adv-switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		flex-shrink: 0;
	}
	.adv-switch input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.adv-switch-track {
		width: 2.25rem;
		height: 1.25rem;
		border-radius: 9999px;
		background-color: var(--surface-border);
		transition: background-color 0.15s ease;
		position: relative;
	}
	.adv-switch-track::after {
		content: '';
		position: absolute;
		top: 2.5px;
		left: 2.5px;
		width: 0.9375rem;
		height: 0.9375rem;
		border-radius: 50%;
		background: white;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
		transition: transform 0.15s ease;
	}
	.adv-switch input:checked + .adv-switch-track {
		background-color: #22c55e;
	}
	.adv-switch input:checked + .adv-switch-track::after {
		transform: translateX(1rem);
	}

	.adv-divider {
		height: 1px;
		background-color: var(--surface-border);
		opacity: 0.5;
		margin: 0;
	}

	/* Health check toggle card */
	.hc-toggle-card {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 1rem 1.125rem;
		border-radius: 0.875rem;
		background-color: var(--control-bg);
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		cursor: pointer;
		transition: border-color 0.15s, background-color 0.15s;
	}
	.hc-toggle-card:hover {
		border-color: var(--surface-border);
	}
	.hc-toggle-card--on {
		border-color: color-mix(in srgb, #22c55e 30%, var(--surface-border));
		background: color-mix(in srgb, #22c55e 4%, var(--control-bg));
	}
	.hc-toggle-icon-wrap {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--surface-border) 40%, transparent);
		color: var(--surface-muted);
		transition: background-color 0.15s, color 0.15s;
	}
	.hc-toggle-icon-wrap--on {
		background: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
	}
	.hc-toggle-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		flex: 1;
		min-width: 0;
	}
	.hc-toggle-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.hc-toggle-subtitle {
		font-size: 0.75rem;
		color: var(--surface-muted);
		line-height: 1.4;
	}

	/* Method selection cards */
	.hc-method-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.625rem;
	}
	.hc-method-card {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.875rem;
		border-radius: 0.75rem;
		border: 1.5px solid var(--surface-border);
		background: var(--control-bg);
		cursor: pointer;
		transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;
		user-select: none;
	}
	.hc-method-card:hover {
		border-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-color));
		background: var(--control-hover-bg);
	}
	.hc-method-card--active {
		border-color: var(--sidebar-text-active-border);
		background: var(--sidebar-text-active-bg);
		box-shadow: 0 0 0 1px var(--sidebar-text-active-border);
	}
	.hc-method-card--active:hover {
		background: var(--sidebar-text-active-bg);
	}
	.hc-method-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.25rem;
	}
	.hc-method-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--surface-muted);
	}
	.hc-method-card--active .hc-method-icon {
		color: var(--sidebar-text-active-color);
	}
	.hc-method-badge {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #22c55e;
		background: color-mix(in srgb, #22c55e 10%, transparent);
		padding: 0.125rem 0.375rem;
		border-radius: 0.375rem;
	}
	.hc-method-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.hc-method-desc {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		line-height: 1.4;
	}

	/* Config section */
	.hc-config-section {
		padding: 1rem;
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--surface-border) 15%, transparent);
	}
	.hc-config-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-start;
	}
	.hc-field-label {
		display: block;
		font-size: 0.75rem;
		font-weight: 550;
		color: var(--center-channel-color);
		margin-bottom: 0.375rem;
	}
	.hc-input-with-hint {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.hc-input-hint {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		line-height: 1.3;
	}

	/* Behavior items (replaces probe chips) */
	.hc-behavior-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.hc-behavior-item {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		background: var(--control-bg);
		cursor: pointer;
		transition: border-color 0.15s, background-color 0.15s;
		user-select: none;
	}
	.hc-behavior-item:hover {
		border-color: var(--surface-border);
	}
	.hc-behavior-item--active {
		border-color: color-mix(in srgb, #22c55e 35%, var(--surface-border));
		background: color-mix(in srgb, #22c55e 4%, var(--control-bg));
	}
	.hc-behavior-check {
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 0.375rem;
		border: 1.5px solid var(--surface-border);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-top: 0.0625rem;
		transition: border-color 0.15s, background-color 0.15s;
		color: white;
	}
	.hc-behavior-check--on {
		background: #22c55e;
		border-color: #22c55e;
	}
	.hc-behavior-text {
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
	}
	.hc-behavior-title {
		font-size: 0.8125rem;
		font-weight: 550;
		color: var(--center-channel-color);
	}
	.hc-behavior-desc {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		line-height: 1.4;
	}

	/* Advanced timing section */
	.hc-advanced-details {
		border-radius: 0.75rem;
		overflow: hidden;
	}
	.hc-advanced-details[open] .hc-advanced-chevron {
		transform: rotate(180deg);
	}
	.hc-advanced-summary {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.625rem;
		background: color-mix(in srgb, var(--surface-border) 15%, transparent);
		cursor: pointer;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		user-select: none;
		list-style: none;
		transition: background-color 0.12s;
	}
	.hc-advanced-summary::-webkit-details-marker {
		display: none;
	}
	.hc-advanced-summary:hover {
		background: color-mix(in srgb, var(--surface-border) 25%, transparent);
	}
	.hc-advanced-chevron {
		margin-left: auto;
		transition: transform 0.2s ease;
	}
	.hc-timing-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.625rem;
		padding-top: 0.75rem;
	}
	.hc-timing-card {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.75rem;
		border-radius: 0.625rem;
		background: color-mix(in srgb, var(--surface-border) 12%, transparent);
	}
	.hc-timing-card-label {
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.hc-timing-input-wrap {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.hc-timing-input {
		width: 100%;
		min-width: 0;
		flex: 1;
	}
	.hc-timing-suffix {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		white-space: nowrap;
	}
	.hc-timing-card-hint {
		font-size: 0.625rem;
		color: var(--surface-muted);
		opacity: 0.8;
		line-height: 1.3;
	}


	/* Webhook styles */
	.wh-icon-wrap {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.wh-create-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	/* New token banner */
	.wh-new-token-banner {
		background: var(--success-bg);
		border-top: 1px solid var(--success-border);
		border-bottom: 1px solid var(--success-border);
		padding: 1.25rem;
	}
	.wh-new-token-header {
		margin-bottom: 1rem;
	}
	.wh-new-token-alert {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--success-text);
	}
	.wh-new-token-fields {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.wh-new-token-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--success-muted);
		margin-bottom: 0.375rem;
	}
	.wh-new-token-value-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.wh-new-token-code {
		flex: 1;
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		line-height: 1.5;
		padding: 0.5rem 0.625rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--success-border) 30%, transparent);
		color: var(--success-text);
		word-break: break-all;
	}
	.wh-copy-btn {
		flex-shrink: 0;
		gap: 0.25rem !important;
	}
	.wh-dismiss-btn {
		margin-top: 0.75rem;
		gap: 0.25rem !important;
		opacity: 0.7;
	}
	.wh-dismiss-btn:hover {
		opacity: 1;
	}

	/* Empty state */
	.wh-empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.375rem;
		padding: 2rem 1rem;
	}
	.wh-empty-icon {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--surface-border) 30%, transparent);
		color: var(--surface-muted);
		margin-bottom: 0.25rem;
	}

	/* Token list */
	.wh-token-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		background: var(--control-bg);
		transition: border-color 0.12s;
	}
	.wh-token-card:hover {
		border-color: var(--surface-border);
	}
	.wh-token-icon {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		background: color-mix(in srgb, var(--surface-border) 30%, transparent);
		color: var(--surface-muted);
	}
	.wh-token-info {
		flex: 1;
		min-width: 0;
	}
	.wh-token-name {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.wh-token-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		margin-top: 0.0625rem;
	}
	.wh-token-sep {
		margin: 0 0.125rem;
	}
	.wh-token-unused {
		opacity: 0.6;
		font-style: italic;
	}
	.wh-delete-btn {
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.12s;
	}
	.wh-token-card:hover .wh-delete-btn {
		opacity: 1;
	}

	/* Quick reference examples */
	.wh-examples {
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}
	.wh-example-item {
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}
	.wh-example-item:last-child {
		border-bottom: none;
	}
	.wh-example-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1.25rem;
		cursor: pointer;
		user-select: none;
		list-style: none;
		transition: background-color 0.1s;
	}
	.wh-example-summary::-webkit-details-marker {
		display: none;
	}
	.wh-example-summary:hover {
		background: color-mix(in srgb, var(--surface-border) 10%, transparent);
	}
	.wh-example-summary-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.wh-example-title {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}
	.wh-example-method {
		font-size: 0.625rem;
		font-weight: 600;
		font-family: var(--font-mono, monospace);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--surface-border) 25%, transparent);
		color: var(--surface-muted);
	}
	.wh-code-block {
		margin: 0 1.25rem 1rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.625rem;
		background: var(--code-bg);
		color: var(--code-text);
		font-size: 0.75rem;
		line-height: 1.6;
		overflow-x: auto;
		white-space: pre;
	}
	.wh-inline-code {
		font-family: var(--font-mono, monospace);
		font-size: 0.6875rem;
		padding: 0.0625rem 0.3125rem;
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--surface-border) 25%, transparent);
		color: var(--center-channel-color);
	}

	/* GitHub Actions section */
	.wh-gh-actions-section {
		margin: 0 1.25rem 1.25rem;
		padding: 1rem;
		border-radius: 0.75rem;
		background: var(--info-bg);
		border: 1px solid var(--info-border);
	}
	.wh-gh-actions-header {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--info-text);
		margin-bottom: 0.375rem;
	}
	.wh-gh-actions-section .wh-code-block {
		margin: 0;
		background: color-mix(in srgb, var(--info-border) 20%, var(--code-bg));
	}

	/* Volume cards */
	.vol-card {
		padding: 0.875rem 1rem;
		border-radius: 0.75rem;
		background-color: var(--control-bg);
		border: 1px solid var(--surface-border);
		transition: border-color 0.2s, box-shadow 0.2s;
	}

	.vol-card:hover {
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.vol-card-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.vol-card-number {
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
		color: var(--sidebar-text-active-border);
		font-size: 0.6875rem;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.vol-card-fields {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		flex-wrap: wrap;
	}

	.vol-field {
		flex: 1;
		min-width: 120px;
	}

	.vol-field--size {
		flex: 0 0 5rem;
		min-width: 5rem;
	}

	.vol-arrow {
		color: var(--surface-muted);
		font-size: 0.875rem;
		flex-shrink: 0;
	}

	.vol-input {
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

	.vol-input:focus {
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 20%, transparent);
	}

	.vol-input::placeholder {
		color: var(--surface-muted);
	}

	.vol-input-mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	.vol-card-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.vol-toggle {
		margin-top: 0;
		padding: 0.25rem 0.5rem;
		gap: 0.5rem;
		border-radius: 0.375rem;
	}

	.vol-toggle-label {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		white-space: nowrap;
	}

	.vol-remove {
		opacity: 0.4;
		transition: opacity 0.15s;
	}

	.vol-card:hover .vol-remove {
		opacity: 1;
	}

	/* Port protocol toggle */
	.svc-protocol-toggle {
		display: flex;
		border-radius: 0.5rem;
		overflow: hidden;
		border: 1px solid var(--surface-border);
	}

	.svc-proto-btn {
		padding: 0.375rem 0.75rem;
		font-size: 0.75rem;
		font-weight: 500;
		background: transparent;
		color: var(--surface-muted);
		border: none;
		cursor: pointer;
		transition: all 0.15s;
	}

	.svc-proto-btn:first-child {
		border-right: 1px solid var(--surface-border);
	}

	:global(.svc-proto-active) {
		background-color: var(--sidebar-text-active-border) !important;
		color: #fff !important;
	}

	.svc-port-row {
		transition: border-color 0.2s, box-shadow 0.2s;
	}

	.svc-port-editing {
		border-color: var(--sidebar-text-active-border) !important;
		box-shadow: 0 0 0 1px var(--sidebar-text-active-border);
	}

	/* ── Environment variables ── */
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
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
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
		transition: color 0.15s, background-color 0.15s;
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
		transition: color 0.15s, background-color 0.15s;
	}

	.env-add-btn:hover {
		color: var(--sidebar-text-active-border);
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 6%, transparent);
	}

	.env-raw-textarea {
		display: block;
		width: 100%;
		min-height: 280px;
		padding: 0.75rem;
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
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

	.env-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 1rem;
		gap: 1rem;
	}

	.env-footer-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	/* ── Build history cards ── */
	.bh-card {
		display: flex;
		align-items: stretch;
		gap: 0;
		border-radius: 0.75rem;
		background-color: var(--control-bg);
		border: 1px solid var(--surface-border);
		overflow: hidden;
		transition: border-color 0.15s, box-shadow 0.15s;
	}

	.bh-card:hover {
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.bh-card-active {
		border-color: color-mix(in srgb, #22c55e 30%, var(--surface-border));
	}

	.bh-card-active:hover {
		border-color: color-mix(in srgb, #22c55e 50%, var(--surface-border));
	}

	.bh-card-fail {
		border-color: color-mix(in srgb, #ef4444 25%, var(--surface-border));
	}

	.bh-card-fail:hover {
		border-color: color-mix(in srgb, #ef4444 45%, var(--surface-border));
	}

	/* Left accent strip with dot */
	.bh-card-left {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		flex-shrink: 0;
	}

	/* Status dot */
	.bh-status-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.bh-dot-green {
		background-color: #22c55e;
	}

	.bh-dot-glow {
		box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
	}

	.bh-dot-red {
		background-color: #ef4444;
		box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
	}

	/* Card body */
	.bh-card-body {
		flex: 1;
		min-width: 0;
		padding: 0.75rem 1rem 0.75rem 0;
	}

	.bh-card-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.bh-card-info {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		flex-wrap: wrap;
	}

	.bh-card-title {
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.bh-card-sha {
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
		font-size: 0.8125rem;
		font-weight: 700;
		color: var(--center-channel-color);
		background: none;
		padding: 0;
		letter-spacing: 0.02em;
	}

	.bh-card-branch {
		font-size: 0.6875rem;
		font-weight: 600;
		padding: 0.0625rem 0.5rem;
		border-radius: 1rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		color: var(--sidebar-text-active-border);
		border: 1px solid color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent);
	}

	.bh-card-live {
		font-size: 0.5625rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background-color: #22c55e;
		color: #fff;
	}

	.bh-card-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.bh-card:hover .bh-card-actions {
		opacity: 1;
	}

	.bh-card-commit-msg {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
		margin-top: 0.125rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 20rem;
	}
	.bh-card-sub {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin-top: 0.1875rem;
	}

	.bh-card-user {
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.bh-card-time {
		opacity: 0.7;
	}

	/* ── Log modal ── */
	.log-modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		padding: 2rem;
	}

	.log-modal {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 56rem;
		max-height: 80vh;
		border-radius: 0.75rem;
		overflow: hidden;
		background-color: #111827;
		border: 1px solid rgba(255, 255, 255, 0.08);
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.3),
			0 25px 50px -12px rgba(0, 0, 0, 0.6);
	}

	.log-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		background-color: rgba(255, 255, 255, 0.03);
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}

	.log-modal-header-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.log-modal-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.8);
	}

	.log-modal-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		background: transparent;
		border: none;
		color: rgba(255, 255, 255, 0.4);
		cursor: pointer;
		transition: color 0.15s, background-color 0.15s;
	}

	.log-modal-close:hover {
		color: rgba(255, 255, 255, 0.9);
		background-color: rgba(255, 255, 255, 0.08);
	}

	.log-modal-body {
		flex: 1;
		overflow-y: auto;
		min-height: 12rem;
	}

	.log-modal-body::-webkit-scrollbar {
		width: 6px;
	}

	.log-modal-body::-webkit-scrollbar-track {
		background: transparent;
	}

	.log-modal-body::-webkit-scrollbar-thumb {
		background-color: rgba(255, 255, 255, 0.1);
		border-radius: 3px;
	}

	.log-modal-body::-webkit-scrollbar-thumb:hover {
		background-color: rgba(255, 255, 255, 0.2);
	}

	.log-modal-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4rem 0;
	}

	.log-modal-pre {
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
		font-size: 0.75rem;
		line-height: 1.7;
		white-space: pre-wrap;
		word-break: break-all;
		padding: 1rem 1.25rem;
		margin: 0;
		color: #d1d5db;
		tab-size: 4;
	}

</style>
