<script lang="ts">
	import { apiFetch, pinnedItems, toasts, subscribeOrgEvents } from '$lib/stores';
	import {
		Plus,
		Search,
		Sparkles,
		GitBranch,
		Star,
		MoreVertical,
		ExternalLink,
		RefreshCw,
		Pin,
		PinOff,
		Copy,
		ChevronRight,
		Loader2,
		CheckCircle2,
		XCircle,
		Clock,
		Folder,
		Rocket,
		Database,
		ArrowRight
	} from 'lucide-svelte';
	import { onDestroy, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { animate } from 'motion';
	import BuildTimer from '$lib/components/BuildTimer.svelte';
	import type { PageData } from './$types';

	// ── Physics-based animation helpers (see physics-ui.md) ──
	// Track elements that have already played their entrance animation. Without
	// this, every SSE-driven re-render re-fires the stagger from y:8/opacity:0
	// and the whole grid flickers in.
	const staggered = new WeakSet<Element>();

	// Pre-blur project backdrop images on a canvas once per URL, then use the
	// resulting bitmap as a static background. Firefox doesn't cache filter
	// output on a compositor layer, so animating a transform on top of a CSS
	// blur causes per-frame re-rasterization. Pre-blurring sidesteps that — the
	// running animation becomes a pure transform.
	const preBlurCache = new Map<string, Promise<string | null>>();
	function preBlurImage(url: string): Promise<string | null> {
		let p = preBlurCache.get(url);
		if (p) return p;
		p = new Promise((resolve) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => {
				try {
					const W = 512;
					const H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W));
					const canvas = document.createElement('canvas');
					canvas.width = W;
					canvas.height = H;
					const ctx = canvas.getContext('2d');
					if (!ctx) return resolve(null);
					// Blur radius scales with bitmap size; 48px CSS blur on a ~512px wide
					// element ≈ ~10% of width. Use the same ratio on the canvas.
					ctx.filter = 'blur(48px) saturate(1.6)';
					ctx.drawImage(img, 0, 0, W, H);
					resolve(canvas.toDataURL('image/jpeg', 0.85));
				} catch {
					resolve(null);
				}
			};
			img.onerror = () => resolve(null);
			img.src = url;
		});
		preBlurCache.set(url, p);
		return p;
	}
	function preBlurBg(url: string) {
		// We own background-image + filter imperatively here. The template MUST
		// NOT set `style="background-image: ..."` — a reactive Svelte binding
		// would overwrite the pre-blurred dataURL on any unrelated reactive
		// update (e.g. sidebar resize / SSE merge), reverting to the full-size
		// image filtered by CSS blur for a frame. That single-frame swap is the
		// visible flicker on backdrop cards.
		return (el: Element) => {
			const target = el as HTMLElement;
			let cancelled = false;
			// Set the original URL immediately so the CSS blur fallback has
			// something to render before preBlurImage resolves.
			target.style.backgroundImage = `url("${url}")`;
			preBlurImage(url).then((dataUrl) => {
				if (cancelled || !dataUrl) return;
				target.style.backgroundImage = `url("${dataUrl}")`;
				target.style.filter = 'none';
			});
			return () => {
				cancelled = true;
			};
		};
	}
	function motionStagger(
		opts: {
			index?: number;
			stride?: number;
			from?: { y?: number; opacity?: number; scale?: number };
			stiffness?: number;
			damping?: number;
			mass?: number;
			axis?: 'x' | 'y';
		} = {}
	) {
		const i = opts.index ?? 0;
		const stride = opts.stride ?? 0.04;
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
			const kf: Record<string, number[]> = { opacity: [from.opacity, 1], scale: [from.scale, 1] };
			kf[axis] = [from.y, 0];
			animate(target, kf, {
				type: 'spring',
				stiffness: opts.stiffness ?? 260,
				damping: opts.damping ?? 22,
				mass: opts.mass ?? 0.9,
				delay: i * stride
			});
		};
	}
	function springHover(
		opts: { rest?: number; lift?: number; stiffness?: number; damping?: number } = {}
	) {
		const rest = opts.rest ?? 0;
		const lift = opts.lift ?? -3;
		const stiffness = opts.stiffness ?? 380;
		const damping = opts.damping ?? 22;
		return (el: Element) => {
			const target = el as HTMLElement;
			const enter = () => animate(target, { y: lift }, { type: 'spring', stiffness, damping });
			const leave = () =>
				animate(
					target,
					{ y: rest },
					{ type: 'spring', stiffness: stiffness * 0.8, damping: damping + 4 }
				);
			const press = () =>
				animate(target, { scale: 0.98 }, { type: 'spring', stiffness: 600, damping: 28 });
			const release = () =>
				animate(target, { scale: 1 }, { type: 'spring', stiffness: 420, damping: 18 });
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
	function cardTilt(
		opts: { max?: number; stiffness?: number; damping?: number; mass?: number } = {}
	) {
		const max = opts.max ?? 4;
		const stiffness = opts.stiffness ?? 380;
		const damping = opts.damping ?? 28;
		const mass = opts.mass ?? 0.5;
		return (el: Element) => {
			const target = el as HTMLElement;
			target.style.transformStyle = 'preserve-3d';
			target.style.perspective = '900px';
			let rect: DOMRect | null = null;
			// rAF-coalesce pointermove. Without this, animate() runs 60–120×/sec
			// per hovered card — each call allocates a new spring (visible as
			// scopedAnimate/animateSubject/readKeyframes hot frames in the profile).
			let pendingX = 0;
			let pendingY = 0;
			let rafId = 0;
			const tick = () => {
				rafId = 0;
				animate(
					target,
					{ rotateX: -pendingY * max, rotateY: pendingX * max },
					{ type: 'spring', stiffness, damping, mass }
				);
			};
			const onEnter = () => {
				rect = target.getBoundingClientRect();
			};
			const onMove = (e: PointerEvent) => {
				if (!rect) rect = target.getBoundingClientRect();
				pendingX = (e.clientX - rect.left) / rect.width - 0.5;
				pendingY = (e.clientY - rect.top) / rect.height - 0.5;
				if (!rafId) rafId = requestAnimationFrame(tick);
			};
			const onLeave = () => {
				if (rafId) {
					cancelAnimationFrame(rafId);
					rafId = 0;
				}
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
				if (rafId) cancelAnimationFrame(rafId);
				target.removeEventListener('pointerenter', onEnter);
				target.removeEventListener('pointermove', onMove);
				target.removeEventListener('pointerleave', onLeave);
			};
		};
	}
	function springPop(active: () => boolean) {
		return (el: Element) => {
			const target = el as HTMLElement;
			let prev = active();
			$effect(() => {
				const next = active();
				if (next && !prev) {
					animate(
						target,
						{ scale: [0.9, 1.06, 1] },
						{ type: 'spring', stiffness: 480, damping: 16, mass: 0.85 }
					);
				}
				prev = next;
			});
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
				if (firstRun) {
					firstRun = false;
					return;
				}
				if (closing) {
					animate(
						target,
						{ opacity: from.opacity, scale: from.scale, y: from.y },
						{ type: 'spring', stiffness: stiffness * 1.1, damping: damping + 6, mass }
					).finished.then(() => {
						if (opts.closing()) opts.onClosed();
					});
				} else {
					animate(
						target,
						{ opacity: 1, scale: 1, y: 0 },
						{ type: 'spring', stiffness, damping, mass }
					);
				}
			});
		};
	}
	// Spring-driven rotation between two angles when `active()` flips.
	function springRotate(
		active: () => boolean,
		opts: { rest?: number; on?: number; stiffness?: number; damping?: number; mass?: number } = {}
	) {
		const rest = opts.rest ?? 0;
		const on = opts.on ?? 90;
		const stiffness = opts.stiffness ?? 380;
		const damping = opts.damping ?? 24;
		const mass = opts.mass ?? 0.7;
		return (el: Element) => {
			const target = el as HTMLElement;
			target.style.transform = `rotate(${active() ? on : rest}deg)`;
			let prev = active();
			$effect(() => {
				const next = active();
				if (next === prev) return;
				prev = next;
				animate(target, { rotate: next ? on : rest }, { type: 'spring', stiffness, damping, mass });
			});
		};
	}

	function springScale(
		getScale: () => number,
		opts: { stiffness?: number; damping?: number; mass?: number } = {}
	) {
		const stiffness = opts.stiffness ?? 480;
		const damping = opts.damping ?? 18;
		const mass = opts.mass ?? 0.7;
		return (el: Element) => {
			const target = el as HTMLElement;
			let prev = getScale();
			target.style.transform = `scale(${prev})`;
			$effect(() => {
				const next = getScale();
				if (next === prev) return;
				prev = next;
				animate(target, { scale: next }, { type: 'spring', stiffness, damping, mass });
			});
		};
	}

	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);

	// Current viewer's org role — gates the "create project" CTAs. Guests can
	// only see projects they were invited to and cannot spawn new ones.
	let currentOrgRole = $state<'owner' | 'admin' | 'member' | 'guest' | null>(null);
	const canCreateProjects = $derived(
		currentOrgRole !== null && currentOrgRole !== 'guest',
	);

	interface DeploymentSummary {
		id: string;
		name: string;
		status: string;
		buildStatus: string;
		image?: string;
		githubRepo?: string;
		githubBranch?: string;
		updatedAt: string;
		replicas: number;
		ingresses: Array<{ id: string; host: string }>;
		project: {
			id: string;
			name: string;
			slug: string;
			organizationId: string;
		};
	}

	let deployments = $state<DeploymentSummary[]>([]);
	let loading = $state(true);
	let buildsLoading = $state(true);
	let orgId = $state<string | null>(null);
	// Surfaced when loadOverview fails. The most common case we've seen is a
	// 403 from the backend after navigating away and back — the membership
	// check in the membership cache returns empty briefly. Showing this
	// instead of the "Deploy your first app" empty state stops users from
	// thinking their data is gone.
	let loadError = $state<{ status: number; message: string } | null>(null);

	interface DatabaseSummary {
		id: string;
		name: string;
		dbName: string;
		status: string;
		mode?: string;
		updatedAt: string;
		project: { id: string; name: string; slug: string; organizationId: string };
	}
	let databases = $state<DatabaseSummary[]>([]);

	interface ProjectMeta {
		id: string;
		name: string;
		slug: string;
		description?: string;
		icon?: string | null;
		backgroundImage?: string | null;
	}
	// SvelteMap so per-key reads (`projectMetas.get(id)`) are fine-grained reactive
	// dependencies. Combined with the in-place merge below, only cards whose
	// meta actually changed re-render.
	const projectMetas = new SvelteMap<string, ProjectMeta>();

	async function fetchDeployments() {
		// Used by single-deployment actions (e.g. restart) to refresh after a mutation
		// without waiting for the SSE round-trip.
		await loadOverview();
	}

	// Direct fetch — the source of truth for refresh. Mirrors the deployment
	// page pattern: the streamed promise from +page.ts is just a seed for
	// fast first paint; this function reliably populates state on every
	// navigation (including browser back) and on every SSE event, without
	// depending on SvelteKit's load() re-running.
	async function loadOverview() {
		const slug = data.orgSlug;
		if (!slug) return;
		try {
			const res = await apiFetch(`/apiv1/overview/orgs/${slug}`);
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				let message = body;
				try {
					message = JSON.parse(body)?.message ?? body;
				} catch {}
				throw Object.assign(new Error(message || `overview ${res.status}`), {
					status: res.status,
				});
			}
			const payload = await res.json();
			// Drop stale result if user navigated to another org meanwhile.
			if (data.orgSlug !== slug) return;
			applyOverview(payload);
			loadError = null;
			loading = false;
			buildsLoading = false;
		} catch (e: any) {
			console.error('Failed to load overview:', e);
			loadError = { status: e?.status ?? 0, message: e?.message ?? String(e) };
			loading = false;
			buildsLoading = false;
		}
	}

	// Stable display order: captured the first time each id is seen, and only
	// extended (never re-sorted) on subsequent refreshes. Without this, two
	// projects building at once keep updating their `updatedAt` and swap places
	// every SSE event.
	let depOrder = $state<string[]>([]);
	let dbOrder = $state<string[]>([]);
	let projOrder = $state<string[]>([]);

	function mergeOrder<T extends { id: string }>(
		existing: string[],
		items: T[],
		rank: (item: T) => number
	): string[] {
		const present = new Set(items.map((x) => x.id));
		const kept = existing.filter((id) => present.has(id));
		const known = new Set(kept);
		const fresh = items
			.filter((x) => !known.has(x.id))
			.sort((a, b) => rank(b) - rank(a))
			.map((x) => x.id);
		return [...kept, ...fresh];
	}

	// Shallow value-equality good enough for our payload fields: scalars are ===,
	// arrays compare element-wise (one level deep), nested objects compare by
	// their own top-level keys. We use this to avoid writing fields that didn't
	// actually change — Svelte 5 fine-grained reactivity then leaves dependent
	// effects alone instead of marking them dirty.
	function shallowEq(a: any, b: any): boolean {
		if (a === b) return true;
		if (a == null || b == null) return false;
		if (Array.isArray(a) && Array.isArray(b)) {
			if (a.length !== b.length) return false;
			for (let i = 0; i < a.length; i++) if (!shallowEq(a[i], b[i])) return false;
			return true;
		}
		if (typeof a === 'object' && typeof b === 'object') {
			const ka = Object.keys(a);
			const kb = Object.keys(b);
			if (ka.length !== kb.length) return false;
			for (const k of ka) if ((a as any)[k] !== (b as any)[k]) return false;
			return true;
		}
		return false;
	}

	// Mutate `list` in place so identity is preserved for items present in both
	// the old and new payload. Critical for SSE perf: every event used to
	// replace the array (and every object), forcing every keyed-each item's
	// bindings to re-evaluate even when the content was identical. With this,
	// per-card effects only re-run for ids whose fields actually changed.
	function syncList<T extends { id: string }>(list: T[], next: T[]) {
		const nextById = new Map(next.map((x) => [x.id, x]));
		for (let i = list.length - 1; i >= 0; i--) {
			if (!nextById.has(list[i].id)) list.splice(i, 1);
		}
		const curById = new Map<string, T>();
		for (const x of list) curById.set(x.id, x);
		for (const n of next) {
			const cur = curById.get(n.id);
			if (cur) {
				for (const k of Object.keys(n) as Array<keyof T>) {
					if (!shallowEq(cur[k], n[k])) cur[k] = n[k];
				}
			} else {
				list.push(n);
				curById.set(n.id, n);
			}
		}
	}

	function syncMap<V extends { id: string }>(map: Map<string, V>, next: V[]) {
		const nextIds = new Set<string>();
		for (const v of next) nextIds.add(v.id);
		for (const id of [...map.keys()]) if (!nextIds.has(id)) map.delete(id);
		for (const v of next) {
			const cur = map.get(v.id);
			if (!cur) {
				map.set(v.id, v);
				continue;
			}
			let changed = false;
			for (const k of Object.keys(v) as Array<keyof V>) {
				if (!shallowEq(cur[k], v[k])) {
					cur[k] = v[k];
					changed = true;
				}
			}
			if (changed) map.set(v.id, cur); // re-set to notify Map reactivity
		}
	}

	function applyOverview(payload: any) {
		// Merge in place. Replacing arrays/Maps was the SSE bottleneck — every
		// event invalidated every keyed-each binding because object identities
		// changed wholesale. Now only ids with actual field deltas trigger work.
		syncList(deployments, payload.deployments ?? []);
		syncList(databases, payload.databases ?? []);
		syncMap(projectMetas, payload.projects ?? []);
		syncList(activeBuilds, payload.builds?.active ?? []);
		syncList(recentBuilds, payload.builds?.recent ?? []);
		orgId = payload.organization?.id ?? null;
		// Fetch viewer's org role once we know the org id — used to gate the
		// "create project" CTAs against guests.
		if (orgId && currentOrgRole === null) {
			apiFetch(`/apiv1/organizations/${orgId}/members/me`)
				.then(async (r) => {
					if (!r.ok) return;
					const body = await r.json().catch(() => null);
					if (body?.role) currentOrgRole = body.role;
				})
				.catch(() => {});
		}

		depOrder = mergeOrder(depOrder, deployments, (d) => new Date(d.updatedAt).getTime());
		dbOrder = mergeOrder(dbOrder, databases, (d) => new Date(d.updatedAt).getTime());
		const projLatest = new Map<string, number>();
		for (const d of deployments) {
			if (!d.project) continue;
			const t = new Date(d.updatedAt).getTime();
			projLatest.set(d.project.id, Math.max(projLatest.get(d.project.id) ?? 0, t));
		}
		for (const d of databases) {
			if (!d.project) continue;
			const t = new Date(d.updatedAt).getTime();
			projLatest.set(d.project.id, Math.max(projLatest.get(d.project.id) ?? 0, t));
		}
		const projItems = [...projLatest.entries()].map(([id, t]) => ({ id, t }));
		projOrder = mergeOrder(projOrder, projItems, (x) => x.t);
	}

	// ── Builds ──
	interface ActiveBuild {
		id: string;
		name: string;
		image?: string;
		status: string;
		buildStatus: string;
		buildStep: string | null;
		updatedAt: string;
		githubRepo?: string;
		githubBranch?: string;
		ingresses: Array<{ host: string }>;
		project?: { name: string };
	}
	interface RecentBuild {
		id: string;
		commitSha: string | null;
		branch: string | null;
		triggerType: string | null;
		isActive: boolean;
		createdAt: string;
		deployment: {
			id: string;
			name: string;
			image?: string;
			buildStatus: string;
			ingresses: Array<{ host: string }>;
			project?: { name: string };
		};
	}

	let activeBuilds = $state<ActiveBuild[]>([]);
	let recentBuilds = $state<RecentBuild[]>([]);

	// ── Expand state (persisted) ──
	const EXPAND_KEY = 'overview-expanded-projects';
	let expandedProjects = $state<Set<string>>(
		typeof localStorage !== 'undefined'
			? new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) ?? '[]'))
			: new Set()
	);
	// Per-project body refs + render flags so we can keep the element mounted
	// long enough to animate the collapse with Motion.
	const projectBodyEls = new Map<string, HTMLElement>();
	let renderedProjectBodies = $state<Set<string>>(new Set());
	$effect(() => {
		// Whenever a project is expanded, mark its body as rendered.
		// untrack the read+write of renderedProjectBodies so we don't loop.
		const exp = expandedProjects;
		untrack(() => {
			let changed = false;
			const next = new Set(renderedProjectBodies);
			for (const id of exp) {
				if (!next.has(id)) {
					next.add(id);
					changed = true;
				}
			}
			if (changed) renderedProjectBodies = next;
		});
	});
	function toggleExpand(id: string, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		const next = new Set(expandedProjects);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedProjects = next;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(EXPAND_KEY, JSON.stringify([...next]));
		}
	}

	function bodyAttach(id: string) {
		return (el: Element) => {
			const target = el as HTMLElement;
			projectBodyEls.set(id, target);
			target.style.overflow = 'hidden';
			target.style.willChange = 'height';
			let firstEffect = true;
			const measure = () => {
				const cur = target.style.height;
				target.style.height = 'auto';
				const h = target.scrollHeight;
				target.style.height = cur;
				return h;
			};
			// Sympathetic squish on the inner grid — propagates the parent's
			// bounce into the children so they "feel" the weight.
			const sympathy = (compress: boolean) => {
				const grid = target.querySelector<HTMLElement>('.grid');
				if (grid) {
					const yKick = compress ? 8 : -6;
					animate(
						grid,
						{ y: [yKick, 0], scaleY: [compress ? 0.94 : 0.96, 1] },
						{ type: 'spring', stiffness: 200, damping: 13, mass: 1, delay: 0.04 }
					);
				}
			};
			$effect(() => {
				const open = expandedProjects.has(id);
				if (firstEffect) {
					firstEffect = false;
					target.style.opacity = '0';
					target.style.height = '0px';
					void target.offsetHeight;
					const h = target.scrollHeight;
					animate(
						target,
						{ height: h, opacity: 1 },
						{ type: 'spring', stiffness: 220, damping: 16, mass: 0.9 }
					).finished.then(() => {
						target.style.height = 'auto';
					});
					sympathy(false);
					return;
				}
				if (open) {
					const cur = target.getBoundingClientRect().height;
					target.style.height = `${cur}px`;
					void target.offsetHeight;
					const h = measure();
					animate(
						target,
						{ height: h, opacity: 1 },
						{ type: 'spring', stiffness: 220, damping: 16, mass: 0.9 }
					).finished.then(() => {
						target.style.height = 'auto';
					});
					sympathy(false);
				} else {
					const cur = target.getBoundingClientRect().height;
					target.style.height = `${cur}px`;
					void target.offsetHeight;
					const card = target.closest('.proj-card') as HTMLElement | null;
					if (card) card.style.transformOrigin = 'top center';
					// Inner grid pre-compresses while parent collapses (transform only).
					const grid = target.querySelector<HTMLElement>('.grid');
					if (grid) {
						animate(
							grid,
							{ y: 6, scaleY: 0.96, opacity: 0.8 },
							{ duration: 0.22, ease: [0.4, 0, 1, 1] }
						);
					}
					// Body close — fixed-duration ease-in. The squish on the parent
					// card fires the moment .finished resolves, so the impact lines
					// up with the actual close end regardless of duration drift.
					animate(
						target,
						{ height: 0, opacity: 0 },
						{ duration: 0.24, ease: [0.4, 0, 1, 1] }
					).finished.then(() => {
						if (card) {
							// Card "lifts" the moment the body closes (weight removed).
							// Spring params match the open dropdown bounce so both ends
							// feel like the same physical system.
							animate(
								card,
								{ y: [-5, 0] },
								{ type: 'spring', stiffness: 120, damping: 10, mass: 1 }
							);
						}
						if (!expandedProjects.has(id)) {
							renderedProjectBodies = new Set([...renderedProjectBodies].filter((x) => x !== id));
							projectBodyEls.delete(id);
						}
					});
				}
			});
			return () => {
				projectBodyEls.delete(id);
			};
		};
	}

	// ── Filtering ──
	let searchQuery = $state('');
	let openMenuId = $state<string | null>(null);
	let renderMenuId = $state<string | null>(null);
	$effect(() => {
		if (openMenuId !== null) renderMenuId = openMenuId;
	});

	// SvelteSet gives per-key reactivity: `favouriteIds.has(id)` creates a
	// dependency on that specific id, not the whole set. Combined with mutating
	// in place (instead of replacing the Set), unrelated cards skip re-evaluation
	// when one star toggles — which used to invalidate every Star + springPop.
	const favouriteIds = new SvelteSet<string>();
	$effect(() => {
		const next = new Set(
			$pinnedItems.filter((i) => i.type === 'deployment').map((i) => i.id)
		);
		for (const id of favouriteIds) if (!next.has(id)) favouriteIds.delete(id);
		for (const id of next) if (!favouriteIds.has(id)) favouriteIds.add(id);
	});

	// Filtered deployments — ordered by `depOrder` (a stable snapshot from
	// applyOverview), not by live `updatedAt`, so building deployments don't
	// keep shuffling.
	let filtered = $derived.by(() => {
		let r = deployments;
		const q = searchQuery.trim().toLowerCase();
		if (q)
			r = r.filter(
				(d) =>
					d.name.toLowerCase().includes(q) ||
					(d.project?.name?.toLowerCase().includes(q) ?? false) ||
					(d.githubRepo?.toLowerCase().includes(q) ?? false) ||
					d.ingresses.some((i) => i.host.toLowerCase().includes(q))
			);
		const byId = new Map(r.map((d) => [d.id, d]));
		const ordered: DeploymentSummary[] = [];
		for (const id of depOrder) {
			const d = byId.get(id);
			if (d) {
				ordered.push(d);
				byId.delete(id);
			}
		}
		for (const d of byId.values()) ordered.push(d);
		return ordered;
	});

	let favDeps = $derived(filtered.filter((d) => favouriteIds.has(d.id)));

	let filteredDbs = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		let r = databases;
		if (q)
			r = r.filter(
				(d) =>
					d.name.toLowerCase().includes(q) ||
					d.dbName.toLowerCase().includes(q) ||
					(d.project?.name?.toLowerCase().includes(q) ?? false)
			);
		const byId = new Map(r.map((d) => [d.id, d]));
		const ordered: DatabaseSummary[] = [];
		for (const id of dbOrder) {
			const d = byId.get(id);
			if (d) {
				ordered.push(d);
				byId.delete(id);
			}
		}
		for (const d of byId.values()) ordered.push(d);
		return ordered;
	});

	// Group non-fav deployments by project, preserving project order by most recent deployment
	interface ProjectGroup {
		id: string;
		name: string;
		slug: string;
		deps: DeploymentSummary[];
		dbs: DatabaseSummary[];
	}

	let projectGroups = $derived.by(() => {
		const nonFav = filtered.filter((d) => !favouriteIds.has(d.id));
		const map = new Map<string, ProjectGroup>();
		for (const d of nonFav) {
			const p = d.project;
			if (!p) continue;
			if (!map.has(p.id)) {
				map.set(p.id, { id: p.id, name: p.name, slug: p.slug, deps: [], dbs: [] });
			}
			map.get(p.id)!.deps.push(d);
		}
		for (const db of filteredDbs) {
			const p = db.project;
			if (!p) continue;
			if (!map.has(p.id)) {
				map.set(p.id, { id: p.id, name: p.name, slug: p.slug, deps: [], dbs: [] });
			}
			map.get(p.id)!.dbs.push(db);
		}
		// Use the stable `projOrder` snapshot. Groups not yet in projOrder (a
		// race during initial mount) fall through to the end in insertion order.
		const ordered: ProjectGroup[] = [];
		for (const id of projOrder) {
			const g = map.get(id);
			if (g) {
				ordered.push(g);
				map.delete(id);
			}
		}
		for (const g of map.values()) ordered.push(g);
		return ordered;
	});

	// Paginate project groups into tabs of 10. The full list is kept in
	// `projectGroups` so favourites/search still see everything; only the
	// rendered grid is sliced. Saves O(N) per-card effect cost when an org
	// has many projects.
	const PROJECTS_PER_TAB = 10;
	let projectTab = $state(0);
	const totalProjectTabs = $derived(
		Math.max(1, Math.ceil(projectGroups.length / PROJECTS_PER_TAB))
	);
	// Clamp the active tab if groups shrink (search filter, project deleted).
	$effect(() => {
		if (projectTab >= totalProjectTabs) projectTab = Math.max(0, totalProjectTabs - 1);
	});
	// Reset to first tab whenever the search query changes — the result set
	// is different so the old tab index doesn't mean anything.
	$effect(() => {
		searchQuery;
		untrack(() => {
			projectTab = 0;
		});
	});
	const visibleProjectGroups = $derived(
		projectGroups.slice(projectTab * PROJECTS_PER_TAB, (projectTab + 1) * PROJECTS_PER_TAB)
	);

	// ── Helpers ──
	function projectStatusSummary(g: ProjectGroup) {
		let green = 0,
			amber = 0,
			red = 0;
		const bump = (cls: string) => {
			if (cls === 'dot--green') green++;
			else if (cls === 'dot--amber') amber++;
			else if (cls === 'dot--red') red++;
		};
		for (const d of g.deps) bump(dotClass(d.status, d.buildStatus));
		for (const db of g.dbs) {
			bump(
				db.status === 'ready' ? 'dot--green' : db.status === 'error' ? 'dot--red' : 'dot--amber'
			);
		}
		if (!green && !amber && !red) return null;
		return { green, amber, red };
	}

	function dotClass(s?: string, bs?: string) {
		if (bs === 'building') return 'dot--amber';
		if (!s) return 'dot--gray';
		const l = s.toLowerCase();
		if (l === 'running') return 'dot--green';
		if (['pending', 'restarting', 'scaling'].includes(l)) return 'dot--amber';
		if (['failed', 'error', 'deleting', 'stopped', 'unhealthy'].includes(l)) return 'dot--red';
		return 'dot--gray';
	}
	function statusText(s?: string, bs?: string): string {
		if (bs === 'building') return 'Building';
		if (!s) return 'Unknown';
		return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
	}
	function timeAgo(d?: string): string {
		if (!d) return '';
		const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
		if (s < 60) return 'just now';
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		const dy = Math.floor(h / 24);
		if (dy < 30) return `${dy}d ago`;
		return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	const IMG_ICONS: Record<string, string> = {
		postgres:
			'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/postgresql/postgresql-original.svg',
		postgresql:
			'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/postgresql/postgresql-original.svg',
		mysql: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/mysql/mysql-original.svg',
		redis: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/redis/redis-original.svg',
		mongo: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/mongodb/mongodb-original.svg',
		mongodb:
			'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/mongodb/mongodb-original.svg',
		nginx: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nginx/nginx-original.svg',
		node: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nodejs/nodejs-original.svg',
		python: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/python/python-original.svg',
		go: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/go/go-original.svg',
		rust: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/rust/rust-original.svg',
		grafana:
			'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/grafana/grafana-original.svg'
	};
	function knownIcon(img?: string): string | null {
		if (!img) return null;
		const n =
			img
				.replace(/^[^/]+\.[^/]+\//, '')
				.split(':')[0]
				.split('/')
				.pop()
				?.toLowerCase() ?? '';
		if (IMG_ICONS[n]) return IMG_ICONS[n];
		for (const [k, v] of Object.entries(IMG_ICONS)) {
			if (n.startsWith(k) || n.includes(k)) return v;
		}
		return null;
	}

	let failedFav = $state<Set<string>>(new Set());
	function favUrl(host: string) {
		return `/apiv1/deployments/favicon?domain=${encodeURIComponent(host)}`;
	}
	function favErr(id: string) {
		failedFav = new Set(failedFav).add(id);
	}

	function toggleFav(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		pinnedItems.toggle({
			id: dep.id,
			name: dep.name,
			type: 'deployment',
			href: `/${orgSlug}/deployments/${dep.id}`
		});
	}
	function toggleMenu(id: string, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		openMenuId = openMenuId === id ? null : id;
	}
	function closeAll() {
		openMenuId = null;
	}
	async function restart(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		openMenuId = null;
		try {
			const r = await apiFetch(`/apiv1/deployments/${dep.id}/restart`, { method: 'POST' });
			if (r.ok) {
				toasts.add({ title: `Restarting ${dep.name}...`, color: 'success' });
				fetchDeployments();
			} else toasts.add({ title: 'Restart failed', color: 'error' });
		} catch {
			toasts.add({ title: 'Restart failed', color: 'error' });
		}
	}
	function cpUrl(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		openMenuId = null;
		if (dep.ingresses.length) {
			navigator.clipboard.writeText(`https://${dep.ingresses[0].host.split('/')[0]}`);
			toasts.add({ title: 'Copied', color: 'success' });
		}
	}
	function visit(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		openMenuId = null;
		if (dep.ingresses.length)
			window.open(`https://${dep.ingresses[0].host.split('/')[0]}`, '_blank');
	}

	function buildIcon(img?: string, ings?: Array<{ host: string }>, id?: string) {
		const k = knownIcon(img);
		if (k) return k;
		if (ings?.length && !failedFav.has('b-' + (id ?? '')))
			return favUrl(ings[0].host.split('/')[0]);
		return null;
	}

	let unsub: (() => void) | null = null;
	// Tracks which slug the SSE subscription is bound to. Compared with the
	// current route slug to detect a real org-switch (vs. a re-run of the
	// effect for the same org) so we can reset state and re-subscribe only
	// when actually needed.
	let lastSeenOrgSlug: string | null = null;

	$effect(() => {
		const slug = data.orgSlug;
		if (!slug) return;
		const isNewRoute = slug !== lastSeenOrgSlug;
		if (!isNewRoute) return; // SSE refreshes call loadOverview() directly.
		loadError = null;
		if (lastSeenOrgSlug !== null) {
			// Real org switch — reset to skeleton so the previous org's data
			// doesn't linger while the new one loads.
			loading = true;
			buildsLoading = true;
			depOrder = [];
			dbOrder = [];
			projOrder = [];
			deployments.length = 0;
			databases.length = 0;
			activeBuilds.length = 0;
			recentBuilds.length = 0;
			projectMetas.clear();
		}
		lastSeenOrgSlug = slug;

		// Seed from streamed loader for instant first paint when available.
		data.overview
			?.then((payload) => {
				if (!payload || data.orgSlug !== slug) return;
				if (deployments.length === 0) {
					applyOverview(payload);
					loading = false;
					buildsLoading = false;
				}
			})
			.catch(() => {});

		// Authoritative direct fetch. Runs on every real navigation so we
		// don't depend on SvelteKit's load() re-running on browser back.
		loadOverview().then(() => {
			if (data.orgSlug !== slug) return;
			if (orgId) {
				unsub?.();
				const id = orgId;
				unsub = subscribeOrgEvents(
					id,
					(ev) => {
						if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
						loadOverview();
					},
					{ invalidateDependencies: [] }
				);
			}
		});
	});

	onDestroy(() => {
		unsub?.();
	});
</script>

<svelte:window onclick={closeAll} />

<div class="page">
	<!-- Header -->
	<header class="header" {@attach motionStagger({ index: 0, from: { y: -6 } })}>
		<h1 class="title">Overview</h1>
		{#if canCreateProjects}
		<a
			href="/{orgSlug}/new?autoCreate=1"
			class="btn-primary"
			{@attach springHover({ lift: -1, stiffness: 480, damping: 26 })}
			><Plus size={15} /> Add New...</a
		>
		{/if}
	</header>

	<div class="layout">
		<main class="main">
			{#if loading}
				<div class="grid">
					{#each Array(6) as _}
						<div class="card card--skel">
							<div class="card-top">
								<div class="sk sk-icon"></div>
								<div class="sk-col">
									<div class="sk" style="width:7rem;height:0.7rem"></div>
									<div class="sk" style="width:10rem;height:0.5rem"></div>
								</div>
							</div>
							<div class="card-bot">
								<div class="sk" style="width:4rem;height:0.5rem"></div>
								<div class="sk" style="width:3rem;height:0.5rem"></div>
							</div>
						</div>
					{/each}
				</div>
			{:else if loadError}
				<div class="empty">
					<div class="empty-icon"><Sparkles size={28} /></div>
					<h3 class="empty-h">
						{loadError.status === 403 ? "Can't load this organization" : 'Failed to load overview'}
					</h3>
					<p class="empty-p">
						{loadError.status === 403
							? 'The server says you don\'t have access right now. This usually clears on reload.'
							: loadError.message}
					</p>
					<button
						class="btn-primary"
						style="margin-top:0.5rem"
						onclick={() => location.reload()}
					>
						<RefreshCw size={15} /> Reload
					</button>
				</div>
			{:else if deployments.length === 0}
				<div class="empty">
					<div class="empty-icon"><Sparkles size={28} /></div>
					<h3 class="empty-h">
						{canCreateProjects ? 'Deploy your first app' : 'No projects to show yet'}
					</h3>
					<p class="empty-p">
						{canCreateProjects
							? 'Import a GitHub repo or deploy a Docker image.'
							: 'A project admin needs to invite you to a specific project before anything shows up here.'}
					</p>
					{#if canCreateProjects}
					<a href="/{orgSlug}/new" class="btn-primary" style="margin-top:0.5rem"
						><Plus size={15} /> New Deployment</a
					>
					{/if}
				</div>
			{:else}
				<!-- Toolbar -->
				<div class="bar" {@attach motionStagger({ index: 1, from: { y: 6 } })}>
					<div class="search-box">
						<Search size={13} class="search-ic" />
						<input
							type="search"
							placeholder="Search deployments..."
							class="search"
							bind:value={searchQuery}
						/>
					</div>
				</div>

				<!-- Favourites -->
				{#if favDeps.length > 0}
					<section class="section">
						<h2 class="label"><Star size={11} /> Favourites</h2>
						<div class="grid">
							{#each favDeps as dep, i (dep.id)}
								<div {@attach motionStagger({ index: i, stride: 0.04, from: { y: 10 } })}>
									{@render card(dep, true)}
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<!-- Group by Project -->
				{#if projectGroups.length > 0}
					{#if totalProjectTabs > 1}
						<nav class="proj-tabs" aria-label="Project pages">
							{#each Array(totalProjectTabs) as _, ti}
								<button
									type="button"
									class="proj-tab"
									class:proj-tab--active={projectTab === ti}
									onclick={() => (projectTab = ti)}
									aria-current={projectTab === ti ? 'page' : undefined}
								>
									{ti * PROJECTS_PER_TAB + 1}–{Math.min(
										(ti + 1) * PROJECTS_PER_TAB,
										projectGroups.length
									)}
								</button>
							{/each}
						</nav>
					{/if}
					{#each visibleProjectGroups as group, gi (group.id)}
							{@const expanded = expandedProjects.has(group.id)}
							{@const meta = projectMetas.get(group.id)}
							{@const summary = projectStatusSummary(group)}
							<section
								class="section"
								{@attach motionStagger({ index: gi, stride: 0.05, from: { y: 14 } })}
							>
								<div
									class="proj-card"
									class:proj-card--expanded={expanded}
									class:proj-card--hasbg={!!meta?.backgroundImage}
								>
									{#if meta?.backgroundImage}
										<div class="proj-card-backdrop" aria-hidden="true">
											<div
												class="proj-body-bg proj-body-bg--1"
												{@attach preBlurBg(meta.backgroundImage)}
											></div>
											<div
												class="proj-body-bg proj-body-bg--2"
												{@attach preBlurBg(meta.backgroundImage)}
											></div>
											<div
												class="proj-body-bg proj-body-bg--3"
												{@attach preBlurBg(meta.backgroundImage)}
											></div>
											<div class="proj-body-veil"></div>
										</div>
									{/if}
									<button
										class="proj-head"
										onclick={(e) => toggleExpand(group.id, e)}
										aria-expanded={expanded}
										aria-label={expanded ? `Collapse ${group.name}` : `Expand ${group.name}`}
									>
										<div
											class="proj-chev"
											class:proj-chev--open={expanded}
											{@attach springRotate(() => expanded, { rest: 0, on: 90 })}
										>
											<ChevronRight size={16} />
										</div>
										<div
											class="proj-av"
											class:proj-av--fallback={!meta?.icon || !/^https?:\/\//.test(meta.icon)}
										>
											{#if meta?.icon}
												{#if /^https?:\/\//.test(meta.icon)}
													<img src={meta.icon} alt="" class="proj-av-img" />
												{:else}
													<span class="proj-av-emoji">{meta.icon}</span>
												{/if}
											{:else}
												<Folder size={16} />
											{/if}
										</div>
										<div class="proj-text">
											<span class="proj-name">{group.name}</span>
											{#if meta?.description}
												<span class="proj-sub">{meta.description}</span>
											{/if}
										</div>
										<div class="proj-stats">
											<span class="proj-stat" title="Deployments"
												><Rocket size={12} /> {group.deps.length}</span
											>
											{#if group.dbs.length > 0}
												<span class="proj-stat" title="Databases"
													><Database size={12} /> {group.dbs.length}</span
												>
											{/if}
											{#if summary}
												<span class="proj-summary">
													{#if summary.green > 0}<span class="dot dot--green"
														></span>{summary.green}{/if}
													{#if summary.amber > 0}<span class="dot dot--amber"
														></span>{summary.amber}{/if}
													{#if summary.red > 0}<span class="dot dot--red"></span>{summary.red}{/if}
												</span>
											{/if}
										</div>
										<a
											href="/{orgSlug}/new?projectSlug={group.slug}"
											class="proj-new"
											onclick={(e) => e.stopPropagation()}
											aria-label="Add new to this project"
										>
											<Plus size={12} /> New
										</a>
										<a
											href="/{orgSlug}/projects/{group.slug}"
											class="proj-open"
											onclick={(e) => e.stopPropagation()}
											aria-label="Open project"
										>
											<ArrowRight size={14} />
										</a>
									</button>
									{#if renderedProjectBodies.has(group.id)}
										<div class="proj-body" {@attach bodyAttach(group.id)}>
											<div class="grid">
												{#each group.deps as dep, i (dep.id)}
													<div {@attach motionStagger({ index: i, stride: 0.04, from: { y: 8 } })}>
														{@render card(dep, false)}
													</div>
												{/each}
												{#each group.dbs as db, i (db.id)}
													<div
														{@attach motionStagger({
															index: group.deps.length + i,
															stride: 0.04,
															from: { y: 8 }
														})}
													>
														{@render dbCard(db)}
													</div>
												{/each}
											</div>
										</div>
									{/if}
								</div>
							</section>
						{/each}
					{/if}
				{#if filtered.length === 0 && filteredDbs.length === 0}
					<p class="no-results">
						{searchQuery ? `No results for "${searchQuery}"` : 'Nothing here yet'}
					</p>
				{/if}
			{/if}
		</main>

		<!-- Builds sidebar -->
		<aside class="aside">
			<h2 class="label aside-label">Recent Builds</h2>
			{#if buildsLoading}
				{#each Array(3) as _}
					<div class="bld bld--skel">
						<div class="sk" style="width:1.5rem;height:1.5rem;border-radius:0.375rem"></div>
						<div class="sk-col" style="flex:1">
							<div class="sk" style="width:5rem;height:0.6rem"></div>
							<div class="sk" style="width:7rem;height:0.45rem"></div>
						</div>
					</div>
				{/each}
			{:else if activeBuilds.length === 0 && recentBuilds.length === 0}
				<p class="aside-empty">No recent builds</p>
			{:else}
				{#each activeBuilds as b, i (b.id)}
					{@const ic = buildIcon(b.image, b.ingresses, b.id)}
					<a
						href="/{orgSlug}/deployments/{b.id}"
						class="bld bld--live"
						{@attach motionStagger({ index: i, stride: 0.04, from: { y: 6, scale: 1 } })}
					>
						<div class="bld-dot bld-dot--building"><Loader2 size={13} class="spin" /></div>
						<div class="bld-info">
							<span class="bld-row"
								>{#if ic}<img
										src={ic}
										alt=""
										class="bld-ic"
										onerror={() => favErr('b-' + b.id)}
									/>{/if}<span class="bld-name">{b.name}</span></span
							>
							<span class="bld-sub"
								>{#if b.project?.name}<strong>{b.project.name}</strong> ·
								{/if}{b.buildStep ?? 'Building'}</span
							>
						</div>
						<span class="bld-time bld-time--live"
							><BuildTimer updatedAt={b.updatedAt} /></span
						>
					</a>
				{/each}
				{#each recentBuilds as b, i (b.id)}
					{@const ok = b.deployment.buildStatus !== 'failed'}
					{@const ic = buildIcon(b.deployment.image, b.deployment.ingresses, b.deployment.id)}
					<a
						href="/{orgSlug}/deployments/{b.deployment.id}"
						class="bld"
						{@attach motionStagger({
							index: activeBuilds.length + i,
							stride: 0.04,
							from: { y: 6, scale: 1 }
						})}
					>
						<div class="bld-dot" class:bld-dot--ok={ok} class:bld-dot--fail={!ok}>
							{#if ok}<CheckCircle2 size={13} />{:else}<XCircle size={13} />{/if}
						</div>
						<div class="bld-info">
							<span class="bld-row"
								>{#if ic}<img
										src={ic}
										alt=""
										class="bld-ic"
										onerror={() => favErr('b-' + b.deployment.id)}
									/>{/if}<span class="bld-name">{b.deployment.name}</span></span
							>
							<span class="bld-sub"
								>{#if b.deployment.project?.name}<strong>{b.deployment.project.name}</strong
									>{/if}{#if b.commitSha}{#if b.deployment.project?.name}
										·
									{/if}{b.commitSha.slice(
										0,
										7
									)}{/if}{#if b.branch}{#if b.deployment.project?.name || b.commitSha}
										·
									{/if}{b.branch}{/if}</span
							>
						</div>
						<span class="bld-time"><Clock size={10} /> {timeAgo(b.createdAt)}</span>
					</a>
				{/each}
			{/if}
		</aside>
	</div>
</div>

<!-- Deployment card snippet -->
{#snippet card(dep: DeploymentSummary, isFav: boolean)}
	{@const icon = knownIcon(dep.image)}
	<a
		href="/{orgSlug}/deployments/{dep.id}"
		class="card"
		class:card--fav={isFav}
		{@attach springHover({ lift: -3, stiffness: 360, damping: 22 })}
		{@attach cardTilt({ max: 4 })}
	>
		<div class="card-top">
			{#if icon}
				<img src={icon} alt="" class="card-ic" />
			{:else if dep.ingresses.length > 0 && !failedFav.has(dep.id)}
				<img
					src={favUrl(dep.ingresses[0].host.split('/')[0])}
					alt=""
					class="card-ic"
					onerror={() => favErr(dep.id)}
				/>
			{:else}
				<div class="card-av">{dep.name.charAt(0).toUpperCase()}</div>
			{/if}
			<div class="card-text">
				<span class="card-name">{dep.name}</span>
				{#if dep.ingresses.length > 0}
					<span class="card-sub">{dep.ingresses[0].host.split('/')[0]}</span>
				{:else if dep.githubRepo}
					<span class="card-sub"
						>{dep.githubRepo}{#if dep.githubBranch}
							/ {dep.githubBranch}{/if}</span
					>
				{:else if dep.image}
					<span class="card-sub">{dep.image}</span>
				{/if}
			</div>
			<div class="card-acts">
				<button
					class="abtn fav"
					class:fav--on={favouriteIds.has(dep.id)}
					onclick={(e) => toggleFav(dep, e)}
					aria-label="Favourite"
					{@attach springPop(() => favouriteIds.has(dep.id))}><Star size={13} /></button
				>
				<div class="menu-wrap">
					<button class="abtn" onclick={(e) => toggleMenu(dep.id, e)} aria-label="More"
						><MoreVertical size={13} /></button
					>
					{#if renderMenuId === dep.id}
						<div
							class="menu"
							{@attach motionPopover({
								from: { y: -6, scale: 0.94 },
								stiffness: 540,
								damping: 28,
								closing: () => openMenuId !== dep.id,
								onClosed: () => {
									if (renderMenuId === dep.id) renderMenuId = null;
								}
							})}
						>
							{#if dep.ingresses.length > 0}
								<button class="menu-item" onclick={(e) => visit(dep, e)}
									><ExternalLink size={14} /> Visit</button
								>
								<button class="menu-item" onclick={(e) => cpUrl(dep, e)}
									><Copy size={14} /> Copy URL</button
								>
							{/if}
							<button class="menu-item" onclick={(e) => restart(dep, e)}
								><RefreshCw size={14} /> Restart</button
							>
							<button class="menu-item" onclick={(e) => toggleFav(dep, e)}
								>{#if favouriteIds.has(dep.id)}<PinOff size={14} /> Unfavourite{:else}<Pin
										size={14}
									/> Favourite{/if}</button
							>
						</div>
					{/if}
				</div>
			</div>
		</div>
		<div class="card-bot">
			<span class="card-status"
				><span class="dot {dotClass(dep.status, dep.buildStatus)}"></span>
				{statusText(dep.status, dep.buildStatus)}</span
			>
			<span class="card-meta">{timeAgo(dep.updatedAt)}</span>
		</div>
	</a>
{/snippet}

{#snippet dbCard(db: DatabaseSummary)}
	{@const dbIcon = IMG_ICONS.postgres}
	<a
		href="/{orgSlug}/databases/{db.id}"
		class="card"
		{@attach springHover({ lift: -3, stiffness: 360, damping: 22 })}
		{@attach cardTilt({ max: 4 })}
	>
		<div class="card-top">
			<img src={dbIcon} alt="" class="card-ic" />
			<div class="card-text">
				<span class="card-name">{db.name}</span>
				<span class="card-sub">{db.dbName}</span>
			</div>
		</div>
		<div class="card-bot">
			<span class="card-status">
				<span
					class="dot {db.status === 'ready'
						? 'dot--green'
						: db.status === 'error'
							? 'dot--red'
							: 'dot--amber'}"
				></span>
				{db.status === 'ready' ? 'Running' : db.status.charAt(0).toUpperCase() + db.status.slice(1)}
			</span>
			<span class="card-meta">{timeAgo(db.updatedAt)}</span>
		</div>
	</a>
{/snippet}

<style>
	.page {
		max-width: 80rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 4rem;
	}

	/* Header */
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.75rem;
	}
	.title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}
	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		background: var(--button-bg);
		color: var(--button-color);
		text-decoration: none;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
	}
	.btn-primary:hover {
		opacity: 0.85;
	}

	/* Layout */
	.layout {
		display: flex;
		gap: 2rem;
		align-items: flex-start;
	}
	.main {
		flex: 1;
		min-width: 0;
	}

	/* Toolbar */
	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.search-box {
		position: relative;
		flex: 1;
		max-width: 18rem;
	}
	:global(.search-ic) {
		position: absolute;
		left: 0.625rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--surface-muted);
		pointer-events: none;
	}
	.search {
		width: 100%;
		padding: 0.4375rem 0.75rem 0.4375rem 2rem;
		border-radius: 0.5rem;
		border: 1px solid transparent;
		background: color-mix(in srgb, var(--surface-border) 30%, var(--center-channel-bg));
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		transition: all 0.15s;
	}
	.search::placeholder {
		color: var(--surface-muted);
	}
	.search:focus {
		outline: none;
		border-color: var(--surface-muted);
		background: var(--center-channel-bg);
	}

	/* Section labels */
	.section {
		margin-bottom: 1.75rem;
	}
	.proj-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin: 0 0 1rem;
	}
	.proj-tab {
		appearance: none;
		border: 1px solid var(--center-channel-divider);
		background: var(--center-channel-bg);
		color: var(--surface-muted);
		padding: 0.3rem 0.65rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
	}
	.proj-tab:hover {
		color: var(--center-channel-color);
		border-color: var(--button-bg);
	}
	.proj-tab--active {
		background: var(--button-bg);
		border-color: var(--button-bg);
		color: var(--button-color, #fff);
	}
	.label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--surface-muted);
		margin: 0 0 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}

	/* Project card (expandable) */
	.proj-card {
		position: relative;
		border-radius: 0.75rem;
		background: var(--center-channel-bg);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 3px 8px rgba(0, 0, 0, 0.03);
		transition: box-shadow 0.15s;
		overflow: hidden;
	}
	.proj-card:hover {
		box-shadow:
			0 2px 4px rgba(0, 0, 0, 0.06),
			0 6px 16px rgba(0, 0, 0, 0.07);
	}
	.proj-card--expanded {
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--surface-border) 55%, transparent),
			0 2px 4px rgba(0, 0, 0, 0.05),
			0 8px 20px rgba(0, 0, 0, 0.06);
	}
	.proj-card--hasbg {
		color: #fff;
	}
	.proj-card-backdrop {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 7.5rem;
		overflow: hidden;
		pointer-events: none;
		border-radius: inherit;
		/* Isolate the filtered layer from parent reflow. Without `contain`,
		   Chrome treats the backdrop as part of the card's paint tree, so any
		   reflow on the card (sidebar resize, grid column flip, body
		   expand/collapse) invalidates the cached blur. With `contain` the
		   backdrop owns its own paint subtree and isn't repainted on parent
		   size changes — only on its own. */
		contain: layout paint;
	}
	/* Backdrop keeps fully-rounded corners always — squaring only the bottom
	   when expanded caused a square-to-rounded pop the moment the user
	   clicked collapse (class flips off before the body anim runs). */
	.proj-card--hasbg .proj-head {
		position: relative;
		z-index: 1;
		color: #fff;
	}
	.proj-card--hasbg .proj-name {
		color: #fff;
	}
	.proj-card--hasbg .proj-sub,
	.proj-card--hasbg .proj-stat,
	.proj-card--hasbg .proj-chev,
	.proj-card--hasbg .proj-open {
		color: rgba(255, 255, 255, 0.78);
	}
	.proj-card--hasbg .proj-chev--open {
		color: #fff;
	}
	.proj-card--hasbg .proj-summary {
		border-left-color: rgba(255, 255, 255, 0.25);
		color: rgba(255, 255, 255, 0.85);
	}
	.proj-card--hasbg .proj-new {
		color: #fff;
		border-color: rgba(255, 255, 255, 0.45);
	}
	.proj-card--hasbg .proj-new:hover {
		color: #fff;
		background: rgba(255, 255, 255, 0.15);
		border-color: #fff;
	}
	/* Body wrapper — holds the optional blurred backdrop + the actual grid card */
	.proj-body-wrap {
		position: relative;
	}

	.proj-body-bg {
		position: absolute;
		inset: -40%;
		background-size: cover;
		background-position: center;
		filter: blur(48px) saturate(1.6);
		will-change: transform;
		transform-origin: 50% 50%;
	}
	/* Firefox doesn't cache filter output to a compositor layer, so a 48px blur
	   gets re-rasterized on every animation frame. Use a smaller radius there. */
	@-moz-document url-prefix() {
		.proj-body-bg {
			filter: blur(20px) saturate(1.4);
		}
	}
	.proj-body-bg--1 {
		transform: scale(1.6) rotate(0deg);
		animation: proj-spin-a 28s linear infinite;
		opacity: 0.9;
	}
	.proj-body-bg--2 {
		transform: scale(2.1) translate(8%, -6%) rotate(70deg);
		animation: proj-spin-b 44s linear infinite;
		opacity: 0.55;
	}
	.proj-body-bg--3 {
		transform: scale(2.6) translate(-10%, 9%) rotate(140deg);
		animation: proj-spin-c 60s linear infinite;
		opacity: 0.4;
	}
	.proj-body-veil {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgba(0, 0, 0, 0.15) 0%, rgba(0, 0, 0, 0.35) 100%);
	}

	@keyframes proj-spin-a {
		from {
			transform: scale(1.6) rotate(0deg);
		}
		to {
			transform: scale(1.6) rotate(360deg);
		}
	}
	@keyframes proj-spin-b {
		from {
			transform: scale(2.1) translate(8%, -6%) rotate(70deg);
		}
		to {
			transform: scale(2.1) translate(8%, -6%) rotate(430deg);
		}
	}
	@keyframes proj-spin-c {
		from {
			transform: scale(2.6) translate(-10%, 9%) rotate(140deg);
		}
		to {
			transform: scale(2.6) translate(-10%, 9%) rotate(-220deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.proj-body-bg--1,
		.proj-body-bg--2,
		.proj-body-bg--3 {
			animation: none;
		}
	}

	.proj-card--hasbg .proj-body {
		position: relative;
		z-index: 1;
		background: var(--center-channel-bg);
		color: var(--center-channel-color);
		padding: 1rem 1.125rem 1.125rem;
		border-radius: 0 0 0.75rem 0.75rem;
		box-sizing: border-box;
	}

	/* Inner deployment/database cards over a banner — solid surface like the rest of the app */
	.proj-card--hasbg .proj-body :global(.card) {
		background: var(--center-channel-bg);
		box-shadow:
			0 2px 8px rgba(0, 0, 0, 0.08),
			0 10px 24px rgba(0, 0, 0, 0.12);
	}
	.proj-card--hasbg .proj-body :global(.card:hover) {
		box-shadow:
			0 4px 12px rgba(0, 0, 0, 0.1),
			0 14px 32px rgba(0, 0, 0, 0.16);
	}

	.proj-av-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.proj-av-emoji {
		font-size: 1.125rem;
		line-height: 1;
	}

	.proj-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		min-height: 7.5rem;
		padding: 2rem 1.125rem;
		border: none;
		background: none;
		color: var(--center-channel-color);
		cursor: pointer;
		text-align: left;
		font: inherit;
	}
	.proj-chev {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		flex-shrink: 0;
		color: var(--surface-muted);
		/* rotation owned by Motion (springRotate attachment) */
	}
	.proj-chev--open {
		color: var(--center-channel-color);
	}
	.proj-av {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.proj-av--fallback {
		background: #4a8aff;
		color: #fff;
	}
	.proj-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.proj-name {
		font-size: 0.9375rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.proj-sub {
		font-size: 0.75rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.proj-stats {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
	}
	.proj-stat {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
		font-variant-numeric: tabular-nums;
	}
	.proj-summary {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
		font-variant-numeric: tabular-nums;
		padding-left: 0.75rem;
		border-left: 1px solid color-mix(in srgb, var(--surface-border) 45%, transparent);
	}
	.proj-summary .dot {
		margin-right: 0.0625rem;
	}
	.proj-new {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.3125rem 0.625rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		text-decoration: none;
		flex-shrink: 0;
		border: 1px dashed color-mix(in srgb, var(--surface-border) 80%, transparent);
		background: none;
		transition: all 0.12s;
		white-space: nowrap;
	}
	.proj-new:hover {
		color: var(--sidebar-text-active-border);
		border-color: var(--sidebar-text-active-border);
	}
	.proj-open {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		color: var(--surface-muted);
		text-decoration: none;
		flex-shrink: 0;
		transition: all 0.12s;
	}
	.proj-open:hover {
		color: var(--sidebar-text-active-border);
		background: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
	}

	.proj-body {
		padding: 0 1.125rem 1.125rem;
		box-sizing: border-box;
	}

	/* Card grid */
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		gap: 0.875rem;
		transform-origin: top;
	}

	/* Card — transform is owned by Motion (springHover + cardTilt). */
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: 0.625rem;
		background: var(--center-channel-bg);
		min-height: 8rem;
		text-decoration: none;
		color: var(--center-channel-color);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 3px 8px rgba(0, 0, 0, 0.03);
		transition: box-shadow 0.18s ease;
		cursor: pointer;
	}
	.card:hover {
		box-shadow:
			0 2px 4px rgba(0, 0, 0, 0.06),
			0 8px 22px rgba(0, 0, 0, 0.09);
	}
	.card--fav {
		box-shadow:
			0 0 0 1.5px color-mix(in srgb, var(--sidebar-text-active-border) 25%, transparent),
			0 1px 2px rgba(0, 0, 0, 0.04),
			0 3px 8px rgba(0, 0, 0, 0.03);
	}
	.card--skel {
		pointer-events: none;
	}

	.card-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.card-ic {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		object-fit: cover;
	}
	.card-av {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent),
			color-mix(in srgb, var(--sidebar-text-active-border) 5%, transparent)
		);
		color: var(--sidebar-text-active-border);
		font-size: 0.75rem;
		font-weight: 700;
	}
	.card-text {
		flex: 1;
		min-width: 0;
	}
	.card-name {
		display: block;
		font-size: 0.9375rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.card-sub {
		display: block;
		font-size: 0.75rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		margin-top: 0.0625rem;
	}
	.card-bot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: auto;
		padding-top: 0.5rem;
	}
	.card-status {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.6875rem;
		color: var(--surface-muted);
		font-weight: 500;
	}
	.card-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		white-space: nowrap;
	}

	/* Hover actions */
	.card-acts {
		display: flex;
		align-items: center;
		gap: 0.0625rem;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity 0.1s;
	}
	.card:hover .card-acts {
		opacity: 1;
	}
	.fav--on {
		opacity: 1 !important;
	}
	.abtn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.25rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition: all 0.1s;
	}
	.abtn:hover {
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
		color: var(--center-channel-color);
	}
	.fav--on {
		color: #eab308;
	}
	.fav--on:hover {
		color: #ca8a04;
	}

	/* Menus */
	.menu-wrap {
		position: relative;
	}
	.menu {
		position: absolute;
		top: calc(100% + 0.25rem);
		right: 0;
		z-index: 50;
		min-width: 10rem;
		padding: 0.25rem;
		border-radius: 0.5rem;
		background: var(--center-channel-bg);
		box-shadow:
			0 6px 20px rgba(0, 0, 0, 0.12),
			0 0 0 1px color-mix(in srgb, var(--surface-border) 45%, transparent);
		transform-origin: top right;
	}
	.menu--left {
		left: 0;
		right: auto;
		max-height: 20rem;
		overflow-y: auto;
		min-width: 11rem;
	}
	.menu-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.4375rem 0.5rem;
		border: none;
		border-radius: 0.3rem;
		background: none;
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s;
	}
	.menu-item:hover {
		background: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}
	.menu-item--on {
		font-weight: 600;
		color: var(--sidebar-text-active-border);
	}

	/* Dots */
	.dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		display: inline-block;
	}
	.dot--green {
		background: #22c55e;
		box-shadow: 0 0 5px color-mix(in srgb, #22c55e 35%, transparent);
	}
	.dot--amber {
		background: #f59e0b;
		box-shadow: 0 0 5px color-mix(in srgb, #f59e0b 35%, transparent);
	}
	.dot--red {
		background: #ef4444;
		box-shadow: 0 0 5px color-mix(in srgb, #ef4444 35%, transparent);
	}
	.dot--gray {
		background: var(--surface-muted);
		opacity: 0.35;
	}

	/* Empty */
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 5rem 2rem;
		text-align: center;
	}
	.empty-icon {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 1rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.empty-h {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}
	.empty-p {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		max-width: 20rem;
		margin: 0;
		line-height: 1.5;
	}
	.no-results {
		text-align: center;
		padding: 3rem;
		color: var(--surface-muted);
		font-size: 0.8125rem;
	}

	/* Builds sidebar */
	.aside {
		flex: 0 0 17.5rem;
		position: sticky;
		top: 1.5rem;
		border-radius: 0.625rem;
		background: var(--center-channel-bg);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--surface-border) 50%, transparent),
			0 1px 3px rgba(0, 0, 0, 0.04);
		overflow: hidden;
	}
	.aside-label {
		padding: 0.875rem 0.875rem 0;
		margin-bottom: 0.375rem;
	}
	.aside-empty {
		padding: 2rem 1rem;
		text-align: center;
		color: var(--surface-muted);
		font-size: 0.75rem;
		margin: 0;
	}

	.bld {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.625rem 0.875rem;
		text-decoration: none;
		color: var(--center-channel-color);
		transition: background 0.1s;
		cursor: pointer;
	}
	.bld + .bld {
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--surface-border) 25%, transparent);
	}
	.bld:hover {
		background: color-mix(in srgb, var(--surface-border) 12%, transparent);
	}
	.bld--live {
		background: color-mix(in srgb, #f59e0b 3%, transparent);
	}
	.bld--skel {
		pointer-events: none;
	}

	.bld-dot {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		flex-shrink: 0;
	}
	.bld-dot--building {
		color: #f59e0b;
		background: color-mix(in srgb, #f59e0b 10%, transparent);
	}
	.bld-dot--ok {
		color: #22c55e;
		background: color-mix(in srgb, #22c55e 10%, transparent);
	}
	.bld-dot--fail {
		color: #ef4444;
		background: color-mix(in srgb, #ef4444 10%, transparent);
	}

	.bld-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.bld-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}
	.bld-ic {
		width: 0.875rem;
		height: 0.875rem;
		border-radius: 0.125rem;
		flex-shrink: 0;
		object-fit: contain;
	}
	.bld-name {
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.bld-sub {
		font-size: 0.625rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.bld-sub strong {
		font-weight: 500;
		color: color-mix(in srgb, var(--center-channel-color) 65%, transparent);
	}

	.bld-time {
		display: inline-flex;
		align-items: center;
		gap: 0.1875rem;
		font-size: 0.625rem;
		color: var(--surface-muted);
		white-space: nowrap;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}
	.bld-time--live {
		color: #f59e0b;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}

	/* Skeletons */
	.sk-icon {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
	}
	.sk-col {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		flex: 1;
	}
	:global(.sk) {
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--surface-border) 40%, transparent) 25%,
			color-mix(in srgb, var(--surface-border) 18%, transparent) 50%,
			color-mix(in srgb, var(--surface-border) 40%, transparent) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
		border-radius: 0.25rem;
	}
	@keyframes shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	/* Responsive */
	@media (max-width: 64rem) {
		.layout {
			flex-direction: column-reverse;
		}
		.aside {
			flex: none;
			width: 100%;
			position: static;
		}
	}
	@media (max-width: 48rem) {
		.page {
			padding: 1.5rem 1rem 3rem;
		}
		.bar {
			flex-wrap: wrap;
		}
		.search-box {
			max-width: none;
			flex: 1;
			min-width: 8rem;
		}
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
