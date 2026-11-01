<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import {
		apiFetch,
		pinnedItems,
		toasts,
		subscribeOrgEvents,
		sseStatusFor,
		isSuperAdmin,
		dashboardDensity
	} from '$lib/stores';
	import { projectGradientEnabled } from '$lib/stores/preferences';
	import { queryClient } from '$lib/query';
	import { ingressUrl } from '$lib/ingress-url';
	import { overviewQueryOptions, buildsQueryOptions } from '$lib/queries/overview';
	import {
		Box,
		Database,
		Timer,
		FolderPlus,
		Ellipsis,
		ExternalLink,
		RotateCw,
		LayoutGrid,
		List,
		ChevronDown,
		Sprout
	} from 'lucide-svelte';
	import { onDestroy, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import Page from '$lib/components/ui/Page.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import ProjectGroup from '$lib/components/patterns/ProjectGroup.svelte';
	import EntityCard from '$lib/components/patterns/EntityCard.svelte';
	import EntityLine from '$lib/components/patterns/EntityLine.svelte';
	import NeedsAttention from '$lib/components/patterns/NeedsAttention.svelte';
	import RecentBuilds from '$lib/components/patterns/RecentBuilds.svelte';
	import LiquidNewButton, {
		type NewMenuItem
	} from '$lib/components/patterns/LiquidNewButton.svelte';
	import type { BuildItem } from '$lib/components/patterns/builds';
	import { toBuildItems } from '$lib/components/org-dashboard/build-items';
	import type { FailingApp } from '$lib/components/patterns/sidebar';
	import { IMG_ICONS, knownIcon, favUrl } from '$lib/components/org-dashboard/helpers.svelte';
	import type {
		DeploymentSummary,
		DatabaseSummary,
		ActiveBuild,
		RecentBuild,
		ProjectMeta,
		ProjectGroup as Group
	} from '$lib/components/org-dashboard';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);

	// Manual state — set from $effect watching query, avoids $derived chains
	let currentOrgRole = $state<'owner' | 'admin' | 'member' | 'guest' | null>(null);
	let isSyntheticMembership = $state(false);
	let joiningOrg = $state(false);
	const canCreateProjects = $derived(currentOrgRole !== null && currentOrgRole !== 'guest');
	let loading = $state(true);
	let buildsLoading = $state(true);
	let orgId = $state<string | null>(null);
	let loadError = $state<{ status: number; message: string } | null>(null);
	let deployments = $state<DeploymentSummary[]>([]);
	let databases = $state<DatabaseSummary[]>([]);
	const projectMetas = new SvelteMap<string, ProjectMeta>();
	const liveMetrics = new SvelteMap<string, { cpuMilli: number; memoryBytes: number }>();
	const cpuSeries = new SvelteMap<string, number[]>();
	const SERIES = 24;
	let activeBuilds = $state<ActiveBuild[]>([]);
	let recentBuilds = $state<RecentBuild[]>([]);
	let sseStatusValue = $state<'connecting' | 'connected' | 'disconnected'>('connecting');

	const overviewQuery = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: !!orgSlug,
		refetchInterval: (() => {
			const sseUp = sseStatusValue === 'connected';
			if (activeBuilds.length > 0) return sseUp ? 15_000 : 8_000;
			if (!sseUp) return 10_000;
			return 30_000;
		})(),
		refetchIntervalInBackground: true
	}));

	const buildsQuery = createQuery(() => ({
		...buildsQueryOptions(orgSlug),
		enabled: !!orgSlug,
		refetchInterval: (() => {
			const sseUp = sseStatusValue === 'connected';
			if (activeBuilds.length > 0) return 5_000;
			if (!sseUp) return 15_000;
			return 60_000;
		})(),
		refetchIntervalInBackground: true
	}));

	// ── Stable ordering (existing cards keep their position; new ids are
	// rank-sorted and appended). Returns `prev` untouched when nothing changed
	// so downstream deriveds don't churn on every refetch. ──
	let depOrder = $state<string[]>([]);
	let dbOrder = $state<string[]>([]);
	let projOrder = $state<string[]>([]);

	function mergeOrder<T extends { id: string }>(
		prev: string[],
		items: T[],
		rank: (item: T) => number
	): string[] {
		const present = new Set(items.map((x) => x.id));
		const kept = prev.filter((id) => present.has(id));
		const known = new Set(kept);
		const fresh = items
			.filter((x) => !known.has(x.id))
			.sort((a, b) => rank(b) - rank(a))
			.map((x) => x.id);
		if (fresh.length === 0 && kept.length === prev.length) return prev;
		return [...kept, ...fresh];
	}

	// Compares all the way down, not one level. The stored copies live in `$state`,
	// so every nested object read back out is a fresh proxy and never reference-equal
	// to the raw payload. A one-level `!==` therefore reported every value holding a
	// nested array or object as changed: `ingresses` was rewritten on all ~200 rows
	// of every refetch because each one carries `entrypoints: ['websecure']`, and each
	// of those writes re-proxied a subtree and invalidated everything reading it.
	function valueEq(a: any, b: any): boolean {
		if (a === b) return true;
		if (a == null || b == null) return false;
		if (Array.isArray(a) !== Array.isArray(b)) return false;
		if (Array.isArray(a) && Array.isArray(b)) {
			if (a.length !== b.length) return false;
			for (let i = 0; i < a.length; i++) if (!valueEq(a[i], b[i])) return false;
			return true;
		}
		if (typeof a === 'object' && typeof b === 'object') {
			const ka = Object.keys(a);
			if (ka.length !== Object.keys(b).length) return false;
			for (const k of ka) if (!valueEq((a as any)[k], (b as any)[k])) return false;
			return true;
		}
		return false;
	}

	// The row objects we last copied in, by id. TanStack's structural sharing hands
	// back the previous object untouched when a row is unchanged, so identity alone
	// settles it and the per-key walk is skipped. Nothing else writes these rows:
	// SSE only touches `liveMetrics` and invalidates the query.
	const appliedDeployments = new Map<string, unknown>();
	const appliedDatabases = new Map<string, unknown>();
	const appliedProjects = new Map<string, unknown>();
	const appliedActiveBuilds = new Map<string, unknown>();
	const appliedRecentBuilds = new Map<string, unknown>();

	function syncList<T extends { id: string }>(list: T[], next: T[], applied: Map<string, unknown>) {
		const nextById = new Map(next.map((x) => [x.id, x]));
		for (let i = list.length - 1; i >= 0; i--) {
			if (!nextById.has(list[i].id)) {
				applied.delete(list[i].id);
				list.splice(i, 1);
			}
		}
		const curById = new Map<string, T>();
		for (const x of list) curById.set(x.id, x);
		for (const n of next) {
			const cur = curById.get(n.id);
			if (cur) {
				if (applied.get(n.id) === n) continue;
				applied.set(n.id, n);
				for (const k of Object.keys(n) as Array<keyof T>) {
					if (!valueEq(cur[k], n[k])) cur[k] = n[k];
				}
			} else {
				list.push(n);
				curById.set(n.id, n);
				applied.set(n.id, n);
			}
		}
	}

	function syncMap<V extends { id: string }>(
		map: Map<string, V>,
		next: V[],
		applied: Map<string, unknown>
	) {
		const nextIds = new Set<string>();
		for (const v of next) nextIds.add(v.id);
		for (const id of [...map.keys()]) {
			if (!nextIds.has(id)) {
				map.delete(id);
				applied.delete(id);
			}
		}
		for (const v of next) {
			const cur = map.get(v.id);
			if (!cur) {
				map.set(v.id, v);
				applied.set(v.id, v);
				continue;
			}
			if (applied.get(v.id) === v) continue;
			applied.set(v.id, v);
			let changed = false;
			for (const k of Object.keys(v) as Array<keyof V>) {
				if (!valueEq(cur[k], v[k])) {
					cur[k] = v[k];
					changed = true;
				}
			}
			if (changed) map.set(v.id, cur);
		}
	}

	// Apply query data to reactive state (preserving stable ordering & identity).
	// Read query status/data/error and set manual state to avoid $derived loops.
	let lastDataRef: any = null;
	$effect(() => {
		const qData = overviewQuery.data;
		const qError = overviewQuery.error;
		const qPending = overviewQuery.isPending;
		untrack(() => {
			if (qPending) {
				// Only show loading skeleton on initial load, not background refetch
				if (!lastDataRef) {
					loading = true;
				}
				return;
			}
			if (qError) {
				const e = qError as any;
				loadError = { status: e?.status ?? 0, message: e?.message ?? String(e) };
				loading = false;
				return;
			}
			if (!qData || qData === lastDataRef) return;
			lastDataRef = qData;
			loadError = null;

			syncList(deployments, qData.deployments ?? [], appliedDeployments);
			syncList(databases, qData.databases ?? [], appliedDatabases);
			syncMap(projectMetas, qData.projects ?? [], appliedProjects);

			const newOrgId = qData.organization?.id ?? null;
			if (newOrgId && newOrgId !== orgId) orgId = newOrgId;
			// Membership is inlined in the overview payload — no extra fetch
			if (qData.currentMember) {
				currentOrgRole = qData.currentMember.role;
				isSyntheticMembership = !!qData.currentMember.synthetic;
			} else {
				currentOrgRole = null;
				isSyntheticMembership = false;
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

			loading = false;
		});
	});

	let lastBuildsRef: any = null;
	$effect(() => {
		const qData = buildsQuery.data;
		const qPending = buildsQuery.isPending;
		untrack(() => {
			if (qPending) {
				if (!lastBuildsRef) buildsLoading = true;
				return;
			}
			if (!qData || qData === lastBuildsRef) {
				buildsLoading = false;
				return;
			}
			lastBuildsRef = qData;
			syncList(activeBuilds, qData.active ?? [], appliedActiveBuilds);
			syncList(recentBuilds, qData.recent ?? [], appliedRecentBuilds);
			buildsLoading = false;
		});
	});

	// Reset state when switching orgs
	let lastSlug: string | null = null;
	$effect(() => {
		const slug = orgSlug;
		untrack(() => {
			if (slug === lastSlug) return;
			if (lastSlug !== null) {
				loading = true;
				buildsLoading = true;
				loadError = null;
				orgId = null;
				currentOrgRole = null;
				isSyntheticMembership = false;
				lastDataRef = null;
				lastBuildsRef = null;
				depOrder = [];
				dbOrder = [];
				projOrder = [];
				deployments.length = 0;
				databases.length = 0;
				activeBuilds.length = 0;
				recentBuilds.length = 0;
				projectMetas.clear();
				liveMetrics.clear();
				cpuSeries.clear();
			}
			lastSlug = slug;
		});
	});

	// ── SSE subscription ──
	// Subscribes once orgId is known. SSE events invalidate the TanStack query
	// which triggers an automatic refetch — no manual loadOverview() needed.
	let unsub: (() => void) | null = null;
	let sseOrgId: string | null = null;
	// Builds emit a burst of SSE events; collapse them into one refetch per
	// 2s window instead of refetching the full overview on every event. The
	// builds feed is cheap, so it gets its own tight 400ms window.
	let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
	let buildsInvalidateTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const id = orgId;
		const slug = orgSlug;
		untrack(() => {
			if (id === sseOrgId) return;
			sseOrgId = id;
			unsub?.();
			if (!id) return;
			unsub = subscribeOrgEvents(id, (ev) => {
				if (ev.type === 'deployment.metrics') {
					if (ev.id && ev.payload) {
						const cpuMilli = ev.payload.totalCpuUsage ?? 0;
						liveMetrics.set(ev.id, {
							cpuMilli,
							memoryBytes: ev.payload.totalMemoryUsage ?? 0
						});
						cpuSeries.set(ev.id, [...(cpuSeries.get(ev.id) ?? []), cpuMilli].slice(-SERIES));
					}
					return;
				}
				if (ev.type === 'heartbeat') return;
				if (ev.type === 'build.changed' && !buildsInvalidateTimer) {
					buildsInvalidateTimer = setTimeout(() => {
						buildsInvalidateTimer = null;
						queryClient.invalidateQueries({ queryKey: ['builds', slug] });
					}, 400);
				}
				if (invalidateTimer) return;
				invalidateTimer = setTimeout(() => {
					invalidateTimer = null;
					queryClient.invalidateQueries({ queryKey: ['overview', slug] });
				}, 2000);
			});
		});
	});

	$effect(() => {
		const id = orgId;
		if (!id) {
			sseStatusValue = 'connecting';
			return;
		}
		const store = sseStatusFor(id);
		return store.subscribe((v) => {
			sseStatusValue = v;
		});
	});

	onDestroy(() => {
		unsub?.();
		if (invalidateTimer) clearTimeout(invalidateTimer);
		if (buildsInvalidateTimer) clearTimeout(buildsInvalidateTimer);
	});

	const compact = $derived($dashboardDensity === 'compact');

	const expandKey = (slug: string) => `home-expanded:${slug}`;
	let expandedIds = $state<Set<string> | null>(null);
	$effect(() => {
		const slug = orgSlug;
		untrack(() => {
			try {
				const raw = localStorage.getItem(expandKey(slug));
				expandedIds = raw ? new Set(JSON.parse(raw)) : null;
			} catch {
				expandedIds = null;
			}
		});
	});

	function isExpanded(id: string, index: number) {
		return expandedIds ? expandedIds.has(id) : index === 0;
	}

	function setExpanded(id: string, open: boolean) {
		const next = new Set(
			expandedIds ?? (visibleProjectGroups[0] ? [visibleProjectGroups[0].id] : [])
		);
		if (open) next.add(id);
		else next.delete(id);
		expandedIds = next;
		localStorage.setItem(expandKey(orgSlug), JSON.stringify([...next]));
	}

	let searchQuery = $state('');
	const pinnedIds = new SvelteSet<string>();
	$effect(() => {
		const next = new Set($pinnedItems.filter((i) => i.type === 'deployment').map((i) => i.id));
		for (const id of pinnedIds) if (!next.has(id)) pinnedIds.delete(id);
		for (const id of next) if (!pinnedIds.has(id)) pinnedIds.add(id);
	});

	const filtered = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		const r = q
			? deployments.filter(
					(d) =>
						d.name.toLowerCase().includes(q) ||
						(d.displayName?.toLowerCase().includes(q) ?? false) ||
						(d.project?.name?.toLowerCase().includes(q) ?? false) ||
						(d.githubRepo?.toLowerCase().includes(q) ?? false) ||
						d.ingresses.some((i) => i.host.toLowerCase().includes(q))
				)
			: deployments;
		return ordered(r, depOrder);
	});

	const filteredDbs = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		const r = q
			? databases.filter(
					(d) =>
						d.name.toLowerCase().includes(q) ||
						d.dbName.toLowerCase().includes(q) ||
						(d.project?.name?.toLowerCase().includes(q) ?? false)
				)
			: databases;
		return ordered(r, dbOrder);
	});

	function ordered<T extends { id: string }>(items: T[], order: string[]) {
		const byId = new Map(items.map((x) => [x.id, x]));
		const out: T[] = [];
		for (const id of order) {
			const x = byId.get(id);
			if (x) {
				out.push(x);
				byId.delete(id);
			}
		}
		for (const x of byId.values()) out.push(x);
		return out;
	}

	const projectGroups = $derived.by(() => {
		const map = new Map<string, Group>();
		const group = (p: { id: string; name: string; slug: string }) => {
			if (!map.has(p.id))
				map.set(p.id, { id: p.id, name: p.name, slug: p.slug, deps: [], dbs: [] });
			return map.get(p.id)!;
		};
		for (const d of filtered) if (d.project) group(d.project).deps.push(d);
		for (const db of filteredDbs) if (db.project) group(db.project).dbs.push(db);
		const q = searchQuery.trim().toLowerCase();
		for (const p of projectMetas.values()) {
			if (map.has(p.id)) continue;
			if (q && !p.name.toLowerCase().includes(q) && !p.slug.toLowerCase().includes(q)) continue;
			group(p);
		}
		return ordered([...map.values()], projOrder);
	});

	const PROJECTS_INITIAL = 12;
	const PROJECTS_STEP = 24;
	let visibleCount = $state(PROJECTS_INITIAL);
	$effect(() => {
		searchQuery;
		untrack(() => (visibleCount = PROJECTS_INITIAL));
	});
	const visibleProjectGroups = $derived(projectGroups.slice(0, visibleCount));
	const hiddenProjectCount = $derived(Math.max(0, projectGroups.length - visibleCount));

	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

	function counts(g: Group) {
		const out: string[] = [];
		if (g.deps.length) out.push(plural(g.deps.length, 'app'));
		if (g.dbs.length) out.push(plural(g.dbs.length, 'database'));
		return out.length ? out : ['Nothing deployed yet'];
	}

	function summary(g: Group) {
		const kinds = [
			...g.deps.map((d) => resourceStatus(d.status, d.buildStatus).kind),
			...g.dbs.map((d) => resourceStatus(d.status).kind)
		];
		if (!kinds.length) return undefined;
		const failing = kinds.filter((k) => k === 'error').length;
		const building = kinds.filter((k) => k === 'progress' || k === 'warning').length;
		if (failing) return { tone: 'error' as const, label: `${failing} failing` };
		if (building) return { tone: 'progress' as const, label: `${building} building` };
		return { tone: 'success' as const, label: 'All running' };
	}

	function latest(g: Group) {
		let t = 0;
		for (const x of [...g.deps, ...g.dbs]) t = Math.max(t, new Date(x.updatedAt).getTime());
		return t ? new Date(t).toISOString() : null;
	}

	const isUrl = (v?: string | null) => !!v && /^(https?:)?\/\//.test(v);

	let failedFav = $state<Set<string>>(new Set());

	function depIcon(d: DeploymentSummary) {
		const k = knownIcon(d.image);
		if (k) return k;
		if (failedFav.has(d.id)) return null;
		return d.faviconUrl ?? (d.ingresses[0] ? favUrl(d.ingresses[0].host.split('/')[0]) : null);
	}

	function fmtCpu(milli: number) {
		return milli < 1000 ? `${Math.round(milli)}m` : `${(milli / 1000).toFixed(1)} cores`;
	}

	function fmtMem(bytes: number) {
		const mib = bytes / (1024 * 1024);
		return mib < 1024 ? `${Math.round(mib)} MiB` : `${(mib / 1024).toFixed(1)} GiB`;
	}

	function cpuTraffic(id: string) {
		const values = cpuSeries.get(id);
		if (!values || values.length < 2) return undefined;
		return {
			values,
			label: `${fmtCpu(values[values.length - 1])} CPU`,
			format: (v: number) => `${fmtCpu(v)} CPU`
		};
	}

	function metricsOf(id: string) {
		const m = liveMetrics.get(id);
		return m ? `${fmtCpu(m.cpuMilli)} · ${fmtMem(m.memoryBytes)}` : undefined;
	}

	const failing = $derived<FailingApp[]>(
		deployments
			.filter((d) => resourceStatus(d.status, d.buildStatus).kind === 'error')
			.slice(0, 6)
			.map((d) => ({
				label: d.displayName || d.name,
				href: `/${orgSlug}/deployments/${d.id}`,
				reason: resourceStatus(d.status, d.buildStatus).label,
				kind: 'deployment' as const,
				icon: depIcon(d)
			}))
	);

	const projectIconByName = $derived(
		new Map(
			[...projectMetas.values()].map((p) => [p.name, isUrl(p.icon) ? (p.icon ?? null) : null])
		)
	);
	const projectIcon = (name?: string) => (name ? (projectIconByName.get(name) ?? null) : null);

	const builds = $derived<BuildItem[]>(
		toBuildItems(activeBuilds, recentBuilds, { orgSlug, failedFav, projectIcon })
	);

	const NEW_ITEMS: NewMenuItem[] = [
		{ id: 'deployment', label: 'App', description: 'From a repo or image', icon: Box },
		{ id: 'database', label: 'Database', description: 'Postgres, Redis and more', icon: Database },
		{ id: 'job', label: 'Job', description: 'Runs on a schedule', icon: Timer },
		{ id: 'project', label: 'Project', description: 'A group for related apps', icon: FolderPlus }
	];

	function create(id: string) {
		const to = {
			deployment: `/${orgSlug}/new`,
			database: `/${orgSlug}/new?type=database`,
			job: `/${orgSlug}/jobs/new`,
			project: `/${orgSlug}/projects/new`
		}[id];
		if (to) goto(to);
	}

	function togglePin(d: DeploymentSummary) {
		pinnedItems.toggle({
			id: d.id,
			name: d.displayName || d.name,
			type: 'deployment',
			href: `/${orgSlug}/deployments/${d.id}`
		});
	}

	async function joinOrganization() {
		if (!orgId || joiningOrg) return;
		joiningOrg = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${orgId}/members/join`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: 'owner' })
			});
			if (r.ok) {
				isSyntheticMembership = false;
				toasts.add({ title: 'Joined organization', color: 'success' });
				queryClient.invalidateQueries({ queryKey: ['overview', orgSlug] });
			} else {
				const body = await r.json().catch(() => null);
				toasts.add({ title: body?.message || 'Could not join', color: 'error' });
			}
		} catch {
			toasts.add({ title: 'Could not join the organization', color: 'error' });
		} finally {
			joiningOrg = false;
		}
	}

	async function redeploy(d: DeploymentSummary) {
		try {
			const r = await apiFetch(`/apiv1/deployments/${d.id}/restart`, { method: 'POST' });
			if (r.ok) {
				toasts.add({ title: `Restarting ${d.displayName || d.name}`, color: 'success' });
				queryClient.invalidateQueries({ queryKey: ['overview', orgSlug] });
			} else toasts.add({ title: 'Restart failed', color: 'error' });
		} catch {
			toasts.add({ title: 'Restart failed', color: 'error' });
		}
	}

	function copyUrl(d: DeploymentSummary) {
		if (!d.ingresses.length) return;
		navigator.clipboard.writeText(ingressUrl(d.ingresses[0]));
		toasts.add({ title: 'URL copied', color: 'success' });
	}
</script>

<svelte:head><title>Your Apps</title></svelte:head>

{#snippet side()}
	<div class="side">
		<NeedsAttention items={failing} />
		{#if builds.length}<RecentBuilds {builds} />{/if}
	</div>
{/snippet}

{#snippet deploymentCard(d: DeploymentSummary)}
	{@const status = resourceStatus(d.status, d.buildStatus)}
	{@const host = d.ingresses[0]?.host}
	{#if compact}
		<EntityLine
			kind="deployment"
			name={d.displayName || d.name}
			{status}
			detail={host ?? d.githubBranch}
			metrics={metricsOf(d.id)}
			traffic={cpuTraffic(d.id)}
			updatedAt={d.updatedAt}
			href="/{orgSlug}/deployments/{d.id}"
		/>
	{:else}
		<EntityCard
			kind="deployment"
			name={d.displayName || d.name}
			{status}
			image={depIcon(d)}
			detail={host ?? d.githubBranch}
			metrics={metricsOf(d.id)}
			traffic={cpuTraffic(d.id)}
			updatedAt={d.updatedAt}
			href="/{orgSlug}/deployments/{d.id}"
			quick={[
				...(d.ingresses[0]
					? [{ label: 'Visit', icon: ExternalLink, href: ingressUrl(d.ingresses[0]) }]
					: []),
				{ label: 'Restart', icon: RotateCw, onclick: () => redeploy(d) }
			]}
		>
			{#snippet actions()}
				<Menu>
					{#snippet trigger(props)}
						<Button {...props} size="sm" variant="ghost" icon={Ellipsis} label="Actions" />
					{/snippet}
					<MenuItem href="/{orgSlug}/deployments/{d.id}?tab=deploys">View deploys</MenuItem>
					{#if d.ingresses.length}<MenuItem onclick={() => copyUrl(d)}>Copy URL</MenuItem>{/if}
					<MenuItem onclick={() => togglePin(d)}>
						{pinnedIds.has(d.id) ? 'Unpin from sidebar' : 'Pin to sidebar'}
					</MenuItem>
				</Menu>
			{/snippet}
		</EntityCard>
	{/if}
{/snippet}

{#snippet databaseCard(db: DatabaseSummary)}
	{@const status = resourceStatus(db.status)}
	{#if compact}
		<EntityLine
			kind="database"
			name={db.name}
			{status}
			detail={db.dbName}
			updatedAt={db.updatedAt}
			href="/{orgSlug}/databases/{db.id}"
		/>
	{:else}
		<EntityCard
			kind="database"
			name={db.name}
			{status}
			image={IMG_ICONS.postgres}
			detail={db.mode ? `${db.dbName} · ${db.mode}` : db.dbName}
			updatedAt={db.updatedAt}
			href="/{orgSlug}/databases/{db.id}"
		/>
	{/if}
{/snippet}

<Page title="Your Apps" width="wide" aside={loading || loadError ? undefined : side}>
	{#snippet tools()}
		<SegmentedControl
			label="Project density"
			size="sm"
			iconOnly
			value={compact ? 'compact' : 'normal'}
			onchange={(v) => dashboardDensity.set(v as 'compact' | 'normal')}
			options={[
				{ value: 'normal', label: 'Cards', icon: LayoutGrid },
				{ value: 'compact', label: 'List', icon: List }
			]}
		/>
	{/snippet}
	{#snippet actions()}
		<SearchField placeholder="Search apps" shortcut="/" bind:value={searchQuery} />
		{#if $isSuperAdmin && isSyntheticMembership}
			<Button variant="secondary" loading={joiningOrg} onclick={joinOrganization}>
				Join organization
			</Button>
		{/if}
		{#if canCreateProjects}
			<LiquidNewButton items={NEW_ITEMS} onSelect={create} />
		{/if}
	{/snippet}

	{#if loading}
		<div class="projects">
			{#each [0, 1, 2, 3] as i (i)}<Skeleton height="4.5rem" rounded="1.125rem" />{/each}
		</div>
	{:else if loadError}
		<EmptyState
			title="Your apps did not load"
			description={loadError.status === 403
				? 'You are not a member of this organization.'
				: loadError.message}
		>
			<Button
				variant="secondary"
				onclick={() => queryClient.invalidateQueries({ queryKey: ['overview', orgSlug] })}
			>
				Try again
			</Button>
		</EmptyState>
	{:else if projectGroups.length === 0}
		<EmptyState
			title={searchQuery ? `Nothing matches “${searchQuery}”` : 'Nothing deployed yet'}
			description={searchQuery
				? 'Try a project, app or domain name.'
				: 'Deploy a repo, an image or a database to get started.'}
		>
			{#snippet icon()}<Sprout size={22} />{/snippet}
			{#if !searchQuery && canCreateProjects}
				<Button variant="primary" href="/{orgSlug}/new">Deploy an app</Button>
			{/if}
		</EmptyState>
	{:else}
		<div class="projects" class:projects--compact={compact}>
			{#each visibleProjectGroups as g, i (g.id)}
				{@const meta = projectMetas.get(g.id)}
				<ProjectGroup
					name={g.name}
					href="/{orgSlug}/projects/{g.slug}"
					image={isUrl(meta?.icon) ? meta?.icon : null}
					background={$projectGradientEnabled ? (meta?.backgroundImage ?? null) : null}
					owner={meta?.owner?.username ?? undefined}
					counts={counts(g)}
					updatedAt={latest(g)}
					summary={summary(g)}
					onNew={canCreateProjects
						? () => goto(`/${orgSlug}/new?projectSlug=${g.slug}`)
						: undefined}
					bind:expanded={() => isExpanded(g.id, i), (v) => setExpanded(g.id, v)}
					density={compact ? 'compact' : 'regular'}
					layout={compact ? 'lines' : 'dense'}
				>
					{#each g.deps as d (d.id)}{@render deploymentCard(d)}{/each}
					{#each g.dbs as db (db.id)}{@render databaseCard(db)}{/each}
				</ProjectGroup>
			{/each}
		</div>
		{#if hiddenProjectCount > 0}
			<div class="more">
				<Button variant="ghost" icon={ChevronDown} onclick={() => (visibleCount += PROJECTS_STEP)}>
					Show {Math.min(hiddenProjectCount, PROJECTS_STEP)} more
				</Button>
			</div>
		{/if}
	{/if}
</Page>

<style>
	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.projects {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.projects--compact {
		gap: 0.375rem;
	}
	.more {
		display: flex;
		justify-content: center;
		margin-top: 1rem;
	}
</style>
