<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { onDestroy, onMount, tick } from 'svelte';
	import { animate } from 'motion';

	// Disable native macOS rubber-band overscroll on this page only — restored
	// on unmount so other pages keep their default behavior.
	onMount(() => {
		const main = document.querySelector<HTMLElement>('main.flex-1');
		if (!main) return;
		const prev = main.style.overscrollBehavior;
		main.style.overscrollBehavior = 'none';
		return () => { main.style.overscrollBehavior = prev; };
	});

	// Velocity-aware spring lift on hover. Interrupting mid-animation inherits
	// the current velocity, so the element settles smoothly instead of snapping.
	function springHover(opts: { rest?: number; lift?: number; stiffness?: number; damping?: number } = {}) {
		const rest = opts.rest ?? 0;
		const lift = opts.lift ?? -4;
		const stiffness = opts.stiffness ?? 380;
		const damping = opts.damping ?? 22;
		return (el: Element) => {
			const target = el as HTMLElement;
			const enter = () => {
				animate(target, { y: lift }, { type: 'spring', stiffness, damping });
			};
			const leave = () => {
				animate(target, { y: rest }, { type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 });
			};
			const press = () => {
				animate(target, { scale: 0.97 }, { type: 'spring', stiffness: 600, damping: 28 });
			};
			const release = () => {
				animate(target, { scale: 1 }, { type: 'spring', stiffness: 420, damping: 18 });
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

	// Springs an element's width between two pixel values when `active()` flips.
	function springWidth(active: () => boolean, opts: { rest: number; on: number; stiffness?: number; damping?: number; mass?: number }) {
		return (el: Element) => {
			const target = el as HTMLElement;
			target.style.width = `${active() ? opts.on : opts.rest}px`;
			let prev = active();
			$effect(() => {
				const next = active();
				if (next === prev) return;
				prev = next;
				animate(
					target,
					{ width: `${next ? opts.on : opts.rest}px` },
					{ type: 'spring', stiffness: opts.stiffness ?? 380, damping: opts.damping ?? 22, mass: opts.mass ?? 0.7 }
				);
			});
		};
	}

	// Cursor-tracking 3D tilt — small spring-tracked rotation toward the cursor.
	// Independent transform axes (rotateX/rotateY) compose with springHover's y/scale.
	function cardTilt(opts: { max?: number; stiffness?: number; damping?: number; mass?: number } = {}) {
		const max = opts.max ?? 5;
		const stiffness = opts.stiffness ?? 380;
		const damping = opts.damping ?? 28;
		const mass = opts.mass ?? 0.5;
		return (el: Element) => {
			const target = el as HTMLElement;
			target.style.transformStyle = 'preserve-3d';
			target.style.perspective = '900px';
			let rect: DOMRect | null = null;
			const onEnter = () => { rect = target.getBoundingClientRect(); };
			const onMove = (e: PointerEvent) => {
				if (!rect) rect = target.getBoundingClientRect();
				const x = (e.clientX - rect.left) / rect.width - 0.5;
				const y = (e.clientY - rect.top) / rect.height - 0.5;
				animate(
					target,
					{ rotateX: -y * max, rotateY: x * max },
					{ type: 'spring', stiffness, damping, mass }
				);
			};
			const onLeave = () => {
				animate(
					target,
					{ rotateX: 0, rotateY: 0 },
					{ type: 'spring', stiffness: stiffness * 0.7, damping: damping + 4, mass }
				);
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

	// Mount-time stagger using Motion. Replaces CSS keyframes so everything is
	// driven by the same physics engine.
	// WeakSet guard so SSE-triggered re-renders don't re-fire the entrance
	// animation on cards that have already played it.
	const staggered = new WeakSet<Element>();
	function motionStagger(opts: {
		index?: number;
		stride?: number;
		from?: { y?: number; opacity?: number; scale?: number };
		stiffness?: number;
		damping?: number;
		mass?: number;
		axis?: 'x' | 'y';
	} = {}) {
		const i = opts.index ?? 0;
		const stride = opts.stride ?? 0.05;
		const from = {
			y: opts.from?.y ?? 8,
			opacity: opts.from?.opacity ?? 0,
			scale: opts.from?.scale ?? 0.985
		};
		const axis = opts.axis ?? 'y';
		return (el: Element) => {
			const target = el as HTMLElement;
			if (staggered.has(target)) return;
			staggered.add(target);
			const keyframes: Record<string, number[]> = {
				opacity: [from.opacity, 1],
				scale: [from.scale, 1]
			};
			keyframes[axis] = [from.y, 0];
			animate(target, keyframes, {
				type: 'spring',
				stiffness: opts.stiffness ?? 260,
				damping: opts.damping ?? 22,
				mass: opts.mass ?? 0.9,
				delay: i * stride
			});
		};
	}

	// Portal an element to <body> and pin it under a reference element with
	// position:fixed. Sidesteps ancestor stacking contexts (backdrop-filter,
	// transforms) so the popover sits above everything in the document.
	function portalUnder(getAnchor: () => Element | null | undefined, offset = 6) {
		return (el: Element) => {
			const node = el as HTMLElement;
			const place = () => {
				const anchor = getAnchor();
				if (!anchor) return;
				const r = anchor.getBoundingClientRect();
				node.style.position = 'fixed';
				node.style.top = `${r.bottom + offset}px`;
				node.style.right = `${window.innerWidth - r.right}px`;
				node.style.left = 'auto';
				node.style.zIndex = '9999';
			};
			place();
			document.body.appendChild(node);
			const onResize = () => place();
			window.addEventListener('resize', onResize);
			window.addEventListener('scroll', onResize, true);
			return () => {
				window.removeEventListener('resize', onResize);
				window.removeEventListener('scroll', onResize, true);
				try { node.remove(); } catch { /* already removed */ }
			};
		};
	}

	// Motion-driven popover lifecycle. `isOpen` is reactive; element runs IN spring
	// on mount, OUT spring when isOpen goes false. The element stays mounted (set
	// `keepMounted=true` and switch off via getter) until OUT finishes.
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
			y: opts.from?.y ?? -6
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
					// Reopened while still rendered — re-run the IN.
					animate(
						target,
						{ opacity: 1, scale: 1, y: 0 },
						{ type: 'spring', stiffness, damping, mass }
					);
				}
			});
		};
	}

	// One-shot pop spring — fires when `active` flips false → true.
	function springPop(active: () => boolean) {
		return (el: Element) => {
			const target = el as HTMLElement;
			let prev = active();
			$effect(() => {
				const next = active();
				if (next && !prev) {
					animate(
						target,
						{ scale: [0.92, 1.04, 1] },
						{ type: 'spring', stiffness: 480, damping: 16, mass: 0.9 }
					);
				}
				prev = next;
			});
		};
	}
	import { apiFetch, toasts, refreshTree, subscribeOrgEvents } from '$lib/stores';
	import type { PageData } from './$types';
	import { mergeAttrs } from 'melt';
	import { SpatialMenu } from 'melt/builders';
	import {
		Loader2,
		Plus,
		ExternalLink,
		Trash2,
		Server,
		GitBranch,
		LayoutTemplate,
		Users,
		Database as DatabaseIcon,
		Palette,
		Upload,
		Image as ImageIcon,
		Smile,
		X as XIcon,
		Check,
		ChevronDown,
		ChevronLeft,
		ChevronRight,
		FileText,
	} from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import NewResourceModal from '$lib/components/NewResourceModal.svelte';
	import Breadcrumb from '$lib/components/Breadcrumb.svelte';

	interface DeploymentUser {
		id: string;
		username?: string;
		firstName?: string;
		lastName?: string;
		imageUrl?: string;
	}

	interface Deployment {
		id: string;
		name: string;
		status: string;
		buildStatus?: string;
		replicas: number;
		image?: string;
		githubRepo?: string;
		githubBranch?: string;
		ingresses?: Array<{ id: string; host: string }>;
		creator?: DeploymentUser;
		imageHistory?: Array<{
			buildStartedAt?: string;
			buildCompletedAt?: string;
			commitAuthorName?: string;
			commitAuthorUsername?: string;
			triggeredBy?: DeploymentUser;
		}>;
	}

	interface Member {
		id: string;
		role: string;
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
		};
	}

	interface Project {
		id: string;
		name: string;
		slug: string;
		description?: string;
		namespace?: string;
		repositoryUrl?: string;
		icon?: string | null;
		backgroundImage?: string | null;
		deployments?: Deployment[];
		members?: ProjectMember[];
		organization?: {
			id: string;
			name: string;
			slug: string;
		};
		currentUserRole?: {
			orgRole: 'owner' | 'admin' | 'member' | 'guest' | null;
			projectRole: 'admin' | 'member' | 'viewer' | null;
			source?: 'orgAdmin' | 'projectMember' | 'superadmin';
			canView?: boolean;
			canEdit: boolean;
			canManageMembers?: boolean;
			canDelete?: boolean;
		};
	}

	interface TemplateInstanceSummary {
		id: string;
		name: string;
		status: string;
		createdAt: string;
		template: {
			id: string;
			name: string;
			displayName: string;
			icon?: string;
			category?: string;
		};
		_count?: { deployments: number; databases: number; ingresses: number };
		deployments?: { id: string }[];
		databases?: { id: string }[];
		ingresses?: { id: string }[];
	}

	const deploymentMenu = new SpatialMenu<Deployment>({
		wrap: true,
		crossAxis: true
	});

	interface ProjectMember {
		id: string;
		role: { name: string };
		// `orgRole` is the user's role at the organisation level (owner / admin /
		// member / guest). The server enriches each ProjectMember row with this
		// so the UI can flag guests without needing a second fetch.
		orgRole?: 'owner' | 'admin' | 'member' | 'guest' | null;
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
		};
	}

	let project = $state<Project | null>(null);
	const canEdit = $derived(project?.currentUserRole?.canEdit ?? false);
	const canManageMembers = $derived(project?.currentUserRole?.canManageMembers ?? false);
	const canDelete = $derived(project?.currentUserRole?.canDelete ?? false);
	let templateInstances = $state<TemplateInstanceSummary[]>([]);

	interface DatabaseSummary {
		id: string;
		name: string;
		dbName: string;
		status: string;
		mode?: string;
		createdAt: string;
	}
	let databases = $state<DatabaseSummary[]>([]);
	let loading = $state(true);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let heroImgReady = $state(false);
	let showDeleteModal = $state(false);
	let deploymentSearch = $state('');
	let showNewResourceModal = $state(false);
	let projectMembers = $state<ProjectMember[]>([]);
	let newMemberRole = $state<'member' | 'admin' | 'viewer'>('member');
	let addingMember = $state(false);
	let favFailed = $state<Set<string>>(new Set());

	// Customize modal (icon + background image)
	let showCustomize = $state(false);
	let iconMode = $state<'emoji' | 'image'>('emoji');
	let emojiValue = $state('');
	const emojiSuggestions = ['🚀', '⚡', '✨', '🌱', '🔥', '🧪', '📦', '🛠️', '🌊', '🎯', '🧩', '🪐'];
	let savingCustom = $state(false);
	let uploadingIcon = $state(false);
	let uploadingBg = $state(false);
	let iconPreview = $state<string | null>(null); // current or newly uploaded icon URL (for image mode)
	let bgPreview = $state<string | null>(null);
	let nameValue = $state('');

	function isImageUrl(v?: string | null) {
		return !!v && /^https?:\/\//.test(v);
	}

	function openCustomize() {
		const icon = project?.icon ?? '';
		if (icon && isImageUrl(icon)) {
			iconMode = 'image';
			iconPreview = icon;
			emojiValue = '';
		} else {
			iconMode = 'emoji';
			emojiValue = icon;
			iconPreview = null;
		}
		bgPreview = project?.backgroundImage ?? null;
		nameValue = project?.name ?? '';
		showCustomize = true;
	}

	async function handleIconFile(e: Event) {
		if (!project) return;
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadingIcon = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await apiFetch(`/apiv1/projects/${project.id}/icon`, { method: 'POST', body: fd });
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Upload failed');
			}
			const updated = await res.json();
			iconPreview = updated.icon;
			project = { ...project, icon: updated.icon };
			toasts.add({ title: 'Icon uploaded', color: 'success' });
		} catch (err) {
			toasts.add({ title: 'Upload failed', description: err instanceof Error ? err.message : '', color: 'error' });
		} finally {
			uploadingIcon = false;
			input.value = '';
		}
	}

	async function handleBgFile(e: Event) {
		if (!project) return;
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadingBg = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await apiFetch(`/apiv1/projects/${project.id}/background-image`, { method: 'POST', body: fd });
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Upload failed');
			}
			const updated = await res.json();
			bgPreview = updated.backgroundImage;
			project = { ...project, backgroundImage: updated.backgroundImage };
			toasts.add({ title: 'Background uploaded', color: 'success' });
		} catch (err) {
			toasts.add({ title: 'Upload failed', description: err instanceof Error ? err.message : '', color: 'error' });
		} finally {
			uploadingBg = false;
			input.value = '';
		}
	}

	async function saveCustomize() {
		if (!project || savingCustom) return;
		savingCustom = true;
		try {
			const payload: Record<string, string | null> = {};
			if (iconMode === 'emoji') {
				payload.icon = emojiValue.trim() || null;
			}
			// In image mode, icon was already persisted by the upload endpoint; no need to overwrite.
			// Background was also already persisted by its upload endpoint. But if user cleared it:
			if (bgPreview === null && project.backgroundImage) {
				payload.backgroundImage = null;
			}
			if (iconMode === 'emoji' && project.icon && isImageUrl(project.icon)) {
				// User switched from image back to emoji → clear the image URL if they also left emoji empty.
				if (!emojiValue.trim()) payload.icon = null;
			}
			const trimmedName = nameValue.trim();
			if (trimmedName && trimmedName !== project.name) {
				payload.name = trimmedName;
			}

			if (Object.keys(payload).length > 0) {
				const res = await apiFetch(`/apiv1/projects/${project.id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});
				if (!res.ok) {
					const d = await res.json().catch(() => ({}));
					throw new Error(d.message || 'Failed to save');
				}
				const updated = await res.json();
				project = { ...project, name: updated.name, icon: updated.icon, backgroundImage: updated.backgroundImage };
			}
			toasts.add({ title: 'Project updated', color: 'success' });
			showCustomize = false;
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to save', color: 'error' });
		} finally {
			savingCustom = false;
		}
	}

	function clearBg() { bgPreview = null; }
	let removingMemberId = $state<string | null>(null);
	let updatingMemberId = $state<string | null>(null);
	let openRoleMenuId = $state<string | null>(null);
	let renderRoleMenuId = $state<string | null>(null);
	$effect(() => {
		if (openRoleMenuId !== null) renderRoleMenuId = openRoleMenuId;
	});
	let activeTab = $state<'resources' | 'compose' | 'members'>('resources');

	interface ComposeStackSummary {
		id: string;
		name: string;
		status: string;
		createdAt: string;
		deployments: { id: string; name: string; status: string; composeServiceName?: string }[];
	}
	let composeStacks = $state<ComposeStackSummary[]>([]);
	let composeStacksLoading = $state(false);

	async function fetchComposeStacks(projectId: string) {
		composeStacksLoading = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${projectId}/compose-stacks`);
			if (response.ok) {
				composeStacks = await response.json();
			}
		} catch {
			/* silent */
		} finally {
			composeStacksLoading = false;
		}
	}

	$effect(() => {
		if (project?.id) {
			fetchComposeStacks(project.id);
		}
	});
	let heroEl = $state<HTMLElement | null>(null);
	let heroTitleEl = $state<HTMLElement | null>(null);
	let heroDescEl = $state<HTMLElement | null>(null);
	let tabsRowEl = $state<HTMLElement | null>(null);
	let tabPanelEl = $state<HTMLElement | null>(null);
	let firstTabRun = true;

	$effect(() => {
		const compact = activeTab === 'members';
		const heroPx = compact ? 7.5 * 16 : 18 * 16; // rem → px
		const titlePx = compact ? 1.0625 * 16 : 1.25 * 16;
		const descOp = compact ? 0 : 1;

		// Hero — heavy, slight overshoot. ζ ≈ 0.6 (was 0.46).
		if (heroEl) {
			animate(
				heroEl,
				{ height: `${heroPx}px` },
				{ type: 'spring', stiffness: 180, damping: 19, mass: 1.3 }
			);
		}
		if (heroTitleEl) {
			animate(
				heroTitleEl,
				{ fontSize: `${titlePx}px` },
				{ type: 'spring', stiffness: 220, damping: 22, mass: 1 }
			);
		}
		if (heroDescEl) {
			animate(
				heroDescEl,
				{ opacity: descOp },
				{ type: 'spring', stiffness: 260, damping: 26, mass: 0.7 }
			);
		}

		// Sympathetic shockwave — softened from ζ≈0.34 to ζ≈0.55.
		if (firstTabRun) { firstTabRun = false; return; }
		const dir = compact ? -1 : 1;
		tick().then(() => {
			if (tabsRowEl) {
				animate(
					tabsRowEl,
					{ y: [dir * 5, 0] },
					{ type: 'spring', stiffness: 220, damping: 15, mass: 0.9 }
				);
			}
			if (tabPanelEl) {
				animate(
					tabPanelEl,
					{ y: [dir * 9, 0], opacity: [0.5, 1] },
					{ type: 'spring', stiffness: 180, damping: 15, mass: 1.2, delay: 0.05 }
				);
			}
		});
	});
	let carouselEl = $state<HTMLDivElement | null>(null);
	let carouselPage = $state(0);
	let carouselPages = $state(1);
	function updateCarouselNav() {
		if (!carouselEl) return;
		const cw = carouselEl.clientWidth;
		const sl = carouselEl.scrollLeft;
		// Pages count is now driven by deployment pairs (deploymentPages.length)
		// — each page is exactly one viewport wide.
		carouselPage = cw > 0 ? Math.min(carouselPages - 1, Math.round(sl / cw)) : 0;
	}
	function scrollToPage(i: number) {
		if (!carouselEl) return;
		const cw = carouselEl.clientWidth;
		const max = carouselEl.scrollWidth - cw;
		carouselEl.scrollTo({ left: Math.min(i * cw, max), behavior: 'smooth' });
	}
	function carouselWheel(e: WheelEvent) {
		if (!carouselEl) return;
		// Mouse-wheel users: redirect vertical wheel to horizontal scroll.
		// Trackpad horizontal swipes flow through natively.
		if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
			e.preventDefault();
			carouselEl.scrollBy({ left: e.deltaY, behavior: 'auto' });
		}
	}
	$effect(() => {
		if (!carouselEl) return;
		updateCarouselNav();
		const ro = new ResizeObserver(updateCarouselNav);
		ro.observe(carouselEl);
		return () => ro.disconnect();
	});

	// Keep carouselPages in sync with the actual chunk count.
	$effect(() => {
		carouselPages = Math.max(1, deploymentPages.length);
		if (carouselPage >= carouselPages) carouselPage = carouselPages - 1;
	});
	const ROLE_OPTIONS: { value: 'admin' | 'member' | 'viewer'; label: string; desc: string }[] = [
		{ value: 'admin', label: 'Admin', desc: 'Full access — manage members & resources' },
		{ value: 'member', label: 'Member', desc: 'Create & edit project resources' },
		{ value: 'viewer', label: 'Viewer', desc: 'Read-only access' }
	];

	interface OrgMember {
		id: string;
		role: string;
		user: {
			id: string;
			email: string;
			firstName?: string;
			lastName?: string;
			imageUrl?: string;
		};
	}
	let orgMembers = $state<OrgMember[]>([]);
	let memberSearch = $state('');
	let pickerOpen = $state(false);
	let pickerRender = $state(false);
	$effect(() => {
		if (pickerOpen) pickerRender = true;
	});
	let pickerInput = $state<HTMLInputElement | null>(null);

	const availableOrgMembers = $derived.by(() => {
		const existingUserIds = new Set(projectMembers.map((m) => m.user.id));
		return orgMembers.filter((m) => !existingUserIds.has(m.user.id));
	});

	const filteredOrgMembers = $derived.by(() => {
		const query = memberSearch.trim().toLowerCase();
		if (!query) return availableOrgMembers;
		return availableOrgMembers.filter((m) => {
			const name = `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.toLowerCase();
			return name.includes(query) || m.user.email.toLowerCase().includes(query);
		});
	});

	let filteredDeployments = $derived.by(() => {
		const deployments = project?.deployments ?? [];
		const query = deploymentSearch.trim().toLowerCase();
		if (!query) return deployments;
		return deployments.filter(deployment => {
			const name = deployment.name?.toLowerCase() ?? '';
			const status = deployment.status?.toLowerCase() ?? '';
			const image = deployment.image?.toLowerCase() ?? '';
			return (
				name.includes(query) ||
				status.includes(query) ||
				image.includes(query)
			);
		});
	});

	// Group deployments into pages of two so the carousel snaps in pairs
	// instead of per card. Single-card pages happen on odd counts.
	const DEPLOYMENTS_PER_PAGE = 2;
	const deploymentPages = $derived.by(() => {
		const out: Deployment[][] = [];
		for (let i = 0; i < filteredDeployments.length; i += DEPLOYMENTS_PER_PAGE) {
			out.push(filteredDeployments.slice(i, i + DEPLOYMENTS_PER_PAGE));
		}
		return out;
	});

	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);
	const projectSlug = $derived(data.projectSlug);

	async function fetchProject() {
		await invalidate(`project:${orgSlug}/${projectSlug}`);
	}

	function applyProjectData(p: any) {
		project = p;
		projectMembers = p.members ?? [];
		templateInstances = p.templateInstances ?? [];
		databases = p.databases ?? [];
	}

	let orgMembersLoaded = false;
	async function ensureOrgMembersLoaded() {
		if (orgMembersLoaded || !project) return;
		orgMembersLoaded = true;
		try {
			const res = await apiFetch(`/apiv1/organizations/${project.organization?.id ?? ''}/members`);
			if (res.ok) orgMembers = await res.json();
		} catch {
			orgMembersLoaded = false;
		}
	}

	let lastSyncedNamespace: string | null = null;
	async function syncNamespace() {
		if (!project?.namespace) return;
		// Only sync once per namespace per page mount. Without this guard, every
		// SSE-triggered project refetch re-runs sync, which spams the endpoint.
		if (project.namespace === lastSyncedNamespace) return;
		lastSyncedNamespace = project.namespace;
		try {
			await apiFetch(`/apiv1/sync/${project.namespace}`, { method: 'POST' });
			const response = await apiFetch(`/apiv1/projects/${project.id}`);
			if (response.ok) project = await response.json();
		} catch (e) {
			console.error('Failed to sync namespace:', e);
		}
	}

	async function deleteProject() {
		if (!project) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				let errorMessage = 'Failed to delete project';
				try {
					const errorData = await response.json();
					if (errorData.message) {
						errorMessage = errorData.message;
					} else if (errorData.error) {
						errorMessage = errorData.error;
					}
				} catch {
					if (response.status === 403) {
						errorMessage = 'You do not have permission to delete this project.';
					} else if (response.status === 404) {
						errorMessage = 'Project not found';
					}
				}
				throw new Error(errorMessage);
			}

			toasts.add({
				title: 'Project deleted',
				description: `${project.name} has been deleted`,
				color: 'success'
			});

			refreshTree();
			goto(`/${orgSlug}`);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete project',
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}

	async function addMember(email: string) {
		if (!project || !email) return;
		addingMember = true;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, role: newMemberRole })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to add member');
			}
			toasts.add({ title: 'Member added', color: 'success' });
			memberSearch = '';
			pickerOpen = false;
			newMemberRole = 'member';
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to add member',
				color: 'error'
			});
		} finally {
			addingMember = false;
		}
	}

	async function updateMemberRole(memberId: string, role: string, prevRole: string) {
		if (!project || role === prevRole) return;
		updatingMemberId = memberId;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/members/${memberId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update role');
			}
			toasts.add({ title: 'Role updated', color: 'success' });
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update role',
				color: 'error'
			});
			await fetchProject();
		} finally {
			updatingMemberId = null;
		}
	}

	async function removeMember(memberId: string) {
		if (!project) return;
		removingMemberId = memberId;
		try {
			const response = await apiFetch(`/apiv1/projects/${project.id}/members/${memberId}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to remove member');
			}
			toasts.add({ title: 'Member removed', color: 'success' });
			await fetchProject();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove member',
				color: 'error'
			});
		} finally {
			removingMemberId = null;
		}
	}

	function formatBuildDuration(deployment: Deployment): string | null {
		const history = deployment.imageHistory?.[0];
		if (!history?.buildStartedAt || !history?.buildCompletedAt) return null;
		const ms = new Date(history.buildCompletedAt).getTime() - new Date(history.buildStartedAt).getTime();
		if (ms < 1000) return '<1s';
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const rem = seconds % 60;
		return `${minutes}m ${rem}s`;
	}

	function getDeploymentAuthor(deployment: Deployment): string | null {
		const history = deployment.imageHistory?.[0];
		if (history?.commitAuthorName) return history.commitAuthorName;
		if (history?.triggeredBy) {
			const t = history.triggeredBy;
			return t.firstName ? `${t.firstName} ${t.lastName ?? ''}`.trim() : t.username ?? null;
		}
		if (deployment.creator) {
			const c = deployment.creator;
			return c.firstName ? `${c.firstName} ${c.lastName ?? ''}`.trim() : c.username ?? null;
		}
		return null;
	}

	function getStatusColor(status: string) {
		switch (status?.toLowerCase()) {
			case 'running':
				return 'pj-status-running';
			case 'pending':
			case 'restarting':
			case 'scaling':
				return 'pj-status-pending';
			case 'failed':
			case 'error':
			case 'stopped':
			case 'unhealthy':
				return 'pj-status-error';
			default:
				return 'pj-status-neutral';
		}
	}

	function getStatusLabel(status: string) {
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

	let unsub: (() => void) | null = null;
	// Slug we've finished loading. Only used to detect a real project-switch
	// (previously-loaded slug differs from current) so we can reset to a
	// skeleton instead of showing the previous project's content while the
	// new promise resolves. On fresh mount it's null and we leave state
	// alone — `loading` defaults to true so the skeleton already shows.
	let loadedSlug: string | null = null;

	$effect(() => {
		const slug = data.projectSlug;
		const promise = data.projectPromise;
		if (!promise) return;
		const isProjectSwitch = loadedSlug !== null && loadedSlug !== slug;
		if (isProjectSwitch) {
			error = null;
			loading = true;
			project = null;
			projectMembers = [];
			templateInstances = [];
			databases = [];
			lastSyncedNamespace = null;
		}
		promise
			.then((p) => {
				if (!p) return;
				applyProjectData(p);
				loadedSlug = slug;
				loading = false;
				error = null;
				if (p?.namespace) syncNamespace();
				const orgIdValue = p?.organization?.id;
				if (orgIdValue) {
					unsub?.();
					unsub = subscribeOrgEvents(
						orgIdValue,
						(ev) => {
							if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
							if (
								ev.projectId === p.id ||
								ev.type === 'project.changed' ||
								ev.type === 'membership.changed'
							) {
								invalidate(`project:${orgSlug}/${projectSlug}`);
							}
						},
						{ invalidateDependencies: [] },
					);
				}
			})
			.catch((e) => {
				error = e instanceof Error ? e.message : 'Failed to fetch project';
				loading = false;
			});
	});

	onDestroy(() => unsub?.());

	function openDeployment(id: string) {
		return goto(`/${orgSlug}/deployments/${id}`);
	}

	function handleDeploymentClick(event: MouseEvent, id: string) {
		if (
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			event.button !== 0
		) {
			return;
		}
		event.preventDefault();
		openDeployment(id);
	}
</script>

<svelte:window onclick={() => (openRoleMenuId = null)} onkeydown={(e) => { if (e.key === 'Escape') openRoleMenuId = null; }} />

<div class="pj-page" class:pj-page--hasbg={!!project?.backgroundImage}>
	{#if project?.backgroundImage && heroImgReady}
		<div class="pj-accent-glow" aria-hidden="true">
			<div class="pj-accent-glow-layer pj-accent-glow-layer--1" style="background-image: url({JSON.stringify(project.backgroundImage)});"></div>
			<div class="pj-accent-glow-layer pj-accent-glow-layer--2" style="background-image: url({JSON.stringify(project.backgroundImage)});"></div>
			<div class="pj-accent-glow-layer pj-accent-glow-layer--3" style="background-image: url({JSON.stringify(project.backgroundImage)});"></div>
			<div class="pj-accent-glow-fade"></div>
		</div>
	{/if}

	<div class="pj-page-inner">
	{#if error}
		<div class="pj-error">{error}</div>
	{/if}

	{#if loading}
		<!-- Skeleton: Back link -->
		<div class="skeleton" style="height: 0.8125rem; width: 6rem; margin-bottom: 1rem;"></div>
		<!-- Skeleton: Header -->
		<div class="pj-header">
			<div class="pj-header-top">
				<div class="pj-header-info">
					<div class="skeleton" style="height: 1.5rem; width: 40%; margin-bottom: 0.375rem;"></div>
					<div class="skeleton" style="height: 0.875rem; width: 55%;"></div>
				</div>
				<div class="pj-header-actions">
					<div class="skeleton" style="height: 2rem; width: 4.5rem; border-radius: 0.5rem;"></div>
					<div class="skeleton" style="height: 2rem; width: 5rem; border-radius: 0.5rem;"></div>
				</div>
			</div>
		</div>
		<!-- Skeleton: Stats -->
		<div class="pj-stats">
			{#each Array(3) as _}
				<div class="skeleton" style="height: 1.75rem; width: 6rem; border-radius: 0.5rem;"></div>
			{/each}
		</div>
		<!-- Skeleton: Deployments header -->
		<div class="pj-deployments-header">
			<div class="skeleton" style="height: 1.125rem; width: 7rem;"></div>
		</div>
		<!-- Skeleton: Deployment cards -->
		<div class="pj-deployment-grid">
			{#each Array(3) as _}
				<div class="pj-deployment-card" style="pointer-events: none;">
					<div class="pj-deployment-card-top">
						<div class="skeleton skeleton-icon"></div>
						<div class="skeleton skeleton-badge"></div>
					</div>
					<div class="pj-deployment-card-body">
						<div class="skeleton skeleton-title"></div>
						<div class="skeleton skeleton-desc"></div>
					</div>
					<div class="pj-deployment-card-footer">
						<div class="skeleton" style="height: 0.625rem; width: 3rem;"></div>
					</div>
				</div>
			{/each}
		</div>
	{:else if project}
		<!-- Breadcrumb -->
		<Breadcrumb crumbs={[
			{ label: 'Home', href: `/${orgSlug}` },
			{ label: 'Projects', href: `/${orgSlug}` },
			{ label: project.name }
		]} />

		<!-- Hero / Header -->
		{#if project.backgroundImage}
			{#if heroImgReady}
				<div
					class="pj-hero-bleed"
					style="background-image: url({JSON.stringify(project.backgroundImage)});"
					aria-hidden="true"
				></div>
			{/if}
			<div
				class="pj-hero"
				class:pj-hero--compact={activeTab === 'members'}
				bind:this={heroEl}
			>
				<img
					class="pj-hero-img"
					src={project.backgroundImage}
					alt=""
					fetchpriority="high"
					decoding="async"
					onload={() => (heroImgReady = true)}
				/>
				<div class="pj-hero-fade"></div>
				<div class="pj-hero-content">
					<div class="pj-header-info">
						<h1
							class="pj-title pj-title--onhero"
							bind:this={heroTitleEl}
						>
							{#if project.icon}
								<span class="pj-title-icon">
									{#if /^https?:\/\//.test(project.icon)}
										<img src={project.icon} alt="" />
									{:else}
										{project.icon}
									{/if}
								</span>
							{/if}
							{project.name}
						</h1>
						{#if project.description}
							<p
								class="pj-description pj-description--onhero"
								bind:this={heroDescEl}
							>{project.description}</p>
						{/if}
					</div>
					<div class="pj-header-actions">
						{#if canEdit}
						<button
							onclick={openCustomize}
							class="pj-icon-btn pj-icon-btn--onhero"
							aria-label="Customize project"
							title="Customize"
						>
							<Palette class="h-4 w-4" />
						</button>
						{/if}
						{#if canDelete}
						<button
							onclick={() => (showDeleteModal = true)}
							disabled={deleting}
							class="pj-icon-btn pj-icon-btn--danger pj-icon-btn--onhero"
							aria-label="Delete project"
							title="Delete"
						>
							{#if deleting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Trash2 class="h-4 w-4" />{/if}
						</button>
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<div class="pj-header">
				<div class="pj-header-top">
					<div class="pj-header-info">
						<h1 class="pj-title">
							{#if project.icon}
								<span class="pj-title-icon">
									{#if /^https?:\/\//.test(project.icon)}
										<img src={project.icon} alt="" />
									{:else}
										{project.icon}
									{/if}
								</span>
							{/if}
							{project.name}
						</h1>
						{#if project.description}
							<p class="pj-description">{project.description}</p>
						{/if}
					</div>
					<div class="pj-header-actions">
						{#if canEdit}
						<button
							onclick={openCustomize}
							class="pj-icon-btn"
							aria-label="Customize project"
							title="Customize"
						>
							<Palette class="h-4 w-4" />
						</button>
						{/if}
						{#if canDelete}
						<button
							onclick={() => (showDeleteModal = true)}
							disabled={deleting}
							class="pj-icon-btn pj-icon-btn--danger"
							aria-label="Delete project"
							title="Delete"
						>
							{#if deleting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Trash2 class="h-4 w-4" />{/if}
						</button>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- Tab bar -->
		<div class="pj-tabs-row" bind:this={tabsRowEl}>
			<div class="pj-tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'resources'}
					class="pj-tab"
					class:is-active={activeTab === 'resources'}
					onclick={() => (activeTab = 'resources')}
					{@attach springPop(() => activeTab === 'resources')}
				>
					<Server class="h-3.5 w-3.5" />
					Resources
					<span class="pj-tab-count">
						{(project.deployments?.length ?? 0) + databases.length + templateInstances.length}
					</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'compose'}
					class="pj-tab"
					class:is-active={activeTab === 'compose'}
					onclick={() => (activeTab = 'compose')}
					{@attach springPop(() => activeTab === 'compose')}
				>
					<FileText class="h-3.5 w-3.5" />
					Compose
					<span class="pj-tab-count">{composeStacks.length}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === 'members'}
					class="pj-tab"
					class:is-active={activeTab === 'members'}
					onclick={() => (activeTab = 'members')}
					{@attach springPop(() => activeTab === 'members')}
				>
					<Users class="h-3.5 w-3.5" />
					Members
					<span class="pj-tab-count">{projectMembers.length}</span>
				</button>
			</div>
			<div class="pj-tabs-actions">
				{#if project.repositoryUrl}
					<a
						href={project.repositoryUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="pj-tab-chip"
						title="Open repository"
					>
						<ExternalLink class="h-3.5 w-3.5" />
						<span>Repo</span>
					</a>
				{/if}
				{#if activeTab === 'resources'}
					{#if project.deployments?.length}
						<div class="pj-deployment-search-bar" {...deploymentMenu.root}>
							<input
								type="search"
								placeholder="Search…"
								class="pj-search-input"
								bind:value={deploymentSearch}
								{...deploymentMenu.input}
							/>
						</div>
					{/if}
					<button
						class="pj-btn pj-btn-primary pj-btn--sm"
						onclick={() => (showNewResourceModal = true)}
					>
						<Plus class="h-4 w-4" />
						New
					</button>
				{/if}
			</div>
		</div>

		{#if activeTab === 'resources'}
		<div class="pj-tab-panel" bind:this={tabPanelEl}>

		{#if !project.deployments?.length}
			<div class="pj-empty-card">
				<span style:color="var(--surface-muted)"><Server class="h-10 w-10" /></span>
				<p>No deployments yet</p>
				<button
					class="pj-btn pj-btn-primary pj-btn-mt"
					onclick={() => (showNewResourceModal = true)}
				>
					<Plus class="h-4 w-4" />
					Create Resource
				</button>
			</div>
		{:else if filteredDeployments.length}
			<div class="pj-deployment-grid">
				{#each filteredDeployments as deployment, i (deployment.id)}
					{@const href = `/${orgSlug}/deployments/${deployment.id}`}
					{@const item = deploymentMenu.getItem(deployment, {
						onSelect: () => openDeployment(deployment.id)
					})}
					{@const host = deployment.ingresses?.[0]?.host?.split('/')[0]}
					<a
						class="pj-deployment-card"
						class:is-highlighted={item.highlighted}
						{@attach motionStagger({ index: i, from: { y: 10 } })}
						{@attach springHover({ lift: -4, stiffness: 360, damping: 22 })}
						{@attach cardTilt({ max: 5 })}
						{...mergeAttrs(item.attrs, {
							href,
							onclick: (event: Event) => handleDeploymentClick(event as MouseEvent, deployment.id)
						})}
					>
						<div class="pj-deployment-card-top">
							<div class="pj-deployment-favicon">
								{#if host && !favFailed.has(deployment.id)}
									<img
										src={`/apiv1/deployments/favicon?domain=${encodeURIComponent(host)}`}
										alt=""
										onerror={() => (favFailed = new Set(favFailed).add(deployment.id))}
									/>
								{:else}
									<span class="pj-deployment-favicon-letter">{deployment.name.charAt(0).toUpperCase()}</span>
								{/if}
								<span class="pj-deployment-favicon-dot {getStatusColor(deployment.status)}"></span>
							</div>
							<div class="pj-deployment-badges">
								<span class="pj-deployment-status-badge {getStatusColor(deployment.status)}">
									{getStatusLabel(deployment.status)}
								</span>
								{#if deployment.buildStatus && deployment.buildStatus !== 'none' && deployment.buildStatus !== 'succeeded'}
									<span class="pj-deployment-build-badge pj-build-{deployment.buildStatus}">
										Build: {deployment.buildStatus === 'building' ? 'Building' : deployment.buildStatus === 'failed' ? 'Failed' : deployment.buildStatus}
									</span>
								{/if}
							</div>
						</div>
						<div class="pj-deployment-card-body">
							<span class="pj-deployment-name">{deployment.name}</span>
							{#if deployment.githubRepo}
								<span class="pj-deployment-detail">{deployment.githubRepo}</span>
								{#if deployment.githubBranch}
									<span class="pj-deployment-branch">
										<GitBranch class="h-3.5 w-3.5" />
										{deployment.githubBranch}
									</span>
								{/if}
							{:else if deployment.image}
								<span class="pj-deployment-detail">{deployment.image}</span>
							{/if}
						</div>
						<div class="pj-deployment-card-footer">
							<span class="pj-deployment-replicas">
								{deployment.replicas} replica{deployment.replicas !== 1 ? 's' : ''}
							</span>
							{#if formatBuildDuration(deployment)}
								<span class="pj-deployment-meta">Built in {formatBuildDuration(deployment)}</span>
							{/if}
							{#if getDeploymentAuthor(deployment)}
								<span class="pj-deployment-meta">{getDeploymentAuthor(deployment)}</span>
							{/if}
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="pj-empty-card">
				<p>No deployments match "{deploymentSearch}"</p>
			</div>
		{/if}

		<!-- Databases -->
		{#if databases.length}
			<div class="pj-deployments-header" style="margin-top: 1rem;">
				<h2 class="pj-section-title">
					<DatabaseIcon class="h-4 w-4" style="color: var(--pj-color-green); display: inline;" />
					Databases
				</h2>
			</div>
			<div class="pj-deployment-grid">
				{#each databases as db, i (db.id)}
					<a
						href="/{orgSlug}/databases/{db.id}"
						class="pj-deployment-card"
						{@attach motionStagger({ index: i, from: { y: 10 } })}
						{@attach springHover({ lift: -4, stiffness: 360, damping: 22 })}
						{@attach cardTilt({ max: 5 })}
					>
						<div class="pj-deployment-card-top">
							<div class="pj-deployment-indicator" style="background-color: color-mix(in srgb, var(--pj-color-green) 12%, transparent)">
								<DatabaseIcon class="h-5 w-5" style="color: var(--pj-color-green)" />
							</div>
							<span class="pj-deployment-status-badge" style="background-color: color-mix(in srgb, {db.status === 'ready' ? 'var(--pj-color-green)' : db.status === 'error' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'} 15%, transparent); color: {db.status === 'ready' ? 'var(--pj-color-green)' : db.status === 'error' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'}">
								{db.status}
							</span>
						</div>
						<div class="pj-deployment-card-body">
							<span class="pj-deployment-name">{db.name}</span>
							<span class="pj-deployment-detail">{db.dbName}</span>
						</div>
						<div class="pj-deployment-card-footer">
							<span class="pj-deployment-replicas">
								PostgreSQL {db.mode === 'container' ? '· container' : '· shared'}
							</span>
						</div>
					</a>
				{/each}
			</div>
		{/if}

		<!-- Template Instances -->
		{#if templateInstances.length}
			<div class="pj-deployments-header" style="margin-top: 1rem;">
				<h2 class="pj-section-title">
					<LayoutTemplate class="h-4 w-4" style="color: var(--sidebar-text-active-border); display: inline;" />
					Template Instances
				</h2>
			</div>
			<div class="pj-deployment-grid">
				{#each templateInstances as ti, i (ti.id)}
					<a
						href="/{orgSlug}/template-instances/{ti.id}"
						class="pj-deployment-card"
						{@attach motionStagger({ index: i, from: { y: 10 } })}
						{@attach springHover({ lift: -4, stiffness: 360, damping: 22 })}
						{@attach cardTilt({ max: 5 })}
					>
						<div class="pj-deployment-card-top">
							<div class="pj-deployment-indicator" style="background-color: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent)">
								<LayoutTemplate class="h-5 w-5" style="color: var(--sidebar-text-active-border)" />
							</div>
							<span class="pj-deployment-status-badge" style="background-color: color-mix(in srgb, {ti.status === 'active' ? 'var(--pj-color-green)' : ti.status === 'failed' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'} 15%, transparent); color: {ti.status === 'active' ? 'var(--pj-color-green)' : ti.status === 'failed' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'}">
								{ti.status}
							</span>
						</div>
						<div class="pj-deployment-card-body">
							<span class="pj-deployment-name">{ti.name}</span>
							<span class="pj-deployment-detail">{ti.template.displayName}</span>
						</div>
						<div class="pj-deployment-card-footer">
							<span class="pj-deployment-replicas">
								{(ti._count ? ti._count.deployments + ti._count.databases + ti._count.ingresses : (ti.deployments?.length ?? 0) + (ti.databases?.length ?? 0) + (ti.ingresses?.length ?? 0))} resources
							</span>
						</div>
					</a>
				{/each}
			</div>
		{/if}

		</div>
		{/if}

		{#if activeTab === 'compose'}
		<div class="pj-tab-panel" bind:this={tabPanelEl}>
			<div class="pj-deployments-header">
				<h2 class="pj-section-title">
					<FileText class="h-4 w-4" style="color: #0db7ed; display: inline;" />
					Compose Stacks
				</h2>
				<div style="margin-left: auto;">
					<a href="/{orgSlug}/projects/{projectSlug}/compose-stacks/new" class="pj-btn pj-btn-primary pj-btn--sm">
						<Plus class="h-4 w-4" />
						New stack
					</a>
				</div>
			</div>

			{#if composeStacksLoading && composeStacks.length === 0}
				<div class="pj-empty-card">
					<Loader2 class="h-5 w-5 animate-spin" style="color: var(--surface-muted)" />
					<p>Loading compose stacks…</p>
				</div>
			{:else if composeStacks.length === 0}
				<div class="pj-empty-card">
					<span style:color="var(--surface-muted)"><FileText class="h-10 w-10" /></span>
					<p>No compose stacks yet</p>
					<a
						href="/{orgSlug}/projects/{projectSlug}/compose-stacks/new"
						class="pj-btn pj-btn-primary pj-btn-mt"
					>
						<Plus class="h-4 w-4" />
						Deploy from compose file
					</a>
				</div>
			{:else}
				<div class="pj-deployment-grid">
					{#each composeStacks as cs, i (cs.id)}
						<a
							href="/{orgSlug}/compose-stacks/{cs.id}"
							class="pj-deployment-card"
							{@attach motionStagger({ index: i, from: { y: 10 } })}
							{@attach springHover({ lift: -4, stiffness: 360, damping: 22 })}
							{@attach cardTilt({ max: 5 })}
						>
							<div class="pj-deployment-card-top">
								<div class="pj-deployment-indicator" style="background-color: color-mix(in srgb, #0db7ed 12%, transparent)">
									<FileText class="h-5 w-5" style="color: #0db7ed" />
								</div>
								<span
									class="pj-deployment-status-badge"
									style="background-color: color-mix(in srgb, {cs.status === 'active' ? 'var(--pj-color-green)' : cs.status === 'failed' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'} 15%, transparent); color: {cs.status === 'active' ? 'var(--pj-color-green)' : cs.status === 'failed' ? 'var(--pj-color-red)' : 'var(--pj-color-amber)'}"
								>
									{cs.status}
								</span>
							</div>
							<div class="pj-deployment-card-body">
								<span class="pj-deployment-name">{cs.name}</span>
								<span class="pj-deployment-detail">docker-compose.yml</span>
							</div>
							<div class="pj-deployment-card-footer">
								<span class="pj-deployment-replicas">
									{cs.deployments?.length ?? 0} service{(cs.deployments?.length ?? 0) === 1 ? '' : 's'}
								</span>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</div>
		{/if}

		{#if activeTab === 'members'}
		<div class="pj-tab-panel" bind:this={tabPanelEl}>
		<!-- Members -->
		<div class="pj-members-section">
			<div class="pj-members-card">
				<div class="pj-members-head">
					<div class="pj-members-title">
						<Users size={16} />
						<span>Members</span>
						<span class="pj-members-count">{projectMembers.length}</span>
					</div>
					{#if canManageMembers}
					<div class="pj-picker">
						<input
							type="text"
							bind:this={pickerInput}
							bind:value={memberSearch}
							placeholder="Add a member…"
							class="pj-invite-input"
							onfocus={() => { pickerOpen = true; ensureOrgMembersLoaded(); }}
							onblur={() => setTimeout(() => (pickerOpen = false), 150)}
						/>
						{#if pickerRender && filteredOrgMembers.length > 0}
							<div
								class="pj-picker-dropdown"
								{@attach motionPopover({
									from: { y: -8, scale: 0.96 },
									closing: () => !pickerOpen,
									onClosed: () => { pickerRender = false; }
								})}
							>
								{#each filteredOrgMembers as om (om.id)}
									<button
										type="button"
										class="pj-picker-item"
										onmousedown={(e) => e.preventDefault()}
										onclick={() => addMember(om.user.email)}
										disabled={addingMember}
									>
										{#if om.user.imageUrl}
											<img src={om.user.imageUrl} alt="" class="pj-member-avatar" />
										{:else}
											<div class="pj-member-avatar pj-member-avatar--letter">
												{(om.user.firstName ?? om.user.email).charAt(0).toUpperCase()}
											</div>
										{/if}
										<div class="pj-member-info">
											<span class="pj-member-name">
												{#if om.user.firstName}{om.user.firstName}{#if om.user.lastName}&nbsp;{om.user.lastName}{/if}{:else}{om.user.email}{/if}
												{#if om.role === 'guest'}
													<span class="guest-pill" title="Guests only see projects they're explicit members of">Guest</span>
												{/if}
											</span>
											{#if om.user.firstName}
												<span class="pj-member-email">{om.user.email}</span>
											{/if}
										</div>
									</button>
								{/each}
							</div>
						{:else if pickerRender && memberSearch.trim() && filteredOrgMembers.length === 0}
							<div
								class="pj-picker-dropdown"
								{@attach motionPopover({
									from: { y: -8, scale: 0.96 },
									closing: () => !pickerOpen,
									onClosed: () => { pickerRender = false; }
								})}
							>
								<div class="pj-picker-empty">No matching org members</div>
							</div>
						{/if}
					</div>
					{/if}
				</div>

				{#if projectMembers.length > 0}
					<ul class="pj-members-list">
						{#each projectMembers as m, i (m.id)}
							<li
								class="pj-member"
								{@attach motionStagger({ index: i, axis: 'x', from: { y: -10, scale: 1 }, stride: 0.04 })}
							>
								{#if m.user.imageUrl}
									<img src={m.user.imageUrl} alt="" class="pj-member-avatar" />
								{:else}
									<div class="pj-member-avatar pj-member-avatar--letter">
										{(m.user.firstName ?? m.user.email).charAt(0).toUpperCase()}
									</div>
								{/if}
								<div class="pj-member-info">
									<span class="pj-member-name">
										{#if m.user.firstName}{m.user.firstName}{#if m.user.lastName}&nbsp;{m.user.lastName}{/if}{:else}{m.user.email}{/if}
										{#if m.orgRole === 'guest'}
											<span class="guest-pill" title="Guests are only members of specific projects, not the whole organization">Guest</span>
										{/if}
									</span>
									<span class="pj-member-email">{m.user.email}</span>
								</div>
								{#if canManageMembers}
									{@const triggerId = `pj-role-trigger-${m.id}`}
									<div class="pj-role-wrap">
										<button
											type="button"
											id={triggerId}
											class="pj-role-chip pj-role-chip--{m.role.name} pj-role-trigger"
											aria-haspopup="listbox"
											aria-expanded={openRoleMenuId === m.id}
											aria-label="Change role for {m.user.firstName ?? m.user.email}"
											disabled={updatingMemberId === m.id}
											onclick={(e) => {
												e.stopPropagation();
												openRoleMenuId = openRoleMenuId === m.id ? null : m.id;
											}}
										>
											{#if updatingMemberId === m.id}
												<Loader2 class="h-3 w-3 animate-spin" />
											{:else}
												<span>{m.role.name}</span>
												<ChevronDown class="h-3 w-3 pj-role-caret" />
											{/if}
										</button>
										{#if renderRoleMenuId === m.id}
											<div
												class="pj-role-menu"
												role="listbox"
												onclick={(e) => e.stopPropagation()}
												{@attach motionPopover({
													from: { y: -6, scale: 0.9 },
													stiffness: 540,
													damping: 30,
													closing: () => openRoleMenuId !== m.id,
													onClosed: () => { if (renderRoleMenuId === m.id) renderRoleMenuId = null; }
												})}
												{@attach portalUnder(() => document.getElementById(triggerId))}
											>
												{#each ROLE_OPTIONS as opt}
													<button
														type="button"
														role="option"
														class="pj-role-option"
														class:is-selected={m.role.name === opt.value}
														aria-selected={m.role.name === opt.value}
														onclick={() => {
															openRoleMenuId = null;
															updateMemberRole(m.id, opt.value, m.role.name);
														}}
													>
														<span class="pj-role-option-check">
															{#if m.role.name === opt.value}
																<Check class="h-3.5 w-3.5" />
															{/if}
														</span>
														<span class="pj-role-option-text">
															<span class="pj-role-option-label">
																<span class="pj-role-dot pj-role-dot--{opt.value}"></span>
																{opt.label}
															</span>
															<span class="pj-role-option-desc">{opt.desc}</span>
														</span>
													</button>
												{/each}
											</div>
										{/if}
									</div>
								{:else}
									<span class="pj-role-chip pj-role-chip--{m.role.name}">{m.role.name}</span>
								{/if}
								{#if canEdit}
								<button
									class="pj-member-remove"
									title="Remove member"
									aria-label="Remove {m.user.firstName ?? m.user.email}"
									onclick={() => removeMember(m.id)}
									disabled={removingMemberId === m.id}
								>
									{#if removingMemberId === m.id}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<Trash2 class="h-3.5 w-3.5" />
									{/if}
								</button>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<div class="pj-members-empty">No members yet. Add someone from your organization above.</div>
				{/if}
			</div>
		</div>
		</div>
		{/if}
	{/if}
	</div>
</div>

<NewResourceModal
	bind:open={showNewResourceModal}
	orgSlug={orgSlug ?? ''}
	projectSlug={projectSlug ?? ''}
/>

{#if project}
	<ConfirmModal
		bind:open={showDeleteModal}
		title='Delete "{project.name}"?'
		description='This will permanently <strong>delete this project</strong> and all its resources (deployments, databases, ingresses). This cannot be undone.'
		confirmLabel="Delete Project"
		onconfirm={deleteProject}
		oncancel={() => {}}
	/>
{/if}

{#if showCustomize}
	<div
		class="cm-overlay"
		onclick={() => (showCustomize = false)}
		role="presentation"
	>
		<div
			class="cm-modal"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-label="Customize project"
		>
			<button class="cm-close" onclick={() => (showCustomize = false)} aria-label="Close">
				<XIcon class="h-4 w-4" />
			</button>

			<div class="cm-hero" style={bgPreview ? `background-image: url(${JSON.stringify(bgPreview)});` : ''}>
				{#if bgPreview}
					<div class="cm-hero-scrim"></div>
				{:else}
					<div class="cm-hero-placeholder" aria-hidden="true"></div>
				{/if}
				<div class="cm-hero-content">
					<div class="cm-hero-icon" class:cm-hero-icon--empty={!(iconMode === 'emoji' ? emojiValue.trim() : iconPreview)}>
						{#if iconMode === 'emoji' && emojiValue.trim()}
							<span class="cm-hero-emoji">{emojiValue.trim()}</span>
						{:else if iconMode === 'image' && iconPreview}
							<img src={iconPreview} alt="" />
						{:else}
							<Smile class="h-5 w-5" />
						{/if}
					</div>
					<div class="cm-hero-meta">
						<span class="cm-hero-eyebrow">Preview</span>
						<span class="cm-hero-name">{nameValue.trim() || project?.name || 'Project'}</span>
					</div>
				</div>
			</div>

			<div class="cm-body">
				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Name</h3>
					</div>
					<input
						type="text"
						class="cm-input"
						placeholder="Project name"
						maxlength="255"
						bind:value={nameValue}
					/>
				</section>

				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Icon</h3>
						<div class="cm-segmented" role="tablist" aria-label="Icon source">
							<button
								type="button"
								role="tab"
								aria-selected={iconMode === 'emoji'}
								class="cm-seg"
								class:cm-seg--active={iconMode === 'emoji'}
								onclick={() => (iconMode = 'emoji')}
							>Emoji</button>
							<button
								type="button"
								role="tab"
								aria-selected={iconMode === 'image'}
								class="cm-seg"
								class:cm-seg--active={iconMode === 'image'}
								onclick={() => (iconMode = 'image')}
							>Image</button>
						</div>
					</div>

					{#if iconMode === 'emoji'}
						<div class="cm-emoji-grid" role="radiogroup" aria-label="Emoji suggestions">
							{#each emojiSuggestions as emoji}
								<button
									type="button"
									role="radio"
									aria-checked={emojiValue.trim() === emoji}
									class="cm-emoji-chip"
									class:cm-emoji-chip--active={emojiValue.trim() === emoji}
									onclick={() => (emojiValue = emoji)}
								>{emoji}</button>
							{/each}
						</div>
						<div class="cm-emoji-custom">
							<input
								type="text"
								class="cm-input"
								placeholder="or paste any emoji…"
								maxlength="8"
								bind:value={emojiValue}
							/>
						</div>
					{:else}
						<label class="cm-drop" class:cm-drop--filled={!!iconPreview}>
							{#if uploadingIcon}
								<div class="cm-drop-state">
									<Loader2 class="h-5 w-5 animate-spin" />
									<span>Uploading…</span>
								</div>
							{:else if iconPreview}
								<div class="cm-drop-filled">
									<img src={iconPreview} alt="Project icon preview" class="cm-drop-thumb cm-drop-thumb--square" />
									<div class="cm-drop-meta">
										<span class="cm-drop-meta-title">Icon uploaded</span>
										<span class="cm-drop-meta-hint">Click to replace</span>
									</div>
								</div>
							{:else}
								<div class="cm-drop-state">
									<div class="cm-drop-icon"><Upload class="h-5 w-5" /></div>
									<div class="cm-drop-text">
										<span class="cm-drop-title">Upload icon</span>
										<span class="cm-drop-hint">PNG, JPG, SVG · up to 2 MB</span>
									</div>
								</div>
							{/if}
							<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" onchange={handleIconFile} disabled={uploadingIcon} />
						</label>
					{/if}
				</section>

				<section class="cm-section">
					<div class="cm-section-head">
						<h3 class="cm-section-title">Background</h3>
						{#if bgPreview}
							<button type="button" class="cm-text-btn" onclick={clearBg}>
								<Trash2 class="h-3.5 w-3.5" /> Remove
							</button>
						{/if}
					</div>

					<label class="cm-drop" class:cm-drop--filled={!!bgPreview}>
						{#if uploadingBg}
							<div class="cm-drop-state">
								<Loader2 class="h-5 w-5 animate-spin" />
								<span>Uploading…</span>
							</div>
						{:else if bgPreview}
							<div class="cm-drop-filled">
								<img src={bgPreview} alt="Background preview" class="cm-drop-thumb cm-drop-thumb--wide" />
								<div class="cm-drop-meta">
									<span class="cm-drop-meta-title">Background set</span>
									<span class="cm-drop-meta-hint">Click to replace</span>
								</div>
							</div>
						{:else}
							<div class="cm-drop-state">
								<div class="cm-drop-icon"><ImageIcon class="h-5 w-5" /></div>
								<div class="cm-drop-text">
									<span class="cm-drop-title">Upload background</span>
									<span class="cm-drop-hint">PNG, JPG, WebP · up to 8 MB</span>
								</div>
							</div>
						{/if}
						<input type="file" accept="image/png,image/jpeg,image/webp" onchange={handleBgFile} disabled={uploadingBg} />
					</label>
				</section>
			</div>

			<div class="cm-footer">
				<button class="pj-btn pj-btn-secondary" onclick={() => (showCustomize = false)} disabled={savingCustom}>
					Cancel
				</button>
				<button class="pj-btn pj-btn-primary" onclick={saveCustomize} disabled={savingCustom || uploadingIcon || uploadingBg}>
					{#if savingCustom}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					Save changes
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(:root) {
		--pj-color-green: #15803d;
		--pj-color-amber: #b45309;
		--pj-color-red: #b91c1c;
		/* Darker secondary text than --surface-muted for better light-mode contrast. */
		--pj-text-secondary: color-mix(in srgb, var(--center-channel-color) 70%, var(--surface-muted));
	}

	:global(:root.dark) {
		--pj-color-green: #4ade80;
		--pj-color-amber: #fbbf24;
		--pj-color-red: #f87171;
		/* Dark mode muted is already high enough contrast. */
		--pj-text-secondary: var(--surface-muted);
	}

	.pj-page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
		position: relative;
	}
	.pj-page--hasbg .pj-page-inner { position: relative; z-index: 1; }

	/* Subtle animated accent glow — spans the full viewport width, fades into the page.
	   3 rotating blurred copies of the banner, opacity-stacked (no blend modes). */
	.pj-accent-glow {
		position: absolute; top: 0;
		left: 50%; transform: translateX(-50%);
		width: 100vw; max-width: 100vw;
		height: 32rem;
		pointer-events: none; overflow: hidden;
		z-index: 0;
		animation: pj-glow-in 700ms ease-out both;
	}
	@keyframes pj-glow-in { from { opacity: 0; } to { opacity: 1; } }
	.pj-accent-glow-layer {
		position: absolute; inset: -40%;
		background-size: cover; background-position: center;
		filter: blur(80px) saturate(1.5);
		will-change: transform;
		transform-origin: 50% 50%;
	}
	.pj-accent-glow-layer--1 {
		transform: scale(1.6) rotate(0deg);
		animation: pj-accent-spin-a 32s linear infinite;
		opacity: 0.55;
	}
	.pj-accent-glow-layer--2 {
		transform: scale(2.1) translate(8%, -6%) rotate(70deg);
		animation: pj-accent-spin-b 48s linear infinite;
		opacity: 0.35;
	}
	.pj-accent-glow-layer--3 {
		transform: scale(2.6) translate(-10%, 9%) rotate(140deg);
		animation: pj-accent-spin-c 64s linear infinite;
		opacity: 0.25;
	}
	.pj-accent-glow-fade {
		position: absolute; inset: 0;
		background: linear-gradient(180deg, rgba(0,0,0,0) 45%, var(--center-channel-bg) 100%);
	}
	@keyframes pj-accent-spin-a { from { transform: scale(1.6) rotate(0deg); } to { transform: scale(1.6) rotate(360deg); } }
	@keyframes pj-accent-spin-b { from { transform: scale(2.1) translate(8%, -6%) rotate(70deg); } to { transform: scale(2.1) translate(8%, -6%) rotate(430deg); } }
	@keyframes pj-accent-spin-c { from { transform: scale(2.6) translate(-10%, 9%) rotate(140deg); } to { transform: scale(2.6) translate(-10%, 9%) rotate(-220deg); } }
	@media (prefers-reduced-motion: reduce) {
		.pj-accent-glow-layer--1, .pj-accent-glow-layer--2, .pj-accent-glow-layer--3 { animation: none; }
	}

	/* Hero (unblurred banner) */
	/* Hero height / title size / description fade are driven by Motion (motion.dev). */
	.pj-hero {
		position: relative;
		border-radius: 1rem;
		overflow: hidden;
		margin-bottom: 1.5rem;
		height: 18rem;
		box-shadow: 0 10px 30px rgba(0,0,0,0.22);
		z-index: 1;
	}
	.pj-description--onhero {
		overflow: hidden;
		margin: 0;
	}
	/* Extended bleed — continues the banner image below the hero at low opacity,
	   slowly fading to the page background over ~50rem. */
	.pj-hero-bleed {
		position: absolute;
		top: 2.5rem; /* matches pj-page top padding so it starts right under the viewport top */
		bottom: 0;
		left: 50%; transform: translateX(-50%);
		width: 100vw;
		background-size: cover;
		background-position: center top;
		-webkit-mask-image: linear-gradient(180deg,
			rgba(0,0,0,0) 0%,
			rgba(0,0,0,0.22) 30%,
			rgba(0,0,0,0.14) 50%,
			rgba(0,0,0,0.06) 75%,
			rgba(0,0,0,0) 100%);
		mask-image: linear-gradient(180deg,
			rgba(0,0,0,0) 0%,
			rgba(0,0,0,0.22) 30%,
			rgba(0,0,0,0.14) 50%,
			rgba(0,0,0,0.06) 75%,
			rgba(0,0,0,0) 100%);
		filter: blur(40px) saturate(1.2);
		pointer-events: none;
		z-index: 0;
		animation: pj-bleed-in 500ms ease-out both;
	}
	@keyframes pj-bleed-in {
		from { opacity: 0; transform: translateX(-50%) translateY(-0.75rem); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}
	@media (prefers-reduced-motion: reduce) {
		.pj-hero-bleed { animation: pj-bleed-fade 200ms ease-out both; }
		@keyframes pj-bleed-fade { from { opacity: 0; } to { opacity: 1; } }
	}
	.pj-hero-img {
		position: absolute; inset: 0;
		width: 100%; height: 100%;
		object-fit: cover;
		display: block;
	}
	.pj-hero-fade {
		position: absolute; inset: 0;
		background: linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,0.7) 100%);
	}
	.pj-hero-content {
		position: absolute; left: 0; right: 0; bottom: 0;
		padding: 1.25rem 1.5rem;
		display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem;
		color: #fff;
	}
	.pj-title--onhero { color: #fff !important; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }
	.pj-description--onhero { color: rgba(255,255,255,0.9) !important; text-shadow: 0 1px 2px rgba(0,0,0,0.3); }

	/* Breadcrumb pill — encapsulated for contrast against page or hero bg */
	.pj-page :global(.bc) {
		align-self: flex-start;
		padding: 0.3125rem 0.75rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-bg, var(--center-channel-bg)) 70%, transparent);
		border: 1px solid var(--surface-border);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		box-shadow: 0 1px 2px rgba(0,0,0,0.04);
		width: fit-content;
	}

	/* On hero/background variant — translucent white pill so breadcrumb pops over imagery */
	.pj-page--hasbg :global(.bc) {
		background: rgba(0, 0, 0, 0.32);
		border-color: rgba(255, 255, 255, 0.22);
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
	}
	.pj-page--hasbg :global(.bc-item),
	.pj-page--hasbg :global(.bc-link),
	.pj-page--hasbg :global(.bc-current),
	.pj-page--hasbg :global(.bc-sep) { color: rgba(255,255,255,0.85) !important; }
	.pj-page--hasbg :global(.bc-link:hover) { color: #fff !important; }
	.pj-page--hasbg :global(.bc-current) { color: #fff !important; }
	.pj-btn--onhero {
		background: rgba(255,255,255,0.18) !important;
		color: #fff !important;
		border: 1px solid rgba(255,255,255,0.3) !important;
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}
	.pj-btn--onhero:hover:not(:disabled) {
		background: rgba(255,255,255,0.28) !important;
	}

	/* Favicon replacing the status indicator */
	.pj-deployment-favicon {
		position: relative;
		width: 2.25rem; height: 2.25rem; flex-shrink: 0;
		border-radius: 0.5rem; overflow: visible;
		display: flex; align-items: center; justify-content: center;
		background: color-mix(in srgb, var(--surface-border) 35%, transparent);
	}
	.pj-deployment-favicon img {
		width: 100%; height: 100%;
		border-radius: 0.5rem;
		object-fit: contain;
		padding: 0.25rem;
		background: var(--center-channel-bg);
	}
	.pj-deployment-favicon-letter {
		font-size: 0.875rem; font-weight: 700;
		color: var(--center-channel-color);
	}
	.pj-deployment-favicon-dot {
		position: absolute;
		bottom: -2px; right: -2px;
		width: 0.75rem; height: 0.75rem;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--center-channel-bg);
	}
	.pj-deployment-favicon-dot::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: inherit;
		pointer-events: none;
	}
	.pj-deployment-favicon-dot.pj-status-running { background: #22c55e; }
	.pj-deployment-favicon-dot.pj-status-pending { background: #f59e0b; }
	.pj-deployment-favicon-dot.pj-status-error { background: #ef4444; }
	.pj-deployment-favicon-dot.pj-status-neutral { background: #9ca3af; }
	.pj-deployment-favicon-dot.pj-status-running::after,
	.pj-deployment-favicon-dot.pj-status-pending::after {
		animation: pj-dot-pulse 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite;
	}
	.pj-deployment-favicon-dot.pj-status-pending::after { animation-duration: 1.2s; }
	@keyframes pj-dot-pulse {
		0%   { transform: scale(1);   opacity: 0.8; }
		70%  { transform: scale(2.4); opacity: 0; }
		100% { transform: scale(2.4); opacity: 0; }
	}
	@media (prefers-reduced-motion: reduce) {
		.pj-deployment-favicon-dot::after { animation: none; }
	}

	.pj-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--pj-text-secondary);
		font-size: 0.875rem;
	}

	.pj-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	/* Header */
	.pj-header {
		margin-bottom: 1.5rem;
		position: relative;
	}
	.pj-header--hasbg {
		padding: 1.5rem 1.5rem 1.25rem;
		border-radius: 0.875rem;
		background-size: cover;
		background-position: center;
		background-repeat: no-repeat;
		overflow: hidden;
		color: #fff;
		box-shadow: 0 2px 6px rgba(0,0,0,0.08), 0 10px 28px rgba(0,0,0,0.06);
	}
	.pj-header-overlay {
		position: absolute; inset: 0; pointer-events: none;
		background: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.55) 100%);
	}
	.pj-header--hasbg .pj-header-top { position: relative; z-index: 1; }
	.pj-header--hasbg :global(.pj-title),
	.pj-header--hasbg :global(.pj-description) { color: #fff; }
	.pj-header--hasbg :global(.pj-description) { color: rgba(255,255,255,0.85); }

	.pj-title-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.75rem; height: 1.75rem; margin-right: 0.5rem;
		font-size: 1.25rem; vertical-align: -0.25rem; line-height: 1;
	}
	.pj-title-icon img { width: 100%; height: 100%; object-fit: contain; border-radius: 0.25rem; }

	.pj-header-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.pj-header-info {
		flex: 1;
		min-width: 0;
	}

	.pj-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.pj-description {
		font-size: 0.875rem;
		color: var(--pj-text-secondary);
		margin: 0.25rem 0 0;
	}

	.pj-header-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	/* Stats */
	.pj-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.pj-stat {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		color: var(--pj-text-secondary);
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		text-decoration: none;
	}

	.pj-stat-link:hover {
		background-color: color-mix(in srgb, var(--surface-border) 70%, transparent);
	}

	.pj-stat-value {
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.pj-stat-code {
		font-size: 0.75rem;
		font-family: var(--font-mono);
		color: var(--center-channel-color);
	}

	/* Deployments header */
	.pj-deployments-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.pj-section-title {
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--center-channel-color);
		margin: 0;
	}

	.pj-deployments-toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.pj-deployment-search-bar {
		width: 14rem;
	}

	.pj-search-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
	}

	.pj-search-input::placeholder {
		color: var(--surface-muted);
	}

	.pj-search-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
	}

	/* Deployment grid */
	.pj-deployment-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}

	/* Carousel — horizontal scroll with snap */
	.pj-carousel {
		position: relative;
		margin-top: 1rem;
		margin-bottom: 1.5rem;
	}

	/* Wraps just the track + arrows so arrows can center vertically on the
	   cards without being thrown off by the dots row underneath. */
	.pj-carousel-viewport {
		position: relative;
	}

	/* Glassy round arrow buttons floated on top of the track. They fade in
	   only when there's actually somewhere to scroll in that direction. */
	.pj-carousel-arrow {
		position: absolute;
		top: 0;
		bottom: 0;
		margin: auto 0; /* vertical centering without `transform` so Motion's y/scale don't fight it */
		z-index: 3;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--surface-border) 80%, transparent);
		background: color-mix(in srgb, var(--surface-bg, var(--center-channel-bg)) 80%, transparent);
		color: var(--center-channel-color);
		backdrop-filter: blur(10px) saturate(1.2);
		-webkit-backdrop-filter: blur(10px) saturate(1.2);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.06),
			0 6px 18px rgba(0, 0, 0, 0.08);
		cursor: pointer;
		opacity: 0;
		pointer-events: none;
		transition: opacity 180ms ease, background-color 180ms ease, color 180ms ease;
	}
	.pj-carousel-arrow--prev { left: -0.5rem; }
	.pj-carousel-arrow--next { right: -0.5rem; }
	.pj-carousel.has-prev .pj-carousel-arrow--prev,
	.pj-carousel.has-next .pj-carousel-arrow--next {
		opacity: 1;
		pointer-events: auto;
	}
	.pj-carousel-arrow:hover {
		background: var(--surface-bg, var(--center-channel-bg));
		color: var(--sidebar-text-active-border);
	}
	.pj-carousel-arrow:disabled {
		opacity: 0;
		pointer-events: none;
	}
	.pj-carousel-track {
		display: flex;
		gap: 0.75rem;
		overflow-x: auto;
		overflow-y: visible;
		scroll-snap-type: x mandatory;
		scroll-padding-inline: 0.25rem;
		padding: 0.25rem 0.25rem 0.5rem;
		margin: -0.25rem -0.25rem 0;
		scrollbar-width: none;
		overscroll-behavior-x: contain;
		-webkit-overflow-scrolling: touch;
	}
	.pj-carousel-track::-webkit-scrollbar { display: none; }

	/* Each page is one viewport-wide and contains a 2-column grid of cards.
	   Snapping at the page level (rather than per card) makes the carousel
	   navigate in pairs, matching the dot count. */
	.pj-carousel-track > .pj-carousel-page {
		flex: 0 0 100%;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		scroll-snap-align: start;
		scroll-snap-stop: always;
	}
	.pj-carousel-track > .pj-carousel-page > .pj-deployment-card {
		min-width: 0;
	}
	@media (max-width: 32rem) {
		.pj-carousel-track > .pj-carousel-page {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.pj-carousel-dots {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.4375rem;
		margin-top: 0.875rem;
	}
	.pj-carousel-dot {
		height: 0.4375rem;
		border-radius: 999px;
		border: none;
		padding: 0;
		background: color-mix(in srgb, var(--surface-muted) 55%, transparent);
		cursor: pointer;
		/* width is driven by Motion (springWidth attachment) */
		transition:
			background-color 0.2s ease,
			transform 0.2s ease;
	}
	.pj-carousel-dot:hover {
		background: color-mix(in srgb, var(--center-channel-color) 35%, transparent);
		transform: scale(1.15);
	}
	.pj-carousel-dot.is-active {
		background: var(--sidebar-text-active-border);
	}
	.pj-carousel-dot:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 35%, transparent);
	}

	.pj-deployment-card {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding: 1.25rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		border-radius: 1rem;
		background-color: color-mix(in srgb, var(--surface-bg) 55%, transparent);
		backdrop-filter: blur(10px) saturate(1.2);
		-webkit-backdrop-filter: blur(10px) saturate(1.2);
		text-decoration: none;
		color: var(--center-channel-color);
		transition:
			border-color 0.18s ease,
			box-shadow 0.25s cubic-bezier(0.22, 1, 0.36, 1),
			transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
		cursor: pointer;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.pj-deployment-card:hover,
	.pj-tabs-row:focus-within ~ .pj-tab-panel .pj-deployment-card.is-highlighted {
		border-color: var(--sidebar-text-active-border);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent),
			0 8px 24px -8px color-mix(in srgb, var(--sidebar-text-active-border) 30%, transparent),
			0 4px 12px rgba(0, 0, 0, 0.06);
	}

	@media (prefers-reduced-motion: reduce) {
		.pj-deployment-card { animation: none; }
		.pj-deployment-card:hover { transform: none; }
	}

	.pj-deployment-card-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
	}

	.pj-deployment-badges {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.pj-deployment-indicator {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 0.75rem;
		flex-shrink: 0;
	}

	.pj-deployment-indicator.pj-status-running {
		background-color: color-mix(in srgb, var(--pj-color-green) 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-pending {
		background-color: color-mix(in srgb, var(--pj-color-amber) 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-error {
		background-color: color-mix(in srgb, var(--pj-color-red) 12%, transparent);
	}

	.pj-deployment-indicator.pj-status-neutral {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.pj-deployment-status-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 50%;
	}

	.pj-deployment-status-dot.pj-status-running {
		background-color: var(--pj-color-green);
		box-shadow: 0 0 6px color-mix(in srgb, var(--pj-color-green) 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-pending {
		background-color: var(--pj-color-amber);
		box-shadow: 0 0 6px color-mix(in srgb, var(--pj-color-amber) 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-error {
		background-color: var(--pj-color-red);
		box-shadow: 0 0 6px color-mix(in srgb, var(--pj-color-red) 50%, transparent);
	}

	.pj-deployment-status-dot.pj-status-neutral {
		background-color: var(--surface-muted);
	}

	.pj-deployment-card-body {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.pj-deployment-name {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.pj-deployment-detail {
		font-size: 0.8125rem;
		color: var(--pj-text-secondary);
		font-family: var(--font-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pj-deployment-branch {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--pj-text-secondary);
		padding: 0.125rem 0.5rem;
		border-radius: 0.375rem;
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		width: fit-content;
	}

	.pj-deployment-card-footer {
		margin-top: auto;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.pj-deployment-replicas {
		font-size: 0.75rem;
		color: var(--pj-text-secondary);
	}

	.pj-deployment-meta {
		font-size: 0.675rem;
		color: var(--pj-text-secondary);
		opacity: 0.7;
	}

	.pj-deployment-meta::before {
		content: '·';
		margin-right: 0.25rem;
	}

	.pj-deployment-status-badge {
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: capitalize;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		flex-shrink: 0;
	}

	.pj-deployment-status-badge.pj-status-running {
		background-color: color-mix(in srgb, var(--pj-color-green) 15%, transparent);
		color: var(--pj-color-green);
	}

	.pj-deployment-status-badge.pj-status-pending {
		background-color: color-mix(in srgb, var(--pj-color-amber) 15%, transparent);
		color: var(--pj-color-amber);
	}

	.pj-deployment-status-badge.pj-status-error {
		background-color: color-mix(in srgb, var(--pj-color-red) 15%, transparent);
		color: var(--pj-color-red);
	}

	.pj-deployment-status-badge.pj-status-neutral {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--pj-text-secondary);
	}

	.pj-deployment-build-badge {
		font-size: 0.7rem;
		font-weight: 500;
		padding: 0.2rem 0.5rem;
		border-radius: 9999px;
		flex-shrink: 0;
	}

	.pj-deployment-build-badge.pj-build-building {
		background-color: color-mix(in srgb, var(--pj-color-amber) 15%, transparent);
		color: var(--pj-color-amber);
	}

	.pj-deployment-build-badge.pj-build-failed {
		background-color: color-mix(in srgb, var(--pj-color-red) 15%, transparent);
		color: var(--pj-color-red);
	}

	/* Empty state */
	.pj-empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 4rem 1.5rem;
		color: var(--pj-text-secondary);
		font-size: 0.875rem;
		border: 1px dashed var(--surface-border);
		border-radius: 1rem;
		margin-bottom: 1.5rem;
	}

	/* Buttons */
	.pj-btn {
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

	.pj-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pj-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.08),
			0 1px 1px rgb(0 0 0 / 0.04);
	}

	.pj-btn-primary:hover:not(:disabled) {
		opacity: 0.95;
		transform: translateY(-0.5px);
		box-shadow:
			0 2px 4px rgb(0 0 0 / 0.08),
			0 4px 12px rgb(0 0 0 / 0.06);
	}
	.pj-btn--sm {
		padding: 0.3125rem 0.625rem;
		font-size: 0.75rem;
		border-radius: 0.625rem;
	}

	/* Tab bar — matches deployment card surface */
	.pj-tabs-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
		padding: 0.375rem;
		border-radius: 1rem;
		background-color: color-mix(in srgb, var(--surface-bg) 55%, transparent);
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		backdrop-filter: blur(10px) saturate(1.2);
		-webkit-backdrop-filter: blur(10px) saturate(1.2);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		flex-wrap: wrap;
	}
	.pj-tabs {
		display: inline-flex;
		gap: 0.125rem;
	}
	.pj-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		padding: 0.4375rem 0.75rem;
		border: none;
		background: transparent;
		color: var(--pj-text-secondary);
		border-radius: 0.625rem;
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
		font-family: inherit;
		transition: color 0.18s ease, background-color 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s cubic-bezier(0.22, 1, 0.36, 1), transform 0.15s ease;
	}
	.pj-tab:active { transform: scale(0.97); }
	.pj-tab:hover {
		color: var(--center-channel-color);
		background: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}
	.pj-tab.is-active {
		color: var(--center-channel-color);
		background: color-mix(in srgb, var(--center-channel-bg) 80%, transparent);
		box-shadow:
			0 1px 2px rgba(0,0,0,0.05),
			0 0 0 1px color-mix(in srgb, var(--surface-border) 60%, transparent);
	}
	.pj-tab-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.125rem;
		height: 1.125rem;
		padding: 0 0.3125rem;
		border-radius: 999px;
		font-size: 0.625rem;
		font-weight: 700;
		background: color-mix(in srgb, var(--surface-border) 55%, transparent);
		color: var(--pj-text-secondary);
	}
	.pj-tab.is-active .pj-tab-count {
		background: color-mix(in srgb, var(--sidebar-text-active-border) 18%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.pj-tabs-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		padding-right: 0.25rem;
	}
	.pj-tab-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0.3125rem 0.5625rem;
		border-radius: 0.625rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--pj-text-secondary);
		background: color-mix(in srgb, var(--surface-border) 35%, transparent);
		text-decoration: none;
		transition: background-color 0.18s, color 0.18s, transform 0.15s;
	}
	.pj-tab-chip:hover { transform: translateY(-0.5px); }
	.pj-tab-chip:active { transform: scale(0.97); }
	.pj-tab-chip:hover {
		color: var(--center-channel-color);
		background: color-mix(in srgb, var(--surface-border) 60%, transparent);
	}
	.pj-tabs-actions .pj-deployment-search-bar { width: 11rem; }
	.pj-tabs-actions .pj-search-input {
		padding: 0.3125rem 0.625rem;
		font-size: 0.75rem;
		border-radius: 0.625rem;
		transition: border-color 0.18s, box-shadow 0.18s;
	}
	.pj-tabs-actions .pj-search-input:focus {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 18%, transparent);
	}

	/* .pj-tab-panel transform/opacity is owned by Motion (see $effect on activeTab). */


	.pj-btn-mt {
		margin-top: 0.5rem;
	}

	.pj-btn-secondary {
		background-color: transparent;
		color: var(--surface-muted);
		border: 1px solid var(--surface-border);
	}

	.pj-btn-secondary:hover:not(:disabled) {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}

	.pj-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.pj-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	.pj-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.875rem;
		height: 1.875rem;
		padding: 0;
		border-radius: 0.5rem;
		background-color: transparent;
		color: var(--surface-muted);
		border: 1px solid var(--surface-border);
		cursor: pointer;
		transition: background-color 0.12s, color 0.12s, border-color 0.12s, transform 0.08s;
	}
	.pj-icon-btn:hover:not(:disabled) {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
		border-color: color-mix(in srgb, var(--surface-border) 60%, var(--center-channel-color));
	}
	.pj-icon-btn:active:not(:disabled) { transform: scale(0.94); }
	.pj-icon-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 50%, transparent);
	}
	.pj-icon-btn:disabled { opacity: 0.6; cursor: not-allowed; }

	.pj-icon-btn--danger {
		color: var(--error-text-color);
		border-color: color-mix(in srgb, var(--error-text-color) 25%, transparent);
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
	}
	.pj-icon-btn--danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 18%, transparent);
		color: var(--error-text-color);
		border-color: color-mix(in srgb, var(--error-text-color) 45%, transparent);
	}

	.pj-icon-btn--onhero {
		background: rgba(255,255,255,0.18);
		color: #fff;
		border-color: rgba(255,255,255,0.3);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}
	.pj-icon-btn--onhero:hover:not(:disabled) {
		background: rgba(255,255,255,0.28);
		color: #fff;
		border-color: rgba(255,255,255,0.45);
	}
	.pj-icon-btn--onhero.pj-icon-btn--danger {
		background: color-mix(in srgb, var(--error-text-color) 32%, rgba(255,255,255,0.12));
		color: #fff;
		border-color: color-mix(in srgb, var(--error-text-color) 55%, rgba(255,255,255,0.3));
	}
	.pj-icon-btn--onhero.pj-icon-btn--danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--error-text-color) 50%, rgba(255,255,255,0.15));
	}

	/* Members */
	.pj-members-section { margin-top: 0; }

	.pj-members-card {
		background-color: color-mix(in srgb, var(--surface-bg) 55%, transparent);
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		border-radius: 1rem;
		overflow: visible;
		backdrop-filter: blur(10px) saturate(1.2);
		-webkit-backdrop-filter: blur(10px) saturate(1.2);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.pj-members-head {
		display: flex; align-items: center; gap: 1rem;
		padding: 0.875rem 1rem;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 45%, transparent);
	}
	.pj-members-title {
		display: inline-flex; align-items: center; gap: 0.5rem;
		font-size: 0.8125rem; font-weight: 600; color: var(--center-channel-color);
		flex-shrink: 0;
	}
	.pj-members-count {
		display: inline-flex; align-items: center; justify-content: center;
		min-width: 1.25rem; height: 1.25rem; padding: 0 0.375rem;
		border-radius: 999px;
		font-size: 0.6875rem; font-weight: 600;
		background: color-mix(in srgb, var(--surface-border) 55%, transparent);
		color: var(--pj-text-secondary);
	}

	.pj-members-list {
		list-style: none; margin: 0; padding: 0;
		display: flex; flex-direction: column;
	}

	.pj-member {
		display: flex; align-items: center; gap: 0.75rem;
		padding: 0.625rem 1rem;
		transition: background-color 0.18s ease;
	}
	.pj-member:hover { background: color-mix(in srgb, var(--surface-border) 25%, transparent); }
	.pj-member + .pj-member {
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 35%, transparent);
	}

	.pj-member-avatar {
		width: 2rem; height: 2rem;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}
	.pj-member-avatar--letter {
		display: flex; align-items: center; justify-content: center;
		background: linear-gradient(135deg,
			color-mix(in srgb, var(--sidebar-text-active-border) 22%, transparent),
			color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent));
		color: var(--sidebar-text-active-border);
		font-size: 0.75rem; font-weight: 700;
	}

	.pj-member-info {
		flex: 1; min-width: 0;
		display: flex; flex-direction: column; gap: 0.0625rem;
	}
	.pj-member-name {
		font-size: 0.8125rem; font-weight: 600;
		color: var(--center-channel-color);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.guest-pill {
		display: inline-block;
		margin-left: 0.4rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		font-size: 0.6rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		background: color-mix(in srgb, var(--surface-border) 35%, transparent);
		color: var(--pj-text-secondary);
		border: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		vertical-align: middle;
	}
	.pj-member-email {
		font-size: 0.6875rem;
		color: var(--pj-text-secondary);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}

	/* Role chips — color-coded by role */
	.pj-role-chip {
		flex-shrink: 0;
		display: inline-flex; align-items: center;
		padding: 0.1875rem 0.5rem;
		border-radius: 999px;
		font-size: 0.6875rem; font-weight: 600;
		text-transform: capitalize;
		letter-spacing: 0.01em;
		border: 1px solid transparent;
	}
	.pj-role-chip--admin {
		background: color-mix(in srgb, #f59e0b 14%, transparent);
		color: #b45309;
		border-color: color-mix(in srgb, #f59e0b 30%, transparent);
	}
	:global(:root.dark) .pj-role-chip--admin { color: #fbbf24; }
	.pj-role-chip--member {
		background: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		color: var(--sidebar-text-active-border);
		border-color: color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent);
	}
	.pj-role-chip--viewer {
		background: color-mix(in srgb, var(--surface-border) 45%, transparent);
		color: var(--pj-text-secondary);
	}
	.pj-role-wrap {
		position: relative;
		flex-shrink: 0;
	}
	.pj-role-trigger {
		gap: 0.25rem;
		cursor: pointer;
		font-family: inherit;
		transition: filter 0.12s, transform 0.12s, box-shadow 0.12s;
	}
	.pj-role-trigger:hover:not(:disabled) {
		filter: brightness(1.05);
		box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 14%, transparent);
	}
	.pj-role-trigger:disabled { opacity: 0.65; cursor: wait; }
	.pj-role-trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 50%, transparent);
	}
	.pj-role-caret {
		opacity: 0.7;
		transition: transform 0.15s;
	}
	.pj-role-trigger[aria-expanded="true"] .pj-role-caret {
		transform: rotate(180deg);
		opacity: 1;
	}

	.pj-role-menu {
		position: absolute;
		top: calc(100% + 0.375rem);
		right: 0;
		z-index: 50;
		min-width: 16rem;
		padding: 0.3125rem;
		background: var(--center-channel-bg, #fff);
		border: 1px solid var(--surface-border);
		border-radius: 0.625rem;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 8px 24px -4px rgba(0, 0, 0, 0.12),
			0 16px 40px -8px rgba(0, 0, 0, 0.18);
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		transform-origin: top right;
	}
	:global(:root.dark) .pj-role-menu {
		background: var(--surface-bg, #1f1f23);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.4),
			0 8px 24px -4px rgba(0, 0, 0, 0.5),
			0 16px 40px -8px rgba(0, 0, 0, 0.55);
	}

	.pj-role-option {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem 0.625rem;
		border: none;
		background: transparent;
		border-radius: 0.4375rem;
		text-align: left;
		cursor: pointer;
		color: var(--center-channel-color);
		font-family: inherit;
		transition: background-color 0.1s;
	}
	.pj-role-option:hover,
	.pj-role-option:focus-visible {
		background: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		outline: none;
	}
	.pj-role-option.is-selected {
		background: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent);
	}
	.pj-role-option-check {
		width: 0.875rem;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--sidebar-text-active-border);
		margin-top: 0.0625rem;
	}
	.pj-role-option-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.pj-role-option-label {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.pj-role-option-desc {
		font-size: 0.6875rem;
		color: var(--pj-text-secondary);
		line-height: 1.3;
	}
	.pj-role-dot {
		display: inline-block;
		width: 0.5rem; height: 0.5rem;
		border-radius: 999px;
		flex-shrink: 0;
	}
	.pj-role-dot--admin { background: #f59e0b; box-shadow: 0 0 0 2px color-mix(in srgb, #f59e0b 25%, transparent); }
	.pj-role-dot--member { background: var(--sidebar-text-active-border); box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent); }
	.pj-role-dot--viewer { background: var(--surface-muted); box-shadow: 0 0 0 2px color-mix(in srgb, var(--surface-muted) 25%, transparent); }

	.pj-member-remove {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.75rem; height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: transparent;
		color: var(--surface-muted);
		cursor: pointer; flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.12s, background-color 0.12s, color 0.12s;
	}
	.pj-member:hover .pj-member-remove { opacity: 1; }
	.pj-member-remove:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 14%, transparent);
		color: var(--error-text-color);
	}
	.pj-member-remove:disabled { opacity: 0.6; cursor: not-allowed; }
	.pj-member-remove:focus-visible { opacity: 1; outline: 2px solid var(--sidebar-text-active-border); outline-offset: 1px; }

	.pj-members-empty {
		padding: 1.25rem 1rem;
		font-size: 0.8125rem;
		color: var(--pj-text-secondary);
		text-align: center;
	}

	.pj-picker { position: relative; flex: 1; max-width: 18rem; margin-left: auto; }
	.pj-invite-input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		background: color-mix(in srgb, var(--surface-border) 20%, var(--center-channel-bg));
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.12s, background-color 0.12s;
	}
	.pj-invite-input::placeholder { color: var(--surface-muted); }
	.pj-invite-input:focus {
		outline: none;
		background: var(--center-channel-bg);
		border-color: var(--sidebar-text-active-border);
	}

	.pj-picker-dropdown {
		position: absolute;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		z-index: 20;
		max-height: 10rem;
		overflow-y: auto;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		box-shadow:
			0 4px 12px rgb(0 0 0 / 0.08),
			0 2px 4px rgb(0 0 0 / 0.04);
		padding: 0.25rem;
		transform-origin: top center;
	}

	.pj-picker-item {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.5rem;
		border: none;
		background: transparent;
		border-radius: 0.5rem;
		cursor: pointer;
		text-align: left;
	}

	.pj-picker-item:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.pj-picker-item:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pj-picker-empty {
		padding: 0.75rem;
		font-size: 0.8125rem;
		color: var(--pj-text-secondary);
		text-align: center;
	}

	/* Customize modal */
	.cm-overlay {
		position: fixed; inset: 0; z-index: 60;
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center;
		padding: 1.5rem;
		animation: cm-fade 150ms ease-out;
	}
	@keyframes cm-fade {
		from { opacity: 0; }
		to   { opacity: 1; }
	}

	.cm-modal {
		position: relative;
		width: 100%;
		max-width: 32rem;
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		border-radius: 1rem;
		overflow: hidden;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.06),
			0 24px 60px rgba(0, 0, 0, 0.28);
		animation: cm-pop 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
	}
	@keyframes cm-pop {
		from { opacity: 0; transform: translateY(8px) scale(0.98); }
		to   { opacity: 1; transform: translateY(0) scale(1); }
	}

	.cm-close {
		position: absolute;
		top: 0.75rem; right: 0.75rem;
		z-index: 2;
		display: flex; align-items: center; justify-content: center;
		width: 1.875rem; height: 1.875rem;
		border-radius: 0.5rem;
		border: none;
		background: rgba(0, 0, 0, 0.35);
		color: #fff;
		cursor: pointer;
		backdrop-filter: blur(6px);
		transition: background-color 0.15s;
	}
	.cm-close:hover { background: rgba(0, 0, 0, 0.55); }

	/* Preview hero — the centerpiece */
	.cm-hero {
		position: relative;
		height: 9rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 20%, var(--surface-bg));
		background-size: cover;
		background-position: center;
		overflow: hidden;
	}
	.cm-hero-placeholder {
		position: absolute; inset: 0;
		background:
			radial-gradient(circle at 20% 30%, color-mix(in srgb, var(--sidebar-text-active-border) 45%, transparent) 0%, transparent 55%),
			radial-gradient(circle at 85% 75%, color-mix(in srgb, var(--sidebar-text-active-color) 35%, transparent) 0%, transparent 50%),
			linear-gradient(135deg,
				color-mix(in srgb, var(--sidebar-text-active-border) 22%, var(--surface-bg)) 0%,
				color-mix(in srgb, var(--sidebar-text-active-color) 18%, var(--surface-bg)) 100%);
	}
	.cm-hero-scrim {
		position: absolute; inset: 0;
		background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.6) 100%);
	}
	.cm-hero-content {
		position: absolute;
		left: 1.25rem; bottom: 1rem;
		display: flex; align-items: center; gap: 0.75rem;
		color: #fff;
	}
	.cm-hero-icon {
		width: 2.75rem; height: 2.75rem;
		border-radius: 0.75rem;
		background: rgba(255, 255, 255, 0.15);
		border: 1px solid rgba(255, 255, 255, 0.25);
		backdrop-filter: blur(8px);
		display: flex; align-items: center; justify-content: center;
		overflow: hidden;
		flex-shrink: 0;
	}
	.cm-hero-icon--empty { color: rgba(255, 255, 255, 0.75); }
	.cm-hero-emoji { font-size: 1.5rem; line-height: 1; }
	.cm-hero-icon img { width: 100%; height: 100%; object-fit: cover; }
	.cm-hero-meta { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
	.cm-hero-eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.7);
	}
	.cm-hero-name {
		font-size: 1.0625rem;
		font-weight: 600;
		line-height: 1.2;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 22rem;
	}

	/* Body */
	.cm-body {
		padding: 1.25rem 1.25rem 0.5rem;
		display: flex; flex-direction: column; gap: 1.25rem;
	}

	.cm-section { display: flex; flex-direction: column; gap: 0.625rem; }
	.cm-section-head {
		display: flex; align-items: center; justify-content: space-between;
		min-height: 1.75rem;
	}
	.cm-section-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.cm-text-btn {
		display: inline-flex; align-items: center; gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		border: none; background: none;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.15s, background-color 0.15s;
	}
	.cm-text-btn:hover {
		color: var(--error-text-color);
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	/* Segmented control */
	.cm-segmented {
		display: inline-flex;
		padding: 0.1875rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
	.cm-seg {
		padding: 0.25rem 0.625rem;
		border-radius: 0.375rem;
		border: none; background: none;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.12s, background-color 0.12s, box-shadow 0.12s;
	}
	.cm-seg:hover:not(.cm-seg--active) { color: var(--center-channel-color); }
	.cm-seg--active {
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	/* Emoji picker */
	.cm-emoji-grid {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 0.375rem;
	}
	.cm-emoji-chip {
		aspect-ratio: 1;
		display: flex; align-items: center; justify-content: center;
		font-size: 1.125rem;
		border-radius: 0.5rem;
		border: 1px solid transparent;
		background: color-mix(in srgb, var(--surface-border) 30%, transparent);
		cursor: pointer;
		transition: background-color 0.12s, border-color 0.12s, transform 0.12s;
	}
	.cm-emoji-chip:hover {
		background: color-mix(in srgb, var(--surface-border) 60%, transparent);
		transform: translateY(-1px);
	}
	.cm-emoji-chip--active {
		background: color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
		border-color: var(--sidebar-text-active-border);
	}
	.cm-emoji-custom { display: flex; }
	.cm-input {
		width: 100%;
		padding: 0.4375rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background: var(--control-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: border-color 0.12s, box-shadow 0.12s;
	}
	.cm-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--sidebar-text-active-border) 18%, transparent);
	}
	.cm-input::placeholder { color: var(--surface-muted); }

	/* Upload drop zone */
	.cm-drop {
		position: relative;
		display: flex;
		align-items: center;
		padding: 0.875rem;
		border-radius: 0.625rem;
		border: 1.5px dashed color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-color));
		background: color-mix(in srgb, var(--surface-border) 18%, transparent);
		cursor: pointer;
		transition: border-color 0.15s, background-color 0.15s;
		min-height: 3.75rem;
	}
	.cm-drop:hover {
		border-color: var(--sidebar-text-active-border);
		background: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent);
	}
	.cm-drop--filled {
		border-style: solid;
		border-color: color-mix(in srgb, var(--surface-border) 70%, transparent);
		background: var(--surface-bg);
	}
	.cm-drop > input[type="file"] { display: none; }

	.cm-drop-state {
		display: flex; align-items: center; gap: 0.75rem;
		color: var(--surface-muted);
		width: 100%;
	}
	.cm-drop-icon {
		display: flex; align-items: center; justify-content: center;
		width: 2.25rem; height: 2.25rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
		flex-shrink: 0;
	}
	.cm-drop-text { display: flex; flex-direction: column; gap: 0.125rem; }
	.cm-drop-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.cm-drop-hint {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	.cm-drop-filled {
		display: flex; align-items: center; gap: 0.75rem;
		width: 100%;
	}
	.cm-drop-thumb {
		border-radius: 0.375rem;
		object-fit: cover;
		flex-shrink: 0;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
	}
	.cm-drop-thumb--square { width: 2.5rem; height: 2.5rem; }
	.cm-drop-thumb--wide { width: 4.5rem; height: 2.5rem; }
	.cm-drop-meta { display: flex; flex-direction: column; gap: 0.125rem; }
	.cm-drop-meta-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.cm-drop-meta-hint {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	/* Footer */
	.cm-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.25rem 1.25rem;
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		margin-top: 0.5rem;
	}
</style>
