<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { Tabs } from 'melt/builders';
	import { apiFetch, toasts, refreshTree, isSuperAdmin, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import { env } from '$env/dynamic/public';
	import { invalidate } from '$app/navigation';
	import type { PageData } from './$types';
	import { AnsiUp } from 'ansi_up';
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
	// movingicons.dev experiment: animated icons for select tab triggers and action
	// buttons. Auto-animates on hover via the icon's internal mouseenter handler.
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
	import AnimatedNumber from '$lib/components/AnimatedNumber.svelte';
	import BuildSteps from '$lib/components/BuildSteps.svelte';
	import PodTerminal from '$lib/components/PodTerminal.svelte';

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	const APP_DOMAIN = env.PUBLIC_APP_DOMAIN || 'a.lfdl.ink';
	const INGRESS_CNAME = env.PUBLIC_INGRESS_CNAME || 'ingress.lfdl.ink';
	const PUBLIC_DEPLOYMENT_DOMAIN = env.PUBLIC_DEPLOYMENT_DOMAIN || 'public.orchard.my';

	// ---- Pointer "hardness" tracker -------------------------------------------------
	// Tracks pointer velocity in real time. On press, callers read `pointerHardness()`
	// — a 0..1 value derived from velocity (mouse) or pressure (touch/stylus). Used to
	// modulate spring response: harder push → deeper compress + livelier release.
	let lastPointerX = 0;
	let lastPointerY = 0;
	let lastPointerT = 0;
	let lastPointerSpeed = 0;
	let lastPointerPressure = 0;
	if (browser) {
		const onPointerMove = (e: PointerEvent) => {
			const now = performance.now();
			const dt = Math.max(1, now - lastPointerT);
			const dx = e.clientX - lastPointerX;
			const dy = e.clientY - lastPointerY;
			const speed = Math.sqrt(dx * dx + dy * dy) / dt; // px/ms
			lastPointerSpeed = lastPointerSpeed * 0.6 + speed * 0.4;
			lastPointerX = e.clientX;
			lastPointerY = e.clientY;
			lastPointerT = now;
			if (e.pressure && e.pressure > 0 && e.pointerType !== 'mouse') {
				lastPointerPressure = e.pressure;
			}
		};
		window.addEventListener('pointermove', onPointerMove, { passive: true });
	}
	function pointerHardness(e?: PointerEvent): number {
		if (e && e.pressure && e.pressure > 0 && e.pointerType !== 'mouse') return e.pressure;
		if (lastPointerPressure > 0) return lastPointerPressure;
		// Map mouse speed (px/ms) to a 0..1 hardness; ~2 px/ms ≈ a firm flick.
		return Math.max(0, Math.min(1, lastPointerSpeed / 2));
	}

	// ---- Motion attachments -----------------------------------------------------------
	function springHover(opts: { rest?: number; lift?: number; stiffness?: number; damping?: number } = {}) {
		const rest = opts.rest ?? 0;
		const lift = opts.lift ?? -3;
		const stiffness = opts.stiffness ?? 380;
		const damping = opts.damping ?? 22;
		return (el: Element) => {
			const target = el as HTMLElement;
			const enter = () => animate(target, { y: lift }, { type: 'spring', stiffness, damping });
			const leave = () => animate(target, { y: rest, scale: 1 }, { type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 });
			const press = (e: Event) => {
				const h = pointerHardness(e as PointerEvent);
				// 0.97 (soft tap) → 0.92 (hard slam). Higher stiffness on harder press.
				const compress = 0.97 - h * 0.05;
				const k = 520 + h * 260;
				animate(target, { scale: compress }, { type: 'spring', stiffness: k, damping: 26 });
			};
			const release = () => {
				const h = lastPointerSpeed / 2;
				const overshoot = 1 + Math.max(0, Math.min(1, h)) * 0.025;
				animate(target, { scale: [null, overshoot, 1] as any }, { type: 'spring', stiffness: 420, damping: 14, mass: 0.7 });
			};
			target.addEventListener('mouseenter', enter);
			target.addEventListener('mouseleave', leave);
			target.addEventListener('pointerdown', press);
			target.addEventListener('pointerup', release);
			target.addEventListener('pointerleave', release);
			return () => {
				target.removeEventListener('mouseenter', enter);
				target.removeEventListener('mouseleave', leave);
				target.removeEventListener('pointerdown', press);
				target.removeEventListener('pointerup', release);
				target.removeEventListener('pointerleave', release);
			};
		};
	}

	function motionStagger(opts: {
		index?: number;
		stride?: number;
		from?: { y?: number; opacity?: number; scale?: number };
		stiffness?: number;
		damping?: number;
		mass?: number;
	} = {}) {
		const i = opts.index ?? 0;
		const stride = opts.stride ?? 0.04;
		const from = {
			y: opts.from?.y ?? 8,
			opacity: opts.from?.opacity ?? 0,
			scale: opts.from?.scale ?? 0.99
		};
		return (el: Element) => {
			animate(
				el as HTMLElement,
				{ opacity: [from.opacity, 1], y: [from.y, 0], scale: [from.scale, 1] },
				{
					type: 'spring',
					stiffness: opts.stiffness ?? 280,
					damping: opts.damping ?? 24,
					mass: opts.mass ?? 0.85,
					delay: i * stride
				}
			);
		};
	}

	function motionPopover(opts: {
		from?: { opacity?: number; scale?: number; y?: number };
		stiffness?: number;
		damping?: number;
		mass?: number;
		closing: () => boolean;
		onClosed: () => void;
	}) {
		const from = {
			opacity: opts.from?.opacity ?? 0,
			scale: opts.from?.scale ?? 0.94,
			y: opts.from?.y ?? -4
		};
		const stiffness = opts.stiffness ?? 520;
		const damping = opts.damping ?? 30;
		const mass = opts.mass ?? 0.85;
		return (el: Element) => {
			const target = el as HTMLElement;
			animate(
				target,
				{ opacity: [from.opacity, 1], scale: [from.scale, 1], y: [from.y, 0] },
				{ type: 'spring', stiffness, damping, mass }
			);
			let firstRun = true;
			$effect(() => {
				const closing = opts.closing();
				if (firstRun) { firstRun = false; return; }
				if (closing) {
					animate(
						target,
						{ opacity: from.opacity, scale: from.scale, y: from.y },
						{ type: 'spring', stiffness: stiffness * 1.1, damping: damping + 6, mass }
					).finished.then(() => {
						if (opts.closing()) opts.onClosed();
					});
				} else {
					animate(target, { opacity: 1, scale: 1, y: 0 }, { type: 'spring', stiffness, damping, mass });
				}
			});
		};
	}

	// Backdrop fade — pairs with motionPopover for modals.
	function motionBackdrop(closing: () => boolean, onClosed: () => void) {
		return (el: Element) => {
			const target = el as HTMLElement;
			animate(target, { opacity: [0, 1] }, { type: 'spring', stiffness: 320, damping: 30 });
			let firstRun = true;
			$effect(() => {
				const c = closing();
				if (firstRun) { firstRun = false; return; }
				if (c) {
					animate(target, { opacity: 0 }, { type: 'spring', stiffness: 360, damping: 32 })
						.finished.then(() => { if (closing()) onClosed(); });
				}
			});
		};
	}

	// Cursor-tracking 3D tilt — composes with springHover (different transform components).
	function cardTilt(opts: { max?: number } = {}) {
		const max = opts.max ?? 4;
		return (el: Element) => {
			const target = el as HTMLElement;
			target.style.transformStyle = 'preserve-3d';
			target.style.perspective = '1000px';
			let rect: DOMRect | null = null;
			const onEnter = () => { rect = target.getBoundingClientRect(); };
			const onMove = (e: PointerEvent) => {
				if (!rect) rect = target.getBoundingClientRect();
				const x = (e.clientX - rect.left) / rect.width - 0.5;
				const y = (e.clientY - rect.top) / rect.height - 0.5;
				animate(target, { rotateX: -y * max, rotateY: x * max }, { type: 'spring', stiffness: 380, damping: 28, mass: 0.5 });
			};
			const onLeave = () => {
				animate(target, { rotateX: 0, rotateY: 0 }, { type: 'spring', stiffness: 250, damping: 32 });
				rect = null;
			};
			target.addEventListener('pointerenter', onEnter);
			target.addEventListener('pointermove', onMove);
			target.addEventListener('pointerleave', onLeave);
			return () => {
				target.removeEventListener('pointerenter', onEnter);
				target.removeEventListener('pointermove', onMove);
				target.removeEventListener('pointerleave', onLeave);
			};
		};
	}

	// Scroll-velocity-aware "rubber" — content micro-shifts based on wheel intensity,
	// then springs back. Captures the "react to how hard you scroll" feel.
	function scrollRubber(opts: { axis?: 'y' | 'x'; max?: number; stiffness?: number; damping?: number } = {}) {
		const axis = opts.axis ?? 'y';
		const max = opts.max ?? 6;
		const stiffness = opts.stiffness ?? 420;
		const damping = opts.damping ?? 22;
		return (el: Element) => {
			const target = el as HTMLElement;
			let raf = 0;
			let pending = 0;
			const settle = () => {
				animate(target, { [axis]: 0 } as any, { type: 'spring', stiffness, damping, mass: 0.6 });
				raf = 0;
				pending = 0;
			};
			const onWheel = (e: WheelEvent) => {
				const delta = axis === 'y' ? e.deltaY : e.deltaX;
				// Only apply rubber when at scroll bounds.
				const atTop = target.scrollTop <= 0 && delta < 0;
				const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1 && delta > 0;
				if (axis === 'y' && !atTop && !atBottom) return;
				const intensity = Math.max(-1, Math.min(1, delta / 200));
				pending = Math.max(-max, Math.min(max, pending - intensity * max * 0.6));
				animate(target, { [axis]: pending } as any, { type: 'spring', stiffness: 600, damping: 30 });
				if (raf) clearTimeout(raf);
				raf = window.setTimeout(settle, 120);
			};
			target.addEventListener('wheel', onWheel, { passive: true });
			return () => {
				target.removeEventListener('wheel', onWheel);
				if (raf) clearTimeout(raf);
			};
		};
	}

	// Delegated press-spring for any descendant matching `selector` — wires hover/press
	// once at mount, so we don't need {@attach} on every button.
	function pressSpringDelegate(root: HTMLElement, selector: string) {
		let hovered: HTMLElement | null = null;
		const onMove = (e: PointerEvent) => {
			const t = (e.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
			if (t === hovered) return;
			if (hovered && !t?.contains(hovered) && !hovered.contains(t as Node)) {
				animate(hovered, { y: 0, scale: 1 }, { type: 'spring', stiffness: 320, damping: 28 });
			}
			if (t && root.contains(t)) {
				animate(t, { y: -2, scale: 1.02 }, { type: 'spring', stiffness: 380, damping: 22 });
			}
			hovered = t;
		};
		const onLeaveRoot = () => {
			if (hovered) {
				animate(hovered, { y: 0, scale: 1 }, { type: 'spring', stiffness: 320, damping: 28 });
				hovered = null;
			}
		};
		const onDown = (e: PointerEvent) => {
			const t = (e.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
			if (!t || !root.contains(t)) return;
			const h = pointerHardness(e);
			// 0.95 (soft tap) → 0.86 (hard slam)
			const compress = 0.95 - h * 0.09;
			const k = 540 + h * 320;
			animate(t, { scale: compress, y: -2 }, { type: 'spring', stiffness: k, damping: 26 });
		};
		const onUp = (e: PointerEvent) => {
			const t = (e.target as HTMLElement | null)?.closest?.(selector) as HTMLElement | null;
			if (!t || !root.contains(t)) return;
			const h = Math.max(0, Math.min(1, lastPointerSpeed / 2));
			// Harder press → bigger overshoot (1.08 → 1.14)
			const overshoot = 1.08 + h * 0.06;
			const settle = t === hovered ? 1.02 : 1;
			const settleY = t === hovered ? -2 : 0;
			animate(t, { scale: [null, overshoot, settle] as any, y: settleY }, { type: 'spring', stiffness: 380, damping: 12, mass: 0.7 });
		};
		root.addEventListener('pointermove', onMove, { passive: true });
		root.addEventListener('pointerleave', onLeaveRoot);
		root.addEventListener('pointerdown', onDown);
		root.addEventListener('pointerup', onUp);
		root.addEventListener('pointercancel', onUp);
		return () => {
			root.removeEventListener('pointermove', onMove);
			root.removeEventListener('pointerleave', onLeaveRoot);
			root.removeEventListener('pointerdown', onDown);
			root.removeEventListener('pointerup', onUp);
			root.removeEventListener('pointercancel', onUp);
		};
	}

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

	function formatBuildDurationBetween(startedAt?: string, completedAt?: string): string | null {
		if (!startedAt || !completedAt) return null;
		const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		if (!isFinite(ms) || ms < 0) return null;
		return formatBuildDuration(Math.round(ms / 1000));
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
		id?: string;
		name?: string;
		port: number;
		targetPort: number;
		protocol: string;
		nodePort?: number | null;
		publicEnabled?: boolean;
		publicPort?: number | null;
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
		commitAuthorName?: string;
		commitAuthorUsername?: string;
		buildStartedAt?: string;
		buildCompletedAt?: string;
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
			id: 'metrics',
			label: 'Metrics',
			description: 'Live charts & history',
			icon: Activity
		},
		{
			id: 'volumes',
			label: 'Storage',
			description: 'Persistent storage',
			icon: HardDriveDownload
		},
		{
			id: 'network',
			label: 'Network',
			description: 'Ports & domains',
			icon: Wifi
		},
		{
			id: 'history',
			label: 'Deployments',
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
			id: 'audit',
			label: 'Audit Log',
			description: 'Recent activity on this deployment',
			icon: ClipboardList
		},
		{
			id: 'advanced',
			label: 'Advanced',
			description: 'Build options & settings',
			icon: SlidersHorizontal
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
			const naturalMargin = parseFloat(getComputedStyle(target).marginTop) || 0;
			const naturalHeight = () => {
				const prev = target.style.height;
				target.style.height = 'auto';
				const h = target.scrollHeight;
				target.style.height = prev;
				return h;
			};
			// Arm the spring after a short grace period so any post-hydration noise on
			// tabs.value (briefly undefined / re-asserted to 'overview') doesn't trigger
			// a spurious collapse→expand animation on first paint.
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
				// Snap margin-top immediately so the inner content sits at its final
				// vertical offset from frame 1 — animating it alongside height makes the
				// text appear "too high" until both settle.
				target.style.marginTop = isCollapsed ? '0px' : `${naturalMargin}px`;
				const to = isCollapsed ? 0 : naturalHeight();
				const opts = isCollapsed
					? { type: 'spring' as const, stiffness: 200, damping: 18, mass: 1.2 }
					: { type: 'spring' as const, stiffness: 180, damping: 16, mass: 1.3 };
				const ctrl = animate(
					target,
					{ height: to, opacity: isCollapsed ? 0 : 1 },
					opts
				);
				if (!isCollapsed) {
					ctrl.finished.then(() => {
						if (!collapsed()) {
							target.style.height = 'auto';
							target.style.marginTop = '';
						}
					});
				}
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
	const notificationSeverity = $derived<'error' | 'warning' | null>(
		buildFailedActive ? 'error' : (activePodWarnings.length > 0 ? 'warning' : null)
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

	// Tailscale state
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

	async function fetchDeployment() {
		try {
			const response = await apiFetch(`/apiv1/deployments/${deploymentId}`);
			if (!response.ok) {
				throw new Error('Failed to fetch deployment');
			}
			const data = await response.json();

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
		} catch (e) {
			if (!deployment) {
				error = e instanceof Error ? e.message : 'Failed to fetch deployment';
			}
		} finally {
			loading = false;
		}
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

	$effect(() => {
		if (!deploymentId) return;

		const isNewRoute = deploymentId !== lastSeenDeploymentId;
		if (!isNewRoute) {
			// Loader re-ran because of an SSE-triggered invalidate(). The SSE
			// handler already calls fetchDeployment to refresh data; we don't
			// need to reset page state or re-subscribe.
			return;
		}
		lastSeenDeploymentId = deploymentId;

		loading = true;
		error = null;
		deployment = null;
		selectedPod = '';
		selectedContainer = '';
		manualPodSelection = false;
		logs = '';
		buildLogs = '';
		accumulatedBuildLogs = null;
		autoDeployFetched = false;
		projectIngressesFetched = false;

		// Seed from streamed loader (instant render on hover-prefetched nav).
		// All live updates come via SSE — no client-side polling.
		data.deploymentPromise
			.then((seed: any) => {
				if (!deployment && deploymentId === data.deploymentId) {
					deployment = seed;
					loading = false;
					loadDismissedNotifications();
				}
			})
			.catch(() => {});
		fetchDeployment();
		checkTailscaleStatus();

		sseUnsub?.();
		const orgIdForSse = $selectedOrganization?.id;
		if (orgIdForSse) {
			sseUnsub = subscribeOrgEvents(
				orgIdForSse,
				(ev) => {
					if (ev.id === deploymentId || ev.projectId === deployment?.projectId) {
						fetchDeployment();
					}
				},
				// No invalidateDependencies: the SSE handler refetches directly.
				// Re-running the loader would force the $effect to redo a hard
				// reset and flicker the skeleton.
				{ invalidateDependencies: [] },
			);
		}
	});

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
		if (tabs.value === 'advanced' && deployment?.githubRepo && !autoDeployFetched) {
			autoDeployFetched = true;
			loadAutoDeployStatus();
			loadGitHubDeployments();
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
			<!-- Header: deployment identity + status + actions + active build -->
			<section
				class="dep-header dep-header-card"
				class:dep-header-card--hasbg={!!projectBgImage}
				class:dep-header-card--collapsed={headerCollapsed}
				{@attach motionStagger({ index: 0, from: { y: 14, scale: 0.985 } })}
				{@attach cardTilt({ max: 2 })}
			>
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
						<h1 class="dep-header-name">{deployment.name}</h1>
						<span class="dep-status-chip dep-status-chip--{deploymentStatusChip.tone}">
							<span class="dep-status-dot"></span>
							{deploymentStatusChip.label}
						</span>
					</div>
					<div class="dep-header-actions">
						{#if notificationSeverity}
							<div class="relative">
								<button
									bind:this={notifBtnEl}
									class="dep-alert-pill dep-alert-pill--{notificationSeverity}"
									onclick={() => notificationsOpen = !notificationsOpen}
									title="Open notifications"
								>
									{#if notificationSeverity === 'error'}
										<CircleX class="h-3.5 w-3.5" />
									{:else}
										<TriangleAlert class="h-3.5 w-3.5" />
									{/if}
									<span class="dep-alert-pill-label">{notificationLabel}</span>
									{#if notificationCount > 1}
										<span class="dep-alert-pill-count">{notificationCount}</span>
									{/if}
								</button>

								{#if notificationsRender}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div class="notification-backdrop" use:portal onclick={() => notificationsOpen = false} {@attach motionBackdrop(() => !notificationsOpen, () => {})}></div>
									<div class="notification-panel" use:portal style="top: {notifPanelPos.top}px; left: {notifPanelPos.left}px; transform-origin: top right;" {@attach motionPopover({ closing: () => !notificationsOpen, onClosed: () => { notificationsRender = false; }, from: { y: -8, scale: 0.96, opacity: 0 } })}>
										<div class="flex items-center justify-between px-4 py-3" style="border-bottom: 1px solid var(--surface-border);">
											<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Notifications</p>
											<button class="btn-icon rounded-md p-1" onclick={() => notificationsOpen = false}>
												<X class="h-3.5 w-3.5" />
											</button>
										</div>
										<div class="notification-scroll">
											{#if deployment.buildStatus === 'failed' && (deployment.buildError || deployment.buildLogs)}
												{@const _bfId = buildFailedNotifId(deployment)}
												{#if !dismissedNotifications.has(_bfId)}
													<div class="notification-item">
														<div class="flex items-start gap-3">
															<div class="notification-icon notification-icon-error">
																<CircleX size={16} class="h-4 w-4" />
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
															<button
																class="notification-dismiss"
																title="Dismiss"
																aria-label="Dismiss notification"
																onclick={() => dismissNotification(_bfId)}
															>
																<X class="h-3 w-3" />
															</button>
														</div>
													</div>
												{/if}
											{/if}
											{#if deployment.warnings?.length}
												{#each deployment.warnings as warning}
													{@const _pwId = podWarningNotifId(warning)}
													{#if !dismissedNotifications.has(_pwId)}
														<div class="notification-item">
															<div class="flex items-start gap-3">
																<div class="notification-icon notification-icon-warning">
																	<TriangleAlert size={16} class="h-4 w-4" />
																</div>
																<div class="flex-1 min-w-0">
																	<p class="text-xs font-semibold" style="color: var(--warning-text);">Pod warning</p>
																	<p class="mt-0.5 font-mono text-xs font-medium" style="color: var(--surface-muted);">{warning.podName}</p>
																	<p class="mt-0.5 text-xs" style="color: var(--center-channel-color); opacity: 0.75;">{warning.message}</p>
																	{#if warning.timestamp}
																		<p class="mt-1 text-[10px]" style="color: var(--surface-muted);">{new Date(warning.timestamp).toLocaleTimeString()}</p>
																	{/if}
																</div>
																<button
																	class="notification-dismiss"
																	title="Dismiss"
																	aria-label="Dismiss notification"
																	onclick={() => dismissNotification(_pwId)}
																>
																	<X class="h-3 w-3" />
																</button>
															</div>
														</div>
													{/if}
												{/each}
											{/if}
											{#if notificationCount === 0}
												<p class="notification-empty">No notifications</p>
											{/if}
										</div>
									</div>
								{/if}
							</div>
						{/if}
						{#if repoUrl}
							<button onclick={rebuild} disabled={rebuilding || _isBuilding} class="btn btn-secondary btn-sm" onmouseenter={() => triggerActionAnim('redeploy')}>
								{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw size={14} animate={actionAnim.redeploy ?? false} />{/if}
								<span>Redeploy</span>
							</button>
						{/if}
						<button onclick={restart} disabled={restarting} class="btn btn-secondary btn-sm" onmouseenter={() => triggerActionAnim('restart')}>
							{#if restarting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play size={14} animate={actionAnim.restart ?? false} />{/if}
							<span>Restart</span>
						</button>
						<button onclick={() => (showDeleteModal = true)} disabled={deleting} class="btn btn-sm dep-delete-btn" onmouseenter={() => triggerActionAnim('delete')}>
							{#if deleting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 size={14} animate={actionAnim.delete ?? false} />{/if}
						</button>
					</div>
				</div>

				<!-- Body: meta + domains. Spring-collapses when the user leaves Overview. -->
				<div class="dep-header-body" {@attach springCollapse(() => headerCollapsed)}>
					<p class="dep-header-meta">
						{#if _commitLead}
							{#if deployment.githubRepo && _activeBuild?.commitSha}
								<a
									href="{deployment.githubRepo.replace(/\.git$/, '')}/commit/{_activeBuild.commitSha}"
									target="_blank"
									rel="noopener noreferrer"
									class="dep-meta-lead dep-meta-lead-link"
									class:dep-meta-mono={_commitLeadMono}
								>{_commitLead}</a>
							{:else}
								<span class="dep-meta-lead" class:dep-meta-mono={_commitLeadMono}>{_commitLead}</span>
							{/if}
						{/if}
						{#if deployment.githubRepo}
							{#if _commitLead}<span class="dep-meta-dot">·</span>{/if}
							<a href={deployment.githubRepo.replace(/\.git$/, '')} target="_blank" rel="noopener noreferrer" class="dep-meta-link">
								{deployment.githubRepo.replace('https://github.com/', '').replace(/\.git$/, '')}
							</a>
						{/if}
						{#if _activeBuild?.branch || branch}
							{#if deployment.githubRepo}<span class="dep-meta-dot">·</span>{/if}
							<span class="dep-meta-mono">{_activeBuild?.branch || branch}</span>
						{/if}
						{#if _activeBuild}
							<span class="dep-meta-dot">·</span>
							<span>{(() => {
								const diff = Date.now() - new Date(_activeBuild.createdAt).getTime();
								const mins = Math.floor(diff / 60000);
								if (mins < 1) return 'just now';
								if (mins < 60) return `${mins}m ago`;
								const hrs = Math.floor(mins / 60);
								if (hrs < 24) return `${hrs}h ago`;
								const days = Math.floor(hrs / 24);
								if (days < 30) return `${days}d ago`;
								return new Date(_activeBuild.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
							})()}</span>
							{#if _activeBuild.triggerType === 'manual' && _activeBuild.triggeredBy}
								<span>by</span>
								<span class="dep-meta-strong">@{_activeBuild.triggeredBy.username}</span>
							{:else if _activeBuild.triggerType === 'auto'}
								<span>via GitHub</span>
							{/if}
						{/if}
						{#if _buildFailed && (deployment.buildLogs || deployment.buildError)}
							{@const dep = deployment}
							<span class="dep-meta-dot">·</span>
							<button
								class="dep-meta-link dep-meta-button"
								onclick={() => {
									buildModalStatus = 'failed';
									buildModalError = dep.buildError ?? null;
									accumulatedBuildLogs = dep.buildLogs ?? null;
									buildModalStep = null;
									buildModalWarnings = [];
									buildModalTimestamps = dep.buildStepTimestamps ?? null;
									showBuildModal = true;
								}}
							>View build logs</button>
						{/if}
					</p>

					{#if deployment.ingresses?.length}
						<div class="dep-header-divider" aria-hidden="true"></div>
						<div class="dep-header-domains">
							{#each deployment.ingresses.slice(0, 4) as ingress}
								<a
									href="{ingress.tlsEnabled ? 'https' : 'http'}://{ingress.host}{ingress.path}"
									target="_blank"
									rel="noopener noreferrer"
									class="dep-meta-domain"
								>
									{ingress.host}
									<ExternalLink class="dep-meta-domain-icon h-3 w-3" />
								</a>
							{/each}
						</div>
					{/if}
				</div>
			</section>

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

{#each visibleTabs as tab}
	<section {...tabs.getContent(tab.id)} hidden={undefined} class="tab-panel">
					{#if tab.id === 'overview'}
						<div class="grid gap-5 lg:grid-cols-[1fr_300px] items-stretch overview-grid">
							<!-- Left: Console (hero) -->
							<div class="flex flex-col gap-5 min-w-0 overview-left">
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
														<Boxes size={12} class="h-3 w-3 opacity-40" />
														<span>{podLabel(selectedPod)}{selectedContainer ? ` / ${selectedContainer}` : ''}</span>
														<ChevronDown size={10} class="h-2.5 w-2.5 opacity-40" />
													</button>
													{#if showLogsPodMenuRender}
														<div class="console-compact-menu" style="transform-origin: top left;" {@attach motionPopover({ closing: () => !showLogsPodMenu, onClosed: () => { showLogsPodMenuRender = false; }, from: { y: -4, scale: 0.96, opacity: 0 } })}>
															{#each deployment.pods ?? [] as pod}
																{#each pod.containers ?? [] as cont}
																	<button type="button" onclick={() => selectLogsPod(pod.name, cont.name)}
																		class="console-compact-item"
																		class:console-compact-item--active={selectedPod === pod.name && selectedContainer === cont.name}>
																		<Boxes size={10} class="h-2.5 w-2.5 shrink-0 opacity-30" />
																		{podLabel(pod.name)}<span class="console-compact-sep">/</span><span class="console-compact-hl">{cont.name}</span>
																	</button>
																{/each}
															{/each}
														</div>
													{/if}
												</div>

												<button onclick={fetchLogs} disabled={logsLoading}
													class="console-icon-btn" title="Refresh">
													{#if logsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw size={14} class="h-3.5 w-3.5" />{/if}
												</button>
											{/if}

											<!-- New shell -->
											<div class="relative custom-dropdown-container">
												<button class="console-action-btn" onclick={handleNewShell} title="Open shell in pod">
													<Terminal size={12} class="h-3 w-3" />
													Shell
												</button>
												{#if showNewShellMenuRender}
													<div class="console-compact-menu" style="transform-origin: top left;" {@attach motionPopover({ closing: () => !showNewShellMenu, onClosed: () => { showNewShellMenuRender = false; }, from: { y: -4, scale: 0.96, opacity: 0 } })}>
														{#each deployment.pods ?? [] as pod}
															{#each pod.containers ?? [] as cont}
																<button type="button" onclick={() => openShell(pod.name, cont.name)}
																	class="console-compact-item">
																	<Terminal size={10} class="h-2.5 w-2.5 shrink-0 opacity-40" />
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
												{#if consoleExpanded}<Minimize2 size={14} class="h-3.5 w-3.5" />{:else}<Maximize2 size={14} class="h-3.5 w-3.5" />{/if}
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
												<pre
													class="console-output"
													bind:this={logsOutputRef}
													onscroll={onLogsScroll}
												>{#if loadingMoreLogs}<div class="logs-loading-more"><Loader2 class="h-3 w-3 animate-spin" /> Loading earlier logs…</div>{:else if logsAtMax || tailLines >= LOG_MAX_LINES}<div class="logs-loading-more logs-loading-more--end">— start of available logs —</div>{/if}{@html ansiToHtml(logs)}</pre>
											{:else}
												<div class="console-empty">
													<Terminal size={16} class="h-4 w-4 opacity-30" />
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

							</div>

							<!-- Right sidebar: stats + scale + pods -->
							<div class="flex flex-col gap-4 overview-right min-h-0">
								<!-- Resource stats as compact cards. Charts moved to the Metrics tab. -->
								<div class="stat-card">
									<div class="stat-card-header">
										<Cpu size={14} class="h-3.5 w-3.5" style="color: #b33346;" />
										<span class="stat-card-label">CPU</span>
										<button
											class="stat-card-expand"
											title="Open Metrics tab"
											aria-label="Open Metrics tab"
											onclick={() => { tabs.value = 'metrics'; }}
										>
											<Activity size={12} class="h-3 w-3" />
										</button>
									</div>
									<p class="stat-card-value">{formatCpu(deployment.totalCpuUsage)}</p>
								</div>

								<div class="stat-card">
									<div class="stat-card-header">
										<MemoryStick class="h-3.5 w-3.5" style="color: #e87485;" />
										<span class="stat-card-label">Memory</span>
										<button
											class="stat-card-expand"
											title="Open Metrics tab"
											aria-label="Open Metrics tab"
											onclick={() => { tabs.value = 'metrics'; }}
										>
											<Activity size={12} class="h-3 w-3" />
										</button>
									</div>
									<p class="stat-card-value">{formatMemory(deployment.totalMemoryUsage)}</p>
								</div>

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

								<!-- Pods (merged into Replicas card) -->
								<div class="mt-3 pt-3 border-t" style="border-color: var(--surface-border);">
									<div class="flex flex-wrap items-center justify-between gap-2 mb-2.5">
										<div class="flex items-center gap-2">
											<p class="text-xs font-semibold uppercase tracking-wide" style="color: var(--surface-muted);">Pods</p>
											<span class="text-xs font-mono" style="color: var(--surface-muted);">{activePods.length}</span>
										</div>
										<div class="flex gap-2.5 text-[11px]" style="color: var(--surface-muted);">
											<span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>{activePods.filter((pod) => pod.status?.toLowerCase() === 'ready').length} ready</span>
											{#if activePods.filter((pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')).length > 0}
												<span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full bg-yellow-500"></span>{activePods.filter((pod) => !['ready'].includes(pod.status?.toLowerCase() ?? '')).length} other</span>
											{/if}
										</div>
									</div>
								{#if activePods.length}
									<div class="space-y-1 overview-pods-scroll">
										{#each activePods as pod}
											<div class="console-pod-row-wrap">
												<button
													class="console-pod-row console-pod-row--compact"
													class:console-pod-row--active={selectedPod === pod.name}
													onclick={() => { selectedPod = pod.name; if (pod.containers?.length) selectedContainer = pod.containers[0].name; manualPodSelection = true; }}
												>
													<div class="flex items-center gap-2 min-w-0">
														<span class="h-1.5 w-1.5 rounded-full shrink-0 {pod.status?.toLowerCase() === 'ready' ? 'bg-green-500' : pod.status?.toLowerCase() === 'scheduled' ? 'bg-yellow-500' : 'bg-gray-400'}"></span>
														<span class="font-mono text-xs truncate">{podLabel(pod.name)}</span>
													</div>
													<div class="flex items-center gap-2 shrink-0 text-[10px] font-mono" style="color: var(--surface-muted);">
														{#if pod.startTime}<span>{formatRelativeTime(new Date(pod.startTime))}</span>{/if}
														<span class="badge {getStatusColor(pod.status)} text-[9px] px-1 py-0.5">{pod.status}</span>
													</div>
												</button>
												<button
													class="pod-delete-btn"
													title="Delete pod"
													onclick={() => deletePod(pod.name)}
													disabled={deletingPod === pod.name}
												>
													{#if deletingPod === pod.name}
														<Loader2 class="h-3 w-3 animate-spin" />
													{:else}
														<Trash2 size={12} class="h-3 w-3" />
													{/if}
												</button>
											</div>
										{/each}
									</div>
								{:else}
									<p class="text-xs text-center py-3" style="color: var(--surface-muted);">No pods reporting yet</p>
								{/if}
								</div>
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
														{#if isRevealed}<EyeOff size={14} class="h-3.5 w-3.5" />{:else}<Eye size={14} class="h-3.5 w-3.5" />{/if}
													</button>
													<button onclick={() => removeEnvRow(index)} class="env-action-btn env-action-delete" aria-label="Remove">
														<Trash2 size={14} class="h-3.5 w-3.5" />
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
					{:else if tab.id === 'resources'}
						{#if resourcePressure.any}
							<div class="strategy-note resource-warning mb-4">
								<TriangleAlert class="h-4 w-4 shrink-0" />
								<div>
									Usage is near this deployment's resource limits — consider assigning more
									{#if resourcePressure.cpuNear && resourcePressure.memNear}CPU and memory{:else if resourcePressure.cpuNear}CPU{:else}memory{/if},
									or pods might behave unexpectedly.
									<div class="resource-warning-ratios">
										{#if resourcePressure.cpuRatio != null}
											CPU {Math.round(resourcePressure.cpuRatio * 100)}%
										{/if}
										{#if resourcePressure.cpuRatio != null && resourcePressure.memRatio != null}
											·
										{/if}
										{#if resourcePressure.memRatio != null}
											Memory {Math.round(resourcePressure.memRatio * 100)}%
										{/if}
									</div>
								</div>
							</div>
						{/if}
						{#if isImageSourceDeployment}
							<div class="card rounded-2xl p-5 mb-4">
								<div class="mb-3">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Container image</p>
									<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
										Switch the Docker image this deployment runs. Pods will roll to pull the new image.
									</p>
								</div>
								<input
									type="text"
									class="image-input w-full rounded-md border px-3 py-2 text-sm font-mono"
									style="border-color: var(--surface-border); background-color: var(--control-bg); color: var(--center-channel-color);"
									placeholder="ghcr.io/org/image:tag"
									bind:value={imageInput}
									disabled={savingImage}
								/>
								<div class="mt-3 flex items-center justify-between gap-2">
									<p class="text-xs" style="color: var(--surface-muted);">
										Current: <span class="font-mono" style="color: var(--center-channel-color);">{deployment?.image || '—'}</span>
									</p>
									<div class="flex gap-2">
										<button
											class="btn btn-secondary"
											disabled={!imageDirty || savingImage}
											onclick={() => { imageInput = deployment?.image ?? ''; }}
										>Reset</button>
										<button
											class="btn btn-primary"
											disabled={!imageDirty || savingImage}
											onclick={saveImage}
										>
											{#if savingImage}<Loader2 class="h-4 w-4 animate-spin" />{/if}
											<span>{savingImage ? 'Updating…' : 'Update image'}</span>
										</button>
									</div>
								</div>
							</div>
						{/if}
						<div class="card rounded-2xl p-5">
							<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
								<div>
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Container resources</p>
									<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
										Pick a preset or set custom CPU and memory. Saving triggers a rolling restart of this deployment.
									</p>
								</div>
								<div class="text-xs" style="color: var(--surface-muted);">
									{#if resourceCpuMilli === 0 && resourceMemoryBytes === 0}
										Current: <strong style="color: #f59e0b;">Unlimited</strong>
									{:else if resourceCpuMilli != null && resourceMemoryBytes != null}
										Current: <strong style="color: var(--center-channel-color);">{fmtCpuPreset(resourceCpuMilli)} · {fmtMemoryPreset(resourceMemoryBytes)}</strong>
									{:else}
										Current: <strong style="color: var(--center-channel-color);">Organization default</strong>
									{/if}
								</div>
							</div>
							<ResourcePicker
								bind:cpuMilli={resourceCpuMilli}
								bind:memoryBytes={resourceMemoryBytes}
								defaultCpuMilli={orgDefaultCpuMilli}
								defaultMemoryBytes={orgDefaultMemoryBytes}
								showUnlimited={$isSuperAdmin}
								onchange={() => { resourcesDirty = true; }}
							/>
							<div class="mt-4 flex justify-end gap-2">
								<button
									class="btn btn-secondary"
									disabled={!resourcesDirty || savingResources}
									onclick={() => {
										resourceCpuMilli = deployment?.cpuRequestMilli ?? null;
										resourceMemoryBytes = deployment?.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null;
										resourcesDirty = false;
									}}
								>
									Reset
								</button>
								<button
									class="btn btn-primary"
									disabled={!resourcesDirty || savingResources}
									onclick={saveResources}
								>
									{savingResources ? 'Saving…' : 'Save resources'}
								</button>
							</div>
						</div>
					{:else if tab.id === 'metrics'}
						<div class="card rounded-2xl p-5">
							<DeploymentMetrics deploymentId={deployment?.id ?? null} />
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
							{#if hasPvcVolume}
								<div class="strategy-note mb-4">
									<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
									<span>Rolling deployments are disabled because this deployment uses a PVC volume. Updates run with the <strong>Recreate</strong> strategy — pods are torn down before new ones start.</span>
								</div>
							{/if}
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
												<button onclick={() => removeVolume(index)} class="btn btn-ghost btn-sm vol-remove"><Trash2 size={14} class="h-3.5 w-3.5" /></button>
											</div>
										</div>
									</div>
								{:else}
									<div class="text-center py-8" transition:fade={{ duration: 150 }}>
										<HardDriveDownload size={32} class="h-8 w-8 mx-auto mb-2" style="color: var(--surface-muted);" />
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
							<!-- Tailscale -->
							<div class="card rounded-2xl p-5">
								<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Tailscale</p>
								</div>
								{#if deployment?.tailscaleExposed}
									<div class="rounded-xl" style="background-color: var(--control-bg); border: 1px solid var(--surface-border); overflow: hidden;">
										<div class="flex items-center justify-between gap-3 px-4 py-3">
											<div class="flex items-center gap-3">
												<Wifi size={16} class="h-4 w-4 flex-shrink-0" style="color: var(--button-bg);" />
												<div>
													{#if tailscaleDns}
														<p class="text-sm font-medium" style="color: var(--center-channel-color);">{tailscaleDns}</p>
													{:else}
														<p class="text-sm font-medium" style="color: var(--center-channel-color);">{deployment.tailscaleHostname}</p>
													{/if}
													{#if tailscaleIp}
														<p class="text-xs" style="color: var(--surface-muted);">{tailscaleIp}</p>
													{:else}
														<p class="text-xs flex items-center gap-1" style="color: var(--surface-muted);">
															<Loader2 class="h-3 w-3 animate-spin" />
															Connecting to Tailscale...
														</p>
													{/if}
												</div>
											</div>
											<button onclick={unexposeTailscale} disabled={tailscaleUnexposing} class="btn btn-secondary btn-sm">
												{#if tailscaleUnexposing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<X class="h-3.5 w-3.5" />{/if}
												<span>Remove</span>
											</button>
										</div>
										{#if (tailscaleDns || tailscaleIp) && deployment.services?.length}
											<div style="border-top: 1px solid var(--surface-border);">
												{#each deployment.services as service}
													{@const tsHost = tailscaleDns || tailscaleIp}
													{@const displayedPorts = service.ports?.length ? service.ports : [{ port: service.port, targetPort: service.targetPort, protocol: service.protocol }]}
													{#each displayedPorts as port}
														{@const addr = `${tsHost}:${port.targetPort}`}
														<div class="flex items-center justify-between gap-2 px-4 py-2" style="border-bottom: 1px solid var(--surface-border);">
															<div class="flex items-center gap-2 min-w-0">
																<span class="text-xs font-mono truncate" style="color: var(--center-channel-color);">{addr}</span>
																<span class="text-xs px-1.5 py-0.5 rounded" style="background-color: var(--surface-border); color: var(--surface-muted);">{port.protocol || 'TCP'}</span>
															</div>
															<button
																class="btn btn-ghost btn-sm"
																onclick={() => { navigator.clipboard.writeText(addr); toasts.add({ title: 'Copied', description: addr, color: 'success' }); }}
															>
																<Copy size={14} class="h-3.5 w-3.5" />
															</button>
														</div>
													{/each}
												{/each}
											</div>
										{/if}
									</div>
								{:else if tailscaleLinked}
									<button onclick={exposeTailscale} disabled={tailscaleExposing} class="btn btn-secondary btn-sm">
										{#if tailscaleExposing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Wifi size={14} class="h-3.5 w-3.5" />{/if}
										<span>Expose to Tailscale</span>
									</button>
								{:else}
									<p class="text-xs" style="color: var(--surface-muted);">Connect your Tailscale account in <a href="/user/settings" class="underline">user settings</a> to expose deployments to your private network.</p>
								{/if}
							</div>

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
														{#if port.publicEnabled && port.publicPort}
															{@const pubEndpoint = `${PUBLIC_DEPLOYMENT_DOMAIN}:${port.publicPort}`}
															<button
																type="button"
																class="svc-public-pill flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono"
																onclick={() => { navigator.clipboard.writeText(pubEndpoint); toasts.add({ title: 'Copied public endpoint', description: pubEndpoint, color: 'success' }); }}
																title="Click to copy public endpoint"
															>
																<Wifi size={12} class="h-3 w-3" />
																<span>{pubEndpoint}</span>
																<Copy size={12} class="h-3 w-3 opacity-60" />
															</button>
														{/if}
													{/if}
													<div class="flex-1"></div>
													{#if !serviceEditForms[service.id] && port.id}
														{#if port.publicEnabled}
															<button
																type="button"
																class="btn btn-ghost btn-sm"
																onclick={() => togglePortPublic(service.id, port.id, true)}
																disabled={portPublicBusyId === port.id}
																title="Stop exposing this port publicly"
															>
																{#if portPublicBusyId === port.id}
																	<Loader2 class="h-3.5 w-3.5 animate-spin" />
																{:else}
																	<Lock class="h-3.5 w-3.5" />
																{/if}
																<span class="ml-1 text-xs">Unexpose</span>
															</button>
														{:else}
															<button
																type="button"
																class="btn btn-secondary btn-sm"
																onclick={() => togglePortPublic(service.id, port.id, false)}
																disabled={portPublicBusyId === port.id}
																title="Expose this port to the public internet"
															>
																{#if portPublicBusyId === port.id}
																	<Loader2 class="h-3.5 w-3.5 animate-spin" />
																{:else}
																	<Wifi size={14} class="h-3.5 w-3.5" />
																{/if}
																<span class="ml-1 text-xs">Expose publicly</span>
															</button>
														{/if}
													{/if}
													{#if !serviceEditForms[service.id]}
														<button type="button" class="btn btn-ghost btn-sm" title="Edit port" onclick={() => toggleServiceEdit(service)}>
															<Settings size={14} class="h-3.5 w-3.5" />
														</button>
													{/if}
													<button type="button" class="btn btn-ghost btn-sm text-red-500" onclick={() => deleteService(service.id)} disabled={serviceDeletingId === service.id}>
														{#if serviceDeletingId === service.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 size={14} class="h-3.5 w-3.5" />{/if}
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
												title={`Generate a free *.${APP_DOMAIN} domain`}
											>
												<RefreshCw size={14} class="h-3.5 w-3.5" />
												Auto
											</button>
										</div>
										<p class="text-xs mt-1" style="color: var(--surface-muted);">
											For custom domains, point a CNAME record to <code>{INGRESS_CNAME}</code>.
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
											<ChevronDown size={12} class="h-3 w-3" style={showDomainAdvanced ? '' : 'transform: rotate(-90deg);'} />
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
														<Trash2 size={16} class="h-4 w-4" />
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
						<div class="card rounded-2xl overflow-hidden">
							<div class="dep-list-header">
								<div>
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Deployments</p>
									<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
										{#if deployment.githubRepo}
											History of every build for <span class="font-mono">{deployment.githubRepo.replace('https://github.com/', '').replace(/\.git$/, '')}</span>
										{:else}
											History of every build
										{/if}
									</p>
								</div>
								{#if deployment.githubRepo}
									<button onclick={rebuild} disabled={rebuilding} class="btn btn-secondary btn-sm">
										{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw size={14} class="h-3.5 w-3.5" />{/if}
										<span>Redeploy</span>
									</button>
								{/if}
							</div>

							{#if (deployment.imageHistory?.length ?? 0) > 0 || deployment.buildStatus === 'failed' || deployment.buildStatus === 'building' || deployment.buildStatus === 'queued' || deployment.buildStatus === 'pending'}
								<div class="dep-list-table">
									<div class="dep-list-row dep-list-row--head">
										<div class="dep-col-status">Status</div>
										<div class="dep-col-commit">Commit</div>
										<div class="dep-col-built">Built</div>
										<div class="dep-col-author">Author</div>
										<div class="dep-col-meta">Created</div>
										<div class="dep-col-actions"></div>
									</div>

									{#if deployment.buildStatus === 'building' || deployment.buildStatus === 'queued' || deployment.buildStatus === 'pending'}
										<div class="dep-list-row dep-list-row--building" transition:slide={{ duration: 150 }}>
											<div class="dep-col-status">
												<span class="dep-status">
													<span class="dep-status-dot dep-status-dot--building"></span>
													<span class="dep-status-label">Building</span>
												</span>
											</div>
											<div class="dep-col-commit">
												<div class="dep-commit-stack">
													<span class="dep-commit-msg dep-commit-msg--muted">Build in progress…</span>
													<div class="dep-commit-meta">
														<span class="dep-mini-chip"><GitBranch class="h-2.5 w-2.5" />{deployment.githubBranch || 'main'}</span>
													</div>
												</div>
											</div>
											<div class="dep-col-built">
												<span class="dep-meta-text dep-meta-text--placeholder">—</span>
											</div>
											<div class="dep-col-author">
												<span class="dep-meta-text dep-meta-text--placeholder">—</span>
											</div>
											<div class="dep-col-meta">
												<span class="dep-meta-text">just now</span>
											</div>
											<div class="dep-col-actions">
												<Loader2 class="h-3.5 w-3.5 animate-spin" style="color: var(--surface-muted);" />
											</div>
										</div>
									{/if}

									{#if deployment.buildStatus === 'failed'}
										<div class="dep-list-row dep-list-row--failed" transition:slide={{ duration: 150 }}>
											<div class="dep-col-status">
												<span class="dep-status">
													<span class="dep-status-dot dep-status-dot--failed"></span>
													<span class="dep-status-label" style="color: #ef4444;">Error</span>
												</span>
											</div>
											<div class="dep-col-commit">
												<div class="dep-commit-stack">
													<span class="dep-commit-msg" style="color: #ef4444;">Build failed</span>
													{#if deployment.buildError}
														<div class="dep-commit-meta">
															<span class="dep-meta-text font-mono" style="color: color-mix(in srgb, #ef4444 60%, var(--surface-muted)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">{deployment.buildError.split('\n')[0]}</span>
														</div>
													{/if}
												</div>
											</div>
											<div class="dep-col-built">
												<span class="dep-meta-text dep-meta-text--placeholder">—</span>
											</div>
											<div class="dep-col-author">
												<span class="dep-meta-text dep-meta-text--placeholder">—</span>
											</div>
											<div class="dep-col-meta">
												<span class="dep-meta-text">recently</span>
											</div>
											<div class="dep-col-actions">
												{#if deployment.buildLogs || deployment.buildError}
													<button onclick={() => {
														buildModalStatus = 'failed';
														buildModalError = deployment.buildError ?? null;
														accumulatedBuildLogs = deployment.buildLogs ?? null;
														buildModalStep = null;
														buildModalWarnings = [];
														buildModalTimestamps = deployment.buildStepTimestamps ?? null;
														showBuildModal = true;
													}} class="dep-action-btn" title="View build logs">
														<Terminal size={14} class="h-3.5 w-3.5" />
													</button>
												{/if}
											</div>
										</div>
									{/if}

									{#each deployment.imageHistory ?? [] as history, _hi}
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
										{@const rowFallbackMsg = history.commitSha
											? deployment.imageHistory?.find((h) => h.commitMessage && h.commitSha === history.commitSha)?.commitMessage
											: undefined}
										{@const rowDisplayMsgFull = history.commitMessage || rowFallbackMsg}
										{@const rowDisplayMsg = rowDisplayMsgFull?.split('\n')[0].trim()}
										{@const rowBuildDuration = formatBuildDurationBetween(history.buildStartedAt, history.buildCompletedAt)}
										{@const rowAuthor = history.commitAuthorUsername || history.commitAuthorName || null}
										<div class="dep-list-row" class:dep-list-row--active={history.isActive} {@attach motionStagger({ index: _hi, stride: 0.035, from: { y: 10 } })}>
											<div class="dep-col-status">
												<span class="dep-status">
													<span class="dep-status-dot dep-status-dot--ready" class:dep-status-dot--live={history.isActive}></span>
													<span class="dep-status-label">Ready</span>
												</span>
												{#if history.isActive}
													<span class="dep-current-pill">Current</span>
												{/if}
											</div>
											<div class="dep-col-commit">
												<div class="dep-commit-stack">
													{#if rowDisplayMsg}
														<span class="dep-commit-msg" title={rowDisplayMsgFull}>{rowDisplayMsg}</span>
													{:else if history.branch}
														<span class="dep-commit-msg dep-commit-msg--muted">Deployed from {history.branch}</span>
													{:else}
														<span class="dep-commit-msg dep-commit-msg--muted">Image build</span>
													{/if}
													<div class="dep-commit-meta">
														{#if history.branch}
															<span class="dep-mini-chip"><GitBranch class="h-2.5 w-2.5" />{history.branch}</span>
														{/if}
														{#if history.commitSha && deployment.githubRepo}
															<a
																href="{deployment.githubRepo.replace(/\.git$/, '')}/commit/{history.commitSha}"
																target="_blank"
																rel="noopener noreferrer"
																class="dep-mini-chip dep-mini-chip--link"
																onclick={(e) => e.stopPropagation()}
															>
																<GitCommit class="h-2.5 w-2.5" />
																<span class="font-mono">{history.commitSha.slice(0, 7)}</span>
															</a>
														{:else if history.commitSha}
															<span class="dep-mini-chip">
																<GitCommit class="h-2.5 w-2.5" />
																<span class="font-mono">{history.commitSha.slice(0, 7)}</span>
															</span>
														{/if}
													</div>
												</div>
											</div>
											<div class="dep-col-built">
												{#if rowBuildDuration}
													<span class="dep-meta-text dep-meta-text--mono">{rowBuildDuration}</span>
												{:else}
													<span class="dep-meta-text dep-meta-text--placeholder">—</span>
												{/if}
											</div>
											<div class="dep-col-author">
												{#if rowAuthor}
													<span class="dep-meta-text dep-meta-author">
														{history.commitAuthorUsername ? `@${history.commitAuthorUsername}` : rowAuthor}
													</span>
												{:else}
													<span class="dep-meta-text dep-meta-text--placeholder">—</span>
												{/if}
											</div>
											<div class="dep-col-meta">
												<span class="dep-meta-text">{timeAgo}</span>
												<span class="dep-meta-sub">
													{#if history.triggerType === 'manual' && history.triggeredBy}
														by <span class="dep-meta-user">@{history.triggeredBy.username}</span>
													{:else if history.triggerType === 'auto'}
														via GitHub
													{:else}
														manual
													{/if}
												</span>
											</div>
											<div class="dep-col-actions">
												<button onclick={() => openLogModal(history.id)} class="dep-action-btn" title="View logs">
													<Terminal size={14} class="h-3.5 w-3.5" />
												</button>
												{#if !history.isActive}
													<button onclick={() => rollbackToImage(history.id)} class="dep-action-btn dep-action-btn--primary" title="Promote to production">
														<RefreshCw size={14} class="h-3.5 w-3.5" />
													</button>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{:else}
								<div class="dep-list-empty">
									<History size={32} class="h-8 w-8 mx-auto mb-2" style="color: var(--surface-muted);" />
									<p class="text-sm font-medium" style="color: var(--center-channel-color);">No deployments yet</p>
									<p class="text-xs mt-1" style="color: var(--surface-muted);">
										{#if deployment.githubRepo}
											Push a commit to {deployment.githubBranch || 'main'} to trigger your first deployment.
										{:else}
											Builds will appear here after your first deploy.
										{/if}
									</p>
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
												<TriangleAlert size={16} class="h-4 w-4" />
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
														{#if copiedWebhookToken}<Check size={14} class="h-3.5 w-3.5" /><span>Copied</span>{:else}<Copy size={14} class="h-3.5 w-3.5" /><span>Copy</span>{/if}
													</button>
												</div>
											</div>
											<div>
												<p class="wh-new-token-label">Webhook URL</p>
												<div class="wh-new-token-value-row">
													<code class="wh-new-token-code">{getWebhookUrl(newlyCreatedToken)}</code>
													<button class="btn btn-ghost btn-sm wh-copy-btn" onclick={() => copyToClipboard(getWebhookUrl(newlyCreatedToken!), 'url')}>
														{#if copiedWebhookUrl}<Check size={14} class="h-3.5 w-3.5" /><span>Copied</span>{:else}<Copy size={14} class="h-3.5 w-3.5" /><span>Copy</span>{/if}
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
														{#if deletingWebhookTokenId === token.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 size={14} class="h-3.5 w-3.5" />{/if}
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
												<RefreshCw size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
												<span class="wh-example-title">Restart deployment</span>
											</div>
											<span class="wh-example-method">POST</span>
										</summary>
										<pre class="wh-code-block"><code>{webhookExamples.restart}</code></pre>
									</details>

									<details class="wh-example-item">
										<summary class="wh-example-summary">
											<div class="wh-example-summary-left">
												<RefreshCw size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
												<span class="wh-example-title">Update to a specific tag</span>
											</div>
											<span class="wh-example-method">POST + JSON</span>
										</summary>
										<pre class="wh-code-block"><code>{webhookExamples.updateTag}</code></pre>
									</details>

									<details class="wh-example-item">
										<summary class="wh-example-summary">
											<div class="wh-example-summary-left">
												<Boxes size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
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
					{:else if tab.id === 'audit'}
						<div class="space-y-5">
							<AuditLogList scope={{ deploymentId: deployment.id }} title="Recent activity" />
						</div>
					{:else if tab.id === 'advanced'}
						<div class="space-y-5">
							<!-- Update strategy -->
							<div class="card rounded-2xl p-5">
								<div class="mb-3">
									<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Update strategy</p>
									<p class="text-xs mt-0.5" style="color: var(--surface-muted);">
										How Kubernetes rolls out new pods when this deployment changes.
									</p>
								</div>
								<div class="strategy-grid">
									<button
										type="button"
										class="strategy-card"
										class:strategy-card--active={strategyValue === 'rollingUpdate'}
										disabled={savingStrategy || hasPvcVolume}
										onclick={() => saveStrategy('rollingUpdate')}
									>
										<div class="flex items-center justify-between gap-2">
											<span class="strategy-card-title">Rolling Update</span>
											{#if strategyValue === 'rollingUpdate'}
												<Check class="h-3.5 w-3.5 text-primary-500" />
											{/if}
										</div>
										<p class="strategy-card-desc">Bring up new pods, then drain the old ones — zero downtime.</p>
									</button>
									<button
										type="button"
										class="strategy-card"
										class:strategy-card--active={strategyValue === 'recreate'}
										disabled={savingStrategy}
										onclick={() => saveStrategy('recreate')}
									>
										<div class="flex items-center justify-between gap-2">
											<span class="strategy-card-title">Recreate</span>
											{#if strategyValue === 'recreate'}
												<Check class="h-3.5 w-3.5 text-primary-500" />
											{/if}
										</div>
										<p class="strategy-card-desc">Tear down all pods first, then start the new ones — brief downtime.</p>
									</button>
								</div>
								{#if hasPvcVolume}
									<div class="strategy-note mt-3">
										<TriangleAlert class="h-3.5 w-3.5 shrink-0" />
										<span>This deployment has a PVC volume, so rolling updates are unavailable. Pods can't share a ReadWriteOnce volume during a rolling cutover.</span>
									</div>
								{/if}
							</div>

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
										{#if !autoDeployStatus?.appInstalled}
											<div class="mt-3 flex items-center justify-between gap-3 rounded-xl p-4" style="background-color: var(--control-bg); border: 1px dashed var(--error-text-color);">
												<div>
													<p class="text-sm font-medium" style="color: var(--error-text-color);">GitHub App can't access this repository</p>
													<p class="text-xs mt-0.5" style="color: var(--surface-muted);">Auto-deploy is enabled, but the App isn't installed on this repo or "Only select repositories" doesn't include it. Pushes won't trigger deployments until access is granted.</p>
												</div>
												<button onclick={openGitHubAppInstall} disabled={!githubAppInstallUrl || loadingAppInstallUrl} class="btn btn-primary btn-sm shrink-0">
													{#if loadingAppInstallUrl}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
													<ExternalLink class="h-3.5 w-3.5" />
													<span>Configure</span>
												</button>
											</div>
										{/if}
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
														<span class="hc-method-icon"><Wifi size={20} class="h-5 w-5" /></span>
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
														<span class="hc-method-icon"><ServerCog size={20} class="h-5 w-5" /></span>
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
														<span class="hc-method-icon"><Terminal size={20} class="h-5 w-5" /></span>
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
												<Settings size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
												<span>Advanced timing settings</span>
												<ChevronDown size={14} class="h-3.5 w-3.5 hc-advanced-chevron" style="color: var(--surface-muted);" />
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
{#if showBuildModalRender}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Build progress"
		onclick={(e) => { if (e.target === e.currentTarget) minimizeBuildModal(); }}
		onkeydown={(e) => { if (e.key === 'Escape') minimizeBuildModal(); }}
		{@attach motionBackdrop(() => !showBuildModal, () => { showBuildModalRender = false; })}
	>
		<div
			class="build-modal card w-full max-w-2xl rounded-2xl shadow-2xl"
			{@attach motionPopover({ closing: () => !showBuildModal, onClosed: () => {}, from: { y: 14, scale: 0.94, opacity: 0 }, stiffness: 460, damping: 30, mass: 0.95 })}
		>
			<div class="flex items-center justify-between border-b px-6 py-4" style="border-color: var(--surface-border);">
				<div class="flex items-center gap-3">
					<h2 class="text-lg font-semibold">Rebuilding {deployment?.name ?? 'deployment'}</h2>
					<div class="flex items-center gap-1.5 text-sm" style="color: var(--surface-muted);">
						<Clock size={14} class="h-3.5 w-3.5" />
						<AnimatedNumber value={buildElapsed} format={formatBuildElapsed} class="font-mono" />
					</div>
				</div>
				<button
					onclick={minimizeBuildModal}
					class="btn-icon rounded-lg p-1.5 transition-colors"
					title="Minimize"
				>
					<Minimize2 size={16} class="h-4 w-4" />
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
{#if showBuildCardRender}
	<button
		class="build-card fixed bottom-6 right-6 z-40 w-72 cursor-pointer rounded-xl shadow-lg hover:shadow-xl"
		style="transform-origin: bottom right;"
		onclick={expandBuildCard}
		{@attach motionPopover({ closing: () => !(showBuildCard && !showBuildModal), onClosed: () => { showBuildCardRender = false; }, from: { y: 18, scale: 0.86, opacity: 0 }, stiffness: 500, damping: 28, mass: 0.9 })}
	>
		<div class="flex items-center justify-between px-4 py-3">
			<div class="flex items-center gap-2 min-w-0">
				{#if buildModalStatus === 'building' || buildModalStatus === 'pending'}
					<Loader2 class="h-4 w-4 animate-spin shrink-0 text-primary-500" />
				{:else if buildModalStatus === 'failed'}
					<X class="h-4 w-4 shrink-0 text-red-500" />
				{:else if buildModalStatus === 'running'}
					<Check size={16} class="h-4 w-4 shrink-0 text-green-500" />
				{/if}
				<span class="truncate text-sm font-medium">{deployment?.name ?? 'Build'}</span>
			</div>
			<div class="flex items-center gap-2 shrink-0">
				<div class="flex items-center gap-1 text-xs font-mono" style="color: var(--surface-muted);">
					<Clock size={12} class="h-3 w-3" />
					<AnimatedNumber value={buildElapsed} format={formatBuildElapsed} />
				</div>
				<Maximize2 size={14} class="h-3.5 w-3.5" style="color: var(--surface-muted);" />
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

	/* Overview: lock to a single viewport. Header card + tabs eat ~340px, leaving the
	   grid to fill the remainder. Both columns use min-height:0 so internal scrolling
	   can take over (logs in the console, pod list in the merged card). */
	.overview-grid {
		height: calc(100vh - 340px);
		min-height: 460px;
	}
	.overview-left {
		height: 100%;
		min-height: 0;
	}
	.overview-left > .console-panel {
		height: auto;
		flex: 1 1 0;
		min-height: 0;
	}
	.overview-right {
		height: 100%;
	}
	/* Make the last card in the right column (Replicas + Pods) flex-fill the column
	   so the embedded pod list can scroll inside it instead of overflowing the page. */
	.overview-right > .card:last-child {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1 1 auto;
	}
	.overview-right > .card:last-child > div:last-child {
		min-height: 0;
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
	}
	.overview-pods-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.console-pod-row--compact {
		padding-top: 0.3rem;
		padding-bottom: 0.3rem;
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

	/* Glassy breadcrumb pill — mirrors the project page so navigation reads
	   the same across the org → project → deployment hierarchy. */
	.deployment-page :global(.bc) {
		align-self: flex-start;
		padding: 0.3125rem 0.75rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-bg, var(--center-channel-bg)) 70%, transparent);
		border: 1px solid var(--surface-border);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		width: fit-content;
		margin-bottom: 0;
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
		padding: 1.5rem 1.5rem 1.25rem;
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		overflow: hidden;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		transition: padding 320ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* Compact mode: tighter top/bottom padding, less generous spacing under the title.
	   Body height is animated by motion; the card pads in sympathy. */
	.dep-header-card--collapsed {
		padding-top: 0.875rem;
		padding-bottom: 0.875rem;
	}
	.dep-header-card--hasbg {
		border-color: transparent;
		background: none;
	}
	.dep-header-card--hasbg .dep-header-top,
	.dep-header-card--hasbg .dep-header-body,
	.dep-header-card--hasbg .dep-header-meta,
	.dep-header-card--hasbg .dep-header-domains {
		position: relative; z-index: 1;
	}
	/* Hierarchy on colored backgrounds: hand-pick light shades, no flat greys.
	   commit msg = full white (primary)
	   domains    = bright but distinct from primary (secondary, clickable)
	   meta       = clearly muted (tertiary, info-only) */
	.dep-header-card--hasbg .dep-header-name {
		color: #fff;
	}
	.dep-header-card--hasbg .dep-meta-lead {
		color: rgba(255,255,255,0.92);
	}
	.dep-header-card--hasbg .dep-header-meta {
		color: rgba(255,255,255,0.55);
	}
	.dep-header-card--hasbg .dep-meta-mono {
		color: rgba(255,255,255,0.78);
	}
	.dep-header-card--hasbg .dep-meta-strong { color: #fff; }
	.dep-header-card--hasbg .dep-meta-link {
		color: rgba(255,255,255,0.78);
	}
	.dep-header-card--hasbg .dep-meta-link:hover {
		color: #fff;
	}
	.dep-header-card--hasbg .dep-meta-domain {
		color: rgba(255,255,255,0.55);
	}
	.dep-header-card--hasbg .dep-meta-domain:hover {
		color: #fff;
	}
	.dep-header-card--hasbg .dep-meta-domain-icon {
		opacity: 0.4;
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
		flex: 1;
	}

	/* Status chip next to the deployment name — single source of truth for
	   what state the deployment is actually in. */
	.dep-status-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.125rem 0.5rem 0.125rem 0.4rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 600;
		line-height: 1.4;
		letter-spacing: 0.01em;
		white-space: nowrap;
		border: 1px solid transparent;
	}
	.dep-status-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 999px;
		background-color: currentColor;
		box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 25%, transparent);
	}
	.dep-status-chip--success {
		color: #16a34a;
		background-color: color-mix(in srgb, #22c55e 14%, transparent);
		border-color: color-mix(in srgb, #22c55e 35%, transparent);
	}
	.dep-status-chip--warning {
		color: #b45309;
		background-color: color-mix(in srgb, #f59e0b 16%, transparent);
		border-color: color-mix(in srgb, #f59e0b 38%, transparent);
	}
	.dep-status-chip--error {
		color: #b91c1c;
		background-color: color-mix(in srgb, #ef4444 15%, transparent);
		border-color: color-mix(in srgb, #ef4444 40%, transparent);
	}
	.dep-status-chip--info {
		color: #2563eb;
		background-color: color-mix(in srgb, #3b82f6 14%, transparent);
		border-color: color-mix(in srgb, #3b82f6 38%, transparent);
	}
	.dep-status-chip--neutral {
		color: var(--surface-muted);
		background-color: color-mix(in srgb, var(--surface-muted) 15%, transparent);
		border-color: color-mix(in srgb, var(--surface-muted) 32%, transparent);
	}
	:global(:root.dark) .dep-status-chip--success { color: #4ade80; }
	:global(:root.dark) .dep-status-chip--warning { color: #fbbf24; }
	:global(:root.dark) .dep-status-chip--error { color: #f87171; }
	:global(:root.dark) .dep-status-chip--info { color: #60a5fa; }
	.dep-header-card--hasbg .dep-status-chip {
		backdrop-filter: blur(8px);
	}

	/* Alert pill — replaces the discreet bell with a real attention-grabbing
	   chip when there's something to look at. */
	.dep-alert-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.7rem 0.3rem 0.55rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		border: 1px solid transparent;
		cursor: pointer;
		transition: transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
		animation: dep-alert-pulse 2.4s ease-in-out infinite;
	}
	.dep-alert-pill:hover {
		transform: translateY(-1px);
	}
	.dep-alert-pill-label {
		line-height: 1.2;
	}
	.dep-alert-pill-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.1rem;
		padding: 0 0.3rem;
		height: 1.1rem;
		border-radius: 999px;
		font-size: 0.65rem;
		font-weight: 700;
		background-color: rgba(255, 255, 255, 0.22);
		color: inherit;
	}
	.dep-alert-pill--error {
		color: #fff;
		background-color: #dc2626;
		box-shadow: 0 4px 14px -4px rgba(220, 38, 38, 0.55);
	}
	.dep-alert-pill--error:hover {
		background-color: #b91c1c;
	}
	.dep-alert-pill--warning {
		color: #78350f;
		background-color: #fbbf24;
		box-shadow: 0 4px 14px -4px rgba(245, 158, 11, 0.5);
	}
	.dep-alert-pill--warning:hover {
		background-color: #f59e0b;
	}
	:global(:root.dark) .dep-alert-pill--warning {
		color: #1a1208;
	}
	@keyframes dep-alert-pulse {
		0%, 100% { box-shadow: 0 4px 14px -4px rgba(220, 38, 38, 0.4); }
		50% { box-shadow: 0 4px 18px -2px rgba(220, 38, 38, 0.7); }
	}
	.dep-alert-pill--warning {
		animation: none;
	}

	.dep-header-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	/* Body: meta + domains, sit just below the deployment name. Generous gap so the
	   meta line and the domains row read as distinct groups, not a tight stack. */
	.dep-header-body {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		margin-top: 0.875rem;
	}

	/* Single hairline divider that turns "stack of text" into two clear groups:
	   build provenance (commit/repo/branch/time) above, public addresses below. */
	.dep-header-divider {
		height: 1px;
		background-color: color-mix(in srgb, var(--surface-border) 80%, transparent);
		margin: 0;
		border: 0;
	}
	.dep-header-card--hasbg .dep-header-divider {
		background-color: rgba(255, 255, 255, 0.18);
	}

	/* HERO: the deployment name */
	.dep-header-name {
		font-size: 1.625rem;
		font-weight: 700;
		color: var(--center-channel-color);
		line-height: 1.2;
		margin: 0;
		letter-spacing: -0.02em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dep-header-domains {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem 1rem;
	}

	.dep-delete-btn {
		color: #fff !important;
		border: 1px solid #dc2626 !important;
		background-color: #ef4444 !important;
		opacity: 1 !important;
		transition: background-color 0.15s;
	}
	.dep-delete-btn:hover {
		background-color: #dc2626 !important;
		color: #fff !important;
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
		color: var(--center-channel-color);
		cursor: pointer;
		transition: background 0.12s, color 0.12s;
	}
	.dep-notif-btn:hover {
		background: var(--control-hover-bg);
		color: var(--center-channel-color);
	}
	/* On gradient backgrounds the icon needs to read against the image. */
	.dep-header-card--hasbg .dep-notif-btn,
	.dep-header-card--hasbg .dep-notif-btn:hover {
		color: #fff;
	}

	/* Meta: single line of supporting text. Same baseline, no chips, no borders. */
	.dep-header-meta {
		display: flex;
		align-items: baseline;
		gap: 0.4375rem;
		flex-wrap: wrap;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: color-mix(in srgb, var(--center-channel-color) 55%, transparent);
		margin: 0;
	}

	/* Lead: commit message at the start of the meta line — strongest tier in the row */
	.dep-meta-lead {
		font-weight: 600;
		color: color-mix(in srgb, var(--center-channel-color) 90%, transparent);
		max-width: min(28rem, 60%);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	a.dep-meta-lead-link {
		text-decoration: none;
		transition: color 0.12s;
	}
	a.dep-meta-lead-link:hover {
		color: var(--center-channel-color);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.dep-header-card--hasbg a.dep-meta-lead-link:hover {
		color: #fff;
	}

	.dep-meta-mono {
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
		font-weight: 600;
		color: color-mix(in srgb, var(--center-channel-color) 80%, transparent);
	}

	.dep-meta-dot {
		opacity: 0.6;
	}

	.dep-meta-strong {
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.dep-meta-link {
		color: color-mix(in srgb, var(--center-channel-color) 80%, transparent);
		text-decoration: none;
		font-weight: 600;
		transition: color 0.12s;
	}
	.dep-meta-link:hover {
		color: var(--center-channel-color);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.dep-meta-button {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}

	.dep-meta-domain {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		color: color-mix(in srgb, var(--center-channel-color) 55%, transparent);
		text-decoration: none;
		font-size: 0.8125rem;
		font-weight: 400;
		transition: color 0.12s, opacity 0.12s;
	}
	.dep-meta-domain-icon {
		opacity: 0.4;
		transition: opacity 0.12s;
	}
	.dep-meta-domain:hover {
		color: var(--center-channel-color);
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	.dep-meta-domain:hover .dep-meta-domain-icon {
		opacity: 1;
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
		z-index: 99;
	}

	.notification-panel {
		position: fixed;
		z-index: 100;
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

	.notification-dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.12s, background-color 0.12s, color 0.12s;
	}

	.notification-item:hover .notification-dismiss {
		opacity: 1;
	}

	.notification-dismiss:hover {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
	}

	.notification-empty {
		padding: 2rem 1rem;
		text-align: center;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0;
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

	.logs-loading-more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding: 0.5rem 0;
		color: var(--surface-muted);
		font-size: 0.6875rem;
		opacity: 0.75;
	}
	.logs-loading-more--end {
		opacity: 0.5;
		font-style: italic;
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
	.console-pod-row-wrap {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.console-pod-row-wrap:hover .pod-delete-btn {
		opacity: 1;
	}
	.console-pod-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
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
	.pod-delete-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s, color 0.15s, background 0.15s;
		flex-shrink: 0;
	}
	.pod-delete-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--error-text) 15%, transparent);
		color: var(--error-text);
	}
	.pod-delete-btn:disabled {
		opacity: 1;
		cursor: not-allowed;
	}

	/* Sidebar stat cards */
	.stat-card {
		border-radius: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		background: var(--surface-bg);
		padding: 0.875rem;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.02);
		transition: box-shadow 0.18s ease;
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
		flex: 1;
	}

	.stat-card-expand {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		opacity: 0.6;
		transition: background-color 0.12s, color 0.12s, opacity 0.12s;
	}

	.stat-card:hover .stat-card-expand {
		opacity: 1;
	}

	.stat-card-expand:hover {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
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
		position: relative;
	}

	/* Pending state — Datadog-style empty placeholder */
	.stat-card-pending {
		position: relative;
		width: 100%;
		height: 100%;
		border-radius: 0.5rem;
		overflow: hidden;
		background: color-mix(in srgb, var(--surface-border) 18%, transparent);
	}

	.stat-card-pending-grid {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(to right, color-mix(in srgb, var(--surface-border) 60%, transparent) 1px, transparent 1px),
			linear-gradient(to bottom, color-mix(in srgb, var(--surface-border) 60%, transparent) 1px, transparent 1px);
		background-size: 32px 24px;
		opacity: 0.45;
		mask-image: linear-gradient(to bottom, rgba(0,0,0,0.9), rgba(0,0,0,0.4));
		-webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0.9), rgba(0,0,0,0.4));
		animation: stat-pending-shimmer 2.4s ease-in-out infinite;
	}

	@keyframes stat-pending-shimmer {
		0%, 100% { opacity: 0.32; }
		50% { opacity: 0.5; }
	}

	.stat-card-pending-label {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4375rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		letter-spacing: 0.01em;
	}

	/* Metric modal — expanded chart view */
	.metric-modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		background-color: rgba(0, 0, 0, 0.55);
	}

	.metric-modal {
		width: 100%;
		max-width: 1080px;
		max-height: calc(100vh - 3rem);
		display: flex;
		flex-direction: column;
		border-radius: 1rem;
		border: 1px solid var(--surface-border);
		background-color: var(--card-bg);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
		overflow: hidden;
	}

	.metric-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1.25rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.metric-modal-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.metric-modal-value {
		margin-left: 0.375rem;
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
		font-weight: 700;
		color: color-mix(in srgb, var(--center-channel-color) 80%, transparent);
	}

	.metric-modal-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.metric-modal-range {
		display: inline-flex;
		gap: 0.125rem;
		padding: 0.125rem;
		border-radius: 0.5rem;
		background-color: var(--control-bg);
	}

	.metric-modal-range-btn {
		padding: 0.25rem 0.625rem;
		font-size: 0.75rem;
		font-weight: 500;
		border-radius: 0.375rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		transition: background-color 0.12s, color 0.12s;
	}

	.metric-modal-range-btn:hover {
		color: var(--center-channel-color);
	}

	.metric-modal-range-btn--active {
		background-color: var(--button-bg);
		color: var(--button-color);
	}

	.metric-modal-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 0.5rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer;
		transition: background-color 0.12s, color 0.12s;
	}

	.metric-modal-close:hover {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
	}

	.metric-modal-body {
		flex: 1;
		min-height: 360px;
		padding: 1.25rem;
		position: relative;
	}

	.metric-modal-empty-label {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4375rem;
		pointer-events: none;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--surface-muted);
	}

	/* ===== Advanced tab ===== */

	/* Strategy picker — two big tappable cards */
	.strategy-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.625rem;
	}
	@media (max-width: 540px) {
		.strategy-grid { grid-template-columns: 1fr; }
	}
	.strategy-card {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.75rem;
		border: 1px solid var(--surface-border);
		background-color: var(--control-bg);
		text-align: left;
		cursor: pointer;
		transition: border-color 140ms ease, background-color 140ms ease, opacity 140ms ease;
	}
	.strategy-card:hover:not(:disabled) {
		border-color: color-mix(in srgb, var(--button-bg) 50%, var(--surface-border));
	}
	.strategy-card:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}
	.strategy-card--active {
		border-color: var(--button-bg);
		background-color: color-mix(in srgb, var(--button-bg) 10%, var(--control-bg));
	}
	.strategy-card-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.strategy-card-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}
	.strategy-note {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--warning-bg, #f59e0b) 18%, transparent);
		border: 1px solid color-mix(in srgb, var(--warning-border, #f59e0b) 40%, transparent);
		color: var(--warning-text, #b45309);
		font-size: 0.75rem;
		line-height: 1.45;
	}

	.resource-warning {
		padding: 0.75rem 0.875rem;
		font-size: 0.8125rem;
	}
	.resource-warning-ratios {
		margin-top: 0.25rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		opacity: 0.85;
	}

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

	.svc-public-pill {
		background-color: color-mix(in srgb, var(--denim-button-bg) 12%, transparent);
		color: var(--denim-button-bg);
		border: 1px solid color-mix(in srgb, var(--denim-button-bg) 35%, transparent);
		transition: background-color 0.15s;
	}

	.svc-public-pill:hover {
		background-color: color-mix(in srgb, var(--denim-button-bg) 20%, transparent);
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

	/* ── Deployments list (Vercel-style) ── */
	.dep-list-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.dep-list-table {
		display: flex;
		flex-direction: column;
	}

	.dep-list-row {
		display: grid;
		grid-template-columns: 140px minmax(0, 1fr) 90px 140px 130px 80px;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 1.25rem;
		border-bottom: 1px solid var(--surface-border);
		transition: background-color 0.15s;
		min-width: 0;
	}

	.dep-list-row:last-child {
		border-bottom: none;
	}

	.dep-list-row:not(.dep-list-row--head):hover {
		background-color: color-mix(in srgb, var(--surface-border) 25%, transparent);
	}

	.dep-list-row--head {
		font-size: 0.6875rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--surface-muted);
		padding: 0.625rem 1.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 15%, transparent);
	}

	.dep-list-row--head:hover {
		background-color: color-mix(in srgb, var(--surface-border) 15%, transparent);
	}

	.dep-list-row--active {
		background-color: color-mix(in srgb, #22c55e 5%, transparent);
	}

	.dep-list-row--active:hover {
		background-color: color-mix(in srgb, #22c55e 10%, transparent);
	}

	.dep-status {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		min-width: 0;
	}

	.dep-status-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dep-status-dot--ready {
		background-color: #22c55e;
	}

	.dep-status-dot--live {
		box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
	}

	.dep-status-dot--failed {
		background-color: #ef4444;
		box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
	}

	.dep-status-dot--building {
		background-color: #f59e0b;
		box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18);
		animation: dep-pulse 1.4s ease-in-out infinite;
	}

	@keyframes dep-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.dep-status-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.dep-col-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.dep-col-built,
	.dep-col-author {
		min-width: 0;
		display: flex;
		align-items: center;
	}

	.dep-meta-text--mono {
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
		font-weight: 600;
	}

	.dep-meta-text--placeholder {
		color: var(--surface-muted);
		opacity: 0.6;
	}

	.dep-meta-author {
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.dep-current-pill {
		font-size: 0.5625rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, #22c55e 18%, transparent);
		color: #15803d;
		border: 1px solid color-mix(in srgb, #22c55e 35%, transparent);
	}

	.dep-commit-stack {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.dep-commit-msg {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dep-commit-msg--muted {
		color: var(--surface-muted);
		font-style: italic;
	}

	.dep-commit-meta {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
		min-width: 0;
	}

	.dep-mini-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.1875rem;
		font-size: 0.625rem;
		font-weight: 600;
		padding: 0.0625rem 0.3125rem;
		border-radius: 0.25rem;
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		opacity: 0.8;
		text-decoration: none;
	}

	.dep-mini-chip--link:hover {
		opacity: 1;
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 40%, var(--surface-border));
	}

	.dep-meta-text {
		font-size: 0.75rem;
		color: var(--center-channel-color);
		opacity: 0.85;
		display: block;
	}

	.dep-meta-sub {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		display: block;
		margin-top: 0.125rem;
	}

	.dep-meta-user {
		font-weight: 600;
		color: var(--center-channel-color);
		opacity: 0.9;
	}

	.dep-col-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.25rem;
		opacity: 0.4;
		transition: opacity 0.15s;
	}

	.dep-list-row:hover .dep-col-actions {
		opacity: 1;
	}

	.dep-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		background: transparent;
		border: 1px solid transparent;
		color: var(--center-channel-color);
		cursor: pointer;
		transition: background-color 0.12s, border-color 0.12s;
	}

	.dep-action-btn:hover {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		border-color: var(--surface-border);
	}

	.dep-action-btn--primary:hover {
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 50%, var(--surface-border));
		color: var(--sidebar-text-active-border);
	}

	.dep-list-empty {
		text-align: center;
		padding: 3rem 1.5rem;
	}

	@media (max-width: 900px) {
		.dep-list-row {
			grid-template-columns: 130px 1fr 70px;
			grid-template-areas:
				'status commit actions'
				'status built meta'
				'status author meta';
			row-gap: 0.375rem;
		}
		.dep-list-row--head .dep-col-built,
		.dep-list-row--head .dep-col-author,
		.dep-list-row--head .dep-col-commit,
		.dep-list-row--head .dep-col-meta {
			display: none;
		}
		.dep-col-status { grid-area: status; align-self: start; }
		.dep-col-commit { grid-area: commit; }
		.dep-col-built { grid-area: built; }
		.dep-col-author { grid-area: author; }
		.dep-col-meta { grid-area: meta; }
		.dep-col-actions { grid-area: actions; }
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
		font-weight: 600;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
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
		background-color: var(--center-channel-bg, var(--control-bg));
		color: var(--center-channel-color);
		border: 1px solid var(--surface-border);
		box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.45);
	}

	.log-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		background-color: color-mix(in srgb, var(--surface-border) 25%, transparent);
		border-bottom: 1px solid var(--surface-border);
	}

	.log-modal-header-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.log-modal-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
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
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.15s, background-color 0.15s;
	}

	.log-modal-close:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.log-modal-body {
		flex: 1;
		overflow-y: auto;
		min-height: 12rem;
		padding: 0.75rem 1rem 1rem;
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
