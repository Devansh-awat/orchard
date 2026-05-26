<script lang="ts">
	import './deployment-page.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { Tabs } from 'melt/builders';
	import { createQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { apiFetch, toasts, refreshTree, isSuperAdmin, selectedOrganization, subscribeOrgEvents, sseStatusFor } from '$lib/stores';
	import { env } from '$env/dynamic/public';
	import { invalidate } from '$app/navigation';
	import { featureFlag } from '$lib/posthog';
	import type { PageData } from './$types';
	import {
		Loader2,
		Plus,
		Scale,
		X,
		ExternalLink,
		Lock,
		Webhook,
		GitBranch,
		GitCommit
	} from 'lucide-svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';
	import {
		ArrowLeft,
		Activity,
		Bell,
		Boxes,
		Check,
		ChevronDown,
		CircleX,
		ClipboardList,
		Clock,
		Copy,
		Cpu,
		Eye,
		EyeOff,
		HardDriveDownload,
		History,
		Maximize2,
		Minimize2,
		Play,
		RefreshCw,
		Rocket,
		ServerCog,
		Settings,
		SlidersHorizontal,
		Terminal,
		Trash2,
		TriangleAlert,
		User,
		Wifi
	} from '@jis3r/icons';
	import { scale, fade, slide } from 'svelte/transition';
	import { animate } from 'motion';
	import { MemoryStick } from 'lucide-svelte';
	import { browser } from '$app/environment';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
	import DeploymentMetrics from '$lib/components/DeploymentMetrics.svelte';
	import AuditLogList from '$lib/components/AuditLogList.svelte';
	import { formatCpu as fmtCpuPreset, formatMemory as fmtMemoryPreset } from '$lib/presets';

	import DeploymentProgress from '$lib/components/DeploymentProgress.svelte';
	import CircleAlertIcon from '$lib/components/icons/CircleAlertIcon.svelte';
	import TriangleAlertIcon from '$lib/components/icons/TriangleAlertIcon.svelte';
	import AnimatedNumber from '$lib/components/AnimatedNumber.svelte';
	import BuildSteps from '$lib/components/BuildSteps.svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';

	// Extracted modules
	import {
		motionStagger, motionPopover,
		motionBackdrop, cardTilt, pressSpringDelegate
	} from '$lib/utils/motion.svelte';
	import {
		portal, ansiToHtml, formatCpu, formatMemory, formatRelativeTime, formatBuildDurationBetween,
		humanizeWarning
	} from '$lib/utils/format';
	import type {
		Pod, Service, ServicePortConfig, Ingress, IngressRoute, ImageHistory, Volume,
		AutoDeployStatus, GitHubAppInstallation, GitHubDeploymentRecord,
		ServicePortForm, ServiceFormState, WebhookToken, TerminalTabInfo
	} from '$lib/types/deployment';
	import {
		EnvironmentTab, VolumesTab, WebhooksTab, HistoryTab, ResourcesTab,
		OverviewTab, NetworkTab, AdvancedTab, DeploymentHeader, BuildProgressModal,
		DeploymentAlerts, ConfigureTab, DeploysTab, SettingsTab
	} from '$lib/components/deployment';

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN || 'a.lfdl.ink';
	const INGRESS_CNAME = env.PUBLIC_INGRESS_CNAME || 'ingress.lfdl.ink';
	const PUBLIC_DEPLOYMENT_DOMAIN = env.PUBLIC_DEPLOYMENT_DOMAIN || 'public.orchard.my';



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
		persistentBuildCache?: boolean;
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
		cpuRequestMilli?: number | null;
		memoryRequestBytes?: number | null;
		totalCpuUsage?: number | null;
		totalMemoryUsage?: number | null;
		deployStrategy?: 'rollingUpdate' | 'recreate';
		warnings?: Array<{ podName: string; message: string; timestamp: string }>;
		project?: {
			id: string;
			name: string;
			slug: string;
			backgroundImage?: string | null;
		};
		projectId?: string;
		tailscaleExposed?: boolean;
		tailscaleHostname?: string | null;
		envVars?: Array<{ key: string; value: string }>;
	}


	const tabSections = [
		{
			id: 'overview',
			label: 'Overview',
			description: 'Console, status & pods',
			icon: ServerCog
		},
		{
			id: 'environment',
			label: 'Environment',
			description: 'Config & secrets',
			icon: Settings
		},
		{
			id: 'resources',
			label: 'Resources',
			description: 'CPU & memory',
			icon: Cpu
		},
		{
			id: 'volumes',
			label: 'Storage',
			description: 'Persistent volumes',
			icon: HardDriveDownload
		},
		{
			id: 'network',
			label: 'Network',
			description: 'Ports & domains',
			icon: Wifi
		},
		{
			id: 'metrics',
			label: 'Metrics',
			description: 'Live charts & history',
			icon: Activity
		},
		{
			id: 'deploys',
			label: 'Deploys',
			description: 'History, rollbacks & triggers',
			icon: History
		},
		{
			id: 'settings',
			label: 'Advanced',
			description: 'Strategy, health checks & audit log',
			icon: SlidersHorizontal
		}
	] as const;

	type TabId = (typeof tabSections)[number]['id'];

	const isDockerImageDeployment = $derived(!deployment?.githubRepo);
	const visibleTabs = $derived(tabSections);

	const tabs = new Tabs<TabId>({
		value: 'overview',
		loop: true
	});

	// movingicons.dev animations are gated on each icon's internal mouseenter. We want
	// the animation to fire when the user hovers the parent button, not just the
	// 14×14 icon target — so drive the icon's `animate` prop from button-level hover.
	let tabIconAnim = $state<Record<string, boolean>>({});
	function triggerTabIconAnim(id: string) {
		if (tabIconAnim[id]) return;
		tabIconAnim[id] = true;
		setTimeout(() => { tabIconAnim[id] = false; }, 650);
	}
	let actionAnim = $state<Record<string, boolean>>({});
	function triggerActionAnim(id: string) {
		if (actionAnim[id]) return;
		actionAnim[id] = true;
		setTimeout(() => { actionAnim[id] = false; }, 650);
	}

	// Header card collapses (spring) when the user leaves the Overview tab — the
	// build provenance + domains belong with the overview, while the title and the
	// Redeploy/Restart/Delete actions stay visible everywhere.
	const headerCollapsed = $derived(tabs.value !== 'overview');

	// Spring-driven height collapse for the header body. Motion writes height/opacity;
	// CSS handles overflow:hidden so the content clips cleanly mid-animation.
	function springCollapse(collapsed: () => boolean) {
		return (el: Element) => {
			const target = el as HTMLElement;
			target.style.overflow = 'hidden';
			target.style.contain = 'content';
			const naturalMargin = parseFloat(getComputedStyle(target).marginTop) || 0;
			const naturalHeight = () => {
				const prev = target.style.height;
				target.style.height = 'auto';
				const h = target.scrollHeight;
				target.style.height = prev;
				return h;
			};
			let armed = false;
			let last: boolean | null = null;
			setTimeout(() => {
				armed = true;
				last = collapsed();
				if (last) {
					target.style.height = '0px';
					target.style.opacity = '0';
					target.style.marginTop = '0px';
				}
			}, 80);
			$effect(() => {
				const isCollapsed = collapsed();
				if (!armed || isCollapsed === last) return;
				last = isCollapsed;
				target.style.marginTop = isCollapsed ? '0px' : `${naturalMargin}px`;
				const fullHeight = naturalHeight();
				const card = target.parentElement;
				if (isCollapsed) {
					// Height can't go below 0, so a spring to 0 can't bounce.
					// Instead: collapse height quickly with an eased tween,
					// then spring-bounce the parent card's Y to sell the motion.
					animate(target, { height: 0 }, {
						duration: 0.28, easing: [0.32, 0, 0.67, 0]
					});
					if (card) {
						card.style.transformOrigin = 'top center';
						card.style.overflow = 'visible';
						animate(card, { scaleY: 0.97 }, {
							type: 'spring', stiffness: 500, damping: 10, mass: 0.5
						}).finished.then(() => {
							const ctrl = animate(card, { scaleY: 1 }, {
								type: 'spring', stiffness: 260, damping: 12, mass: 0.8
							});
							ctrl.finished.then(() => {
								card.style.overflow = '';
							});
						});
					}
				} else {
					const expandCtrl = animate(
						target,
						{ height: fullHeight },
						{ type: 'spring', stiffness: 120, damping: 15, mass: 1.2 }
					);
					expandCtrl.finished.then(() => {
						if (!collapsed()) {
							target.style.height = 'auto';
							target.style.marginTop = '';
						}
					});
				}
				animate(target, { opacity: isCollapsed ? 0 : 1 }, {
					type: 'spring', stiffness: 300, damping: 28
				});
			});
		};
	}

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

	// Computed properties for template compatibility with API field names
	const repoUrl = $derived(deployment?.githubRepo);
	const branch = $derived(deployment?.githubBranch);

	let notificationsOpen = $state(false);
	let notificationsRender = $state(false);
	$effect(() => { if (notificationsOpen) notificationsRender = true; });
	let notifBtnEl: HTMLButtonElement | undefined = $state();
	let notifPanelPos = $state({ top: 0, left: 0 });
	$effect(() => {
		if (notificationsOpen && notifBtnEl) {
			const rect = notifBtnEl.getBoundingClientRect();
			notifPanelPos = { top: rect.bottom, left: Math.max(8, rect.right - 380) };
		}
	});

	let dismissedNotifications = $state<Set<string>>(new Set());

	function dismissedStorageKey(): string | null {
		return deployment?.id ? `dismissedNotifs:${deployment.id}` : null;
	}

	function loadDismissedNotifications() {
		if (!browser) return;
		const key = dismissedStorageKey();
		if (!key) return;
		try {
			const raw = localStorage.getItem(key);
			dismissedNotifications = new Set(raw ? (JSON.parse(raw) as string[]) : []);
		} catch {
			dismissedNotifications = new Set();
		}
	}

	function persistDismissedNotifications() {
		if (!browser) return;
		const key = dismissedStorageKey();
		if (!key) return;
		try {
			localStorage.setItem(key, JSON.stringify([...dismissedNotifications]));
		} catch {
			// ignore quota errors
		}
	}

	function dismissNotification(id: string) {
		const next = new Set(dismissedNotifications);
		next.add(id);
		dismissedNotifications = next;
		persistDismissedNotifications();
	}

	function buildFailedNotifId(d: { buildError?: string | null; buildLogs?: string | null } | null | undefined): string {
		const err = (d?.buildError ?? '').trim().slice(0, 120);
		const logsLen = d?.buildLogs?.length ?? 0;
		return `bf:${err}:${logsLen}`;
	}

	function podWarningNotifId(w: { podName: string; message: string; timestamp?: string }): string {
		return `pw:${w.podName}:${w.message}:${w.timestamp ?? ''}`;
	}

	// Track which warnings have had their raw message expanded by the user.
	let expandedWarningRaw = $state<Set<string>>(new Set());
	function toggleWarningRaw(id: string) {
		if (expandedWarningRaw.has(id)) expandedWarningRaw.delete(id);
		else expandedWarningRaw.add(id);
		expandedWarningRaw = new Set(expandedWarningRaw);
	}

	const notificationCount = $derived.by(() => {
		let n = 0;
		if (deployment?.buildStatus === 'failed' && (deployment?.buildError || deployment?.buildLogs)) {
			if (!dismissedNotifications.has(buildFailedNotifId(deployment))) n++;
		}
		for (const w of deployment?.warnings ?? []) {
			if (!dismissedNotifications.has(podWarningNotifId(w))) n++;
		}
		return n;
	});

	// Notification triage: surface the highest-severity active alert and let the
	// header show a real, colored pill for it instead of a tiny bell badge.
	const buildFailedActive = $derived.by(() =>
		deployment?.buildStatus === 'failed'
			&& !!(deployment?.buildError || deployment?.buildLogs)
			&& !dismissedNotifications.has(buildFailedNotifId(deployment))
	);
	const activePodWarnings = $derived.by(() =>
		(deployment?.warnings ?? []).filter((w) => !dismissedNotifications.has(podWarningNotifId(w)))
	);
	// Pod warnings escalate to "error" tone when no replicas are actually ready —
	// at that point the deployment is hard down, not just degraded.
	const noPodsReady = $derived(
		(deployment?.replicas ?? 0) > 0 && (deployment?.availableReplicas ?? 0) === 0
	);
	const notificationSeverity = $derived<'error' | 'warning' | null>(
		buildFailedActive
			? 'error'
			: activePodWarnings.length > 0
				? (noPodsReady ? 'error' : 'warning')
				: null
	);
	const notificationLabel = $derived(
		buildFailedActive
			? 'Build failed'
			: (activePodWarnings.length === 1
				? 'Pod warning'
				: activePodWarnings.length > 1
					? `${activePodWarnings.length} pod warnings`
					: '')
	);

	// Deployment status chip: derives a single user-facing label + tone from
	// buildStatus + status. buildStatus dominates when a build is in flight.
	type StatusTone = 'success' | 'warning' | 'error' | 'neutral' | 'info';
	const deploymentStatusChip = $derived.by(() => {
		const bs = deployment?.buildStatus;
		const s = (deployment?.status ?? '').toLowerCase();
		if (bs === 'building' || bs === 'pending') return { label: 'Building', tone: 'info' as StatusTone };
		if (bs === 'failed') return { label: 'Build failed', tone: 'error' as StatusTone };
		if (!s) return { label: 'Unknown', tone: 'neutral' as StatusTone };
		if (s === 'running') return { label: 'Running', tone: 'success' as StatusTone };
		if (s === 'pending') return { label: 'Pending', tone: 'warning' as StatusTone };
		if (s === 'scaling') return { label: 'Scaling', tone: 'warning' as StatusTone };
		if (s === 'restarting') return { label: 'Restarting', tone: 'warning' as StatusTone };
		if (s === 'unhealthy') return { label: 'Unhealthy', tone: 'error' as StatusTone };
		if (s === 'failed' || s === 'error') return { label: 'Failed', tone: 'error' as StatusTone };
		if (s === 'stopped') return { label: 'Stopped', tone: 'neutral' as StatusTone };
		if (s === 'deleting') return { label: 'Deleting', tone: 'error' as StatusTone };
		return { label: s.charAt(0).toUpperCase() + s.slice(1), tone: 'neutral' as StatusTone };
	});
	const activePods = $derived(deployment?.pods?.filter((pod) => pod.status?.toLowerCase() !== 'succeeded') ?? []);

	let deletingPod = $state<string | null>(null);

	async function deletePod(podName: string) {
		if (!deployment?.namespace || deletingPod) return;
		deletingPod = podName;
		try {
			const res = await apiFetch(`/apiv1/pods/${podName}?namespace=${deployment.namespace}`, { method: 'DELETE' });
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to delete pod');
			}
			toasts.add({ title: 'Pod deleted', description: podName, color: 'success' });
			await fetchDeployment();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to delete pod', color: 'error' });
		} finally {
			deletingPod = null;
		}
	}

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
	let persistentBuildCache = $state(false);

	// Tailscale state (gated behind early access flag)
	const tailscaleEnabled = featureFlag('tailscale-integration');
	let tailscaleExposing = $state(false);
	let tailscaleUnexposing = $state(false);
	let tailscaleLinked = $state(false);
	let tailscaleHostname = $state<string | null>(null);
	let tailscaleIp = $state<string | null>(null);
	let tailscaleDns = $state<string | null>(null);

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

	// Resource-utilisation warning. Compare live aggregate usage against the
	// total guaranteed capacity (request × replicas, since requests == limits
	// here). Skip when unlimited (request === 0) or when no live metrics have
	// arrived yet. The user sees this in the resources tab.
	const NEAR_LIMIT_RATIO = 0.85;
	const resourcePressure = $derived.by(() => {
		const replicas = deployment?.replicas ?? 1;
		const cpuReq = deployment?.cpuRequestMilli ?? null;
		const memReq = deployment?.memoryRequestBytes != null
			? Number(deployment.memoryRequestBytes)
			: null;
		const cpuUsage = deployment?.totalCpuUsage ?? null;
		const memUsage = deployment?.totalMemoryUsage ?? null;

		const cpuRatio = cpuReq != null && cpuReq > 0 && cpuUsage != null && replicas > 0
			? cpuUsage / (cpuReq * replicas)
			: null;
		const memRatio = memReq != null && memReq > 0 && memUsage != null && replicas > 0
			? memUsage / (memReq * replicas)
			: null;

		const cpuNear = cpuRatio != null && cpuRatio >= NEAR_LIMIT_RATIO;
		const memNear = memRatio != null && memRatio >= NEAR_LIMIT_RATIO;
		return {
			cpuRatio,
			memRatio,
			cpuNear,
			memNear,
			any: cpuNear || memNear,
		};
	});

	// Deploy update strategy (RollingUpdate vs Recreate). PVC volumes force
	// Recreate; the picker disables RollingUpdate in that case.
	let strategyValue = $state<'rollingUpdate' | 'recreate'>('rollingUpdate');
	let savingStrategy = $state(false);
	const hasPvcVolume = $derived(volumes.some((v) => v.type === 'pvc'));

	async function saveStrategy(next: 'rollingUpdate' | 'recreate') {
		if (!deployment || savingStrategy || next === strategyValue) return;
		if (hasPvcVolume && next === 'rollingUpdate') {
			toasts.add({
				title: 'Rolling updates unavailable',
				description: 'Remove the PVC volume to switch back to rolling updates.',
				color: 'warning',
			});
			return;
		}
		savingStrategy = true;
		const previous = strategyValue;
		strategyValue = next;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/strategy`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ strategy: next }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update strategy');
			}
			toasts.add({ title: 'Strategy updated', color: 'success' });
			await fetchDeployment();
		} catch (e) {
			strategyValue = previous;
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			savingStrategy = false;
		}
	}

	// Container image edit (image-source deployments only — GitHub-built
	// deployments rebuild from source, so a manual image change would be
	// overwritten by the next build).
	let imageInput = $state('');
	let savingImage = $state(false);
	const isImageSourceDeployment = $derived(!deployment?.githubRepo);
	const imageDirty = $derived(
		!!deployment && imageInput.trim() !== '' && imageInput.trim() !== (deployment.image ?? '')
	);

	async function saveImage() {
		if (!deployment || !imageDirty) return;
		savingImage = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/image`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: imageInput.trim() }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update image');
			}
			toasts.add({ title: 'Image updated', description: 'Pods will roll to pull the new image.', color: 'success' });
			await fetchDeployment();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			savingImage = false;
		}
	}

	// Resources (CPU/memory request). Null = inherit org default.
	let resourceCpuMilli = $state<number | null>(null);
	let resourceMemoryBytes = $state<number | null>(null);
	let orgDefaultCpuMilli = $state<number | null>(null);
	let orgDefaultMemoryBytes = $state<number | null>(null);
	let effectiveCpuLimit = $state<number | null>(null);
	let effectiveMemLimit = $state<number | null>(null);
	let savingResources = $state(false);
	let resourcesDirty = $state(false);

	async function saveResources() {
		if (!deployment) return;
		savingResources = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deployment.id}/resources`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cpuRequestMilli: resourceCpuMilli,
					memoryRequestBytes: resourceMemoryBytes,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update resources');
			}
			toasts.add({ title: 'Resources updated', description: 'Pods will roll to pick up the new values.', color: 'success' });
			resourcesDirty = false;
			await fetchDeployment();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			savingResources = false;
		}
	}

	let selectedPod = $state<string>('');
	let selectedContainer = $state<string>('');
	let manualPodSelection = $state(false);
	const LOG_PAGE_SIZE = 500;
	const LOG_INITIAL_LINES = 100;
	const LOG_MAX_LINES = 50_000;
	let tailLines = $state(LOG_INITIAL_LINES);
	let logsAtMax = $state(false);
	let loadingMoreLogs = $state(false);
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
	let showNewShellMenuRender = $state(false);
	$effect(() => { if (showNewShellMenu) showNewShellMenuRender = true; });
	let showLogsPodMenu = $state(false);
	let showLogsPodMenuRender = $state(false);
	$effect(() => { if (showLogsPodMenu) showLogsPodMenuRender = true; });

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
		const active = pods.filter(p => p.status?.toLowerCase() !== 'succeeded');
		if (!active.length) return null;
		return active.reduce((newest, pod) => {
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
	let showBuildModalRender = $state(false);
	$effect(() => { if (showBuildModal) showBuildModalRender = true; });
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
	let showBuildCardRender = $state(false);
	$effect(() => { if (showBuildCard && !showBuildModal) showBuildCardRender = true; });
	let buildStartTime = $state<number>(0);
	let buildElapsed = $state(0);
	let accumulatedBuildLogs = $state<string | null>(null);
	let buildElapsedInterval: ReturnType<typeof setInterval> | null = null;
	let buildModalStatus = $state<string>('pending');
	let buildModalStep = $state<string | null>(null);
	let buildModalError = $state<string | null>(null);
	let buildModalWarnings = $state<Array<{ podName: string; message: string; timestamp: string }>>([]);
	let buildModalTimestamps = $state<Record<string, number> | null>(null);
	let cancelingBuild = $state(false);

	// Webhook state
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
		const total = Math.round(seconds);
		const m = Math.floor(total / 60);
		const s = total % 60;
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

		// Local UI tick for the elapsed timer; not a network poll. Prefer the
		// server-recorded `__start` timestamp (seeded when build was triggered)
		// so the counter survives page reloads and matches the real build start.
		buildElapsedInterval = setInterval(() => {
			const serverStart = buildModalTimestamps?.__start;
			const startMs = serverStart && serverStart > 0 ? serverStart : buildStartTime;
			buildElapsed = Math.floor((Date.now() - startMs) / 1000);
		}, 1000);

		// Build status, step, logs, and warnings all flow through SSE
		// (`build.changed` → fetchDeployment → syncBuildModalFromDeployment).
		// No client polling.
	}

	function syncBuildModalFromDeployment() {
		if (!deployment) return;
		buildModalStatus = (deployment.buildStatus ?? deployment.status) as any;
		buildModalStep = (deployment.buildStep ?? null) as any;
		buildModalError = (deployment.buildError ?? null) as any;
		buildModalWarnings = ((deployment as any).warnings ?? []) as any;
		buildModalTimestamps = ((deployment as any).buildStepTimestamps ?? null) as any;
		if ((deployment as any).buildLogs) {
			accumulatedBuildLogs = (deployment as any).buildLogs;
		}

		if (deployment.buildStatus === 'succeeded') {
			stopBuildPolling();
			setTimeout(() => {
				showBuildModal = false;
				showBuildCard = false;
				fetchDeployment();
			}, 1500);
		} else if (
			deployment.buildStatus === 'failed' ||
			(deployment.buildStatus as any) === 'cancelled' ||
			(deployment.buildStatus as any) === 'canceled'
		) {
			stopBuildPolling();
		}
	}

	function stopBuildPolling() {
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

	let { data } = $props<{ data: PageData }>();
	const deploymentId = $derived(data.deploymentId);
	let sseUnsub: (() => void) | null = null;
	// Track the last deploymentId we hard-reset for so SSE-driven loader
	// revalidations don't blow away page state (selected pod/container/logs).
	let lastSeenDeploymentId: string | null = null;
	const orgSlug = $derived($page.params.orgSlug);

	// SSE connection health — declared early so the query's refetchInterval can read it.
	let sseStatusValue = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
	const sseDisconnected = $derived(sseStatusValue === 'disconnected');

	// ── TanStack Query: deployment data ──
	const TRANSIENT_DEPLOYMENT_STATUSES = new Set([
		'scaling', 'restarting', 'pending', 'building', 'unhealthy',
	]);
	const deploymentQuery = createQuery(() => ({
		queryKey: ['deployment', deploymentId],
		enabled: !!deploymentId,
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}`);
			if (!res.ok) throw new Error('Failed to fetch deployment');
			return res.json();
		},
		// Adaptive polling: fast during transient states or SSE down, silent otherwise.
		refetchInterval: (() => {
			const status = (deployment?.status ?? '').toLowerCase();
			const buildSt = (deployment?.buildStatus ?? '').toLowerCase();
			const transient = TRANSIENT_DEPLOYMENT_STATUSES.has(status) || buildSt === 'building';
			const sseDown = sseStatusValue === 'disconnected';
			if (transient) return 3000;
			if (sseDown) return 10000;
			return false;
		})(),
		refetchIntervalInBackground: false,
	}));

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

	/** Trigger a refetch of deployment data via TanStack Query. All call sites
	 *  that previously called this function directly now just invalidate the cache
	 *  and the $effect below applies the new data. */
	function fetchDeployment() {
		queryClient.invalidateQueries({ queryKey: ['deployment', deploymentId] });
	}

	// Apply query data to local state. This replaces the old fetchDeployment() body.
	let lastQueryData: any = null;
	$effect(() => {
		const qData = deploymentQuery.data;
		const qError = deploymentQuery.error;
		const qPending = deploymentQuery.isPending;
		untrack(() => {
			if (qPending && !lastQueryData) return; // still loading initial
			if (qError && !deployment) {
				error = qError instanceof Error ? qError.message : 'Failed to fetch deployment';
				loading = false;
				return;
			}
			if (!qData || qData === lastQueryData) return;
			lastQueryData = qData;
			applyDeploymentData(qData);
		});
	});

	function applyDeploymentData(data: any) {
		const wasUnloaded = !deployment;

			// If deployment transitions to building during the session, open the build modal.
			// Skip on the first fetch so opening the page on an already-running build doesn't pop the modal.
			if (!wasUnloaded && data.buildStatus === 'building' && data.githubRepo && !showBuildModal && !showBuildCard) {
				showBuildModal = true;
				showBuildCard = false;
				stopBuildPolling();
				startBuildPolling();
			}

			deployment = data;
			if (wasUnloaded) loadDismissedNotifications();
			if (showBuildModal || showBuildCard) syncBuildModalFromDeployment();

			// Sync Tailscale state
			tailscaleHostname = data.tailscaleHostname || null;
			if (data.tailscaleExposed && !tailscaleDns) {
				fetchTailscaleDeploymentStatus();
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
				persistentBuildCache = data.persistentBuildCache ?? false;

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

				// Sync resource state (unless user has unsaved edits).
				if (!resourcesDirty) {
					resourceCpuMilli = data.cpuRequestMilli ?? null;
					resourceMemoryBytes = data.memoryRequestBytes != null ? Number(data.memoryRequestBytes) : null;
				}

				// Seed image input from the deployment's current image, unless the
				// user already has unsaved edits in flight.
				if (!savingImage && imageInput.trim() === '') {
					imageInput = data.image ?? '';
				}

				// Seed deploy strategy from the persisted value.
				if (!savingStrategy) {
					strategyValue = (data.deployStrategy as 'rollingUpdate' | 'recreate') ?? 'rollingUpdate';
				}

				// Org quota defaults are fetched lazily when the resources tab is opened.
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
		loading = false;
	}

	async function fetchLogs(opts?: { preserveScroll?: boolean }) {
		if (!selectedPod || !selectedContainer) return;

		const preserveScroll = opts?.preserveScroll === true;
		// Capture scroll geometry before swap so we can re-anchor after.
		const el = logsOutputRef;
		const prevScrollHeight = preserveScroll && el ? el.scrollHeight : 0;
		const prevScrollTop = preserveScroll && el ? el.scrollTop : 0;

		logsLoading = true;
		try {
			const response = await apiFetch(
				`/apiv1/pods/${selectedPod}/logs?namespace=${deployment?.namespace}&container=${selectedContainer}&tailLines=${tailLines}`
			);
			if (response.ok) {
				const data = await response.json();
				const next: string = data.logs || '';
				const prevLineCount = logs ? logs.split('\n').length : 0;
				const nextLineCount = next ? next.split('\n').length : 0;
				logs = next;
				// k8s caps `tailLines` at total pod log buffer; if we asked for more
				// than is available, line count won't grow. Mark as exhausted so we
				// stop trying.
				if (preserveScroll && nextLineCount <= prevLineCount) {
					logsAtMax = true;
				}
				if (preserveScroll && el) {
					requestAnimationFrame(() => {
						const cur = logsOutputRef;
						if (!cur) return;
						const delta = cur.scrollHeight - prevScrollHeight;
						cur.scrollTop = prevScrollTop + delta;
					});
				}
			}
		} catch (e) {
		} finally {
			logsLoading = false;
		}
	}

	let lastLoadMoreAt = 0;
	function onLogsScroll(e: Event) {
		const el = e.currentTarget as HTMLPreElement;
		if (loadingMoreLogs || logsAtMax || tailLines >= LOG_MAX_LINES) return;
		// Trigger a bit before reaching the very top so it feels seamless.
		if (el.scrollTop > 80) return;
		// Throttle so a fast scroll doesn't fire two requests.
		const now = Date.now();
		if (now - lastLoadMoreAt < 400) return;
		lastLoadMoreAt = now;

		loadingMoreLogs = true;
		tailLines = Math.min(tailLines + LOG_PAGE_SIZE, LOG_MAX_LINES);
		fetchLogs({ preserveScroll: true }).finally(() => {
			loadingMoreLogs = false;
		});
	}

	function resetLogPagination() {
		tailLines = LOG_INITIAL_LINES;
		logsAtMax = false;
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
				description: deployment?.deployStrategy === 'recreate'
					? 'Recreate restart initiated'
					: 'Rolling restart initiated',
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

	async function checkTailscaleStatus() {
		try {
			const response = await apiFetch('/apiv1/tailscale/status');
			if (response.ok) {
				const data = await response.json();
				tailscaleLinked = data.linked;
			}
		} catch (e) {
			console.error('Failed to check Tailscale status:', e);
		}
	}

	async function fetchTailscaleDeploymentStatus() {
		if (!deployment?.tailscaleExposed) return;
		try {
			const response = await apiFetch(`/apiv1/tailscale/deployment/${deploymentId}`);
			if (response.ok) {
				const data = await response.json();
				tailscaleIp = data.ip;
				tailscaleDns = data.dns;
			}
		} catch (e) {
			console.error('Failed to fetch Tailscale deployment status:', e);
		}
	}

	async function exposeTailscale() {
		tailscaleExposing = true;
		try {
			const response = await apiFetch(`/apiv1/tailscale/expose/${deploymentId}`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to expose to Tailscale');
			}
			const data = await response.json();
			tailscaleHostname = data.hostname;
			toasts.add({
				title: 'Exposed to Tailscale',
				description: 'Sidecar is starting — address will appear shortly',
				color: 'success'
			});
			fetchDeployment();
			// Poll for the IP/DNS once the sidecar is ready
			setTimeout(fetchTailscaleDeploymentStatus, 5000);
			setTimeout(fetchTailscaleDeploymentStatus, 15000);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to expose to Tailscale',
				color: 'error'
			});
		} finally {
			tailscaleExposing = false;
		}
	}

	async function unexposeTailscale() {
		tailscaleUnexposing = true;
		try {
			const response = await apiFetch(`/apiv1/tailscale/unexpose/${deploymentId}`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to remove Tailscale exposure');
			}
			tailscaleHostname = null;
			tailscaleIp = null;
			tailscaleDns = null;
			toasts.add({
				title: 'Tailscale removed',
				description: 'Deployment is no longer exposed to Tailscale',
				color: 'success'
			});
			fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove Tailscale exposure',
				color: 'error'
			});
		} finally {
			tailscaleUnexposing = false;
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

	let portPublicBusyId: string | null = $state(null);

	async function togglePortPublic(serviceId: string, portId: string, currentlyEnabled: boolean) {
		portPublicBusyId = portId;
		try {
			const method = currentlyEnabled ? 'DELETE' : 'POST';
			const response = await apiFetch(
				`/apiv1/deployments/${deploymentId}/services/${serviceId}/ports/${portId}/public`,
				{ method }
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to toggle public exposure');
			}
			const res = await response.json();
			await fetchDeployment();
			toasts.add({
				title: currentlyEnabled ? 'Port unexposed' : 'Port exposed publicly',
				description:
					!currentlyEnabled && res?.host && res?.port
						? `Reachable at ${res.host}:${res.port}`
						: undefined,
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Public exposure failed',
				description: e instanceof Error ? e.message : 'Unknown error',
				color: 'danger'
			});
		} finally {
			portPublicBusyId = null;
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
		newDomainHost = `${randomPart}.${APP_DOMAIN}`;
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
	let logModalRender = $state(false);
	$effect(() => { if (logModalId) logModalRender = true; });
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
				body: JSON.stringify({ buildFromRoot, buildWithDepot, persistentBuildCache })
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
			resetLogPagination();
			fetchLogs();
		}
	});

	// Auto-scroll logs to bottom when they change — but only on initial load /
	// fresh tail, not when the user is scrolling up to load more historical lines
	// (that path manages its own scroll position).
	$effect(() => {
		if (logs && !loadingMoreLogs) {
			requestAnimationFrame(scrollLogsToBottom);
		}
	});

	// Build logs are refreshed by fetchDeployment, which is triggered by SSE
	// `build.changed` events. Just kick off a single fetch on transition.
	$effect(() => {
		if (deployment?.buildStatus === 'building') {
			fetchBuildLogs();
		}
	});

	// Pod logs: fetch once when the overview tab is active and selection changes.
	// Live tailing via SSE is a separate piece of work; for now logs only refresh
	// on tab activation, container switch, or manual refresh.
	$effect(() => {
		if (tabs.value === 'overview' && selectedPod && selectedContainer) {
			resetLogPagination();
			fetchLogs();
		}
	});

	let projectIngressesFetched = false;
	$effect(() => {
		const projectId = deployment?.project?.id;
		if (!projectId) return;
		if (tabs.value === 'network') {
			fetchProjectIngresses();
			projectIngressesFetched = true;
		}
	});

	$effect(() => {
		if (showDomainForm && !newDomainServiceKey) {
			newDomainServiceKey = domainServiceOptions[0]?.key ?? '';
		}
	});

	// Subscribe to SSE status changes for the current org.
	$effect(() => {
		const id = $selectedOrganization?.id;
		if (!id) {
			sseStatusValue = 'connecting';
			return;
		}
		const store = sseStatusFor(id);
		return store.subscribe((v) => { sseStatusValue = v; });
	});

	// Reset page state when navigating to a different deployment.
	$effect(() => {
		if (!deploymentId) return;
		const isNewRoute = deploymentId !== lastSeenDeploymentId;
		if (!isNewRoute) return;
		lastSeenDeploymentId = deploymentId;

		loading = true;
		error = null;
		deployment = null;
		lastQueryData = null;
		selectedPod = '';
		selectedContainer = '';
		manualPodSelection = false;
		logs = '';
		buildLogs = '';
		accumulatedBuildLogs = null;
		autoDeployFetched = false;
		projectIngressesFetched = false;

		if ($tailscaleEnabled) checkTailscaleStatus();
	});

	// SSE subscription — invalidates the TanStack query instead of fetching directly.
	let sseOrgId: string | null = null;
	$effect(() => {
		const orgIdForSse = $selectedOrganization?.id ?? null;
		const depId = deploymentId;
		untrack(() => {
			if (orgIdForSse === sseOrgId) return;
			sseOrgId = orgIdForSse;
			sseUnsub?.();
			if (!orgIdForSse) return;
			sseUnsub = subscribeOrgEvents(
				orgIdForSse,
				(ev) => {
					if (ev.id === depId || ev.projectId === deployment?.projectId) {
						queryClient.invalidateQueries({ queryKey: ['deployment', depId] });
					}
				},
				{ invalidateDependencies: [] },
			);
		});
	});

	// Adaptive polling is handled by TanStack Query's refetchInterval option
	// on deploymentQuery above — no manual setInterval needed.

	onMount(() => {
		// Reserve scrollbar space so switching between tall/short tabs doesn't shift the
		// centered max-w container left/right when the scrollbar appears/disappears.
		const mainEl = document.querySelector<HTMLElement>('main.flex-1');
		const prevGutter = mainEl?.style.scrollbarGutter ?? '';
		if (mainEl) mainEl.style.scrollbarGutter = 'stable';

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

		// movingicons.dev: by default each icon only animates when its own 14×14 wrapper
		// is hovered. Re-fire each icon's mouseenter when the user enters the parent
		// button/link, so the animation plays on parent hover everywhere.
		let lastHoverButton: HTMLElement | null = null;
		const iconHoverSelector = 'button, a, .dep-action-btn, .console-tab-btn, .console-source-btn, .console-action-btn, .console-icon-btn, .console-compact-item, .notification-item, .dep-list-row';
		const onIconHover = (e: PointerEvent) => {
			const btn = (e.target as HTMLElement | null)?.closest?.(iconHoverSelector) as HTMLElement | null;
			if (btn === lastHoverButton) return;
			lastHoverButton = btn;
			if (!btn) return;
			// @jis3r icons render as <div role="img" aria-label="..."> with inner svg.
			btn.querySelectorAll<HTMLElement>('[role="img"][aria-label]').forEach((iconWrap) => {
				iconWrap.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
			});
		};
		document.addEventListener('pointermove', onIconHover, { passive: true });

		// Velocity-aware press lift on action buttons + tabs. Hover lifts ~2px;
		// press compresses proportional to pointer speed at click; release overshoots.
		const detachPress = pressSpringDelegate(
			document.body,
			'.dep-action-btn, .dep-notif-btn, .dep-meta-tabs button, .console-action-btn, .console-icon-btn, .console-source-btn, .btn-icon, .btn, .tabs-trigger, .dep-tab, .console-compact-item, .notification-item, .dep-list-row:not(.dep-list-row--head)'
		);

		return () => {
			detachPress();
			if (mainEl) mainEl.style.scrollbarGutter = prevGutter;
			document.removeEventListener('pointermove', onIconHover);
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleKeydown);
			document.removeEventListener('mouseover', handleTsPointer, true);
		};
	});

	onDestroy(() => {
		stopBuildPolling();
		sseUnsub?.();
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

	// Lazy-load auto-deploy status when advanced tab is opened
	let autoDeployFetched = false;
	$effect(() => {
		if (tabs.value === 'settings' && deployment?.githubRepo && !autoDeployFetched) {
			autoDeployFetched = true;
			loadAutoDeployStatus();
			loadGitHubDeployments();
		}
	});

	// Fetch user's effective resource limits eagerly
	let quotaMeFetched = false;
	$effect(() => {
		const orgId = $selectedOrganization?.id;
		if (orgId && !quotaMeFetched) {
			quotaMeFetched = true;
			apiFetch(`/apiv1/organizations/${orgId}/quota/me`)
				.then((r) => (r.ok ? r.json() : null))
				.then((q) => {
					if (!q) return;
					if (q.effectiveLimit) {
						effectiveCpuLimit = q.effectiveLimit.cpuMilli ?? null;
						effectiveMemLimit = q.effectiveLimit.memoryBytes ?? null;
					}
				})
				.catch(() => {});
		}
	});

	// Lazy-load org quota defaults when resources tab is opened
	let orgQuotaFetched = false;
	$effect(() => {
		if (tabs.value === 'resources' && !orgQuotaFetched) {
			orgQuotaFetched = true;
			const orgId = $selectedOrganization?.id;
			if (orgId) {
				apiFetch(`/apiv1/organizations/${orgId}/quota`)
					.then((r) => (r.ok ? r.json() : null))
					.then((q) => {
						if (!q?.org) return;
						orgDefaultCpuMilli = q.org.defaultPodCpuMilli ?? null;
						orgDefaultMemoryBytes = q.org.defaultPodMemoryBytes ?? null;
					})
					.catch(() => {});
			}
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

	function handleViewBuildLogs() {
		buildModalStatus = 'failed';
		buildModalError = deployment?.buildError ?? null;
		accumulatedBuildLogs = deployment?.buildLogs ?? null;
		buildModalStep = null;
		buildModalWarnings = [];
		buildModalTimestamps = deployment?.buildStepTimestamps ?? null;
		showBuildModal = true;
	}

	function handleCloseBuildModal() {
		showBuildModal = false;
		showBuildCard = false;
		stopBuildPolling();
	}

	function handleSliderKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
			e.preventDefault();
			scaleReplicas = Math.max(0, scaleReplicas - 1);
		} else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
			e.preventDefault();
			scaleReplicas = Math.min(20, scaleReplicas + 1);
		}
	}
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
		{@const _activeBuild = deployment.imageHistory?.find((h) => h.isActive)}
		{@const _isBuilding = deployment.buildStatus === 'building' || deployment.buildStatus === 'queued' || deployment.buildStatus === 'pending'}
		{@const _buildFailed = deployment.buildStatus === 'failed'}
		{@const _activeFallbackMsg = _activeBuild?.commitSha
			? deployment.imageHistory?.find((h) => h.commitMessage && h.commitSha === _activeBuild.commitSha)?.commitMessage
			: undefined}
		{@const _commitLead = deployment.githubRepo
			? (_activeBuild
				? (_activeBuild.commitMessage || _activeFallbackMsg || null)
				: (_isBuilding
					? `Building from ${deployment.githubBranch || 'main'}…`
					: (_buildFailed ? 'Last build failed' : null)))
			: (deployment.image || null)}
		{@const _commitLeadMono = !deployment.githubRepo && !!deployment.image}
		<div class="space-y-5">
			<!-- Header -->
			<DeploymentHeader
				{deployment}
				{projectBgImage}
				{headerCollapsed}
				{springCollapse}
				{deploymentStatusChip}
				{sseDisconnected}
				{notificationSeverity}
				{notificationLabel}
				{notificationCount}
				bind:notificationsOpen
				bind:notificationsRender
				bind:notifBtnEl
				{notifPanelPos}
				{dismissedNotifications}
				{noPodsReady}
				{expandedWarningRaw}
				{repoUrl}
				{rebuilding}
				{restarting}
				{deleting}
				{actionAnim}
				{_isBuilding}
				onRebuild={rebuild}
				onRestart={restart}
				onShowDeleteModal={() => (showDeleteModal = true)}
				onTriggerActionAnim={triggerActionAnim}
				onDismissNotification={dismissNotification}
				onToggleWarningRaw={toggleWarningRaw}
				onViewBuildLogs={handleViewBuildLogs}
				{buildFailedNotifId}
				{podWarningNotifId}
				{humanizeWarning}
				{sanitizeLogs}
				{_commitLead}
				{_commitLeadMono}
				{_activeBuild}
				{_buildFailed}
				{branch}
			/>

			<!-- Tab nav -->
			<nav class="dep-tabs" {...tabs.triggerList}>
				<div class="dep-tabs-inner">
					{#each visibleTabs as tab, _ti}
						{@const Icon = tab.icon}
						<button
							class="tabs-trigger dep-tab"
							{...tabs.getTrigger(tab.id)}
							{@attach motionStagger({ index: _ti, stride: 0.03, from: { y: -6 } })}
							onmouseenter={() => triggerTabIconAnim(tab.id)}
						>
							<Icon class="dep-tab-icon" size={14} animate={tabIconAnim[tab.id] ?? false} />
							<span>{tab.label}</span>
						</button>
					{/each}
				</div>
			</nav>

			<!-- Unified alerts -->
			<DeploymentAlerts
				buildFailed={buildFailedActive}
				buildError={deployment?.buildError ?? ''}
				{noPodsReady}
				podWarnings={activePodWarnings}
				{resourcePressure}
				dismissedIds={dismissedNotifications}
				{sseDisconnected}
				onDismiss={dismissNotification}
				onViewLogs={handleViewBuildLogs}
				onGoToResources={() => { tabs.value = 'resources'; }}
			/>

			<!-- Tab panels -->
			{#each visibleTabs as tab}
				<section {...tabs.getContent(tab.id)} hidden={undefined} class="tab-panel">
					{#if tab.id === 'overview'}
						<OverviewTab
							{deployment}
							{activePods}
							bind:selectedPod
							bind:selectedContainer
							bind:scaleReplicas
							{logs}
							{logsLoading}
							{loadingMoreLogs}
							{logsAtMax}
							{tailLines}
							bind:logsOutputRef
							{consoleExpanded}
							{consoleAnimating}
							bind:consoleRef
							{consoleInlineRect}
							{isDragging}
							bind:sliderRef
							{sliderPercentage}
							{scaling}
							{deletingPod}
							bind:activeConsoleTab
							bind:terminalTabs
							bind:showNewShellMenu
							bind:showNewShellMenuRender
							bind:showLogsPodMenu
							bind:showLogsPodMenuRender
							onFetchLogs={fetchLogs}
							onScaleDeployment={scaleDeployment}
							onDeletePod={deletePod}
							onToggleConsoleExpand={toggleConsoleExpand}
							onHandleNewShell={handleNewShell}
							onOpenShell={openShell}
							onCloseTerminalTab={closeTerminalTab}
							onSelectLogsPod={selectLogsPod}
							onLogsScroll={onLogsScroll}
							onPointerDown={handlePointerDown}
							onPointerMove={handlePointerMove}
							onPointerUp={handlePointerUp}
							onPointerCancel={handlePointerCancel}
							onTrackClick={handleTrackClick}
							onSetTabMetrics={() => { tabs.value = 'metrics'; }}
							onKeydownSlider={handleSliderKeydown}
							{getStatusColor}
							{podLabel}
						/>
					{:else if tab.id === 'environment'}
						<EnvironmentTab
							bind:envVars
							{savingEnv}
							onSave={saveEnv}
						/>
					{:else if tab.id === 'resources'}
						<ResourcesTab
							{deployment}
							bind:resourceCpuMilli
							bind:resourceMemoryBytes
							{orgDefaultCpuMilli}
							{orgDefaultMemoryBytes}
							{effectiveCpuLimit}
							{effectiveMemLimit}
							bind:resourcesDirty
							{savingResources}
							{resourcePressure}
							{isImageSourceDeployment}
							bind:imageInput
							{imageDirty}
							{savingImage}
							onSaveResources={saveResources}
							onSaveImage={saveImage}
						/>
					{:else if tab.id === 'volumes'}
						<VolumesTab
							bind:volumes
							{savingVolumes}
							{hasPvcVolume}
							onSave={saveVolumes}
						/>
					{:else if tab.id === 'network'}
						<NetworkTab
							{deployment}
							tailscaleFeatureEnabled={$tailscaleEnabled}
							{tailscaleLinked}
							{tailscaleExposing}
							{tailscaleUnexposing}
							{tailscaleDns}
							{tailscaleIp}
							{tailscaleHostname}
							onExposeTailscale={exposeTailscale}
							onUnexposeTailscale={unexposeTailscale}
							bind:showServiceForm
							bind:newServiceForm
							{serviceFormError}
							bind:serviceEditForms
							{serviceEditErrors}
							{creatingService}
							{serviceSavingId}
							{serviceDeletingId}
							{portPublicBusyId}
							bind:isEditingServices
							onCreateService={createService}
							onSaveServicePorts={saveServicePorts}
							onDeleteService={deleteService}
							onToggleServiceEdit={toggleServiceEdit}
							onTogglePortPublic={togglePortPublic}
							onResetNewServiceForm={resetNewServiceForm}
							onUpdateNewServicePort={updateNewServicePort}
							onUpdateServiceEditPort={updateServiceEditPort}
							onCopyInternalUrl={copyInternalUrl}
							{copiedUrlId}
							bind:showDomainForm
							bind:newDomainHost
							bind:newDomainPath
							bind:newDomainTlsEnabled
							bind:newDomainServiceKey
							bind:showDomainAdvanced
							{creatingDomain}
							{domainFormError}
							{domainServiceOptions}
							{newDomainNormalizedHost}
							{newDomainNormalizedPath}
							{newDomainConflict}
							{deletingIngressId}
							onCreateDomain={createDomain}
							onDeleteIngress={deleteIngress}
							onResetDomainForm={resetDomainForm}
							onGenerateRandomDomain={generateRandomDomainForNew}
							{toasts}
						/>
					{:else if tab.id === 'metrics'}
						<div class="card rounded-2xl p-5">
							<DeploymentMetrics deploymentId={deployment?.id ?? null} />
						</div>
					{:else if tab.id === 'deploys'}
						<DeploysTab
							{deployment}
							{rebuilding}
							onRebuild={rebuild}
							onOpenLogModal={openLogModal}
							onRollback={rollbackToImage}
							onViewBuildLogs={handleViewBuildLogs}
							{isDockerImageDeployment}
							deploymentId={deployment.id}
							{webhookTokens}
							{webhookTokensLoading}
							{creatingWebhookToken}
							{deletingWebhookTokenId}
							onCreateToken={(label) => { newWebhookLabel = label; createWebhookToken(); }}
							onDeleteToken={deleteWebhookToken}
						/>
					{:else if tab.id === 'settings'}
						<SettingsTab
							{deployment}
							bind:strategyValue
							{savingStrategy}
							{hasPvcVolume}
							onSaveStrategy={saveStrategy}
							bind:buildFromRoot
							bind:buildWithDepot
							bind:persistentBuildCache
							{savingAdvanced}
							onSaveAdvanced={saveAdvanced}
							{autoDeployStatus}
							{autoDeployLoading}
							bind:autoDeployBranch
							{enablingAutoDeploy}
							{disablingAutoDeploy}
							{githubDeployments}
							{githubAppInstallUrl}
							{loadingAppInstallUrl}
							onEnableAutoDeploy={enableAutoDeploy}
							onDisableAutoDeploy={disableAutoDeploy}
							onOpenGitHubAppInstall={openGitHubAppInstall}
							bind:healthCheckEnabled
							bind:healthCheckType
							bind:healthCheckPath
							bind:healthCheckPort
							bind:healthCheckCommand
							bind:livenessEnabled
							bind:readinessEnabled
							bind:startupEnabled
							bind:healthCheckInterval
							bind:healthCheckTimeout
							bind:healthCheckRetries
							bind:startupFailureThreshold
							{savingHealthCheck}
							bind:isEditingHealthCheck
							onSaveHealthCheck={saveHealthCheck}
						/>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</div>

<!-- Build Progress Modal + Floating Card -->
<BuildProgressModal
	{deployment}
	bind:showBuildModal
	bind:showBuildModalRender
	{buildModalStatus}
	{buildModalStep}
	{buildModalError}
	{buildModalWarnings}
	{buildModalTimestamps}
	{accumulatedBuildLogs}
	{buildElapsed}
	{buildProgressValue}
	{canCancelBuild}
	{cancelingBuild}
	onMinimizeBuildModal={minimizeBuildModal}
	onCancelBuild={cancelBuildFromModal}
	onCloseBuildModal={handleCloseBuildModal}
	{formatBuildElapsed}
	bind:showBuildCard
	bind:showBuildCardRender
	onExpandBuildCard={expandBuildCard}
/>

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

{#if logModalRender}
	<div class="log-modal-backdrop" onclick={closeLogModal} {@attach motionBackdrop(() => !logModalId, () => {})}>
		<div class="log-modal" onclick={(e) => e.stopPropagation()} {@attach motionPopover({ closing: () => !logModalId, onClosed: () => { logModalRender = false; }, from: { y: 12, scale: 0.96, opacity: 0 }, stiffness: 480, damping: 30, mass: 0.9 })}>
			<div class="log-modal-header">
				<div class="log-modal-header-left">
					<Terminal size={16} class="h-4 w-4" style="color: var(--sidebar-text, #e0e0e0); opacity: 0.5;" />
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
					<BuildSteps logs={logModalContent} fill />
				{/if}
			</div>
		</div>
	</div>
{/if}

