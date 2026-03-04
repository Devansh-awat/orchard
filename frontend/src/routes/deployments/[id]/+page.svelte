<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { Tabs } from 'melt/builders';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
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
		Pencil,
		Eye,
		EyeOff,
		Lock,
		Webhook
	} from 'lucide-svelte';
	import { scale, fade } from 'svelte/transition';
	import { Clock, Minimize2, Maximize2 } from 'lucide-svelte';
	import DeploymentProgress from '$lib/components/DeploymentProgress.svelte';

	interface Pod {
		name: string;
		status: string;
		ip?: string;
		startTime?: string;
		containers?: Array<{ name: string; image: string; ready: boolean }>;
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
		buildLogs?: string;
		buildError?: string;
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
			description: 'Runtime status & pods',
			icon: Server
		},
		{
			id: 'logs',
			label: 'Logs',
			description: 'Streaming & build output',
			icon: Terminal
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

	// Computed properties for template compatibility with API field names
	const repoUrl = $derived(deployment?.githubRepo);
	const branch = $derived(deployment?.githubBranch);

	let restarting = $state(false);
	let scaling = $state(false);
	let deleting = $state(false);
	let rebuilding = $state(false);
	let savingEnv = $state(false);
	let savingVolumes = $state(false);
	let savingAdvanced = $state(false);
	let savingService = $state(false);
	let buildFromRoot = $state(false);

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

	let deletingIngress = $state<string | null>(null);
	let editingIngress = $state<string | null>(null);
	let editingIngressForm = $state<{
		host: string;
		path: string;
		serviceId: string;
		servicePort: number;
		tlsEnabled: boolean;
		basicAuthEnabled: boolean;
		basicAuthUsername: string;
		basicAuthPassword: string;
		basicAuthShowPassword: boolean;
	} | null>(null);
	let savingIngress = $state(false);

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

		buildElapsedInterval = setInterval(() => {
			buildElapsed = Math.floor((Date.now() - buildStartTime) / 1000);
		}, 1000);

		buildPollInterval = setInterval(async () => {
			try {
				const response = await apiFetch(`/apiv1/deployments/${deploymentId}`);
				if (!response.ok) return;
				const data = await response.json();

				buildModalStatus = data.status;
				buildModalStep = data.buildStep ?? null;
				buildModalError = data.buildError ?? null;
				buildModalWarnings = data.warnings ?? [];
				if (data.buildLogs) {
					accumulatedBuildLogs = data.buildLogs;
				}

				if (data.status === 'running') {
					stopBuildPolling();
					// Brief delay to show completion state
					setTimeout(() => {
						showBuildModal = false;
						showBuildCard = false;
						fetchDeployment();
					}, 1500);
				} else if (data.status === 'failed') {
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
			if (data.status === 'building' && data.githubRepo && !showBuildModal && !showBuildCard) {
				showBuildModal = true;
				showBuildCard = false;
				stopBuildPolling();
				startBuildPolling();
			}

			deployment = data;

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
		if (!confirm(`Delete ${deployment.name}? This cannot be undone.`)) return;

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
				goto(`/workspaces/${deployment.project.workspace.slug}/projects/${deployment.project.slug}`);
			} else {
				goto('/');
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

	function startEditIngress(ingress: Ingress) {
		const service = deployment?.services?.find((s) => s.id === ingress.service?.id);
		const hasBasicAuth = ingress.annotations?.['traefik.ingress.kubernetes.io/router.middlewares']?.includes('auth@kubernetescrd');
		editingIngress = ingress.id;
		editingIngressForm = {
			host: ingress.host,
			path: ingress.path,
			serviceId: service?.id || '',
			servicePort: service?.port || 80,
			tlsEnabled: ingress.tlsEnabled ?? true,
			basicAuthEnabled: hasBasicAuth ?? false,
			basicAuthUsername: '',
			basicAuthPassword: '',
			basicAuthShowPassword: false,
		};
	}

	function cancelEditIngress() {
		editingIngress = null;
		editingIngressForm = null;
	}

	async function saveIngress(ingressId: string) {
		if (!editingIngressForm) return;

		if (!editingIngressForm.host.trim()) {
			toasts.add({ title: 'Host is required', color: 'error' });
			return;
		}

		if (editingIngressForm.basicAuthEnabled) {
			if (!editingIngressForm.basicAuthUsername.trim()) {
				toasts.add({ title: 'Basic auth username is required', color: 'error' });
				return;
			}
			if (!editingIngressForm.basicAuthPassword.trim()) {
				toasts.add({ title: 'Basic auth password is required', color: 'error' });
				return;
			}
		}

		savingIngress = true;
		try {
			const service = deployment?.services?.find((s) => s.id === editingIngressForm.serviceId);
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/ingresses/${ingressId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					host: editingIngressForm.host.trim(),
					path: editingIngressForm.path || '/',
					serviceName: service?.name,
					servicePort: editingIngressForm.servicePort,
					tlsEnabled: editingIngressForm.tlsEnabled,
					basicAuth: editingIngressForm.basicAuthEnabled ? {
						enabled: true,
						username: editingIngressForm.basicAuthUsername,
						password: editingIngressForm.basicAuthPassword
					} : { enabled: false }
				})
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update ingress');
			}
			toasts.add({
				title: 'Ingress updated',
				color: 'success'
			});
			editingIngress = null;
			editingIngressForm = null;
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update ingress',
				color: 'error'
			});
		} finally {
			savingIngress = false;
		}
	}

	async function deleteIngress(ingressId: string) {
		deletingIngress = ingressId;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/ingresses/${ingressId}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				throw new Error('Failed to delete ingress');
			}
			toasts.add({
				title: 'Ingress deleted',
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete ingress',
				color: 'error'
			});
		} finally {
			deletingIngress = null;
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
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/rollback`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageHistoryId: historyId })
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
				body: JSON.stringify({ buildFromRoot })
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
				return 'badge-warning';
			case 'warning':
				return 'badge-warning';
			case 'stopped':
				return 'badge-error';
			case 'pending':
			case 'building':
				return 'badge-warning';
			case 'failed':
			case 'error':
				return 'badge-error';
			default:
				return 'badge-neutral';
		}
	}

	$effect(() => {
		if (selectedPod && selectedContainer) {
			fetchLogs();
		}
	});

	$effect(() => {
		if (deployment?.status === 'building') {
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
		return () => {
			document.removeEventListener('click', handleClickOutside);
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
			onclick={() => goto(`/workspaces/${deployment.project.workspace.slug}/projects/${deployment.project.slug}`)}
			class="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer"
		>
			<ArrowLeft class="h-4 w-4" />
			<span>Back to project</span>
		</button>
	{:else}
		<button
			onclick={() => goto('/')}
			class="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer"
		>
			<ArrowLeft class="h-4 w-4" />
			<span>Back to home</span>
		</button>
	{/if}

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<div class="flex justify-center py-12">
			<div class="text-center">
				<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
				<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading deployment...</p>
			</div>
		</div>
	{:else if deployment}
		<div class="space-y-8">
			<section class="card rounded-3xl p-6 shadow-sm">
				<div class="flex flex-wrap items-start justify-between gap-6">
					<div>
						<p class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Deployment</p>
						<div class="mt-2 flex items-center gap-3">
							<h1 class="text-3xl font-bold text-gray-900 dark:text-gray-50">{deployment.name}</h1>
							<span class="badge {getStatusColor(deployment.status)}">{deployment.status}</span>
						</div>
							<div class="mt-4 flex flex-wrap items-center gap-4 text-sm" style="color: var(--surface-muted);">
								{#if deployment.namespace}
									<span class="surface-pill font-mono text-xs">
										{deployment.namespace}
									</span>
								{/if}
							{#if deployment.githubRepo}
								<span class="truncate font-mono text-xs" style="color: var(--center-channel-color);">
									{deployment.githubRepo}
								</span>
								{#if deployment.buildType}
									<span class="rounded-full px-2 py-0.5 text-xs font-medium {deployment.buildType === 'railpack' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'}">
										{deployment.buildType === 'railpack' ? 'Railpack' : 'Dockerfile'}
									</span>
								{/if}
							{:else if deployment.image}
								<span class="truncate font-mono text-xs" style="color: var(--center-channel-color);">
									{deployment.image}
								</span>
							{/if}
							{#if branch}
								<span class="rounded-full px-3 py-1 text-xs font-medium" style="background-color: var(--sidebar-text-active-bg); color: var(--sidebar-text-active-color);">
									{branch}
								</span>
							{/if}
						</div>
					</div>
					<div class="flex flex-wrap justify-end gap-2">
						{#if repoUrl}
							<button onclick={rebuild} disabled={rebuilding} class="btn btn-secondary">
								{#if rebuilding}
									<Loader2 class="h-4 w-4 animate-spin" />
								{:else}
									<RefreshCw class="h-4 w-4" />
								{/if}
								<span>Rebuild</span>
							</button>
						{/if}
						<button onclick={restart} disabled={restarting} class="btn btn-secondary">
							{#if restarting}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Play class="h-4 w-4" />
							{/if}
							<span>Restart</span>
						</button>
						<button onclick={deleteDeployment} disabled={deleting} class="btn btn-danger">
							{#if deleting}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<Trash2 class="h-4 w-4" />
							{/if}
							<span>Delete</span>
						</button>
					</div>
				</div>
			</section>

			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<div class="card rounded-2xl p-4">
					<p class="text-xs uppercase tracking-wide text-gray-500">Desired replicas</p>
					<p class="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">
						{deployment.replicas ?? 0}
					</p>
				</div>
				<div class="card rounded-2xl p-4">
					<p class="text-xs uppercase tracking-wide text-gray-500">Available replicas</p>
					<p class="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">
						{deployment.availableReplicas ?? 0}
					</p>
				</div>
				<div class="card rounded-2xl p-4">
					<p class="text-xs uppercase tracking-wide text-gray-500">Pods</p>
					<p class="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">
						{deployment.pods?.length ?? 0}
					</p>
				</div>
				<div class="card rounded-2xl p-4">
					<p class="text-xs uppercase tracking-wide text-gray-500">Services</p>
					<p class="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">
						{deployment.services?.length ?? 0}
					</p>
				</div>
			</div>

			<section class="card rounded-3xl p-2 shadow-sm" {...tabs.triggerList}>
				<div class="grid gap-2 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
				{#each visibleTabs as tab}
					{@const Icon = tab.icon}
					<button class="tabs-trigger flex items-start gap-3 rounded-2xl px-4 py-3 text-left transition" {...tabs.getTrigger(tab.id)}>
						<Icon class="mt-1 h-4 w-4 text-gray-400" />
							<div>
								<p class="text-sm font-semibold text-gray-900 dark:text-gray-50">{tab.label}</p>
								<p class="text-xs text-gray-500">{tab.description}</p>
							</div>
						</button>
					{/each}
				</div>
			</section>

{#each visibleTabs as tab}
	<section {...tabs.getContent(tab.id)} hidden={undefined} class="tab-panel mt-2">
					{#if tab.id === 'overview'}
						<div class="space-y-6">
							{#if deployment.status === 'failed' && (deployment.buildError || deployment.buildLogs)}
								<div class="rounded-2xl border border-red-200 bg-red-50/80 p-4 dark:border-red-400/30 dark:bg-red-500/10">
									<p class="text-sm font-semibold text-red-900 dark:text-red-100">Last build logs</p>
									{#if deployment.buildError}
										<p class="mt-2 text-sm font-medium text-red-800 dark:text-red-200">Error</p>
										<pre class="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-red-900/10 p-3 text-xs font-mono text-red-900 dark:text-red-100">{sanitizeLogs(deployment.buildError)}</pre>
									{/if}
									{#if deployment.buildLogs}
										<pre class="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/10 p-3 text-xs font-mono text-gray-900 dark:text-gray-100">{sanitizeLogs(deployment.buildLogs)}</pre>
									{/if}
								</div>
							{/if}
							<div class="grid gap-6 lg:grid-cols-3">
								<div class="card rounded-2xl p-6 lg:col-span-2" style="background-color: var(--center-channel-bg);">
									<div class="mb-6">
										<div class="flex items-center justify-between mb-4">
											<label class="text-sm font-medium" style="color: var(--center-channel-color);">
												Desired replicas
											</label>
											<span class="text-2xl font-bold font-mono" style="color: var(--center-channel-color);">
												{scaleReplicas}
											</span>
										</div>
										<div class="slider-container" style="padding: 12px 0;">
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
										<div class="flex items-center justify-between mt-2 text-xs" style="color: var(--surface-muted);">
											<span>0</span>
											<span>20</span>
										</div>
									</div>

									<div class="flex items-center justify-end gap-3 pt-4 border-t" style="border-color: var(--divider-color);">
										<button
											onclick={scaleDeployment}
											disabled={scaling || scaleReplicas === deployment.replicas}
											class="btn btn-primary"
										>
											{#if scaling}
												<Loader2 class="h-4 w-4 animate-spin" />
											{/if}
											Apply changes
										</button>
									</div>
								</div>
								<div class="card rounded-2xl p-6">
									<dl class="space-y-4 text-sm">
										<div>
											<dt class="text-xs uppercase tracking-wide text-gray-500">Namespace</dt>
											<dd class="font-mono text-gray-900 dark:text-gray-100">
												{deployment.namespace ?? 'Not assigned'}
											</dd>
										</div>
										{#if deployment.project}
											<div>
												<dt class="text-xs uppercase tracking-wide text-gray-500">Project</dt>
												<dd class="text-gray-900 dark:text-gray-100">{deployment.project.name}</dd>
											</div>
										{/if}
										{#if repoUrl}
											<div>
												<dt class="text-xs uppercase tracking-wide text-gray-500">Repository</dt>
												<dd class="flex items-center gap-2 text-sm text-primary-600 dark:text-primary-300">
													<a href={repoUrl} target="_blank" class="inline-flex items-center gap-1 hover:underline">
														<span>Open</span>
														<ExternalLink class="h-3.5 w-3.5" />
													</a>
												</dd>
											</div>
										{/if}
										{#if deployment.githubRepo}
											<div>
												<dt class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Repository</dt>
												<dd class="truncate font-mono text-xs" style="color: var(--center-channel-color);">
													{deployment.githubRepo}
												</dd>
											</div>
											{#if branch}
												<div>
													<dt class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Branch</dt>
													<dd class="truncate font-mono text-xs" style="color: var(--center-channel-color);">
														{branch}
													</dd>
												</div>
											{/if}
										{:else if deployment.image}
											<div>
												<dt class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Image</dt>
												<dd class="truncate font-mono text-xs" style="color: var(--center-channel-color);">
													{deployment.image}
												</dd>
											</div>
										{/if}
									</dl>
								</div>
							</div>

							{#if deployment.warnings?.length}
							<div class="warning-box rounded-2xl border p-6 shadow-sm">
								<div class="flex items-start gap-3">
									<div class="warning-icon-box flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
										<svg class="h-5 w-5" style="color: var(--warning-text)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
										</svg>
									</div>
									<div class="flex-1 min-w-0">
										<p class="text-sm font-semibold" style="color: var(--warning-text)">Pod Warnings</p>
										<p class="text-xs mb-3" style="color: var(--warning-text); opacity: 0.8">Issues detected with running containers</p>
										<div class="space-y-2">
											{#each deployment.warnings as warning}
												<div class="warning-item rounded-lg p-3 shadow-sm">
													<div class="flex items-start gap-2">
														<div class="flex-1 min-w-0">
															<p class="font-mono text-xs font-medium" style="color: var(--warning-text)">{warning.podName}</p>
															<p class="mt-1 text-xs" style="color: var(--warning-text); opacity: 0.85">{warning.message}</p>
														</div>
														{#if warning.timestamp}
															<span class="shrink-0 text-xs" style="color: var(--warning-text); opacity: 0.7">
																{new Date(warning.timestamp).toLocaleTimeString()}
															</span>
														{/if}
													</div>
												</div>
											{/each}
										</div>
									</div>
								</div>
							</div>
							{/if}

							<div class="card rounded-2xl p-6">
								<div class="flex flex-wrap items-center justify-between gap-4">
									<div>
										<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Pods</p>
										<p class="text-sm text-gray-500">Live Kubernetes workloads</p>
									</div>
									<div class="flex gap-4 text-xs text-gray-500">
										<span>Ready {deployment.pods?.filter((pod) => pod.status?.toLowerCase() === 'ready').length ?? 0}</span>
										<span>|</span>
										<span>Scheduled {deployment.pods?.filter((pod) => pod.status?.toLowerCase() === 'scheduled').length ?? 0}</span>
										<span>|</span>
										<span>Pending {deployment.pods?.filter((pod) => pod.status?.toLowerCase() === 'pending').length ?? 0}</span>
									</div>
								</div>
								{#if deployment.pods?.length}
									<div class="mt-4 divide-y divide-gray-200 dark:divide-gray-800">
										{#each deployment.pods as pod}
											<div class="flex flex-wrap items-center justify-between gap-4 py-4">
												<div class="flex items-center gap-3">
													<Container class="surface-icon h-10 w-10 rounded-xl p-2" />
													<div>
														<p class="font-mono text-sm text-gray-900 dark:text-gray-50">{pod.name}</p>
														{#if pod.ip}
															<p class="text-xs text-gray-500">{pod.ip}</p>
														{/if}
													</div>
												</div>
												<div class="flex items-center gap-3">
													<span class="badge {getStatusColor(pod.status)}">{pod.status}</span>
													<a href="/pods/{pod.name}?namespace={deployment.namespace}" class="btn btn-ghost btn-sm" aria-label="Open pod details">
														<ExternalLink class="h-4 w-4" />
													</a>
												</div>
											</div>
										{/each}
									</div>
								{:else}
											<p class="surface-muted-panel mt-4 rounded-xl py-6 text-center text-sm">No pods are reporting yet.</p>
								{/if}
							</div>
						</div>
					{:else if tab.id === 'logs'}
						<div class="space-y-6">
							<div class="card rounded-2xl p-6">
							<div class="grid gap-4 md:grid-cols-4">
								<div>
									<label class="text-xs font-semibold uppercase tracking-wide text-gray-500">Pod</label>
									<div class="relative mt-2 custom-dropdown-container">
										<button
											type="button"
											onclick={() => (podDropdownOpen = !podDropdownOpen)}
											class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
											style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
										>
											<span>{selectedPod || 'Select pod'}</span>
											<ChevronDown class="h-4 w-4 shrink-0" />
										</button>
										{#if podDropdownOpen}
											<div
												class="absolute z-20 mt-1 w-full rounded-xl border p-2 shadow"
												style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
												transition:scale={{ duration: 150, start: 0.96 }}
											>
												<button
													type="button"
													onclick={() => {
														selectedPod = '';
														podDropdownOpen = false;
													}}
													class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
												>
													<span>Select pod</span>
													{#if !selectedPod}
														<Check class="h-4 w-4 text-primary-600" />
													{/if}
												</button>
												{#each deployment.pods ?? [] as pod}
													<button
														type="button"
														onclick={() => {
															selectedPod = pod.name;
															podDropdownOpen = false;
														}}
														class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
													>
														<span>{pod.name}</span>
														{#if selectedPod === pod.name}
															<Check class="h-4 w-4 text-primary-600" />
														{/if}
													</button>
												{/each}
											</div>
										{/if}
									</div>
								</div>
								<div>
									<label class="text-xs font-semibold uppercase tracking-wide text-gray-500">Container</label>
									<div class="relative mt-2 custom-dropdown-container">
										<button
											type="button"
											onclick={() => (containerDropdownOpen = !containerDropdownOpen)}
											class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
											style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
										>
											<span>{selectedContainer || 'Select container'}</span>
											<ChevronDown class="h-4 w-4 shrink-0" />
										</button>
										{#if containerDropdownOpen}
											<div
												class="absolute z-20 mt-1 w-full rounded-xl border p-2 shadow"
												style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
												transition:scale={{ duration: 150, start: 0.96 }}
											>
												<button
													type="button"
													onclick={() => {
														selectedContainer = '';
														containerDropdownOpen = false;
													}}
													class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
												>
													<span>Select container</span>
													{#if !selectedContainer}
														<Check class="h-4 w-4 text-primary-600" />
													{/if}
												</button>
												{#each deployment.pods?.find((p) => p.name === selectedPod)?.containers ?? [] as container}
													<button
														type="button"
														onclick={() => {
															selectedContainer = container.name;
															containerDropdownOpen = false;
														}}
														class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
													>
														<span>{container.name}</span>
														{#if selectedContainer === container.name}
															<Check class="h-4 w-4 text-primary-600" />
														{/if}
													</button>
												{/each}
											</div>
										{/if}
									</div>
								</div>
									<div>
										<label class="text-xs font-semibold uppercase tracking-wide text-gray-500">Tail lines</label>
										<input type="number" bind:value={tailLines} min="10" step="10" class="input mt-2 w-full" />
									</div>
									<div class="flex items-end justify-end">
										<button onclick={fetchLogs} disabled={logsLoading} class="btn btn-secondary w-full">
											{#if logsLoading}
												<Loader2 class="h-4 w-4 animate-spin" />
											{:else}
												<RefreshCw class="h-4 w-4" />
											{/if}
											<span>Refresh logs</span>
										</button>
									</div>
								</div>
							</div>

							<div class="log-panel rounded-2xl p-4 text-green-200 shadow-inner">
								{#if logsLoading && !logs}
									<div class="flex items-center justify-center gap-2 text-sm">
										<Loader2 class="h-4 w-4 animate-spin" />
										<span>Loading logs...</span>
									</div>
								{:else if logs}
									<pre class="max-h-[500px] overflow-y-auto whitespace-pre-wrap text-xs">{logs}</pre>
								{:else}
									<p class="text-center text-sm text-gray-400">Select a pod and container to start streaming logs.</p>
								{/if}
							</div>

													</div>
					{:else if tab.id === 'environment'}
						<div class="card rounded-2xl p-6">
							<div class="flex flex-wrap items-center justify-between gap-4">
								<div>
									<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Environment variables</p>
									<p class="text-sm text-gray-500">Variables will restart pods on save</p>
								</div>
								<button onclick={addEnvRow} class="btn btn-secondary btn-sm">
									<Plus class="h-4 w-4" />
									<span>Add variable</span>
								</button>
							</div>
							<div class="mt-6 space-y-4 max-w-2xl">
								<details class="group">
									<summary class="cursor-pointer text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 mb-2">
										Paste from file (key=value format)
									</summary>
									<div class="mt-2 space-y-2 mb-4">
										<textarea
											bind:value={envPasteText}
											placeholder="KEY1=value1&#10;KEY2=value2&#10;# Comments are ignored"
											class="input font-mono text-sm min-h-[100px]"
										></textarea>
										<div class="flex items-center justify-between">
											<p class="text-xs text-gray-500 dark:text-gray-400">Paste your .env file content here. Each line should be in KEY=value format.</p>
											<button onclick={parseEnvVars} disabled={!envPasteText.trim()} class="btn btn-secondary btn-sm">
												Parse
											</button>
										</div>
									</div>
								</details>
								{#each envVars as env, index}
									{@const isRevealed = revealedIndices.has(index)}
									<div class="grid gap-3 md:grid-cols-[250px_1fr_auto]">
										<input type="text" bind:value={env.key} placeholder="KEY" class="input font-mono" onfocus={() => isEditingEnv = true} />
										<div class="flex gap-2">
											<input
												type={isRevealed ? 'text' : 'password'}
												bind:value={env.value}
												placeholder="value"
												class="input font-mono flex-1"
												onfocus={() => isEditingEnv = true}
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
										<button onclick={() => removeEnvRow(index)} class="btn btn-ghost" aria-label="Remove row">
											<X class="h-4 w-4" />
										</button>
									</div>
								{/each}
							</div>
							<div class="mt-6 flex flex-wrap justify-end gap-3">
								<button onclick={saveEnv} disabled={savingEnv} class="btn btn-primary">
									{#if savingEnv}
										<Loader2 class="h-4 w-4 animate-spin" />
									{/if}
									<span>Save changes</span>
								</button>
							</div>
						</div>
					{:else if tab.id === 'volumes'}
						<div class="card rounded-2xl p-6">
							<div class="flex flex-wrap items-center justify-between gap-4">
								<div>
									<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Volumes</p>
									<p class="text-sm text-gray-500">Volumes will restart pods on save</p>
								</div>
								<button onclick={addVolume} class="btn btn-secondary btn-sm">
									<Plus class="h-4 w-4" />
									<span>Add volume</span>
								</button>
							</div>
							<div class="mt-6 space-y-4">
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
												<div class="relative custom-dropdown-container">
													<button
														type="button"
														onclick={() => (volumeTypeDropdownOpen = volumeTypeDropdownOpen === index ? null : index)}
														class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
														style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
													>
														<span>
															{volume.type === 'pvc' ? 'Persistent Volume Claim (PVC)' : volume.type === 'hostPath' ? 'Host Path' : 'Empty Directory'}
														</span>
														<ChevronDown class="h-4 w-4 shrink-0" />
													</button>
													{#if volumeTypeDropdownOpen === index}
														<div
															class="absolute z-20 mt-1 w-full rounded-xl border p-2 shadow"
															style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
															transition:scale={{ duration: 150, start: 0.96 }}
														>
															<button
																type="button"
																onclick={() => {
																	volume.type = 'pvc';
																	volumeTypeDropdownOpen = null;
																}}
																class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
															>
																<span>Persistent Volume Claim (PVC)</span>
																{#if volume.type === 'pvc'}
																	<Check class="h-4 w-4 text-primary-600" />
																{/if}
															</button>
															<button
																type="button"
																onclick={() => {
																	volume.type = 'hostPath';
																	volumeTypeDropdownOpen = null;
																}}
																class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
															>
																<span>Host Path</span>
																{#if volume.type === 'hostPath'}
																	<Check class="h-4 w-4 text-primary-600" />
																{/if}
															</button>
															<button
																type="button"
																onclick={() => {
																	volume.type = 'emptyDir';
																	volumeTypeDropdownOpen = null;
																}}
																class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
															>
																<span>Empty Directory</span>
																{#if volume.type === 'emptyDir'}
																	<Check class="h-4 w-4 text-primary-600" />
																{/if}
															</button>
														</div>
													{/if}
												</div>
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
							<div class="mt-6 flex flex-wrap justify-end gap-3">
								<button onclick={saveVolumes} disabled={savingVolumes} class="btn btn-primary">
									{#if savingVolumes}
										<Loader2 class="h-4 w-4 animate-spin" />
									{/if}
									<span>Save changes</span>
								</button>
							</div>
						</div>
					{:else if tab.id === 'network'}
						<div class="grid gap-6 lg:grid-cols-2">
							<div class="card rounded-2xl p-6">
								<div class="flex items-center justify-between">
									<div>
										<p class="text-lg font-semibold" style="color: var(--center-channel-color);">Services</p>
										<p class="text-sm" style="color: var(--surface-muted);">Manage how traffic enters the deployment</p>
									</div>
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
											<span>Add service</span>
										{/if}
									</button>
								</div>

								{#if showServiceForm}
									<div class="surface-form mt-4 rounded-2xl border border-dashed p-4">
										<div class="grid gap-4 md:grid-cols-2">
											<div>
												<label class="mb-2 block text-sm font-medium">Service name</label>
												<input
													type="text"
													class="input"
													placeholder="api-service"
													value={newServiceForm.name}
													oninput={(event) =>
														(newServiceForm = {
															...newServiceForm,
															name: (event.currentTarget as HTMLInputElement).value
														})}
												/>
												<p class="mt-1 text-xs" style="color: var(--surface-muted);">Lowercase letters, numbers, and dashes only.</p>
											</div>
											<label class="surface-checkbox flex items-center gap-3 rounded-2xl px-3 py-2 text-sm">
												<input
													type="checkbox"
													checked={newServiceForm.exposePublic}
													onchange={(event) =>
														(newServiceForm = {
															...newServiceForm,
															exposePublic: (event.currentTarget as HTMLInputElement).checked
														})}
												/>
												<span>
													<span class="font-medium" style="color: var(--center-channel-color);">Expose publicly</span>
													<span class="mt-0.5 block text-xs" style="color: var(--surface-muted);">
														Uses a NodePort so the service is reachable outside the cluster.
													</span>
												</span>
											</label>
										</div>

										<div class="mt-4 space-y-3">
											{#each newServiceForm.ports as port, index}
												<div class="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
													<div>
														<label class="text-xs opacity-70 mb-1 block">Name</label>
														<input
															type="text"
															class="input"
															placeholder="http"
															value={port.name}
															oninput={(event) =>
																updateNewServicePort(index, {
																	name: (event.currentTarget as HTMLInputElement).value
																})}
														/>
													</div>
													<div>
														<label class="text-xs opacity-70 mb-1 block">Container Port</label>
														<input
															type="number"
															min="1"
															class="input"
															placeholder="8080"
															value={port.containerPort}
															oninput={(event) =>
																updateNewServicePort(index, {
																	containerPort: Number(
																		(event.currentTarget as HTMLInputElement).value
																	)
																})}
														/>
													</div>
													<div>
														<label class="text-xs opacity-70 mb-1 block">Service Port</label>
														<input
															type="number"
															min="1"
															class="input"
															placeholder="80"
															value={port.servicePort}
															oninput={(event) =>
																updateNewServicePort(index, {
																	servicePort: Number(
																		(event.currentTarget as HTMLInputElement).value
																	)
																})}
														/>
													</div>
													<div>
														<label class="text-xs opacity-70 mb-1 block">Protocol</label>
														<div class="flex gap-2">
															<div class="relative flex-1 custom-dropdown-container">
																<button
																	type="button"
																	onclick={() => (protocolDropdownOpen = protocolDropdownOpen === `new-${index}` ? null : `new-${index}`)}
																	class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
																	style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
																>
																	<span>{port.protocol}</span>
																	<ChevronDown class="h-4 w-4 shrink-0" />
																</button>
																{#if protocolDropdownOpen === `new-${index}`}
																	<div
																		class="absolute z-20 mt-1 w-full rounded-xl border p-2 shadow"
																		style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
																		transition:scale={{ duration: 150, start: 0.96 }}
																	>
																		<button
																			type="button"
																			onclick={() => {
																				updateNewServicePort(index, { protocol: 'TCP' });
																				protocolDropdownOpen = null;
																			}}
																			class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
																		>
																			<span>TCP</span>
																			{#if port.protocol === 'TCP'}
																				<Check class="h-4 w-4 text-primary-600" />
																			{/if}
																		</button>
																		<button
																			type="button"
																			onclick={() => {
																				updateNewServicePort(index, { protocol: 'UDP' });
																				protocolDropdownOpen = null;
																			}}
																			class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
																		>
																			<span>UDP</span>
																			{#if port.protocol === 'UDP'}
																				<Check class="h-4 w-4 text-primary-600" />
																			{/if}
																		</button>
																	</div>
																{/if}
															</div>
															<button
																type="button"
																class="btn btn-ghost btn-sm"
																onclick={() => removeNewServicePortRow(index)}
															>
																<Trash2 class="h-4 w-4" />
															</button>
														</div>
													</div>
													{#if newServiceForm.exposePublic}
														<div class="md:col-span-4">
															<label class="text-xs opacity-70 mb-1 block">External Port (NodePort, optional)</label>
															<input
																type="number"
																min="30000"
																max="32767"
																class="input"
																placeholder="30000-32767"
																value={port.nodePort ?? ''}
																oninput={(event) =>
																	updateNewServicePort(index, {
																		nodePort:
																			(event.currentTarget as HTMLInputElement).value === ''
																				? null
																				: Number(
																						(event.currentTarget as HTMLInputElement).value
																				  )
																	})}
															/>
														</div>
													{/if}
												</div>
											{/each}
											<button type="button" class="btn btn-secondary btn-sm" onclick={addNewServicePortRow}>
												<Plus class="h-4 w-4" />
												Add port
											</button>
										</div>

										{#if serviceFormError}
											<div class="alert alert-error mt-4">{serviceFormError}</div>
										{/if}

										<div class="mt-4 flex justify-end gap-3">
											<button
												type="button"
												class="btn btn-secondary"
												onclick={() => {
													showServiceForm = false;
													resetNewServiceForm();
												}}
											>
												Cancel
											</button>
											<button
												type="button"
												class="btn btn-primary"
												onclick={createService}
												disabled={creatingService}
											>
												{#if creatingService}
													<Loader2 class="h-4 w-4 animate-spin" />
												{/if}
												Create service
											</button>
										</div>
									</div>
								{/if}

								<div class="mt-6 space-y-4">
									{#if deployment.services?.length}
										{#each deployment.services as service}
											{@const displayedPorts =
												service.ports && service.ports.length
													? service.ports
													: [
															{
																name: service.name,
																port: service.port,
																targetPort: service.targetPort,
																protocol: service.protocol,
																nodePort: service.nodePort ?? null
															}
													  ]}
											<div class="surface-tile rounded-2xl p-6">
												<div class="flex items-start justify-between gap-4 mb-4">
													<div class="flex-1 min-w-0">
														<h3 class="text-lg font-semibold mb-2" style="color: var(--center-channel-color);">{service.name}</h3>
														<div class="flex flex-wrap items-center gap-3">
															<span class="surface-pill rounded-full px-3 py-1 text-xs font-medium">
																{service.type === 'external' ? 'NodePort' : 'ClusterIP'}
															</span>
															{#if service.externalIp}
																<span class="text-sm" style="color: var(--surface-muted);">
																	External IP: <span class="font-mono">{service.externalIp}</span>
																</span>
															{/if}
															{#if service.domain}
																<span class="text-sm" style="color: var(--surface-muted);">
																	Domain: <span class="font-mono">{service.domain}</span>
																</span>
															{/if}
														</div>
													</div>
													<div class="flex gap-2 shrink-0">
														<button
															type="button"
															class="btn btn-ghost btn-sm"
															onclick={() => toggleServiceEdit(service)}
														>
															{#if serviceEditForms[service.id]}
																<X class="h-4 w-4" />
																<span class="hidden sm:inline">Close</span>
															{:else}
																<Settings class="h-4 w-4" />
																<span class="hidden sm:inline">Edit</span>
															{/if}
														</button>
														<button
															type="button"
															class="btn btn-ghost btn-sm text-red-500"
															onclick={() => deleteService(service.id)}
															disabled={serviceDeletingId === service.id}
														>
															{#if serviceDeletingId === service.id}
																<Loader2 class="h-4 w-4 animate-spin" />
															{:else}
																<Trash2 class="h-4 w-4" />
															{/if}
														</button>
													</div>
												</div>

												{#if service.internalUrl}
													<div class="mb-4 p-3 rounded-lg border" style="border-color: var(--divider-color); background-color: var(--surface-color);">
														<div class="flex items-center justify-between gap-3">
															<div class="flex-1 min-w-0">
																<p class="text-xs mb-1 font-medium" style="color: var(--surface-muted);">Internal URL</p>
																<p class="text-sm font-mono break-all" style="color: var(--center-channel-color);">{service.internalUrl}</p>
															</div>
															<button
																type="button"
																class="btn btn-ghost btn-sm shrink-0"
																onclick={() => copyInternalUrl(service.internalUrl, service.id)}
																title="Copy internal URL"
															>
																{#if copiedUrlId === service.id}
																	<Check class="h-4 w-4 text-green-500" />
																{:else}
																	<Copy class="h-4 w-4" />
																{/if}
															</button>
														</div>
													</div>
												{/if}

												<div class="space-y-2">
													<p class="text-xs font-medium mb-2" style="color: var(--surface-muted);">Ports</p>
													{#each displayedPorts as port}
														<div class="flex flex-wrap items-center gap-3 p-2 rounded-lg" style="background-color: var(--surface-color);">
															<span class="font-mono text-sm font-medium" style="color: var(--center-channel-color);">{port.name ?? 'port'}</span>
															<div class="flex flex-wrap items-center gap-2 text-sm" style="color: var(--surface-muted);">
																<span class="inline-flex items-center gap-1">
																	<span class="text-xs opacity-70">Container:</span>
																	<span class="font-mono">{port.targetPort}</span>
																</span>
																<span>→</span>
																<span class="inline-flex items-center gap-1">
																	<span class="text-xs opacity-70">Service:</span>
																	<span class="font-mono">{port.port}</span>
																</span>
																{#if port.nodePort}
																	<span>→</span>
																	<span class="inline-flex items-center gap-1">
																		<span class="text-xs opacity-70">External:</span>
																		<span class="font-mono">{port.nodePort}</span>
																	</span>
																{/if}
																<span class="surface-pill rounded-full px-2 py-0.5 text-xs ml-1">{port.protocol}</span>
															</div>
														</div>
													{/each}
												</div>
												{#if serviceEditForms[service.id]}
													<div class="mt-4 border-t border-dashed pt-4" style="border-color: var(--divider-color);">
														<div class="space-y-3">
															{#each serviceEditForms[service.id].ports as port, index}
																<div class="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
																	<div>
																		<label class="text-xs opacity-70 mb-1 block">Name</label>
																		<input
																			type="text"
																			class="input"
																			placeholder="port name"
																			value={port.name}
																			oninput={(event) =>
																				updateServiceEditPort(service.id, index, {
																					name: (event.currentTarget as HTMLInputElement).value
																				})}
																		/>
																	</div>
																	<div>
																		<label class="text-xs opacity-70 mb-1 block">Container Port</label>
																		<input
																			type="number"
																			min="1"
																			class="input"
																			placeholder="8080"
																			value={port.containerPort}
																			oninput={(event) =>
																				updateServiceEditPort(service.id, index, {
																					containerPort: Number(
																						(event.currentTarget as HTMLInputElement).value
																					)
																				})}
																		/>
																	</div>
																	<div>
																		<label class="text-xs opacity-70 mb-1 block">Service Port</label>
																		<input
																			type="number"
																			min="1"
																			class="input"
																			placeholder="80"
																			value={port.servicePort}
																			oninput={(event) =>
																				updateServiceEditPort(service.id, index, {
																					servicePort: Number(
																						(event.currentTarget as HTMLInputElement).value
																					)
																				})}
																		/>
																	</div>
																	<div>
																		<label class="text-xs opacity-70 mb-1 block">Protocol</label>
																		<div class="flex gap-2">
																			<div class="relative flex-1 custom-dropdown-container">
																				<button
																					type="button"
																					onclick={() => (protocolDropdownOpen = protocolDropdownOpen === `${service.id}-${index}` ? null : `${service.id}-${index}`)}
																					class="flex w-full items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
																					style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
																				>
																					<span>{port.protocol}</span>
																					<ChevronDown class="h-4 w-4 shrink-0" />
																				</button>
																				{#if protocolDropdownOpen === `${service.id}-${index}`}
																					<div
																						class="absolute z-20 mt-1 w-full rounded-xl border p-2 shadow"
																						style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
																						transition:scale={{ duration: 150, start: 0.96 }}
																					>
																						<button
																							type="button"
																							onclick={() => {
																								updateServiceEditPort(service.id, index, { protocol: 'TCP' });
																								protocolDropdownOpen = null;
																							}}
																							class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
																						>
																							<span>TCP</span>
																							{#if port.protocol === 'TCP'}
																								<Check class="h-4 w-4 text-primary-600" />
																							{/if}
																						</button>
																						<button
																							type="button"
																							onclick={() => {
																								updateServiceEditPort(service.id, index, { protocol: 'UDP' });
																								protocolDropdownOpen = null;
																							}}
																							class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
																						>
																							<span>UDP</span>
																							{#if port.protocol === 'UDP'}
																								<Check class="h-4 w-4 text-primary-600" />
																							{/if}
																						</button>
																					</div>
																				{/if}
																			</div>
																			<button
																				type="button"
																				class="btn btn-ghost btn-sm"
																				onclick={() => removeServiceEditPortRow(service.id, index)}
																			>
																				<Trash2 class="h-4 w-4" />
																			</button>
																		</div>
																	</div>
																	{#if serviceEditForms[service.id].exposePublic}
																		<div class="md:col-span-4">
																			<label class="text-xs opacity-70 mb-1 block">External Port (NodePort, optional)</label>
																			<input
																				type="number"
																				min="30000"
																				max="32767"
																				class="input"
																				placeholder="30000-32767"
																				value={port.nodePort ?? ''}
																				oninput={(event) =>
																					updateServiceEditPort(service.id, index, {
																						nodePort:
																							(event.currentTarget as HTMLInputElement).value === ''
																								? null
																								: Number(
																										(event.currentTarget as HTMLInputElement).value
																								  )
																					})}
																			/>
																		</div>
																	{/if}
																</div>
															{/each}
															<button
																type="button"
																class="btn btn-secondary btn-sm"
																onclick={() => addServiceEditPortRow(service.id)}
															>
																<Plus class="h-4 w-4" />
																Add port
															</button>
														</div>
														{#if serviceEditErrors[service.id]}
															<div class="alert alert-error mt-3">{serviceEditErrors[service.id]}</div>
														{/if}
														<div class="mt-3 flex justify-end gap-3">
															<button
																type="button"
																class="btn btn-primary btn-sm"
																onclick={() => saveServicePorts(service.id)}
																disabled={serviceSavingId === service.id}
															>
																{#if serviceSavingId === service.id}
																	<Loader2 class="h-4 w-4 animate-spin" />
																{/if}
																Save ports
															</button>
														</div>
													</div>
												{/if}
											</div>
										{/each}
									{:else}
										<p class="surface-muted-panel rounded-xl px-3 py-3 text-center text-sm">
											No services configured.
										</p>
									{/if}
								</div>
							</div>
								<div class="card rounded-2xl p-6">
									<div class="flex items-center justify-between">
										<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Ingresses</p>
										{#if deployment.project?.workspace?.slug && deployment.project?.slug}
											<button 
												onclick={() => goto(`/workspaces/${deployment.project.workspace.slug}/projects/${deployment.project.slug}/ingresses/new?deployment=${deploymentId}`)} 
												class="btn btn-secondary btn-sm"
											>
												<Plus class="h-4 w-4" />
												<span>Add ingress</span>
											</button>
										{/if}
									</div>
									<div class="mt-4 space-y-4">
										{#if deployment.ingresses?.length}
											{#each deployment.ingresses as ingress}
												<div class="surface-tile rounded-xl p-4">
													<div class="flex flex-wrap items-center justify-between gap-4">
														<div class="flex-1 min-w-0">
															{#if ingress.annotations?.['traefik.ingress.kubernetes.io/router.middlewares']?.includes('auth@kubernetescrd')}
																<p class="text-xs text-amber-500 mb-1">
																	<Lock class="inline h-3 w-3 mr-1" />
																	Basic Auth Enabled
																</p>
															{/if}
															{#if ingress.routes && ingress.routes.length > 1}
																<p class="font-medium text-gray-900 dark:text-gray-50 mb-1">
																	{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}
																</p>
																<div class="space-y-1">
																	{#each ingress.routes as route}
																		<p class="text-sm text-gray-600 dark:text-gray-400">
																			<span class="font-mono">{route.path}</span>
																			<span class="text-xs ml-1">→ {route.serviceName}:{route.servicePort}</span>
																		</p>
																	{/each}
																</div>
															{:else}
																<p class="font-medium text-gray-900 dark:text-gray-50">
																	{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.routes?.[0]?.path ?? ingress.path}
																</p>
															{/if}
															{#if ingress.address}
																<p class="text-xs text-gray-500 mt-1">{ingress.address}</p>
															{/if}
														</div>
														<div class="flex gap-2">
															{#if deployment.project?.workspace?.slug && deployment.project?.slug}
																<button
																	onclick={() => goto(`/workspaces/${deployment.project.workspace.slug}/projects/${deployment.project.slug}/ingresses/${ingress.id}`)}
																	class="btn btn-ghost btn-sm"
																>
																	<Pencil class="h-4 w-4" />
																</button>
															{/if}
															<button
																onclick={() => deleteIngress(ingress.id)}
																disabled={deletingIngress === ingress.id}
																class="btn btn-ghost btn-sm text-red-500"
															>
																{#if deletingIngress === ingress.id}
																	<Loader2 class="h-4 w-4 animate-spin" />
																{:else}
																	<Trash2 class="h-4 w-4" />
																{/if}
															</button>
														</div>
													</div>
												</div>
											{/each}
										{:else}
											<p class="surface-muted-panel rounded-xl px-3 py-2 text-sm">No ingresses yet.</p>
										{/if}
									</div>
								</div>
						</div>
					{:else if tab.id === 'history'}
						<div class="card rounded-2xl p-6">
							<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Image history</p>
							{#if deployment.imageHistory?.length}
									<div class="mt-4 space-y-4">
										{#each deployment.imageHistory as history}
											<div class="surface-tile rounded-2xl p-4">
											<div class="flex flex-wrap items-center justify-between gap-4">
												<div>
													<p class="truncate font-mono text-sm text-gray-900 dark:text-gray-100">{history.image}</p>
													<div class="mt-1 flex flex-wrap gap-3 text-xs text-gray-500">
														{#if history.branch}
															<span>{history.branch}</span>
														{/if}
														{#if history.commit}
															<code>{history.commit.slice(0, 7)}</code>
														{/if}
														<span>{new Date(history.createdAt).toLocaleString()}</span>
													</div>
												</div>
												{#if history.isActive}
													<span class="badge badge-success">Active</span>
												{:else}
													<button onclick={() => rollbackToImage(history.id)} class="btn btn-secondary btn-sm">
														Roll back
													</button>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{:else}
								<p class="mt-4 text-sm text-gray-500">No image history available.</p>
							{/if}
						</div>
					{:else if tab.id === 'webhooks'}
						<div class="space-y-6">
							<!-- Docs card -->
							<div class="card rounded-2xl p-6">
								<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Deploy Webhooks</p>
								<p class="mt-2 text-sm text-gray-500">
									Webhook tokens let you trigger redeployments from CI/CD pipelines like GitHub Actions without needing to log in. Each token is a secret URL you can call to restart your deployment or update its image.
								</p>

								<div class="webhook-usage-section mt-4 rounded-xl p-4">
									<p class="webhook-usage-label mb-2 text-xs font-semibold uppercase tracking-wide">Usage</p>
									<div class="space-y-3 text-sm">
										<div>
											<p class="font-medium">Restart (no image change):</p>
											<pre class="webhook-code-block mt-1 overflow-x-auto rounded-lg p-3 text-xs font-mono"><code>{webhookExamples.restart}</code></pre>
										</div>
										<div>
											<p class="font-medium">Update image tag:</p>
											<pre class="webhook-code-block mt-1 overflow-x-auto rounded-lg p-3 text-xs font-mono"><code>{webhookExamples.updateTag}</code></pre>
										</div>
										<div>
											<p class="font-medium">Update full image:</p>
											<pre class="webhook-code-block mt-1 overflow-x-auto rounded-lg p-3 text-xs font-mono"><code>{webhookExamples.updateImage}</code></pre>
										</div>
									</div>
								</div>

								<div class="webhook-info-card mt-4 rounded-xl p-4">
									<p class="mb-2 text-xs font-semibold uppercase tracking-wide">GitHub Actions Example</p>
									<pre class="webhook-code-block overflow-x-auto rounded-lg p-3 text-xs font-mono"><code>{webhookExamples.githubActions}</code></pre>
								</div>
							</div>

							<!-- Token management card -->
							<div class="card rounded-2xl p-6">
								<div class="flex items-center justify-between">
									<div>
										<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Webhook Tokens</p>
										<p class="mt-1 text-sm text-gray-500">Create and manage webhook tokens for this deployment.</p>
									</div>
								</div>

								<!-- Create new token -->
								<div class="mt-4 flex gap-3">
									<input
										type="text"
										class="input flex-1"
										placeholder="Token label (e.g. github-actions)"
										bind:value={newWebhookLabel}
									/>
									<button
										class="btn btn-primary"
										onclick={createWebhookToken}
										disabled={creatingWebhookToken}
									>
										{#if creatingWebhookToken}
											<Loader2 class="mr-2 h-4 w-4 animate-spin" />
										{:else}
											<Plus class="mr-2 h-4 w-4" />
										{/if}
										Create Token
									</button>
								</div>

								<!-- Newly created token (show once) -->
								{#if newlyCreatedToken}
									<div class="webhook-success-card mt-4 rounded-xl p-4" transition:scale={{ duration: 200 }}>
										<p class="text-sm font-semibold">Token created! Copy it now — it won't be shown again.</p>
										<div class="mt-2 space-y-2">
											<div>
												<p class="webhook-success-muted mb-1 text-xs font-medium">Token</p>
												<div class="flex items-center gap-2">
													<code class="flex-1 break-all rounded-lg px-3 py-2 font-mono text-xs">{newlyCreatedToken}</code>
													<button
														class="btn btn-ghost btn-sm"
														onclick={() => copyToClipboard(newlyCreatedToken!, 'token')}
													>
														{#if copiedWebhookToken}
															<Check class="h-4 w-4 text-[var(--success-muted)]" />
														{:else}
															<Copy class="h-4 w-4" />
														{/if}
													</button>
												</div>
											</div>
											<div>
												<p class="webhook-success-muted mb-1 text-xs font-medium">Webhook URL</p>
												<div class="flex items-center gap-2">
													<code class="flex-1 break-all rounded-lg px-3 py-2 font-mono text-xs">{getWebhookUrl(newlyCreatedToken)}</code>
													<button
														class="btn btn-ghost btn-sm"
														onclick={() => copyToClipboard(getWebhookUrl(newlyCreatedToken!), 'url')}
													>
														{#if copiedWebhookUrl}
															<Check class="h-4 w-4 text-[var(--success-muted)]" />
														{:else}
															<Copy class="h-4 w-4" />
														{/if}
													</button>
												</div>
											</div>
										</div>
										<button
											class="btn btn-ghost btn-sm mt-3"
											onclick={() => (newlyCreatedToken = null)}
										>
											Dismiss
										</button>
									</div>
								{/if}

								<!-- Token list -->
								<div class="mt-4">
									{#if webhookTokensLoading}
										<div class="flex items-center justify-center py-8">
											<Loader2 class="h-6 w-6 animate-spin text-gray-400" />
										</div>
									{:else if webhookTokens.length === 0}
										<div class="webhook-empty-state rounded-xl px-4 py-8 text-center">
											<Webhook class="mx-auto h-8 w-8" />
											<p class="mt-2 text-sm">No webhook tokens yet. Create one to get started.</p>
										</div>
									{:else}
										<div class="space-y-3">
											{#each webhookTokens as token}
												<div class="surface-tile flex items-center justify-between rounded-xl p-4">
													<div>
														<p class="text-sm font-medium text-gray-900 dark:text-gray-50">
															{token.label || 'Unnamed token'}
														</p>
														<p class="text-xs text-gray-500">
															Created {new Date(token.createdAt).toLocaleDateString()}
															{#if token.lastUsedAt}
																&middot; Last used {new Date(token.lastUsedAt).toLocaleDateString()}
															{:else}
																&middot; Never used
															{/if}
														</p>
													</div>
													<button
														class="btn btn-destructive btn-sm"
														onclick={() => deleteWebhookToken(token.id)}
														disabled={deletingWebhookTokenId === token.id}
													>
														{#if deletingWebhookTokenId === token.id}
															<Loader2 class="h-4 w-4 animate-spin" />
														{:else}
															<Trash2 class="h-4 w-4" />
														{/if}
													</button>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							</div>
						</div>
					{:else if tab.id === 'advanced'}
						<div class="card rounded-2xl p-6">
							<div class="mb-6">
								<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Build Options</p>
								<p class="text-sm text-gray-500 mt-1">Configure build settings</p>
							</div>

							{#if deployment.githubRepo}
								<div class="space-y-6">
									<div>
										<label class="flex items-center gap-3">
											<input type="checkbox" bind:checked={buildFromRoot} class="rounded" />
											<div>
												<span class="font-medium">Build from root</span>
												<p class="text-xs text-gray-500">Build from the repository root instead of the Dockerfile directory</p>
											</div>
										</label>
									</div>
								</div>

								<div class="mt-6 flex flex-wrap justify-end gap-3">
									<button onclick={saveAdvanced} disabled={savingAdvanced} class="btn btn-primary">
										{#if savingAdvanced}
											<Loader2 class="h-4 w-4 animate-spin" />
										{/if}
										<span>Save changes</span>
									</button>
								</div>
							{:else}
								<p class="text-sm text-gray-500">Build options are only available for deployments created from GitHub repositories.</p>
							{/if}
						</div>

						<!-- Auto-deploy Section -->
						<div class="card rounded-2xl p-6 mt-6">
							<div class="mb-6">
								<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Auto-Deploy</p>
								<p class="text-sm text-gray-500 mt-1">Automatically deploy on push to a branch</p>
							</div>

							{#if deployment.githubRepo}
								{#if autoDeployLoading}
									<div class="flex items-center justify-center py-8">
										<Loader2 class="h-6 w-6 animate-spin text-gray-400" />
									</div>
								{:else if autoDeployStatus?.enabled}
									<!-- Auto-deploy is enabled -->
									<div class="space-y-4">
										<div class="flex items-center gap-2 text-green-600 dark:text-green-400">
											<Check class="h-5 w-5" />
											<span class="font-medium">Auto-deploy is enabled</span>
										</div>

										<div class="surface-muted-panel rounded-lg p-4 space-y-3">
											<div class="flex items-center justify-between">
												<span class="text-sm text-gray-600 dark:text-gray-400">Branch</span>
												<span class="font-mono text-sm">{autoDeployStatus.branch}</span>
											</div>
										</div>

										<p class="text-xs text-gray-500">
											Pushes to <code class="bg-gray-100 dark:bg-gray-800 px-1 rounded">{autoDeployStatus.branch}</code> will automatically trigger a new deployment.
											Deployment status will appear on your commits in GitHub.
										</p>

										<div class="flex justify-end">
											<button onclick={disableAutoDeploy} disabled={disablingAutoDeploy} class="btn btn-destructive">
												{#if disablingAutoDeploy}
													<Loader2 class="h-4 w-4 animate-spin" />
												{/if}
												<span>Disable auto-deploy</span>
											</button>
										</div>
									</div>
								{:else if !autoDeployStatus?.appInstalled}
									<!-- GitHub App not installed -->
									<div class="space-y-4">
										<div class="surface-muted-panel rounded-lg p-4 border-2 border-dashed border-gray-300 dark:border-gray-600">
											<div class="text-center space-y-3">
												<div class="mx-auto w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
													<svg class="h-6 w-6 text-gray-400" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg">
														<path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/>
													</svg>
												</div>
												<div>
													<p class="text-sm font-medium">Install the GitHub App</p>
													<p class="text-xs text-gray-500 mt-1">
														To enable auto-deploy, you need to install the Leaf GitHub App on your repository.
													</p>
												</div>
												<button
													onclick={openGitHubAppInstall}
													disabled={!githubAppInstallUrl || loadingAppInstallUrl}
													class="btn btn-primary"
												>
													{#if loadingAppInstallUrl}
														<Loader2 class="h-4 w-4 animate-spin" />
													{/if}
													<ExternalLink class="h-4 w-4" />
													<span>Install GitHub App</span>
												</button>
											</div>
										</div>
										<p class="text-xs text-gray-500">
											After installing the app, refresh this page to enable auto-deploy.
										</p>
									</div>
								{:else}
									<!-- Auto-deploy is disabled but app is installed -->
									<div class="space-y-4">
										<p class="text-sm text-gray-600 dark:text-gray-400">
											Enable auto-deploy to automatically trigger a deployment whenever you push to a specific branch.
											This works like Cloudflare Workers - deployment status and logs will be shown on your commits in GitHub.
										</p>

										<div>
											<label class="block text-sm font-medium mb-2">Deploy branch</label>
											<input
												type="text"
												bind:value={autoDeployBranch}
												placeholder={deployment.githubBranch || 'main'}
												class="input w-full font-mono"
											/>
											<p class="text-xs text-gray-500 mt-1">The branch that will trigger auto-deployments when pushed to</p>
										</div>

										<div class="flex justify-end">
											<button onclick={enableAutoDeploy} disabled={enablingAutoDeploy || !autoDeployBranch} class="btn btn-primary">
												{#if enablingAutoDeploy}
													<Loader2 class="h-4 w-4 animate-spin" />
												{/if}
												<span>Enable auto-deploy</span>
											</button>
										</div>
									</div>
								{/if}

								<!-- GitHub Deployments History -->
								{#if githubDeployments.length > 0}
									<div class="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
										<p class="text-sm font-medium mb-3">Recent GitHub Deployments</p>
										<div class="space-y-2">
											{#each githubDeployments.slice(0, 5) as ghDeployment}
												<div class="surface-muted-panel rounded-lg p-3 flex items-center justify-between">
													<div class="flex items-center gap-3">
														<div class="flex-shrink-0">
															{#if ghDeployment.status === 'success'}
																<div class="h-2 w-2 rounded-full bg-green-500"></div>
															{:else if ghDeployment.status === 'failure' || ghDeployment.status === 'error'}
																<div class="h-2 w-2 rounded-full bg-red-500"></div>
															{:else if ghDeployment.status === 'in_progress'}
																<div class="h-2 w-2 rounded-full bg-yellow-500 animate-pulse"></div>
															{:else}
																<div class="h-2 w-2 rounded-full bg-gray-400"></div>
															{/if}
														</div>
														<div>
															<code class="text-xs font-mono">{ghDeployment.commitSha.substring(0, 7)}</code>
															<span class="text-xs text-gray-500 ml-2">{ghDeployment.ref}</span>
														</div>
													</div>
													<div class="flex items-center gap-2 text-xs text-gray-500">
														<span>{new Date(ghDeployment.createdAt).toLocaleString()}</span>
														{#if ghDeployment.logUrl}
															<a href={ghDeployment.logUrl} class="text-blue-500 hover:underline" target="_blank">
																<ExternalLink class="h-3 w-3" />
															</a>
														{/if}
													</div>
												</div>
											{/each}
										</div>
									</div>
								{/if}
							{:else}
								<p class="text-sm text-gray-500">Auto-deploy is only available for deployments created from GitHub repositories.</p>
							{/if}
						</div>

						<!-- Health Check Section -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="card rounded-2xl p-6 mt-6" onchange={() => isEditingHealthCheck = true} oninput={() => isEditingHealthCheck = true} onclick={() => isEditingHealthCheck = true}>
							<div class="mb-6">
								<p class="text-lg font-semibold text-gray-900 dark:text-gray-50">Health Checks</p>
								<p class="text-sm text-gray-500 mt-1">Configure liveness, readiness, and startup probes for your deployment</p>
							</div>

							<div class="space-y-6">
								<div>
									<label class="flex items-center gap-3">
										<input type="checkbox" bind:checked={healthCheckEnabled} class="rounded" />
										<div>
											<span class="font-medium">Enable health checks</span>
											<p class="text-xs text-gray-500">Kubernetes will monitor your container's health and restart it if it becomes unhealthy</p>
										</div>
									</label>
								</div>

								{#if healthCheckEnabled}
									<div class="space-y-5">
										<!-- Probe type selector -->
										<div>
											<label class="block text-sm font-medium mb-2">Check type</label>
											<div class="flex gap-2">
												<button
													onclick={() => healthCheckType = 'http'}
													class="px-4 py-2 rounded-lg text-sm font-medium transition-colors {healthCheckType === 'http' ? 'bg-[var(--sidebar-text-active-bg)] text-[var(--sidebar-text-active-color)] border border-[var(--sidebar-text-active-border)]' : 'bg-[var(--control-bg)] text-[var(--control-text)] border border-[var(--surface-border)] hover:bg-[var(--control-hover-bg)]'}"
												>
													HTTP
												</button>
												<button
													onclick={() => healthCheckType = 'tcp'}
													class="px-4 py-2 rounded-lg text-sm font-medium transition-colors {healthCheckType === 'tcp' ? 'bg-[var(--sidebar-text-active-bg)] text-[var(--sidebar-text-active-color)] border border-[var(--sidebar-text-active-border)]' : 'bg-[var(--control-bg)] text-[var(--control-text)] border border-[var(--surface-border)] hover:bg-[var(--control-hover-bg)]'}"
												>
													TCP
												</button>
												<button
													onclick={() => healthCheckType = 'exec'}
													class="px-4 py-2 rounded-lg text-sm font-medium transition-colors {healthCheckType === 'exec' ? 'bg-[var(--sidebar-text-active-bg)] text-[var(--sidebar-text-active-color)] border border-[var(--sidebar-text-active-border)]' : 'bg-[var(--control-bg)] text-[var(--control-text)] border border-[var(--surface-border)] hover:bg-[var(--control-hover-bg)]'}"
												>
													Command
												</button>
											</div>
											<p class="text-xs text-gray-500 mt-1">
												{#if healthCheckType === 'http'}
													Sends an HTTP GET request to the specified path and port
												{:else if healthCheckType === 'tcp'}
													Checks if a TCP connection can be established on the specified port
												{:else}
													Executes a command inside the container
												{/if}
											</p>
										</div>

										<!-- Type-specific fields -->
										{#if healthCheckType === 'http'}
											<div class="grid grid-cols-2 gap-4">
												<div>
													<label class="block text-sm font-medium mb-2">Path</label>
													<input
														type="text"
														bind:value={healthCheckPath}
														placeholder="/health"
														class="input w-full font-mono"
													/>
												</div>
												<div>
													<label class="block text-sm font-medium mb-2">Port</label>
													<input
														type="number"
														bind:value={healthCheckPort}
														placeholder="80"
														class="input w-full font-mono"
													/>
												</div>
											</div>
										{:else if healthCheckType === 'tcp'}
											<div>
												<label class="block text-sm font-medium mb-2">Port</label>
												<input
													type="number"
													bind:value={healthCheckPort}
													placeholder="80"
													class="input w-full font-mono"
												/>
											</div>
										{:else}
											<div>
												<label class="block text-sm font-medium mb-2">Command</label>
												<input
													type="text"
													bind:value={healthCheckCommand}
													placeholder="cat /tmp/healthy"
													class="input w-full font-mono"
												/>
												<p class="text-xs text-gray-500 mt-1">Command will be split by spaces and executed in the container</p>
											</div>
										{/if}

										<!-- Which probes to enable -->
										<div>
											<label class="block text-sm font-medium mb-3">Probe types</label>
											<div class="space-y-3">
												<label class="flex items-center gap-3">
													<input type="checkbox" bind:checked={livenessEnabled} class="rounded" />
													<div>
														<span class="font-medium text-sm">Liveness probe</span>
														<p class="text-xs text-gray-500">Restarts the container if it becomes unresponsive</p>
													</div>
												</label>
												<label class="flex items-center gap-3">
													<input type="checkbox" bind:checked={readinessEnabled} class="rounded" />
													<div>
														<span class="font-medium text-sm">Readiness probe</span>
														<p class="text-xs text-gray-500">Stops routing traffic to the container until it's ready</p>
													</div>
												</label>
												<label class="flex items-center gap-3">
													<input type="checkbox" bind:checked={startupEnabled} class="rounded" />
													<div>
														<span class="font-medium text-sm">Startup probe</span>
														<p class="text-xs text-gray-500">Gives slow-starting containers extra time before liveness checks begin</p>
													</div>
												</label>
											</div>
										</div>

										<!-- Timing settings -->
										<div>
											<label class="block text-sm font-medium mb-3">Timing</label>
											<div class="surface-muted-panel rounded-lg p-4 space-y-4">
												<div class="grid grid-cols-3 gap-4">
													<div>
														<label class="block text-xs text-gray-500 mb-1">Interval (seconds)</label>
														<input
															type="number"
															bind:value={healthCheckInterval}
															min="1"
															class="input w-full font-mono text-sm"
														/>
													</div>
													<div>
														<label class="block text-xs text-gray-500 mb-1">Timeout (seconds)</label>
														<input
															type="number"
															bind:value={healthCheckTimeout}
															min="1"
															class="input w-full font-mono text-sm"
														/>
													</div>
													<div>
														<label class="block text-xs text-gray-500 mb-1">Failure threshold</label>
														<input
															type="number"
															bind:value={healthCheckRetries}
															min="1"
															class="input w-full font-mono text-sm"
														/>
													</div>
												</div>
												{#if startupEnabled}
													<div>
														<label class="block text-xs text-gray-500 mb-1">Startup failure threshold</label>
														<input
															type="number"
															bind:value={startupFailureThreshold}
															min="1"
															class="input w-full font-mono text-sm"
														/>
														<p class="text-xs text-gray-500 mt-1">Number of failures allowed during startup before the container is killed</p>
													</div>
												{/if}
											</div>
										</div>
									</div>
								{/if}

								<div class="mt-6 flex flex-wrap justify-end gap-3">
									<button onclick={saveHealthCheck} disabled={savingHealthCheck} class="btn btn-primary">
										{#if savingHealthCheck}
											<Loader2 class="h-4 w-4 animate-spin" />
										{/if}
										<span>Save changes</span>
									</button>
								</div>
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
					status={buildModalStatus}
					buildStep={buildModalStep}
					buildLogs={accumulatedBuildLogs}
					buildError={buildModalError}
					isGitHubDeploy={true}
					warnings={buildModalWarnings}
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
		background-color: color-mix(in srgb, var(--center-channel-bg) 75%, #050202);
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
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

	.warning-box {
		background-color: var(--warning-bg);
		border-color: var(--warning-border);
		color: var(--warning-text);
	}

	.warning-icon-box {
		background-color: color-mix(in srgb, var(--warning-border) 25%, transparent);
	}

	.warning-item {
		background-color: color-mix(in srgb, var(--warning-bg) 50%, var(--surface-bg));
	}
</style>
