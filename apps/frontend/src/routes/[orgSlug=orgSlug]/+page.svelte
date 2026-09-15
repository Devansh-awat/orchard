<script lang="ts">
	import '$lib/components/org-dashboard/org-dashboard.css';
	import { createQuery } from '@tanstack/svelte-query';
	import {
		apiFetch,
		pinnedItems,
		toasts,
		subscribeOrgEvents,
		sseStatusFor,
		isSuperAdmin
	} from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { appUrl } from '$lib/appUrl';
	import { overviewQueryOptions, buildsQueryOptions } from '$lib/queries/overview';
	import { Plus, Star, ChevronDown, Rocket, FolderPlus } from 'lucide-svelte';
	import { onDestroy, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { springHover, motionStagger, springRotate } from '$lib/utils/motion.svelte';
	import type { PageData } from './$types';
	import {
		SkeletonGrid,
		EmptyState,
		SearchBar,
		DeploymentCard,
		DatabaseCard,
		ProjectCard,
		BuildsSidebar,
		CompactList
	} from '$lib/components/org-dashboard';
	import { dashboardDensity, type DashboardDensity } from '$lib/stores';
	import { Menu, MenuItem } from '$lib/components/ui';
	import { Rows3, Rows4 } from 'lucide-svelte';
	import type {
		DeploymentSummary,
		DatabaseSummary,
		ActiveBuild,
		RecentBuild,
		ProjectMeta,
		ProjectGroup
	} from '$lib/components/org-dashboard';

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

			syncList(deployments, qData.deployments ?? []);
			syncList(databases, qData.databases ?? []);
			syncMap(projectMetas, qData.projects ?? []);

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
			syncList(activeBuilds, qData.active ?? []);
			syncList(recentBuilds, qData.recent ?? []);
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
						liveMetrics.set(ev.id, {
							cpuMilli: ev.payload.totalCpuUsage ?? 0,
							memoryBytes: ev.payload.totalMemoryUsage ?? 0
						});
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

	// ── Expand state (persisted, scoped per density) ──
	const expandKeyFor = (d: DashboardDensity) => `overview-expanded-projects:${d}`;
	const readExpanded = (d: DashboardDensity): Set<string> => {
		if (typeof localStorage === 'undefined') return new Set();
		try {
			return new Set(JSON.parse(localStorage.getItem(expandKeyFor(d)) ?? '[]'));
		} catch {
			return new Set();
		}
	};
	let expandedProjects = $state<Set<string>>(readExpanded($dashboardDensity));
	const projectBodyEls = new Map<string, HTMLElement>();
	let renderedProjectBodies = $state<Set<string>>(new Set());
	$effect(() => {
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
		persistExpanded(next);
	}

	const DENSITY_OPTIONS: { value: DashboardDensity; icon: typeof Rows3; label: string }[] = [
		{ value: 'compact', icon: Rows4, label: 'Compact' },
		{ value: 'normal', icon: Rows3, label: 'Normal' }
	];

	function persistExpanded(next: Set<string>) {
		expandedProjects = next;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(expandKeyFor($dashboardDensity), JSON.stringify([...next]));
		}
	}

	function setDensity(value: DashboardDensity) {
		if (value === $dashboardDensity) return;
		dashboardDensity.set(value);
		expandedProjects = readExpanded(value);
	}

	let newOpen = $state(false);

	// ── Filtering ──
	let searchQuery = $state('');
	const favouriteIds = new SvelteSet<string>();
	$effect(() => {
		const next = new Set($pinnedItems.filter((i) => i.type === 'deployment').map((i) => i.id));
		for (const id of favouriteIds) if (!next.has(id)) favouriteIds.delete(id);
		for (const id of next) if (!favouriteIds.has(id)) favouriteIds.add(id);
	});

	let filtered = $derived.by(() => {
		let r = deployments;
		const q = searchQuery.trim().toLowerCase();
		if (q)
			r = r.filter(
				(d) =>
					d.name.toLowerCase().includes(q) ||
					(d.displayName?.toLowerCase().includes(q) ?? false) ||
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
		const q = searchQuery.trim().toLowerCase();
		for (const p of projectMetas.values()) {
			if (map.has(p.id)) continue;
			if (q && !p.name.toLowerCase().includes(q) && !p.slug.toLowerCase().includes(q)) continue;
			map.set(p.id, { id: p.id, name: p.name, slug: p.slug, deps: [], dbs: [] });
		}
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

	const PROJECTS_INITIAL = 12;
	const PROJECTS_STEP = 24;
	let visibleCount = $state(PROJECTS_INITIAL);
	$effect(() => {
		searchQuery;
		untrack(() => {
			visibleCount = PROJECTS_INITIAL;
		});
	});
	const visibleProjectGroups = $derived(projectGroups.slice(0, visibleCount));
	const hiddenProjectCount = $derived(Math.max(0, projectGroups.length - visibleCount));

	// ── Actions ──
	let failedFav = $state<Set<string>>(new Set());
	function favErr(id: string) {
		failedFav = new Set(failedFav).add(id);
	}

	function toggleFav(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		pinnedItems.toggle({
			id: dep.id,
			name: dep.displayName || dep.name,
			type: 'deployment',
			href: `/${orgSlug}/deployments/${dep.id}`
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
				toasts.add({ title: body?.message || 'Failed to join', color: 'error' });
			}
		} catch {
			toasts.add({ title: 'Failed to join organization', color: 'error' });
		} finally {
			joiningOrg = false;
		}
	}
	async function restart(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		try {
			const r = await apiFetch(`/apiv1/deployments/${dep.id}/restart`, { method: 'POST' });
			if (r.ok) {
				toasts.add({ title: `Restarting ${dep.displayName || dep.name}...`, color: 'success' });
				queryClient.invalidateQueries({ queryKey: ['overview', orgSlug] });
			} else toasts.add({ title: 'Restart failed', color: 'error' });
		} catch {
			toasts.add({ title: 'Restart failed', color: 'error' });
		}
	}
	function cpUrl(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		if (dep.ingresses.length) {
			navigator.clipboard.writeText(appUrl(dep.ingresses[0].host));
			toasts.add({ title: 'Copied', color: 'success' });
		}
	}
	function visit(dep: DeploymentSummary, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		if (dep.ingresses.length)
			window.open(appUrl(dep.ingresses[0].host), '_blank');
	}
</script>

<div class="page">
	<!-- Header -->
	<header class="header" {@attach motionStagger({ index: 0, from: { y: -6 } })}>
		<h1 class="title">Your Apps</h1>
		<div class="header-actions">
			{#if $isSuperAdmin && isSyntheticMembership}
				<button
					class="btn-secondary"
					onclick={joinOrganization}
					disabled={joiningOrg}
					{@attach springHover({ lift: -1 })}
					>{joiningOrg ? 'Joining...' : 'Join Organization'}</button
				>
			{/if}
			{#if canCreateProjects}
				<Menu placement="bottom-end" bind:open={newOpen}>
					{#snippet trigger(attrs, open)}
						<button
							type="button"
							class="btn-primary"
							aria-haspopup="menu"
							aria-expanded={open}
							{...attrs}
						>
							<Plus size={15} />
							New
							<span
								class="btn-primary-caret"
								{@attach springRotate(() => open, { rest: 0, on: 180 })}
							>
								<ChevronDown size={13} />
							</span>
						</button>
					{/snippet}
					<MenuItem href="/{orgSlug}/new">
						<Rocket size={14} />
						<span class="new-menu-text">
							App
							<span class="new-menu-desc">Deploy a repo, image, or database</span>
						</span>
					</MenuItem>
					<MenuItem href="/{orgSlug}/projects/new">
						<FolderPlus size={14} />
						<span class="new-menu-text">
							Project
							<span class="new-menu-desc">A group to hold related apps</span>
						</span>
					</MenuItem>
				</Menu>
			{/if}
		</div>
	</header>

	<div class="layout">
		<main class="main">
			{#if loading}
				<SkeletonGrid />
			{:else if loadError}
				<EmptyState variant="error" {canCreateProjects} {orgSlug} {loadError} />
			{:else if deployments.length === 0 && databases.length === 0 && projectMetas.size === 0}
				<EmptyState variant="empty" {canCreateProjects} {orgSlug} />
			{:else}
				<div class="list-toolbar">
					<div class="list-toolbar-search"><SearchBar bind:searchQuery /></div>
					<div class="density-seg" role="radiogroup" aria-label="List density">
						{#each DENSITY_OPTIONS as opt (opt.value)}
							{@const Icon = opt.icon}
							<button
								type="button"
								role="radio"
								aria-checked={$dashboardDensity === opt.value}
								class="density-btn"
								class:density-btn--active={$dashboardDensity === opt.value}
								title={opt.label}
								aria-label={opt.label}
								onclick={() => setDensity(opt.value)}
							>
								<Icon size={14} />
							</button>
						{/each}
					</div>
				</div>

				{#if $dashboardDensity === 'compact'}
					<CompactList
						groups={projectGroups}
						metas={projectMetas}
						{favDeps}
						{orgSlug}
						{liveMetrics}
						{failedFav}
						{expandedProjects}
						onToggleExpand={toggleExpand}
						onFavErr={favErr}
					/>
					{#if projectGroups.length === 0 && favDeps.length === 0}
						<p class="no-results">
							{searchQuery ? `No results for "${searchQuery}"` : 'Nothing here yet'}
						</p>
					{/if}
				{:else}
					<!-- Favourites -->
					{#if favDeps.length > 0}
						<section class="section">
							<h2 class="label"><Star size={11} /> Favourites</h2>
							<div class="od-grid">
								{#each favDeps as dep, i (dep.id)}
									<div {@attach motionStagger({ index: i, from: { y: 10 } })}>
										<DeploymentCard
											{dep}
											isFav={true}
											{orgSlug}
											isFavourite={favouriteIds.has(dep.id)}
											{failedFav}
											{liveMetrics}
											onToggleFav={toggleFav}
											onRestart={restart}
											onCopyUrl={cpUrl}
											onVisit={visit}
											onFavErr={favErr}
										/>
									</div>
								{/each}
							</div>
						</section>
					{/if}

					<!-- Project Groups -->
					{#if projectGroups.length > 0}
						{#each visibleProjectGroups as group, gi (group.id)}
							<section class="section" {@attach motionStagger({ index: gi, from: { y: 14 } })}>
								<ProjectCard
									{group}
									meta={projectMetas.get(group.id)}
									{orgSlug}
									expanded={expandedProjects.has(group.id)}
									rendered={renderedProjectBodies.has(group.id)}
									{favouriteIds}
									{failedFav}
									{liveMetrics}
									{projectBodyEls}
									getRenderedProjectBodies={() => renderedProjectBodies}
									setRenderedProjectBodies={(s) => (renderedProjectBodies = s)}
									onToggleExpand={toggleExpand}
									onToggleFav={toggleFav}
									onRestart={restart}
									onCopyUrl={cpUrl}
									onVisit={visit}
									onFavErr={favErr}
								/>
							</section>
						{/each}
						{#if hiddenProjectCount > 0}
							<button
								type="button"
								class="show-more"
								onclick={() => (visibleCount += PROJECTS_STEP)}
							>
								<ChevronDown size={14} />
								Show {Math.min(hiddenProjectCount, PROJECTS_STEP)} more
								{hiddenProjectCount === 1 ? 'project' : 'projects'}
								<span class="show-more-count"
									>{visibleProjectGroups.length} of {projectGroups.length}</span
								>
							</button>
						{/if}
					{/if}
					{#if projectGroups.length === 0 && favDeps.length === 0}
						<p class="no-results">
							{searchQuery ? `No results for "${searchQuery}"` : 'Nothing here yet'}
						</p>
					{/if}
				{/if}
			{/if}
		</main>

		<BuildsSidebar
			{activeBuilds}
			{recentBuilds}
			{buildsLoading}
			{orgSlug}
			{failedFav}
			onFavErr={favErr}
		/>
	</div>
</div>
