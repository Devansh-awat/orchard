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
	import { scale, fade } from 'svelte/transition';
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
		commit?: string;
		createdAt: string;
		isActive: boolean;
	}

	interface Volume {
		id: string;
		name: string;
		type: 'pvc' | 'hostPath' | 'emptyDir';
		mountPath: string;
		pvcName?: string | null;
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
			workspace?: {
				slug: string;
			};
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
			label: 'Volumes',
			description: 'Storage & mounts',
			icon: HardDrive
		},
		{
			id: 'network',
			label: 'Network',
			description: 'Services & ingress',
			icon: Globe
		},
		{
			id: 'history',
			label: 'History',
			description: 'Images & rollbacks',
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
	let tailLines = $state(100);
	let logs = $state<string>('');
	let logsLoading = $state(false);
	let buildLogs = $state<string>('');
	let buildLogsLoading = $state(false);
	let podDropdownOpen = $state(false);
	let containerDropdownOpen = $state(false);
	let volumeTypeDropdownOpen = $state<number | null>(null);
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
	let volumes = $state<Array<{ name: string; type: 'pvc' | 'hostPath' | 'emptyDir'; mountPath: string; pvcName?: string; hostPath?: string; readOnly: boolean }>>([]);
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
		const serviceCount = deployment?.services?.length ?? 0;
		const defaultName = deployment?.name ? `${deployment.name}-${serviceCount + 1}` : '';
		newServiceForm = {
			name: defaultName,
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

			if (data.pods?.length && !selectedPod) {
				selectedPod = data.pods[0].name;
				if (data.pods[0].containers?.length) {
					selectedContainer = data.pods[0].containers[0].name;
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
			if (deployment.project?.workspace?.slug && deployment.project?.slug) {
				goto(`/${orgSlug}/workspaces/${deployment.project.workspace.slug}/projects/${deployment.project.slug}`);
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
		const serviceName = newServiceForm.name.trim().toLowerCase();
		if (!serviceName) {
			serviceFormError = 'Service name is required';
			return;
		}

		const { payload, error } = buildPortPayloadFromForm(newServiceForm);
		if (error) {
			serviceFormError = error;
			return;
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
				title: 'Service created',
				description: `${serviceName} is now routing traffic`,
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
				title: 'Service updated',
				description: 'Ports updated successfully',
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
				title: 'Service deleted',
				color: 'success'
			});

			const { [serviceId]: _removedForm, ...restForms } = serviceEditForms;
			serviceEditForms = restForms;
			const { [serviceId]: _removedError, ...restErrors } = serviceEditErrors;
			serviceEditErrors = restErrors;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete service',
				color: 'error'
			});
		} finally {
			serviceDeletingId = null;
		}
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
		volumes = [...volumes, { name: '', type: 'pvc', mountPath: '', pvcName: '', readOnly: false }];
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

			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/volumes`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ volumes: filteredVolumes })
			});

			if (!response.ok) {
				throw new Error('Failed to update volumes');
			}

			toasts.add({
				title: 'Volumes updated',
				description: 'Deployment will restart with new volume configuration',
				color: 'success'
			});

			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Failed to update volumes',
				description: e instanceof Error ? e.message : 'Failed to update volumes',
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

	function getBuildStatusLabel(buildStatus: string) {
		switch (buildStatus?.toLowerCase()) {
			case 'succeeded':
				return 'Succeeded';
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
		if (deploymentId) {
			loading = true;
			error = null;
			deployment = null;
			selectedPod = '';
			selectedContainer = '';
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
				volumeTypeDropdownOpen = null;
				protocolDropdownOpen = null;
				serviceDropdownOpen = false;
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

<div class="deployment-page p-6">
	{#if deployment?.project?.workspace?.slug && deployment?.project?.slug}
		<button
			onclick={() => goto(`/${orgSlug}/workspaces/${deployment.project.workspace.slug}/projects/${deployment.project.slug}`)}
			class="mb-4 inline-flex items-center gap-2 text-sm cursor-pointer" style="color: var(--surface-muted);"
		>
			<ArrowLeft class="h-4 w-4" />
			<span>Back to project</span>
		</button>
	{:else}
		<button
			onclick={() => goto(`/${orgSlug}`)}
			class="mb-4 inline-flex items-center gap-2 text-sm cursor-pointer" style="color: var(--surface-muted);"
		>
			<ArrowLeft class="h-4 w-4" />
			<span>Back to home</span>
		</button>
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
			<section class="dep-header">
				<div class="dep-header-top">
					<div class="dep-header-identity">
					<h1 class="dep-header-name">{deployment.name}</h1>
					<span class="badge {getStatusColor(deployment.status)} text-[11px]">{getDeploymentStatusLabel(deployment.status)}</span>
					{#if deployment.buildStatus && deployment.buildStatus !== 'none'}
						<span class="badge {getBuildStatusColor(deployment.buildStatus)} text-[11px]">Build: {getBuildStatusLabel(deployment.buildStatus)}</span>
					{/if}
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
						<button onclick={() => (showDeleteModal = true)} disabled={deleting} class="btn btn-ghost btn-sm dep-delete-btn">
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
							<a href="/{orgSlug}/ingresses/{ingress.id}" class="dep-meta-domain">
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
								<!-- Console / Logs -->
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
											<Terminal class="h-3.5 w-3.5 shrink-0 opacity-50" />
											<div class="relative custom-dropdown-container">
												<button type="button" onclick={() => (podDropdownOpen = !podDropdownOpen)}
													class="console-dropdown-btn">
													<span class="truncate max-w-[180px]">{selectedPod || 'Select pod'}</span>
													<ChevronDown class="h-3 w-3 shrink-0 opacity-40" />
												</button>
												{#if podDropdownOpen}
													<div class="console-dropdown" transition:scale={{ duration: 150, start: 0.96 }}>
														{#each deployment.pods ?? [] as pod}
															<button type="button" onclick={() => { selectedPod = pod.name; podDropdownOpen = false; }}
																class="console-dropdown-item">
																<span class="truncate">{pod.name}</span>
																{#if selectedPod === pod.name}<Check class="h-3.5 w-3.5 text-primary-600 shrink-0" />{/if}
															</button>
														{/each}
													</div>
												{/if}
											</div>

											<span class="console-separator">/</span>

											<div class="relative custom-dropdown-container">
												<button type="button" onclick={() => (containerDropdownOpen = !containerDropdownOpen)}
													class="console-dropdown-btn">
													<span class="truncate max-w-[140px]">{selectedContainer || 'container'}</span>
													<ChevronDown class="h-3 w-3 shrink-0 opacity-40" />
												</button>
												{#if containerDropdownOpen}
													<div class="console-dropdown" transition:scale={{ duration: 150, start: 0.96 }}>
														{#each deployment.pods?.find((p) => p.name === selectedPod)?.containers ?? [] as container}
															<button type="button" onclick={() => { selectedContainer = container.name; containerDropdownOpen = false; }}
																class="console-dropdown-item">
																<span>{container.name}</span>
																{#if selectedContainer === container.name}<Check class="h-3.5 w-3.5 text-primary-600 shrink-0" />{/if}
															</button>
														{/each}
													</div>
												{/if}
											</div>
										</div>
										<div class="console-toolbar-right">
											<input type="number" bind:value={tailLines} min="10" step="10"
												class="console-lines-input" title="Tail lines" />
											<button onclick={fetchLogs} disabled={logsLoading}
												class="console-icon-btn" title="Refresh logs">
												{#if logsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
											</button>
											<button
												onclick={toggleConsoleExpand}
												class="console-icon-btn"
												title={consoleExpanded ? 'Collapse' : 'Expand'}
											>
												{#if consoleExpanded}<Minimize2 class="h-3.5 w-3.5" />{:else}<Maximize2 class="h-3.5 w-3.5" />{/if}
											</button>
										</div>
									</div>

									<!-- Log output -->
									<div class="console-body">
										{#if logsLoading && !logs}
											<div class="console-empty">
												<Loader2 class="h-4 w-4 animate-spin" />
												<span>Loading logs...</span>
											</div>
										{:else if logs}
											<pre class="console-output">{@html ansiToHtml(logs)}</pre>
										{:else}
											<div class="console-empty">
												<Terminal class="h-4 w-4 opacity-30" />
												<span>{selectedPod ? 'No output yet' : 'Select a pod to view logs'}</span>
											</div>
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
													onclick={() => { selectedPod = pod.name; if (pod.containers?.length) selectedContainer = pod.containers[0].name; }}
												>
													<div class="flex items-center gap-2 min-w-0">
														<span class="h-1.5 w-1.5 rounded-full shrink-0 {pod.status?.toLowerCase() === 'ready' ? 'bg-green-500' : pod.status?.toLowerCase() === 'scheduled' ? 'bg-yellow-500' : 'bg-gray-400'}"></span>
														<span class="font-mono text-xs truncate">{pod.name}</span>
													</div>
													<div class="flex items-center gap-3 shrink-0 text-xs font-mono" style="color: var(--surface-muted);">
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
								<div class="flex items-center gap-2">
									{#if envViewMode === 'ui'}
										<button onclick={addEnvRow} class="btn btn-secondary btn-sm">
											<Plus class="h-4 w-4" />
											<span>Add</span>
										</button>
									{/if}
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
							</div>
							{#if envViewMode === 'ui'}
								<div class="space-y-2" transition:fade={{ duration: 150 }}>
									{#each envVars as env, index}
										{@const isRevealed = revealedIndices.has(index)}
										<div class="flex gap-2 items-center">
											<input type="text" bind:value={env.key} placeholder="KEY" class="input font-mono text-sm flex-[2]" onfocus={() => isEditingEnv = true} />
											<input
												type={isRevealed ? 'text' : 'password'}
												bind:value={env.value}
												placeholder="value"
												class="input font-mono text-sm flex-[3]"
												onfocus={() => isEditingEnv = true}
											/>
											<button type="button" onclick={() => toggleReveal(index)} class="btn btn-ghost btn-sm shrink-0" aria-label={isRevealed ? 'Hide' : 'Show'}>
												{#if isRevealed}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
											</button>
											<button onclick={() => removeEnvRow(index)} class="btn btn-ghost btn-sm shrink-0" aria-label="Remove">
												<X class="h-3.5 w-3.5" />
											</button>
										</div>
									{/each}
								</div>
							{:else}
								<div transition:fade={{ duration: 150 }}>
									<textarea
										bind:value={envRawText}
										placeholder="KEY1=value1&#10;KEY2=value2&#10;# Comments are ignored"
										class="input font-mono text-xs min-h-[200px] w-full"
										onfocus={() => isEditingEnv = true}
									></textarea>
								</div>
							{/if}
							<div class="mt-4 flex justify-end">
								<button onclick={saveEnv} disabled={savingEnv} class="btn btn-primary">
									{#if savingEnv}<Loader2 class="h-4 w-4 animate-spin" />{/if}
									<span>Save</span>
								</button>
							</div>
							<p class="mt-2 text-xs" style="color: var(--surface-muted);">Saving will restart pods with new variables.</p>
						</div>
					{:else if tab.id === 'volumes'}
						<div class="card rounded-2xl p-5">
							<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
								<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Volumes</p>
								<button onclick={addVolume} class="btn btn-secondary btn-sm">
									<Plus class="h-4 w-4" />
									<span>Add</span>
								</button>
							</div>
							<div class="space-y-3">
								{#each volumes as volume, index}
									<div class="rounded-xl p-4" style="background-color: var(--control-bg); border: 1px solid var(--surface-border);">
										<div class="flex items-center justify-between mb-3">
											<span class="text-sm font-medium" style="color: var(--center-channel-color);">Volume {index + 1}</span>
											<button onclick={() => removeVolume(index)} class="btn btn-ghost btn-sm"><Trash2 class="h-3.5 w-3.5" /></button>
										</div>
										<div class="grid gap-3 md:grid-cols-2">
											<div>
												<p class="text-xs mb-1" style="color: var(--surface-muted);">Name</p>
												<input type="text" bind:value={volume.name} placeholder="data" class="input text-sm" />
											</div>
											<div>
												<p class="text-xs mb-1" style="color: var(--surface-muted);">Type</p>
												<div class="relative custom-dropdown-container">
													<button
														type="button"
														onclick={() => (volumeTypeDropdownOpen = volumeTypeDropdownOpen === index ? null : index)}
														class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
														style="background-color: var(--surface-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
													>
														<span>{volume.type === 'pvc' ? 'PVC' : volume.type === 'hostPath' ? 'Host Path' : 'Empty Dir'}</span>
														<ChevronDown class="h-4 w-4 shrink-0" />
													</button>
													{#if volumeTypeDropdownOpen === index}
														<div class="absolute z-20 mt-1 w-full rounded-xl border p-1.5 shadow-lg" style="background-color: var(--surface-bg); border-color: var(--surface-border);" transition:scale={{ duration: 150, start: 0.96 }}>
															{#each [{ val: 'pvc', label: 'PVC' }, { val: 'hostPath', label: 'Host Path' }, { val: 'emptyDir', label: 'Empty Dir' }] as opt}
																<button type="button" onclick={() => { volume.type = opt.val as any; volumeTypeDropdownOpen = null; }}
																	class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]">
																	<span>{opt.label}</span>
																	{#if volume.type === opt.val}<Check class="h-4 w-4 text-primary-600" />{/if}
																</button>
															{/each}
														</div>
													{/if}
												</div>
											</div>
											<div class="md:col-span-2">
												<p class="text-xs mb-1" style="color: var(--surface-muted);">Mount Path</p>
												<input type="text" bind:value={volume.mountPath} placeholder="/data" class="input font-mono text-sm" />
											</div>
											{#if volume.type === 'pvc'}
												<div class="md:col-span-2">
													<p class="text-xs mb-1" style="color: var(--surface-muted);">PVC Name</p>
													<input type="text" bind:value={volume.pvcName} placeholder="my-pvc" class="input font-mono text-sm" />
												</div>
											{:else if volume.type === 'hostPath'}
												<div class="md:col-span-2">
													<p class="text-xs mb-1" style="color: var(--surface-muted);">Host Path</p>
													<input type="text" bind:value={volume.hostPath} placeholder="/host/path" class="input font-mono text-sm" />
												</div>
											{/if}
											<div class="md:col-span-2">
												<label class="flex items-center gap-2 text-sm">
													<input type="checkbox" bind:checked={volume.readOnly} class="rounded" />
													<span>Read-only</span>
												</label>
											</div>
										</div>
									</div>
								{:else}
									<p class="text-sm text-center py-6" style="color: var(--surface-muted);">No volumes configured</p>
								{/each}
							</div>
							<div class="mt-4 flex justify-end">
								<button onclick={saveVolumes} disabled={savingVolumes} class="btn btn-primary">
									{#if savingVolumes}<Loader2 class="h-4 w-4 animate-spin" />{/if}
									<span>Save</span>
								</button>
							</div>
							<p class="mt-2 text-xs" style="color: var(--surface-muted);">Saving will restart pods with new volume configuration.</p>
						</div>
					{:else if tab.id === 'network'}
						<div class="space-y-5">
							<!-- Services -->
							<div class="card rounded-2xl p-5">
								<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Services</p>
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
									<div class="surface-form rounded-xl border border-dashed p-4 mb-4">
										<div class="flex flex-wrap gap-3 items-end">
											<div class="flex-[2] min-w-[160px]">
												<p class="text-xs mb-1" style="color: var(--surface-muted);">Service name</p>
												<input
													type="text"
													class="input text-sm"
													placeholder="api-service"
													value={newServiceForm.name}
													oninput={(event) =>
														(newServiceForm = {
															...newServiceForm,
															name: (event.currentTarget as HTMLInputElement).value
														})}
												/>
											</div>
											<label class="flex items-center gap-2 text-sm py-2">
												<input
													type="checkbox"
													checked={newServiceForm.exposePublic}
													onchange={(event) =>
														(newServiceForm = {
															...newServiceForm,
															exposePublic: (event.currentTarget as HTMLInputElement).checked
														})}
													class="rounded"
												/>
												<span>Expose publicly</span>
											</label>
										</div>

										<div class="mt-3 space-y-2">
											{#each newServiceForm.ports as port, index}
												<div class="flex flex-wrap gap-2 items-end">
													<div class="flex-1 min-w-[80px]">
														<p class="text-xs mb-1" style="color: var(--surface-muted);">Name</p>
														<input type="text" class="input text-sm" placeholder="http" value={port.name}
															oninput={(event) => updateNewServicePort(index, { name: (event.currentTarget as HTMLInputElement).value })} />
													</div>
													<div class="flex-1 min-w-[80px]">
														<p class="text-xs mb-1" style="color: var(--surface-muted);">Container</p>
														<input type="number" min="1" class="input text-sm" placeholder="8080" value={port.containerPort}
															oninput={(event) => updateNewServicePort(index, { containerPort: Number((event.currentTarget as HTMLInputElement).value) })} />
													</div>
													<div class="flex-1 min-w-[80px]">
														<p class="text-xs mb-1" style="color: var(--surface-muted);">Service</p>
														<input type="number" min="1" class="input text-sm" placeholder="80" value={port.servicePort}
															oninput={(event) => updateNewServicePort(index, { servicePort: Number((event.currentTarget as HTMLInputElement).value) })} />
													</div>
													<div class="w-[90px]">
														<p class="text-xs mb-1" style="color: var(--surface-muted);">Protocol</p>
														<div class="relative custom-dropdown-container">
															<button type="button"
																onclick={() => (protocolDropdownOpen = protocolDropdownOpen === `new-${index}` ? null : `new-${index}`)}
																class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-2 py-2 text-sm transition"
																style="background-color: var(--surface-bg); color: var(--center-channel-color); border-color: var(--surface-border);">
																<span>{port.protocol}</span>
																<ChevronDown class="h-3.5 w-3.5 shrink-0" />
															</button>
															{#if protocolDropdownOpen === `new-${index}`}
																<div class="absolute z-20 mt-1 w-full rounded-xl border p-1.5 shadow-lg" style="background-color: var(--surface-bg); border-color: var(--surface-border);" transition:scale={{ duration: 150, start: 0.96 }}>
																	{#each ['TCP', 'UDP'] as proto}
																		<button type="button" onclick={() => { updateNewServicePort(index, { protocol: proto }); protocolDropdownOpen = null; }}
																			class="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]">
																			<span>{proto}</span>
																			{#if port.protocol === proto}<Check class="h-3.5 w-3.5 text-primary-600" />{/if}
																		</button>
																	{/each}
																</div>
															{/if}
														</div>
													</div>
													<button type="button" class="btn btn-ghost btn-sm" onclick={() => removeNewServicePortRow(index)}>
														<Trash2 class="h-3.5 w-3.5" />
													</button>
													{#if newServiceForm.exposePublic}
														<div class="w-full">
															<p class="text-xs mb-1" style="color: var(--surface-muted);">NodePort (optional)</p>
															<input type="number" min="30000" max="32767" class="input text-sm" placeholder="30000-32767" value={port.nodePort ?? ''}
																oninput={(event) => updateNewServicePort(index, { nodePort: (event.currentTarget as HTMLInputElement).value === '' ? null : Number((event.currentTarget as HTMLInputElement).value) })} />
														</div>
													{/if}
												</div>
											{/each}
											<button type="button" class="btn btn-secondary btn-sm" onclick={addNewServicePortRow}>
												<Plus class="h-3.5 w-3.5" /> Add port
											</button>
										</div>

										{#if serviceFormError}
											<div class="alert alert-error mt-3">{serviceFormError}</div>
										{/if}

										<div class="mt-3 flex justify-end gap-2">
											<button type="button" class="btn btn-secondary btn-sm" onclick={() => { showServiceForm = false; resetNewServiceForm(); }}>Cancel</button>
											<button type="button" class="btn btn-primary btn-sm" onclick={createService} disabled={creatingService}>
												{#if creatingService}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
												Create
											</button>
										</div>
									</div>
								{/if}

								<div class="space-y-3">
									{#if deployment.services?.length}
										{#each deployment.services as service}
											{@const displayedPorts =
												service.ports && service.ports.length
													? service.ports
													: [{ name: service.name, port: service.port, targetPort: service.targetPort, protocol: service.protocol, nodePort: service.nodePort ?? null }]}
											<div class="rounded-xl p-4" style="background-color: var(--control-bg); border: 1px solid var(--surface-border);">
												<div class="flex items-center justify-between gap-3 mb-2">
													<div class="flex items-center gap-2 min-w-0">
														<span class="text-sm font-medium" style="color: var(--center-channel-color);">{service.name}</span>
														<span class="surface-pill rounded-full px-2 py-0.5 text-xs">{service.type === 'external' ? 'NodePort' : 'ClusterIP'}</span>
														{#if service.externalIp}
															<span class="text-xs font-mono" style="color: var(--surface-muted);">{service.externalIp}</span>
														{/if}
													</div>
													<div class="flex gap-1 shrink-0">
														<button type="button" class="btn btn-ghost btn-sm" onclick={() => toggleServiceEdit(service)}>
															{#if serviceEditForms[service.id]}<X class="h-3.5 w-3.5" />{:else}<Settings class="h-3.5 w-3.5" />{/if}
														</button>
														<button type="button" class="btn btn-ghost btn-sm text-red-500" onclick={() => deleteService(service.id)} disabled={serviceDeletingId === service.id}>
															{#if serviceDeletingId === service.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
														</button>
													</div>
												</div>

												{#if service.internalUrl}
													<div class="flex items-center gap-2 mb-2 text-xs font-mono" style="color: var(--surface-muted);">
														<span class="truncate">{service.internalUrl}</span>
														<button type="button" class="btn btn-ghost btn-sm shrink-0" onclick={() => copyInternalUrl(service.internalUrl, service.id)}>
															{#if copiedUrlId === service.id}<Check class="h-3 w-3 text-green-500" />{:else}<Copy class="h-3 w-3" />{/if}
														</button>
													</div>
												{/if}

												<div class="space-y-1">
													{#each displayedPorts as port}
														<div class="flex items-center gap-2 text-xs" style="color: var(--surface-muted);">
															<span class="font-mono font-medium" style="color: var(--center-channel-color);">{port.name ?? 'port'}</span>
															<span class="font-mono">{port.targetPort}</span>
															<span>→</span>
															<span class="font-mono">{port.port}</span>
															{#if port.nodePort}<span>→</span><span class="font-mono">{port.nodePort}</span>{/if}
															<span class="surface-pill rounded-full px-1.5 py-0 text-[10px]">{port.protocol}</span>
														</div>
													{/each}
												</div>

												{#if serviceEditForms[service.id]}
													<div class="mt-3 border-t border-dashed pt-3" style="border-color: var(--surface-border);">
														<div class="space-y-2">
															{#each serviceEditForms[service.id].ports as port, index}
																<div class="flex flex-wrap gap-2 items-end">
																	<div class="flex-1 min-w-[80px]">
																		<p class="text-xs mb-1" style="color: var(--surface-muted);">Name</p>
																		<input type="text" class="input text-sm" placeholder="port name" value={port.name}
																			oninput={(event) => updateServiceEditPort(service.id, index, { name: (event.currentTarget as HTMLInputElement).value })} />
																	</div>
																	<div class="flex-1 min-w-[80px]">
																		<p class="text-xs mb-1" style="color: var(--surface-muted);">Container</p>
																		<input type="number" min="1" class="input text-sm" placeholder="8080" value={port.containerPort}
																			oninput={(event) => updateServiceEditPort(service.id, index, { containerPort: Number((event.currentTarget as HTMLInputElement).value) })} />
																	</div>
																	<div class="flex-1 min-w-[80px]">
																		<p class="text-xs mb-1" style="color: var(--surface-muted);">Service</p>
																		<input type="number" min="1" class="input text-sm" placeholder="80" value={port.servicePort}
																			oninput={(event) => updateServiceEditPort(service.id, index, { servicePort: Number((event.currentTarget as HTMLInputElement).value) })} />
																	</div>
																	<div class="w-[90px]">
																		<p class="text-xs mb-1" style="color: var(--surface-muted);">Protocol</p>
																		<div class="relative custom-dropdown-container">
																			<button type="button"
																				onclick={() => (protocolDropdownOpen = protocolDropdownOpen === `${service.id}-${index}` ? null : `${service.id}-${index}`)}
																				class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-2 py-2 text-sm transition"
																				style="background-color: var(--surface-bg); color: var(--center-channel-color); border-color: var(--surface-border);">
																				<span>{port.protocol}</span>
																				<ChevronDown class="h-3.5 w-3.5 shrink-0" />
																			</button>
																			{#if protocolDropdownOpen === `${service.id}-${index}`}
																				<div class="absolute z-20 mt-1 w-full rounded-xl border p-1.5 shadow-lg" style="background-color: var(--surface-bg); border-color: var(--surface-border);" transition:scale={{ duration: 150, start: 0.96 }}>
																					{#each ['TCP', 'UDP'] as proto}
																						<button type="button" onclick={() => { updateServiceEditPort(service.id, index, { protocol: proto }); protocolDropdownOpen = null; }}
																							class="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]">
																							<span>{proto}</span>
																							{#if port.protocol === proto}<Check class="h-3.5 w-3.5 text-primary-600" />{/if}
																						</button>
																					{/each}
																				</div>
																			{/if}
																		</div>
																	</div>
																	<button type="button" class="btn btn-ghost btn-sm" onclick={() => removeServiceEditPortRow(service.id, index)}>
																		<Trash2 class="h-3.5 w-3.5" />
																	</button>
																	{#if serviceEditForms[service.id].exposePublic}
																		<div class="w-full">
																			<p class="text-xs mb-1" style="color: var(--surface-muted);">NodePort (optional)</p>
																			<input type="number" min="30000" max="32767" class="input text-sm" placeholder="30000-32767" value={port.nodePort ?? ''}
																				oninput={(event) => updateServiceEditPort(service.id, index, { nodePort: (event.currentTarget as HTMLInputElement).value === '' ? null : Number((event.currentTarget as HTMLInputElement).value) })} />
																		</div>
																	{/if}
																</div>
															{/each}
															<button type="button" class="btn btn-secondary btn-sm" onclick={() => addServiceEditPortRow(service.id)}>
																<Plus class="h-3.5 w-3.5" /> Add port
															</button>
														</div>
														{#if serviceEditErrors[service.id]}
															<div class="alert alert-error mt-2">{serviceEditErrors[service.id]}</div>
														{/if}
														<div class="mt-2 flex justify-end">
															<button type="button" class="btn btn-primary btn-sm" onclick={() => saveServicePorts(service.id)} disabled={serviceSavingId === service.id}>
																{#if serviceSavingId === service.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
																Save
															</button>
														</div>
													</div>
												{/if}
											</div>
										{/each}
									{:else}
										<p class="text-sm text-center py-4" style="color: var(--surface-muted);">No services configured</p>
									{/if}
								</div>
							</div>

							<!-- Ingresses -->
							<div class="card rounded-2xl p-5">
								<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Ingresses</p>
									{#if deployment.project?.workspace?.slug && deployment.project?.slug}
										<button
											onclick={() => goto(`/${orgSlug}/workspaces/${deployment.project.workspace.slug}/projects/${deployment.project.slug}/ingresses/new?deployment=${deploymentId}`)}
											class="btn btn-secondary btn-sm"
										>
											<Plus class="h-4 w-4" />
											<span>Add</span>
										</button>
									{/if}
								</div>
								<div class="space-y-2">
									{#if deployment.ingresses?.length}
										{#each deployment.ingresses as ingress}
											<button
												onclick={() => goto(`/${orgSlug}/ingresses/${ingress.id}`)}
												class="flex w-full items-center justify-between gap-3 rounded-xl p-3 text-left transition hover:opacity-80"
												style="background-color: var(--control-bg); border: 1px solid var(--surface-border);"
											>
												<div class="flex-1 min-w-0">
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
												</div>
												<ExternalLink class="h-3.5 w-3.5 shrink-0" style="color: var(--surface-muted);" />
											</button>
										{/each}
									{:else}
										<p class="text-sm text-center py-4" style="color: var(--surface-muted);">No ingresses configured</p>
									{/if}
								</div>
							</div>
						</div>
					{:else if tab.id === 'history'}
						<div class="card rounded-2xl p-5">
							<p class="text-sm font-semibold mb-4" style="color: var(--center-channel-color);">Image History</p>
							{#if deployment.imageHistory?.length}
								<div class="space-y-2">
									{#each deployment.imageHistory as history}
										<div class="flex items-center justify-between gap-3 rounded-xl p-3" style="background-color: var(--control-bg); border: 1px solid var(--surface-border);">
											<div class="flex-1 min-w-0">
												<p class="truncate font-mono text-sm" style="color: var(--center-channel-color);">{history.image}</p>
												<div class="mt-1 flex flex-wrap items-center gap-2 text-xs" style="color: var(--surface-muted);">
													{#if history.branch}
														<span class="surface-pill rounded-full px-2 py-0 text-[10px]">{history.branch}</span>
													{/if}
													{#if history.commit}
														<code class="font-mono">{history.commit.slice(0, 7)}</code>
													{/if}
													<span>{new Date(history.createdAt).toLocaleString()}</span>
												</div>
											</div>
											{#if history.isActive}
												<span class="badge badge-success text-xs">Active</span>
											{:else}
												<button onclick={() => rollbackToImage(history.id)} class="btn btn-secondary btn-sm">Roll back</button>
											{/if}
										</div>
									{/each}
								</div>
							{:else}
								<p class="text-sm text-center py-4" style="color: var(--surface-muted);">No image history available</p>
							{/if}
						</div>
					{:else if tab.id === 'webhooks'}
						<div class="space-y-5">
							<!-- Tokens -->
							<div class="card rounded-2xl p-5">
								<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Webhook Tokens</p>
								</div>

								<div class="flex gap-2 mb-4">
									<input type="text" class="input text-sm flex-1" placeholder="Token label (e.g. github-actions)" bind:value={newWebhookLabel} />
									<button class="btn btn-primary btn-sm" onclick={createWebhookToken} disabled={creatingWebhookToken}>
										{#if creatingWebhookToken}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if}
										<span>Create</span>
									</button>
								</div>

								{#if newlyCreatedToken}
									<div class="webhook-success-card rounded-xl p-4 mb-4" transition:scale={{ duration: 200 }}>
										<p class="text-sm font-semibold">Copy now — won't be shown again.</p>
										<div class="mt-2 space-y-2">
											<div>
												<p class="webhook-success-muted text-xs font-medium mb-1">Token</p>
												<div class="flex items-center gap-2">
													<code class="flex-1 break-all rounded-lg px-2 py-1.5 font-mono text-xs">{newlyCreatedToken}</code>
													<button class="btn btn-ghost btn-sm" onclick={() => copyToClipboard(newlyCreatedToken!, 'token')}>
														{#if copiedWebhookToken}<Check class="h-3.5 w-3.5 text-[var(--success-muted)]" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
													</button>
												</div>
											</div>
											<div>
												<p class="webhook-success-muted text-xs font-medium mb-1">URL</p>
												<div class="flex items-center gap-2">
													<code class="flex-1 break-all rounded-lg px-2 py-1.5 font-mono text-xs">{getWebhookUrl(newlyCreatedToken)}</code>
													<button class="btn btn-ghost btn-sm" onclick={() => copyToClipboard(getWebhookUrl(newlyCreatedToken!), 'url')}>
														{#if copiedWebhookUrl}<Check class="h-3.5 w-3.5 text-[var(--success-muted)]" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
													</button>
												</div>
											</div>
										</div>
										<button class="btn btn-ghost btn-sm mt-2" onclick={() => (newlyCreatedToken = null)}>Dismiss</button>
									</div>
								{/if}

								<div class="space-y-2">
									{#if webhookTokensLoading}
										<div class="flex items-center justify-center py-6">
											<Loader2 class="h-5 w-5 animate-spin" style="color: var(--surface-muted);" />
										</div>
									{:else if webhookTokens.length === 0}
										<p class="text-sm text-center py-4" style="color: var(--surface-muted);">No tokens yet</p>
									{:else}
										{#each webhookTokens as token}
											<div class="flex items-center justify-between rounded-xl p-3" style="background-color: var(--control-bg); border: 1px solid var(--surface-border);">
												<div>
													<p class="text-sm font-medium" style="color: var(--center-channel-color);">{token.label || 'Unnamed token'}</p>
													<p class="text-xs" style="color: var(--surface-muted);">
														Created {new Date(token.createdAt).toLocaleDateString()}
														{#if token.lastUsedAt}&middot; Used {new Date(token.lastUsedAt).toLocaleDateString()}{:else}&middot; Never used{/if}
													</p>
												</div>
												<button class="btn btn-destructive btn-sm" onclick={() => deleteWebhookToken(token.id)} disabled={deletingWebhookTokenId === token.id}>
													{#if deletingWebhookTokenId === token.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
												</button>
											</div>
										{/each}
									{/if}
								</div>
							</div>

							<!-- Usage docs -->
							<div class="card rounded-2xl p-5">
								<p class="text-sm font-semibold mb-3" style="color: var(--center-channel-color);">Usage</p>
								<div class="space-y-3 text-sm">
									<div>
										<p class="text-xs font-medium mb-1" style="color: var(--surface-muted);">Restart</p>
										<pre class="webhook-code-block overflow-x-auto rounded-lg p-2.5 text-xs font-mono"><code>{webhookExamples.restart}</code></pre>
									</div>
									<div>
										<p class="text-xs font-medium mb-1" style="color: var(--surface-muted);">Update image tag</p>
										<pre class="webhook-code-block overflow-x-auto rounded-lg p-2.5 text-xs font-mono"><code>{webhookExamples.updateTag}</code></pre>
									</div>
									<div>
										<p class="text-xs font-medium mb-1" style="color: var(--surface-muted);">Update full image</p>
										<pre class="webhook-code-block overflow-x-auto rounded-lg p-2.5 text-xs font-mono"><code>{webhookExamples.updateImage}</code></pre>
									</div>
								</div>

								<div class="webhook-info-card mt-4 rounded-xl p-4">
									<p class="text-xs font-semibold uppercase tracking-wide mb-2">GitHub Actions Example</p>
									<pre class="webhook-code-block overflow-x-auto rounded-lg p-2.5 text-xs font-mono"><code>{webhookExamples.githubActions}</code></pre>
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
									<p class="text-xs mb-4" style="color: var(--surface-muted);">Configure how Kubernetes monitors your container health.</p>

									<!-- Master toggle -->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="adv-toggle-row"
										onclick={() => { healthCheckEnabled = !healthCheckEnabled; isEditingHealthCheck = true; }}
									>
										<div class="adv-toggle-info">
											<span class="adv-toggle-label">Enable health checks</span>
											<span class="adv-toggle-desc">
												{#if healthCheckEnabled}
													Kubernetes will monitor container health using the configured probes
												{:else}
													Containers will not be health-checked — Kubernetes won't restart unhealthy pods
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

									<!-- Check type + endpoint -->
									<div class="p-5 space-y-5">
										<div>
											<p class="text-xs font-medium mb-2" style="color: var(--surface-muted);">Check type</p>
											<div class="flex gap-1.5">
												{#each [{ val: 'http', label: 'HTTP', desc: 'GET request to a path' }, { val: 'tcp', label: 'TCP', desc: 'TCP socket connection' }, { val: 'exec', label: 'Command', desc: 'Run a command in container' }] as opt}
													<button onclick={() => { healthCheckType = opt.val; isEditingHealthCheck = true; }}
														class="adv-type-btn"
														class:adv-type-btn--active={healthCheckType === opt.val}
													>
														<span class="adv-type-btn-label">{opt.label}</span>
														<span class="adv-type-btn-desc">{opt.desc}</span>
													</button>
												{/each}
											</div>
										</div>

										<!-- Endpoint config based on type -->
										<div class="adv-field-group">
											{#if healthCheckType === 'http'}
												<div class="flex-[3] min-w-[140px]">
													<p class="text-xs font-medium mb-1.5" style="color: var(--surface-muted);">Endpoint path</p>
													<input type="text" bind:value={healthCheckPath} placeholder="/health" class="input text-sm font-mono" />
												</div>
												<div class="w-24">
													<p class="text-xs font-medium mb-1.5" style="color: var(--surface-muted);">Port</p>
													<input type="number" bind:value={healthCheckPort} placeholder="80" class="input text-sm font-mono" />
												</div>
											{:else if healthCheckType === 'tcp'}
												<div class="w-28">
													<p class="text-xs font-medium mb-1.5" style="color: var(--surface-muted);">Port</p>
													<input type="number" bind:value={healthCheckPort} placeholder="80" class="input text-sm font-mono" />
												</div>
											{:else}
												<div class="flex-1 min-w-[200px]">
													<p class="text-xs font-medium mb-1.5" style="color: var(--surface-muted);">Command</p>
													<input type="text" bind:value={healthCheckCommand} placeholder="cat /tmp/healthy" class="input text-sm font-mono" />
												</div>
											{/if}
										</div>

										<!-- Probes -->
										<div>
											<p class="text-xs font-medium mb-2" style="color: var(--surface-muted);">Active probes</p>
											<div class="flex flex-wrap gap-2">
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="adv-probe-chip"
													class:adv-probe-chip--active={livenessEnabled}
													onclick={() => { livenessEnabled = !livenessEnabled; isEditingHealthCheck = true; }}
												>
													<span class="adv-probe-dot" class:adv-probe-dot--on={livenessEnabled}></span>
													<span>Liveness</span>
													<span class="adv-probe-hint">Restarts unhealthy</span>
												</div>
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="adv-probe-chip"
													class:adv-probe-chip--active={readinessEnabled}
													onclick={() => { readinessEnabled = !readinessEnabled; isEditingHealthCheck = true; }}
												>
													<span class="adv-probe-dot" class:adv-probe-dot--on={readinessEnabled}></span>
													<span>Readiness</span>
													<span class="adv-probe-hint">Stops traffic if failing</span>
												</div>
												<!-- svelte-ignore a11y_click_events_have_key_events -->
												<!-- svelte-ignore a11y_no_static_element_interactions -->
												<div
													class="adv-probe-chip"
													class:adv-probe-chip--active={startupEnabled}
													onclick={() => { startupEnabled = !startupEnabled; isEditingHealthCheck = true; }}
												>
													<span class="adv-probe-dot" class:adv-probe-dot--on={startupEnabled}></span>
													<span>Startup</span>
													<span class="adv-probe-hint">Slow-start grace period</span>
												</div>
											</div>
										</div>

										<!-- Timing -->
										<div>
											<p class="text-xs font-medium mb-2" style="color: var(--surface-muted);">Timing</p>
											<div class="adv-field-group">
												<div class="adv-timing-field">
													<p class="adv-timing-label">Interval</p>
													<div class="adv-timing-input-row">
														<input type="number" bind:value={healthCheckInterval} min="1" class="input text-sm font-mono" />
														<span class="adv-timing-unit">sec</span>
													</div>
												</div>
												<div class="adv-timing-field">
													<p class="adv-timing-label">Timeout</p>
													<div class="adv-timing-input-row">
														<input type="number" bind:value={healthCheckTimeout} min="1" class="input text-sm font-mono" />
														<span class="adv-timing-unit">sec</span>
													</div>
												</div>
												<div class="adv-timing-field">
													<p class="adv-timing-label">Retries</p>
													<input type="number" bind:value={healthCheckRetries} min="1" class="input text-sm font-mono" />
												</div>
												{#if startupEnabled}
													<div class="adv-timing-field">
														<p class="adv-timing-label">Startup retries</p>
														<input type="number" bind:value={startupFailureThreshold} min="1" class="input text-sm font-mono" />
													</div>
												{/if}
											</div>
										</div>
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

<style>
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

	.dep-header-top {
		display: flex;
		align-items: flex-start;
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

	.dep-header-name {
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}

	.dep-header-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	.dep-delete-btn {
		color: var(--surface-muted) !important;
		opacity: 0.6;
		transition: opacity 0.15s;
	}
	.dep-delete-btn:hover {
		opacity: 1;
		color: var(--error-text-color) !important;
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
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.5rem;
		font-size: 0.75rem;
	}

	.dep-meta-source {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--surface-muted);
		text-decoration: none;
		transition: color 0.12s;
	}
	a.dep-meta-source:hover {
		color: var(--link-color);
	}

	.dep-meta-pill {
		display: inline-flex;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
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
		font-size: 0.75rem;
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
		border-radius: 0.875rem;
		overflow: hidden;
		border: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
		background-color: #0d1117;
		color: #c9d1d9;
		display: flex;
		flex-direction: column;
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
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		background: rgba(255, 255, 255, 0.02);
		flex-wrap: wrap;
	}

	.console-toolbar-left {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
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
	}

	.console-output {
		min-height: 440px;
		max-height: 440px;
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

	/* Health check type selector */
	.adv-type-btn {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: var(--control-bg);
		color: var(--control-text);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.12s, background-color 0.12s;
	}
	.adv-type-btn:hover {
		background: var(--control-hover-bg);
	}
	.adv-type-btn--active {
		border-color: var(--sidebar-text-active-border);
		background: var(--sidebar-text-active-bg);
		color: var(--sidebar-text-active-color);
	}
	.adv-type-btn--active:hover {
		background: var(--sidebar-text-active-bg);
	}
	.adv-type-btn-label {
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.adv-type-btn-desc {
		font-size: 0.6875rem;
		opacity: 0.7;
	}

	/* Field group — inline flex for config fields */
	.adv-field-group {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-end;
	}

	/* Probe chips — clickable toggle chips with status dot */
	.adv-probe-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background: var(--control-bg);
		color: var(--surface-muted);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: border-color 0.12s, background-color 0.12s, color 0.12s;
		user-select: none;
	}
	.adv-probe-chip:hover {
		border-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-color));
	}
	.adv-probe-chip--active {
		border-color: color-mix(in srgb, #22c55e 40%, var(--surface-border));
		background: color-mix(in srgb, #22c55e 6%, var(--surface-bg));
		color: var(--center-channel-color);
	}

	.adv-probe-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background-color: var(--surface-border);
		transition: background-color 0.12s;
		flex-shrink: 0;
	}
	.adv-probe-dot--on {
		background-color: #22c55e;
		box-shadow: 0 0 4px #22c55e44;
	}

	.adv-probe-hint {
		font-size: 0.6875rem;
		opacity: 0.6;
		margin-left: 0.125rem;
	}

	/* Timing fields */
	.adv-timing-field {
		width: 5.5rem;
	}
	.adv-timing-label {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--surface-muted);
		margin-bottom: 0.25rem;
	}
	.adv-timing-input-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.adv-timing-unit {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		flex-shrink: 0;
	}
</style>
