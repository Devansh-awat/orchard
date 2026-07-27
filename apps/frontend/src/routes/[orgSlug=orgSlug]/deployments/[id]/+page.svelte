<script lang="ts">
	import './deployment-page.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { Tabs } from 'melt/builders';
	import { createQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { deploymentQueryOptions } from '$lib/queries/deployment';
	import { mergeInto, syncListBy, shallowEq } from '$lib/utils/sync';
	import { TailscaleController } from '$lib/components/deployment/tailscale.svelte';
	import { ServicesController } from '$lib/components/deployment/services.svelte';
	import {
		podLabel,
		getNewestPod,
		formatBuildElapsed,
		sanitizeLogs,
		envVarsToRaw,
		rawToEnvVars
	} from '$lib/components/deployment/deployment-helpers';
	import { resourceStatus } from '$lib/components/ui';
	import {
		apiFetch,
		toasts,
		isSuperAdmin,
		user,
		selectedOrganization,
		subscribeOrgEvents,
		sseStatusFor
	} from '$lib/stores';
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
		GitCommit,
		WifiOff,
		RotateCw
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
		Hammer,
		Terminal,
		Trash2,
		TriangleAlert,
		User,
		Wifi
	} from '@jis3r/icons';
	import { scale, fade, slide } from '$lib/utils/transitions';
	import { animate } from 'motion';
	import { MemoryStick } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import ResourcePicker from '$lib/components/ResourcePicker.svelte';
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
		motionStagger,
		motionPopover,
		motionBackdrop,
		cardTilt,
		pressSpringDelegate,
		functionalMotion
	} from '$lib/utils/motion.svelte';
	import {
		portal,
		ansiToHtml,
		formatCpu,
		formatMemory,
		formatRelativeTime,
		formatBuildDurationBetween
	} from '$lib/utils/format';
	import type {
		Pod,
		Service,
		ServicePortConfig,
		Ingress,
		IngressRoute,
		ImageHistory,
		Volume,
		AutoDeployStatus,
		GitHubAppInstallation,
		GitHubDeploymentRecord,
		ServicePortForm,
		ServiceFormState,
		WebhookToken,
		TerminalTabInfo
	} from '$lib/types/deployment';
	import {
		EnvironmentTab,
		VolumesTab,
		WebhooksTab,
		HistoryTab,
		ResourcesTab,
		OverviewTab,
		NetworkTab,
		AdvancedTab,
		DeploymentHeader,
		BuildProgressModal,
		DeploymentAlerts,
		DeploysTab,
		SettingsTab,
		ObserveTab,
		BuildTab
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
		{ id: 'overview', label: 'Overview', icon: ServerCog },
		{ id: 'environment', label: 'Environment', icon: Settings },
		{ id: 'resources', label: 'Resources', icon: Cpu },
		{ id: 'volumes', label: 'Storage', icon: HardDriveDownload },
		{ id: 'network', label: 'Network', icon: Wifi },
		{ id: 'observe', label: 'Observe', icon: Eye },
		{ id: 'deploys', label: 'Deploys', icon: History },
		{ id: 'build', label: 'Build', icon: Hammer },
		{ id: 'settings', label: 'Advanced', icon: SlidersHorizontal }
	] as const;

	type TabId = (typeof tabSections)[number]['id'];

	const advancedObservability = featureFlag('advanced-observability');

	const isDockerImageDeployment = $derived(!deployment?.githubRepo);
	const visibleTabs = $derived(
		tabSections.map((t) =>
			t.id === 'observe' && !$advancedObservability ? { ...t, label: 'Metrics', icon: Activity } : t
		)
	);

	function tabFromUrl(url: URL): TabId {
		const t = url.searchParams.get('tab');
		if (t === 'metrics') return 'observe';
		if (t === 'advanced') return 'settings';
		return t && visibleTabs.some((s) => s.id === t) ? (t as TabId) : 'overview';
	}

	// The URL is the single source of truth for the active tab. melt reads it
	// through the value getter and every change request funnels through gotoTab,
	// which rewrites the URL; two-way sync effects deadlocked under rapid clicks.
	const tabs = new Tabs<TabId>({
		value: () => tabFromUrl($page.url),
		onValueChange: (v) => gotoTab(v),
		loop: true
	});

	let observeView = $state<string>($page.url.searchParams.get('view') ?? 'metrics');

	function gotoTab(v: TabId, view?: string) {
		const url = new URL(window.location.href);
		const effView = view ?? untrack(() => observeView);
		const wantView = v === 'observe' && effView !== 'metrics' ? effView : null;
		if (v === 'overview') url.searchParams.delete('tab');
		else url.searchParams.set('tab', v);
		if (wantView) url.searchParams.set('view', wantView);
		else url.searchParams.delete('view');
		if (url.href !== window.location.href) {
			goto(url, { replaceState: true, keepFocus: true, noScroll: true });
		}
	}

	$effect(() => {
		const fromUrl = tabFromUrl($page.url);
		const v = $page.url.searchParams.get('view');
		untrack(() => {
			if (fromUrl === 'observe' && v && v !== observeView) observeView = v;
		});
	});

	$effect(() => {
		const view = observeView;
		untrack(() => gotoTab(tabs.value, view));
	});

	// movingicons.dev animations are gated on each icon's internal mouseenter. We want
	// the animation to fire when the user hovers the parent button, not just the
	// 14×14 icon target — so drive the icon's `animate` prop from button-level hover.
	let tabIconAnim = $state<Record<string, boolean>>({});
	function triggerTabIconAnim(id: string) {
		if (tabIconAnim[id]) return;
		tabIconAnim[id] = true;
		setTimeout(() => {
			tabIconAnim[id] = false;
		}, 650);
	}
	let actionAnim = $state<Record<string, boolean>>({});
	function triggerActionAnim(id: string) {
		if (actionAnim[id]) return;
		actionAnim[id] = true;
		setTimeout(() => {
			actionAnim[id] = false;
		}, 650);
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
				if (!functionalMotion()) {
					target.style.height = isCollapsed ? '0px' : 'auto';
					target.style.opacity = isCollapsed ? '0' : '1';
					if (!isCollapsed) target.style.marginTop = '';
					return;
				}
				const fullHeight = naturalHeight();
				const card = target.parentElement;
				if (isCollapsed) {
					// Height can't go below 0, so a spring to 0 can't bounce.
					// Instead: collapse height quickly with an eased tween,
					// then spring-bounce the parent card's Y to sell the motion.
					animate(
						target,
						{ height: 0 },
						{
							duration: 0.28,
							easing: [0.32, 0, 0.67, 0]
						}
					);
					if (card) {
						card.style.transformOrigin = 'top center';
						card.style.overflow = 'visible';
						animate(
							card,
							{ scaleY: 0.97 },
							{
								type: 'spring',
								stiffness: 500,
								damping: 10,
								mass: 0.5
							}
						).finished.then(() => {
							const ctrl = animate(
								card,
								{ scaleY: 1 },
								{
									type: 'spring',
									stiffness: 260,
									damping: 12,
									mass: 0.8
								}
							);
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
				animate(
					target,
					{ opacity: isCollapsed ? 0 : 1 },
					{
						type: 'spring',
						stiffness: 300,
						damping: 28
					}
				);
			});
		};
	}

	let deployment = $state<Deployment | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let projectBgImage = $derived(deployment?.project?.backgroundImage ?? null);

	let deletingIngressId = $state<string | null>(null);
	let protectionUpdatingId = $state<string | null>(null);
	let projectIngresses = $state<
		Array<{ id: string; host: string; path?: string; deploymentId?: string | null }>
	>([]);

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
			opts.push({
				key: `${s.id}::${s.port}`,
				label: `Port ${s.port}`,
				serviceName: s.name,
				port: s.port
			});
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

	// Auto-expand Advanced path input when domain already has routes
	$effect(() => {
		if (newDomainConflict) showDomainAdvanced = true;
	});

	// Computed properties for template compatibility with API field names
	const repoUrl = $derived(deployment?.githubRepo);
	const branch = $derived(deployment?.githubBranch);

	const buildFailedActive = $derived.by(
		() =>
			debugAlerts ||
			(deployment?.buildStatus === 'failed' && !!(deployment?.buildError || deployment?.buildLogs))
	);
	const activePodWarnings = $derived.by(() =>
		debugAlerts ? DEBUG_POD_WARNINGS : (deployment?.warnings ?? [])
	);
	// "App is down" only fires once no pod has been ready for a continuous
	// minute: pods flapping through restarts or a slow rollout shouldn't scream
	// that the app is offline, but a sustained zero-ready state must.
	const APP_DOWN_CONFIRM_MS = 60_000;
	const noPodsReadyNow = $derived(
		(deployment?.replicas ?? 0) > 0 && (deployment?.availableReplicas ?? 0) === 0
	);
	let noPodsReadyConfirmed = $state(false);
	let noPodsReadyTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (noPodsReadyNow) {
			noPodsReadyTimer ??= setTimeout(() => {
				noPodsReadyTimer = null;
				noPodsReadyConfirmed = true;
			}, APP_DOWN_CONFIRM_MS);
		} else {
			if (noPodsReadyTimer) {
				clearTimeout(noPodsReadyTimer);
				noPodsReadyTimer = null;
			}
			noPodsReadyConfirmed = false;
		}
		return () => {
			if (noPodsReadyTimer) {
				clearTimeout(noPodsReadyTimer);
				noPodsReadyTimer = null;
			}
		};
	});
	const noPodsReady = $derived(debugAlerts || noPodsReadyConfirmed);

	const deploymentStatusChip = $derived.by(() => {
		const forced = debugStatus;
		if (forced === 'building') return resourceStatus('', 'building');
		if (forced) return resourceStatus(forced);
		return resourceStatus(deployment?.status ?? '', deployment?.buildStatus);
	});
	const activePods = $derived(
		deployment?.pods?.filter((pod) => pod.status?.toLowerCase() !== 'succeeded') ?? []
	);

	let deletingPod = $state<string | null>(null);

	async function deletePod(podName: string) {
		if (!deployment?.namespace || deletingPod) return;
		deletingPod = podName;
		try {
			const res = await apiFetch(`/apiv1/pods/${podName}?namespace=${deployment.namespace}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to delete pod');
			}
			toasts.add({ title: 'Pod deleted', description: podName, color: 'success' });
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete pod',
				color: 'error'
			});
		} finally {
			deletingPod = null;
		}
	}

	let restarting = $state(false);
	let scaling = $state(false);
	let deleting = $state(false);
	let showDeleteModal = $state(false);
	let rebuilding = $state(false);
	let renameOpen = $state(false);
	let renamingApp = $state(false);
	let savingEnv = $state(false);
	let savingVolumes = $state(false);
	let savingAdvanced = $state(false);
	let savingService = $state(false);
	let buildFromRoot = $state(false);
	let buildWithDepot = $state(false);
	let persistentBuildCache = $state(false);

	const tailscaleEnabled = featureFlag('tailscale-integration');
	const tailscale = new TailscaleController({
		deploymentId: () => deploymentId,
		isExposed: () => !!deployment?.tailscaleExposed,
		refetch: fetchDeployment
	});

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
		if (debugAlerts) {
			return { cpuRatio: 0.93, memRatio: 0.97, cpuNear: true, memNear: true, any: true };
		}
		const replicas = deployment?.replicas ?? 1;
		const cpuReq = deployment?.cpuRequestMilli ?? null;
		const memReq =
			deployment?.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null;
		const cpuUsage = deployment?.totalCpuUsage ?? null;
		const memUsage = deployment?.totalMemoryUsage ?? null;

		const cpuRatio =
			cpuReq != null && cpuReq > 0 && cpuUsage != null && replicas > 0
				? cpuUsage / (cpuReq * replicas)
				: null;
		const memRatio =
			memReq != null && memReq > 0 && memUsage != null && replicas > 0
				? memUsage / (memReq * replicas)
				: null;

		const cpuNear = cpuRatio != null && cpuRatio >= NEAR_LIMIT_RATIO;
		const memNear = memRatio != null && memRatio >= NEAR_LIMIT_RATIO;
		return {
			cpuRatio,
			memRatio,
			cpuNear,
			memNear,
			any: cpuNear || memNear
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
				color: 'warning'
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
				body: JSON.stringify({ strategy: next })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update strategy');
			}
			toasts.add({ title: 'Strategy updated', color: 'success' });
			await fetchDeployment();
		} catch (e) {
			strategyValue = previous;
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed',
				color: 'error'
			});
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
				body: JSON.stringify({ image: imageInput.trim() })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update image');
			}
			toasts.add({
				title: 'Image updated',
				description: 'Pods will roll to pull the new image.',
				color: 'success'
			});
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed',
				color: 'error'
			});
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
					memoryRequestBytes: resourceMemoryBytes
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Failed to update resources');
			}
			toasts.add({
				title: 'Resources updated',
				description: 'Pods will roll to pick up the new values.',
				color: 'success'
			});
			resourcesDirty = false;
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed',
				color: 'error'
			});
		} finally {
			savingResources = false;
		}
	}

	let selectedPod = $state<string>('');
	let selectedContainer = $state<string>('');
	let manualPodSelection = $state(false);
	let buildLogs = $state<string>('');
	let buildLogsLoading = $state(false);

	// Console tab management: 'logs' or a terminal tab id
	let activeConsoleTab = $state<string>('logs');

	let terminalTabs = $state<TerminalTabInfo[]>([]);
	let terminalCounter = 0;

	function openShell(podName: string, container: string) {
		terminalCounter++;
		const id = `term-${Date.now()}`;
		const label = `Shell ${terminalCounter}`;
		terminalTabs = [...terminalTabs, { id, podName, container, label }];
		activeConsoleTab = id;
	}

	function closeTerminalTab(id: string) {
		terminalTabs = terminalTabs.filter((t) => t.id !== id);
		if (activeConsoleTab === id) {
			activeConsoleTab =
				terminalTabs.length > 0 ? terminalTabs[terminalTabs.length - 1].id : 'logs';
		}
	}

	function selectLogsPod(podName: string, containerName?: string) {
		selectedPod = podName;
		const pod = (deployment?.pods ?? []).find((p) => p.name === podName);
		selectedContainer = containerName || pod?.containers?.[0]?.name || '';
		manualPodSelection = true;
	}

	let scaleReplicas = $state(1);
	let sliderRef = $state<HTMLDivElement | null>(null);
	let isDragging = $state(false);
	let dragStartX = $state(0);
	let dragStartValue = $state(0);
	// True while the slider holds an unapplied user edit. Server refetches only
	// sync the slider when this is false, so a crash-looping pod (which refetches
	// constantly) can't snap the value back before the user clicks Scale.
	let scaleDirty = $state(false);

	function setScaleValue(value: number) {
		scaleReplicas = value;
		scaleDirty = value !== (deployment?.replicas ?? value);
	}

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
		setScaleValue(getValueFromPosition(event.clientX));
	}

	function handlePointerMove(event: PointerEvent) {
		if (!isDragging || !sliderRef) return;
		setScaleValue(getValueFromPosition(event.clientX));
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
		setScaleValue(dragStartValue);
	}

	function handleTrackClick(event: MouseEvent) {
		if (!sliderRef || isDragging) return;
		setScaleValue(getValueFromPosition(event.clientX));
	}

	const sliderPercentage = $derived((scaleReplicas / 20) * 100);

	let envVars = $state<Array<{ key: string; value: string; secret?: boolean }>>([
		{ key: '', value: '' }
	]);
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
			storageSize?: string;
			hostPath?: string;
			readOnly: boolean;
		}>
	>([]);
	let isEditingEnv = $state(false);
	let isEditingVolumes = $state(false);
	let isEditingBuildOptions = $state(false);
	const services = new ServicesController({
		deploymentId: () => deploymentId,
		getServices: () => deployment?.services ?? [],
		setDeployment: (d) => {
			deployment = d as Deployment;
		},
		refetch: fetchDeployment
	});

	// Build modal state
	let showBuildModal = $state(false);
	let expandedBuildLogId = $state<string | null>(null);
	let buildLogCache = $state<Record<string, string>>({});
	let buildLogLoading = $state<string | null>(null);
	let consoleExpanded = $state(false);
	let consoleAnimating = $state(false);
	let consoleRef = $state<HTMLDivElement | null>(null);
	let consoleInlineRect = $state<{
		top: number;
		left: number;
		width: number;
		height: number;
	} | null>(null);

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
				setTimeout(() => {
					consoleAnimating = false;
				}, 300);
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
	$effect(() => {
		if (showBuildCard && !showBuildModal) showBuildCardRender = true;
	});
	let buildStartTime = $state<number>(0);
	let buildElapsed = $state(0);
	let accumulatedBuildLogs = $state<string | null>(null);
	let buildElapsedInterval: ReturnType<typeof setInterval> | null = null;
	let buildModalStatus = $state<string>('pending');
	let buildModalStep = $state<string | null>(null);
	let buildModalError = $state<string | null>(null);
	let buildModalWarnings = $state<Array<{ podName: string; message: string; timestamp: string }>>(
		[]
	);
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
				throw new Error(data.message || 'Failed to cancel deployment');
			}
			toasts.add({
				title: 'Deployment cancelled',
				description: 'The deployment has been cancelled successfully',
				color: 'success'
			});
			stopBuildPolling();
			showBuildModal = false;
			showBuildCard = false;

			await new Promise((resolve) => setTimeout(resolve, 1000));
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to cancel deployment',
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

	const canCancelBuild = $derived(
		buildModalStatus === 'building' || buildModalStatus === 'pending'
	);

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
	let sseReloadPrompt = $state(false);

	const debugAlerts = $derived($page.url.searchParams.has('debugAlerts'));
	const debugStatus = $derived($page.url.searchParams.get('debugStatus'));
	const DEBUG_CHIPS = [
		resourceStatus('', 'building'),
		resourceStatus('pending'),
		resourceStatus('scaling'),
		resourceStatus('restarting'),
		resourceStatus('unhealthy'),
		resourceStatus('failed'),
		resourceStatus('stopped'),
		resourceStatus('deleting'),
		resourceStatus('')
	];
	const DEBUG_POD_WARNINGS = [
		{
			podName: 'heist-7f9c8b6d4-xk2lp',
			message: 'Back-off restarting failed container app in pod',
			timestamp: new Date().toISOString()
		},
		{
			podName: 'heist-7f9c8b6d4-mq81z',
			message:
				'0/6 nodes are available: 3 Insufficient memory, 3 Insufficient cpu. preemption: not eligible.',
			timestamp: new Date().toISOString()
		},
		{
			podName: 'heist-7f9c8b6d4-xk2lp',
			message: 'OOMKilled: container exceeded its memory limit',
			timestamp: new Date().toISOString()
		}
	];

	// ── TanStack Query: deployment data ──
	const TRANSIENT_DEPLOYMENT_STATUSES = new Set([
		'scaling',
		'restarting',
		'pending',
		'building',
		'unhealthy'
	]);
	const deploymentQuery = createQuery(() => ({
		...deploymentQueryOptions(deploymentId),
		enabled: !!deploymentId,
		refetchInterval: (() => {
			const status = (deployment?.status ?? '').toLowerCase();
			const buildSt = (deployment?.buildStatus ?? '').toLowerCase();
			const transient = TRANSIENT_DEPLOYMENT_STATUSES.has(status) || buildSt === 'building';
			const sseUp = sseStatusValue === 'connected';
			if (transient) return sseUp ? 15_000 : 3_000;
			if (!sseUp) return 10_000;
			if (activePodWarnings.length > 0) return 15_000;
			return 30_000;
		})(),
		refetchIntervalInBackground: true
	}));

	/** Trigger a refetch of deployment data via TanStack Query. All call sites
	 *  that previously called this function directly now just invalidate the cache
	 *  and the $effect below applies the new data. */
	function fetchDeployment() {
		queryClient.invalidateQueries({ queryKey: ['deployment', deploymentId] });
	}

	function applyPodDelta(payload: any) {
		if (!deployment?.pods || !payload?.name) return;
		const pods = deployment.pods as any[];
		const idx = pods.findIndex((p) => p.name === payload.name);
		if (payload.deleted) {
			if (idx >= 0) pods.splice(idx, 1);
			return;
		}
		if (idx < 0) return;
		const pod = pods[idx];
		pod.status = payload.status ?? pod.status;
		pod.restartCount = payload.restartCount ?? pod.restartCount;
		for (const c of pod.containers ?? []) {
			c.ready = payload.ready ?? c.ready;
			c.lastTermination = payload.lastTermination ?? c.lastTermination ?? null;
		}
	}

	function applyMetricsDelta(payload: any) {
		if (!deployment || payload?.totalCpuUsage == null) return;
		const podMetrics = payload.pods ?? {};
		deployment.totalCpuUsage = payload.totalCpuUsage;
		deployment.totalMemoryUsage = payload.totalMemoryUsage;
		for (const p of (deployment.pods as any[]) ?? []) {
			const m = podMetrics[p.name];
			if (m) {
				p.cpuUsage = m.cpuUsage;
				p.memoryUsage = m.memoryUsage;
			}
		}
	}

	let podsLiveInflight = false;
	async function refreshPodsLive() {
		if (!deployment || !deploymentId || podsLiveInflight) return;
		podsLiveInflight = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/pods-live`);
			if (!res.ok) return;
			const data = await res.json();
			if (!deployment) return;
			if (Array.isArray(data.pods)) {
				if (Array.isArray(deployment.pods)) syncListBy(deployment.pods, data.pods, 'name');
				else deployment.pods = data.pods;
			}
			if (data.warnings !== undefined && !shallowEq(deployment.warnings, data.warnings)) {
				deployment.warnings = data.warnings;
			}
			if (data.availableReplicas !== undefined) {
				deployment.availableReplicas = data.availableReplicas;
			}
			if (data.totalCpuUsage !== undefined) deployment.totalCpuUsage = data.totalCpuUsage;
			if (data.totalMemoryUsage !== undefined) deployment.totalMemoryUsage = data.totalMemoryUsage;
		} catch {
		} finally {
			podsLiveInflight = false;
		}
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
				error = qError instanceof Error ? qError.message : 'Failed to fetch app';
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

		// If a build is in progress — either transitioning during the session or
		// already running when the page loaded — surface it immediately. Show the
		// floating card on first load so we don't blast the modal over the page
		// the user just navigated to; show the modal when a build kicks off mid-session.
		if (data.buildStatus === 'building' && data.githubRepo && !showBuildModal && !showBuildCard) {
			if (wasUnloaded) {
				showBuildCard = true;
			} else {
				showBuildModal = true;
			}
			stopBuildPolling();
			startBuildPolling();
		}

		if (!deployment) {
			deployment = data;
		} else {
			mergeInto(deployment, data);
		}
		if (showBuildModal || showBuildCard) syncBuildModalFromDeployment();

		tailscale.syncFromDeployment(data);

		// Skip overwriting form state while a build is in progress so the user can
		// keep editing settings. Form state will refresh when the build finishes.
		const buildActive = showBuildModal || showBuildCard;

		if (!buildActive) {
			if (!isDragging && !scaling && !scaleDirty) {
				if (data.replicas !== undefined && data.replicas !== null) {
					scaleReplicas = data.replicas;
				} else {
					scaleReplicas = 1;
				}
			}
			if (!services.showForm) {
				services.resetNewForm();
			}

			if (!isEditingEnv) {
				if (data.envVars && Array.isArray(data.envVars) && data.envVars.length > 0) {
					envVars = [
						...data.envVars.map((ev: { key: string; value: string; secret?: boolean }) => ({
							key: ev.key || '',
							value: ev.value || '',
							secret: Boolean(ev.secret)
						})),
						{ key: '', value: '' }
					];
				} else {
					envVars = [{ key: '', value: '' }];
				}
			}

			if (!isEditingVolumes) {
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
			}

			if (!isEditingBuildOptions) {
				if (data.buildFromRoot !== undefined) {
					buildFromRoot = data.buildFromRoot;
				}
				buildWithDepot = data.buildWithDepot ?? false;
				persistentBuildCache = data.persistentBuildCache ?? false;
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

			// Sync resource state (unless user has unsaved edits).
			if (!resourcesDirty) {
				resourceCpuMilli = data.cpuRequestMilli ?? null;
				resourceMemoryBytes =
					data.memoryRequestBytes != null ? Number(data.memoryRequestBytes) : null;
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

	async function fetchBuildLogs() {
		if (!deployment || deployment.buildStatus !== 'building') return;

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
				throw new Error('Failed to restart app');
			}
			toasts.add({
				title: 'App restarting',
				description:
					deployment?.deployStrategy === 'recreate'
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

	async function scaleDeployment() {
		scaling = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/scale`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ replicas: scaleReplicas })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to scale app');
			}
			toasts.add({
				title: 'App scaled',
				description: `Scaled to ${scaleReplicas} replica(s)`,
				color: 'success'
			});
			scaleDirty = false;
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
				throw new Error(data.message || 'Failed to redeploy');
			}
			toasts.add({
				title: 'Deployment started',
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
				description: e instanceof Error ? e.message : 'Failed to redeploy',
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
				throw new Error(data.message || 'Failed to delete app');
			}
			toasts.add({
				title: 'App deleted',
				color: 'success'
			});
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

	async function updateProtection(ingressId: string, mode: string, password?: string) {
		if (!deployment?.project?.id) return;
		protectionUpdatingId = ingressId;
		try {
			const response = await apiFetch(
				`/apiv1/projects/${deployment.project.id}/ingresses/${ingressId}/protection`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ mode, password })
				}
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update protection');
			}
			toasts.add({
				title: mode === 'none' ? 'Protection disabled' : 'Protection enabled',
				color: 'success'
			});
			await fetchDeployment();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update protection',
				color: 'error'
			});
		} finally {
			protectionUpdatingId = null;
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

	const SLUG_ADJECTIVES = [
		'sunny',
		'mossy',
		'brave',
		'swift',
		'golden',
		'quiet',
		'wild',
		'fuzzy',
		'minty',
		'rosy',
		'lucky',
		'breezy',
		'peachy',
		'snowy',
		'zesty',
		'amber',
		'coral',
		'dapper',
		'misty',
		'tiny'
	];
	const SLUG_NOUNS = [
		'fox',
		'otter',
		'sprout',
		'acorn',
		'fern',
		'robin',
		'pebble',
		'willow',
		'comet',
		'badger',
		'plum',
		'birch',
		'wren',
		'clover',
		'hazel',
		'pine',
		'sage',
		'petal',
		'finch',
		'maple'
	];

	function generateRandomDomainForNew() {
		const adjective = SLUG_ADJECTIVES[Math.floor(Math.random() * SLUG_ADJECTIVES.length)];
		const noun = SLUG_NOUNS[Math.floor(Math.random() * SLUG_NOUNS.length)];
		const number = Math.floor(Math.random() * 90) + 10;
		newDomainHost = `${adjective}-${noun}-${number}.${APP_DOMAIN}`;
	}

	async function checkDomainDns(domain: string): Promise<{ valid: boolean; message: string }> {
		if (!deployment?.project?.id) throw new Error('Project not loaded');
		const response = await apiFetch('/apiv1/projects/ingresses/validate-dns', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: deployment.project.id, domain })
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.message || 'Failed to check DNS');
		return { valid: !!data.valid, message: data.message || '' };
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
						{
							path: newDomainNormalizedPath,
							serviceName: option.serviceName,
							servicePort: option.port
						}
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
	$effect(() => {
		if (logModalId) logModalRender = true;
	});
	let logModalContent = $state<string | null>(null);
	let logModalLoading = $state(false);

	async function openLogModal(historyId: string) {
		logModalId = historyId;
		logModalContent = buildLogCache[historyId] ?? null;
		if (logModalContent) return;
		logModalLoading = true;
		try {
			const response = await apiFetch(
				`/apiv1/deployments/${deploymentId}/image-history/${historyId}/logs`
			);
			if (!response.ok) throw new Error('Failed to fetch deployment logs');
			const data = await response.json();
			const logs = data.logs || 'No logs available.';
			buildLogCache[historyId] = logs;
			logModalContent = logs;
		} catch {
			const fallback = 'Failed to load deployment logs.';
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

	let rollingBackId = $state<string | null>(null);
	let rollbackTarget = $state<ImageHistory | null>(null);
	let showRollbackModal = $state(false);
	const rollbackTargetTag = $derived(rollbackTarget?.image.split(':').pop() ?? '');

	function requestRollback(historyId: string) {
		if (rollingBackId) return;
		const history = deployment?.imageHistory?.find((h) => h.id === historyId);
		if (!history) return;
		rollbackTarget = history;
		showRollbackModal = true;
	}

	function confirmRollback() {
		const id = rollbackTarget?.id;
		rollbackTarget = null;
		if (id) rollbackToImage(id);
	}

	async function rollbackToImage(historyId: string) {
		if (rollingBackId) return;
		rollingBackId = historyId;
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
		} finally {
			rollingBackId = null;
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
		volumes = [
			...volumes,
			{ name: '', type: 'pvc', mountPath: '', pvcName: '', storageSize: '1Gi', readOnly: false }
		];
	}

	function removeVolume(index: number) {
		volumes = volumes.filter((_, i) => i !== index);
	}

	let savingBuildConfig = $state(false);

	async function saveBuildConfig(body: Record<string, string | null>) {
		if (!deployment) return;
		savingBuildConfig = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/build-config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update build settings');
			}
			const updated = await response.json();
			if (deployment) mergeInto(deployment, updated);
			else deployment = updated;
			toasts.add({
				title: 'Build settings updated',
				description: 'They will apply on the next build',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update build settings',
				color: 'error'
			});
		} finally {
			savingBuildConfig = false;
		}
	}

	async function saveAdvanced() {
		if (!deployment) return;

		savingAdvanced = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/build-config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ buildFromRoot, buildWithDepot, persistentBuildCache })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update build settings');
			}

			const updated = await response.json();
			if (deployment) mergeInto(deployment, updated);
			else deployment = updated;
			isEditingBuildOptions = false;

			toasts.add({
				title: 'Settings updated',
				description: 'Build settings have been updated',
				color: 'success'
			});
		} catch (e) {
			isEditingBuildOptions = true;
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update build settings',
				color: 'error'
			});
		} finally {
			savingAdvanced = false;
		}
	}

	async function renameApp(name: string) {
		if (!deployment) return;
		renamingApp = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/name`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to rename');
			}
			const updated = await response.json();
			deployment.displayName = updated.displayName ?? null;
			renameOpen = false;
			toasts.add({ title: 'App renamed', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to rename',
				color: 'error'
			});
		} finally {
			renamingApp = false;
		}
	}

	function handleSourceUpdated(updated: Deployment) {
		if (deployment) mergeInto(deployment, updated);
		else deployment = updated;
		autoDeployBranch = '';
		loadAutoDeployStatus();
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
			if (deployment) mergeInto(deployment, updated);
			else deployment = updated;
			isEditingHealthCheck = false;

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
		}
	}

	async function loadAutoDeployStatus() {
		if (!deployment?.githubRepo) return;

		if (!autoDeployFetched) autoDeployLoading = true;
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/auto-deploy`);
			if (response.ok) {
				autoDeployStatus = await response.json();
				if (!autoDeployBranch) {
					autoDeployBranch = autoDeployStatus?.branch || deployment.githubBranch || '';
				}

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
			if (deployment) mergeInto(deployment, result);
			else deployment = result;

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

			const result = await response.json();
			if (deployment) mergeInto(deployment, result);
			else deployment = result;
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

	function normalizeVolumeName(raw: string): string {
		return raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 63);
	}

	function normalizeStorageSize(raw: string): string {
		const s = raw.trim();
		if (/^\d+(\.\d+)?$/.test(s)) return `${s}Gi`;
		const m = s.match(/^(\d+(?:\.\d+)?)\s*(gib?|mib?|tib?|gb|mb|tb)$/i);
		if (m) {
			const unit = m[2].toLowerCase();
			const suffix = unit.startsWith('g') ? 'Gi' : unit.startsWith('m') ? 'Mi' : 'Ti';
			return `${m[1]}${suffix}`;
		}
		return s;
	}

	async function saveVolumes() {
		savingVolumes = true;
		try {
			const filteredVolumes = volumes
				.filter((v) => v.pvcName?.trim() && v.mountPath.trim())
				.map((v) => ({
					// Preserve the existing k8s volume name. Substituting pvcName here
					// renamed the volume on every save, which orphaned the volumeMount
					// and broke the strategic-merge patch (400) for any volume whose
					// name differs from its pvcName. New volumes start with name='',
					// so fall back to pvcName only then.
					name: normalizeVolumeName(v.name?.trim() || v.pvcName!),
					type: 'pvc' as const,
					mountPath: v.mountPath.trim(),
					readOnly: v.readOnly,
					pvcName: normalizeVolumeName(v.pvcName!),
					storageSize: normalizeStorageSize(v.storageSize || '') || '1Gi'
				}));

			const response = await apiFetch(`/apiv1/deployments/${deploymentId}/volumes`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ volumes: filteredVolumes })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to update volumes');
			}

			toasts.add({
				title: 'Storage updated',
				description: 'Your app will restart with the new storage configuration.',
				color: 'success'
			});

			await fetchDeployment();
		} catch (e) {
			isEditingVolumes = true;
			toasts.add({
				title: 'Failed to update storage',
				description: e instanceof Error ? e.message : 'Failed to update storage',
				color: 'error'
			});
		} finally {
			savingVolumes = false;
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
		const startTime = Math.min(...keys.map((k) => ts[k]));
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

	// Build logs are refreshed by fetchDeployment, which is triggered by SSE
	// `build.changed` events. Just kick off a single fetch on transition.
	$effect(() => {
		if (deployment?.buildStatus === 'building') {
			fetchBuildLogs();
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
		return store.subscribe((v) => {
			sseStatusValue = v;
		});
	});

	$effect(() => {
		if (sseStatusValue !== 'disconnected') {
			sseReloadPrompt = false;
			return;
		}
		const t = setTimeout(() => {
			sseReloadPrompt = true;
		}, 6000);
		return () => clearTimeout(t);
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
		buildLogs = '';
		accumulatedBuildLogs = null;
		autoDeployFetched = false;
		projectIngressesFetched = false;

		if ($tailscaleEnabled) tailscale.checkStatus();
	});

	// SSE subscription — invalidates the TanStack query instead of fetching directly.
	let sseOrgId: string | null = null;
	$effect(() => {
		const orgIdForSse = $selectedOrganization?.id ?? null;
		untrack(() => {
			if (orgIdForSse === sseOrgId) return;
			sseOrgId = orgIdForSse;
			sseUnsub?.();
			if (!orgIdForSse) return;
			sseUnsub = subscribeOrgEvents(orgIdForSse, (ev) => {
				const currentId = deploymentId;
				const relevant = ev.id === currentId || ev.projectId === deployment?.projectId;
				if (!relevant) return;
				if (ev.type === 'deployment.metrics') {
					if (ev.id === currentId) applyMetricsDelta(ev.payload);
				} else if (ev.type === 'pod.changed' && ev.id === currentId) {
					applyPodDelta(ev.payload);
					refreshPodsLive();
				} else {
					queryClient.invalidateQueries({ queryKey: ['deployment', currentId] });
				}
			});
		});
	});

	onMount(() => {
		// Reserve scrollbar space so switching between tall/short tabs doesn't shift the
		// centered max-w container left/right when the scrollbar appears/disappears.
		const mainEl = document.querySelector<HTMLElement>('main.flex-1');
		const prevGutter = mainEl?.style.scrollbarGutter ?? '';
		if (mainEl) mainEl.style.scrollbarGutter = 'stable';

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
		const iconHoverSelector =
			'button, a, .dep-action-btn, .console-tab-btn, .console-source-btn, .console-action-btn, .console-icon-btn, .dep-list-row';
		const onIconHover = (e: PointerEvent) => {
			const btn = (e.target as HTMLElement | null)?.closest?.(
				iconHoverSelector
			) as HTMLElement | null;
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
			'.dep-action-btn, .dep-meta-tabs button, .console-action-btn, .console-icon-btn, .console-source-btn, .btn-icon, .btn, .tabs-trigger, .dep-tab, .dep-list-row:not(.dep-list-row--head)'
		);

		return () => {
			detachPress();
			if (mainEl) mainEl.style.scrollbarGutter = prevGutter;
			document.removeEventListener('pointermove', onIconHover);
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

	// Refetch webhook tokens every time the deploys tab becomes active. The
	// first fetch shows a loading state; later ones refresh silently so the
	// existing list stays visible.
	$effect(() => {
		if (tabs.value === 'deploys' && deploymentId) {
			untrack(() => fetchWebhookTokens());
		}
	});

	// Same for auto-deploy status + GitHub deployment history on the advanced tab.
	let autoDeployFetched = false;
	$effect(() => {
		if (tabs.value === 'settings' && deployment?.githubRepo) {
			untrack(() => {
				loadAutoDeployStatus();
				loadGitHubDeployments();
				autoDeployFetched = true;
			});
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
		if (!webhookTokensFetched) webhookTokensLoading = true;
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
			const response = await apiFetch(
				`/apiv1/deployments/${deploymentId}/webhook-tokens/${tokenId}`,
				{
					method: 'DELETE'
				}
			);
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
			setScaleValue(Math.max(0, scaleReplicas - 1));
		} else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
			e.preventDefault();
			setScaleValue(Math.min(20, scaleReplicas + 1));
		}
	}
</script>

<div class="deployment-page p-6 max-w-[100rem] mx-auto">
	{#if deployment?.project?.slug}
		<div class="mb-4">
			<Breadcrumb
				crumbs={[
					{ label: 'Home', href: `/${orgSlug}` },
					{
						label: deployment.project.name || deployment.project.slug,
						href: `/${orgSlug}/projects/${deployment.project.slug}`
					},
					{ label: deployment.name }
				]}
			/>
		</div>
	{:else}
		<div class="mb-4">
			<Breadcrumb
				crumbs={[{ label: 'Home', href: `/${orgSlug}` }, { label: deployment?.name || 'App' }]}
			/>
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
							<div
								class="h-6 w-16 rounded-full"
								style="background-color: var(--surface-border);"
							></div>
						</div>
						<div class="mt-3 flex flex-wrap items-center gap-3">
							<div
								class="h-5 w-24 rounded-full"
								style="background-color: var(--surface-border);"
							></div>
							<div class="h-4 w-40 rounded" style="background-color: var(--surface-border);"></div>
							<div
								class="h-5 w-16 rounded-full"
								style="background-color: var(--surface-border);"
							></div>
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
					{#each Array(6) as _, i (i)}
						<div
							class="h-10 w-28 shrink-0 rounded-xl"
							style="background-color: var(--surface-border);"
						></div>
					{/each}
				</div>
			</section>
		</div>
	{:else if deployment}
		{@const _activeBuild = deployment.imageHistory?.find((h) => h.isActive)}
		{@const _isBuilding =
			deployment.buildStatus === 'building' ||
			deployment.buildStatus === 'queued' ||
			deployment.buildStatus === 'pending'}
		{@const _buildFailed = deployment.buildStatus === 'failed'}
		{@const _activeFallbackMsg = _activeBuild?.commitSha
			? deployment.imageHistory?.find(
					(h) => h.commitMessage && h.commitSha === _activeBuild.commitSha
				)?.commitMessage
			: undefined}
		{@const _commitLead = deployment.githubRepo
			? _activeBuild
				? _activeBuild.commitMessage || _activeFallbackMsg || null
				: _isBuilding
					? `Deploying from ${deployment.githubBranch || 'main'}…`
					: _buildFailed
						? 'Last deployment failed'
						: null
			: deployment.image || null}
		{@const _commitLeadMono = !deployment.githubRepo && !!deployment.image}
		<div class="space-y-5">
			{#if sseReloadPrompt || debugAlerts}
				<div class="sse-reload-banner" role="alert" transition:slide={{ duration: 150 }}>
					<div class="sse-reload-icon"><WifiOff size={22} /></div>
					<div class="sse-reload-body">
						<span class="sse-reload-title">Live updates disconnected</span>
						<span class="sse-reload-text"
							>We lost the real-time connection and couldn't reconnect. What you're seeing may be
							out of date — reload to get the latest.</span
						>
					</div>
					<button class="sse-reload-btn" onclick={() => location.reload()}>
						<RotateCw size={16} />
						<span>Reload page</span>
					</button>
				</div>
			{/if}

			<DeploymentHeader
				{deployment}
				{projectBgImage}
				{headerCollapsed}
				{springCollapse}
				{deploymentStatusChip}
				debugChips={debugAlerts ? DEBUG_CHIPS : []}
				{repoUrl}
				{rebuilding}
				{restarting}
				{deleting}
				{actionAnim}
				{_isBuilding}
				onRebuild={rebuild}
				onRestart={restart}
				onRename={() => (renameOpen = true)}
				onShowDeleteModal={() => (showDeleteModal = true)}
				onTriggerActionAnim={triggerActionAnim}
				onViewBuildLogs={handleViewBuildLogs}
				{_commitLead}
				{_commitLeadMono}
				{_activeBuild}
				{_buildFailed}
				{branch}
			/>

			<!-- Tab nav -->
			<nav class="dep-tabs" {...tabs.triggerList}>
				<div class="dep-tabs-inner">
					{#each visibleTabs as tab, _ti (tab.id)}
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
				buildError={debugAlerts
					? $page.url.searchParams.get('debugAlerts') === 'github'
						? 'Build failed: ERROR: GitHub authentication failed.'
						: 'Build failed: process "/bin/sh -c npm ci" did not complete successfully: exit code 1'
					: (deployment?.buildError ?? '')}
				{noPodsReady}
				podWarnings={activePodWarnings}
				{resourcePressure}
				onViewLogs={handleViewBuildLogs}
				onGoToResources={() => {
					gotoTab('resources');
				}}
				githubRepoUrl={deployment?.githubRepo ?? ''}
				canReconnectGithub={!!deployment?.createdBy && deployment.createdBy === $user?.id}
				onReconnectGithub={() => {
					const back = $page.url.pathname + $page.url.search;
					window.location.href = '/apiv1/github/link?redirect=' + encodeURIComponent(back);
				}}
			/>

			{#if deployment?.queuedCommitSha}
				<div class="deploy-queue-banner">
					<Clock size={15} class="deploy-queue-icon" />
					<div class="deploy-queue-text">
						<span class="deploy-queue-title">Next deploy queued</span>
						<span class="deploy-queue-detail">
							<span class="deploy-queue-sha">{deployment.queuedCommitSha.slice(0, 7)}</span>
							{#if deployment.queuedCommitMessage}
								· {deployment.queuedCommitMessage.split('\n')[0]}
							{/if}
							· builds when the current one finishes
						</span>
					</div>
				</div>
			{/if}

			<!-- Tab panels -->
			{#each visibleTabs as tab (tab.id)}
				<section {...tabs.getContent(tab.id)} hidden={undefined} class="tab-panel">
					{#if tab.id === 'overview'}
						<OverviewTab
							{deployment}
							{activePods}
							bind:selectedPod
							bind:selectedContainer
							bind:scaleReplicas
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
							onScaleDeployment={scaleDeployment}
							onDeletePod={deletePod}
							onToggleConsoleExpand={toggleConsoleExpand}
							onOpenShell={openShell}
							onCloseTerminalTab={closeTerminalTab}
							onSelectLogsPod={selectLogsPod}
							onPointerDown={handlePointerDown}
							onPointerMove={handlePointerMove}
							onPointerUp={handlePointerUp}
							onPointerCancel={handlePointerCancel}
							onTrackClick={handleTrackClick}
							onSetTabMetrics={() => {
								observeView = 'metrics';
								gotoTab('observe');
							}}
							onKeydownSlider={handleSliderKeydown}
							{podLabel}
						/>
					{:else if tab.id === 'environment'}
						<EnvironmentTab
							bind:envVars
							bind:isEditing={isEditingEnv}
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
							bind:isEditing={isEditingVolumes}
							{savingVolumes}
							{hasPvcVolume}
							onSave={saveVolumes}
						/>
					{:else if tab.id === 'network'}
						<NetworkTab
							{deployment}
							tailscaleFeatureEnabled={$tailscaleEnabled}
							tailscaleLinked={tailscale.linked}
							tailscaleExposing={tailscale.exposing}
							tailscaleUnexposing={tailscale.unexposing}
							tailscaleDns={tailscale.dns}
							tailscaleIp={tailscale.ip}
							tailscaleHostname={tailscale.hostname}
							onExposeTailscale={() => tailscale.expose()}
							onUnexposeTailscale={() => tailscale.unexpose()}
							bind:showServiceForm={services.showForm}
							bind:newServiceForm={services.newForm}
							serviceFormError={services.formError}
							bind:serviceEditForms={services.editForms}
							serviceEditErrors={services.editErrors}
							creatingService={services.creating}
							serviceSavingId={services.savingId}
							serviceDeletingId={services.deletingId}
							portPublicBusyId={services.portPublicBusyId}
							bind:isEditingServices={services.isEditing}
							onCreateService={() => services.create()}
							onSaveServicePorts={(id) => services.savePorts(id)}
							onDeleteService={(id) => {
								if (
									confirm(
										'Remove this service? Its ports and any routing through them will stop working immediately.'
									)
								)
									services.delete(id);
							}}
							onToggleServiceEdit={(svc) => services.toggleEdit(svc)}
							onTogglePortPublic={(s, p, e) => services.togglePortPublic(s, p, e)}
							onResetNewServiceForm={() => services.resetNewForm()}
							onUpdateNewServicePort={(i, c) => services.updateNewPort(i, c)}
							onUpdateServiceEditPort={(id, i, c) => services.updateEditPort(id, i, c)}
							onCopyInternalUrl={(url, id) => services.copyInternalUrl(url, id)}
							copiedUrlId={services.copiedUrlId}
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
							onCheckDns={checkDomainDns}
							onUpdateProtection={updateProtection}
							{protectionUpdatingId}
							{toasts}
						/>
					{:else if tab.id === 'observe'}
						<div class="card rounded-2xl p-5">
							<ObserveTab
								{deployment}
								active={tabs.value === 'observe'}
								metricsOnly={!$advancedObservability}
								bind:activeTab={observeView}
							/>
						</div>
					{:else if tab.id === 'build'}
						<BuildTab {deployment} saving={savingBuildConfig} onSave={saveBuildConfig} />
					{:else if tab.id === 'deploys'}
						<DeploysTab
							{deployment}
							{rebuilding}
							{rollingBackId}
							onRebuild={rebuild}
							onOpenLogModal={openLogModal}
							onRollback={requestRollback}
							onViewBuildLogs={handleViewBuildLogs}
							{isDockerImageDeployment}
							deploymentId={deployment.id}
							{webhookTokens}
							{webhookTokensLoading}
							{creatingWebhookToken}
							{deletingWebhookTokenId}
							bind:newlyCreatedToken
							onCreateToken={(label) => {
								newWebhookLabel = label;
								createWebhookToken();
							}}
							onDeleteToken={deleteWebhookToken}
						/>
					{:else if tab.id === 'settings'}
						<SettingsTab
							{deployment}
							onSourceUpdated={handleSourceUpdated}
							onRebuild={rebuild}
							{rebuilding}
							bind:strategyValue
							{savingStrategy}
							{hasPvcVolume}
							onSaveStrategy={saveStrategy}
							bind:buildFromRoot
							bind:buildWithDepot
							bind:persistentBuildCache
							bind:buildOptionsDirty={isEditingBuildOptions}
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
	<RenameModal
		bind:open={renameOpen}
		title="Rename app"
		value={deployment.displayName || deployment.name}
		saving={renamingApp}
		onSave={renameApp}
	/>
	<ConfirmModal
		bind:open={showDeleteModal}
		title={`Delete "${deployment.displayName || deployment.name}"?`}
		description="This will permanently <strong>delete this app</strong> and all its associated services and ingresses. This cannot be undone."
		html
		confirmLabel="Delete App"
		onconfirm={deleteDeployment}
		oncancel={() => {}}
	/>
{/if}

{#if rollbackTarget}
	<ConfirmModal
		bind:open={showRollbackModal}
		title="Promote this image to production?"
		description={`Pods will roll to the image tagged <strong>${rollbackTargetTag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</strong>. The currently running image will be replaced.`}
		html
		confirmLabel="Promote"
		danger={false}
		onconfirm={confirmRollback}
		oncancel={() => (rollbackTarget = null)}
	/>
{/if}

{#if logModalRender}
	<div
		class="log-modal-backdrop"
		onclick={closeLogModal}
		{@attach motionBackdrop(
			() => !logModalId,
			() => {}
		)}
	>
		<div
			class="log-modal"
			onclick={(e) => e.stopPropagation()}
			{@attach motionPopover({
				closing: () => !logModalId,
				onClosed: () => {
					logModalRender = false;
				},
				from: { y: 12, scale: 0.96, opacity: 0 },
				stiffness: 480,
				damping: 30,
				mass: 0.9
			})}
		>
			<div class="log-modal-header">
				<div class="log-modal-header-left">
					<Terminal
						size={16}
						class="h-4 w-4"
						style="color: var(--sidebar-text, #e0e0e0); opacity: 0.5;"
					/>
					<p class="log-modal-title">Deployment Logs</p>
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
