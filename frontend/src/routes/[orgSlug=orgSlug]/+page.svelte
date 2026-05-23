<script lang="ts">
	import '$lib/components/org-dashboard/org-dashboard.css';
	import { createQuery } from '@tanstack/svelte-query';
	import { apiFetch, pinnedItems, toasts, subscribeOrgEvents, isSuperAdmin } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { Plus, Star } from 'lucide-svelte';
	import { onDestroy, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { springHover, motionStagger } from '$lib/utils/motion.svelte';
	import type { PageData } from './$types';
	import {
		SkeletonGrid,
		EmptyState,
		SearchBar,
		DeploymentCard,
		DatabaseCard,
		ProjectCard,
		BuildsSidebar
	} from '$lib/components/org-dashboard';
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

	// ── TanStack Query: overview data ──
	const overviewQuery = createQuery(() => ({
		queryKey: ['overview', orgSlug],
		enabled: !!orgSlug,
		queryFn: async () => {
			const res = await apiFetch(`/apiv1/overview/orgs/${orgSlug}`);
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				let message = body;
				try { message = JSON.parse(body)?.message ?? body; } catch {}
				throw Object.assign(new Error(message || `overview ${res.status}`), {
					status: res.status
				});
			}
			return res.json();
		},
	}));

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
	let activeBuilds = $state<ActiveBuild[]>([]);
	let recentBuilds = $state<RecentBuild[]>([]);

	// ── Stable ordering ──
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
					buildsLoading = true;
				}
				return;
			}
			if (qError) {
				const e = qError as any;
				loadError = { status: e?.status ?? 0, message: e?.message ?? String(e) };
				loading = false;
				buildsLoading = false;
				return;
			}
			if (!qData || qData === lastDataRef) return;
			lastDataRef = qData;
			loadError = null;

			syncList(deployments, qData.deployments ?? []);
			syncList(databases, qData.databases ?? []);
			syncMap(projectMetas, qData.projects ?? []);
			syncList(activeBuilds, qData.builds?.active ?? []);
			syncList(recentBuilds, qData.builds?.recent ?? []);

			const newOrgId = qData.organization?.id ?? null;
			if (newOrgId && newOrgId !== orgId) {
				orgId = newOrgId;
				// Fetch role once per org
				apiFetch(`/apiv1/organizations/${newOrgId}/members/me`)
					.then(async (r) => {
						if (!r.ok) return;
						const body = await r.json().catch(() => null);
						if (body?.role) currentOrgRole = body.role;
						if (body?.id?.startsWith('superadmin:')) isSyntheticMembership = true;
						else isSyntheticMembership = false;
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

			loading = false;
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
				depOrder = [];
				dbOrder = [];
				projOrder = [];
				deployments.length = 0;
				databases.length = 0;
				activeBuilds.length = 0;
				recentBuilds.length = 0;
				projectMetas.clear();
			}
			lastSlug = slug;
		});
	});

	// ── SSE subscription ──
	// Subscribes once orgId is known. SSE events invalidate the TanStack query
	// which triggers an automatic refetch — no manual loadOverview() needed.
	let unsub: (() => void) | null = null;
	let sseOrgId: string | null = null;

	$effect(() => {
		const id = orgId;
		const slug = orgSlug;
		untrack(() => {
			if (id === sseOrgId) return;
			sseOrgId = id;
			unsub?.();
			if (!id) return;
			unsub = subscribeOrgEvents(
				id,
				(ev) => {
					if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
					queryClient.invalidateQueries({ queryKey: ['overview', slug] });
				},
				{ invalidateDependencies: [] }
			);
		});
	});

	onDestroy(() => {
		unsub?.();
	});

	// ── Expand state (persisted) ──
	const EXPAND_KEY = 'overview-expanded-projects';
	let expandedProjects = $state<Set<string>>(
		typeof localStorage !== 'undefined'
			? new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) ?? '[]'))
			: new Set()
	);
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
		expandedProjects = next;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(EXPAND_KEY, JSON.stringify([...next]));
		}
	}

	// ── Filtering ──
	let searchQuery = $state('');
	let openMenuId = $state<string | null>(null);
	let renderMenuId = $state<string | null>(null);
	$effect(() => {
		if (openMenuId !== null) renderMenuId = openMenuId;
	});

	const favouriteIds = new SvelteSet<string>();
	$effect(() => {
		const next = new Set(
			$pinnedItems.filter((i) => i.type === 'deployment').map((i) => i.id)
		);
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

	// Pagination
	const PROJECTS_PER_TAB = 10;
	let projectTab = $state(0);
	const totalProjectTabs = $derived(
		Math.max(1, Math.ceil(projectGroups.length / PROJECTS_PER_TAB))
	);
	$effect(() => {
		if (projectTab >= totalProjectTabs) projectTab = Math.max(0, totalProjectTabs - 1);
	});
	$effect(() => {
		searchQuery;
		untrack(() => {
			projectTab = 0;
		});
	});
	const visibleProjectGroups = $derived(
		projectGroups.slice(projectTab * PROJECTS_PER_TAB, (projectTab + 1) * PROJECTS_PER_TAB)
	);

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

	async function joinOrganization() {
		if (!orgId || joiningOrg) return;
		joiningOrg = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${orgId}/members/join`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: 'owner' }),
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
		openMenuId = null;
		try {
			const r = await apiFetch(`/apiv1/deployments/${dep.id}/restart`, { method: 'POST' });
			if (r.ok) {
				toasts.add({ title: `Restarting ${dep.name}...`, color: 'success' });
				queryClient.invalidateQueries({ queryKey: ['overview', orgSlug] });
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
</script>

<svelte:window onclick={closeAll} />

<div class="page">
	<!-- Header -->
	<header class="header" {@attach motionStagger({ index: 0, from: { y: -6 } })}>
		<h1 class="title">Overview</h1>
		<div style="display: flex; gap: 8px; align-items: center;">
			{#if $isSuperAdmin && isSyntheticMembership}
			<button
				class="btn-secondary"
				onclick={joinOrganization}
				disabled={joiningOrg}
				{@attach springHover({ lift: -1, stiffness: 480, damping: 26 })}
			>{joiningOrg ? 'Joining...' : 'Join Organization'}</button>
			{/if}
			{#if canCreateProjects}
			<a
				href="/{orgSlug}/new?autoCreate=1"
				class="btn-primary"
				{@attach springHover({ lift: -1, stiffness: 480, damping: 26 })}
				><Plus size={15} /> Add New...</a
			>
			{/if}
		</div>
	</header>

	<div class="layout">
		<main class="main">
			{#if loading}
				<SkeletonGrid />
			{:else if loadError}
				<EmptyState variant="error" {canCreateProjects} {orgSlug} {loadError} />
			{:else if deployments.length === 0}
				<EmptyState variant="empty" {canCreateProjects} {orgSlug} />
			{:else}
				<SearchBar bind:searchQuery />

				<!-- Favourites -->
				{#if favDeps.length > 0}
					<section class="section">
						<h2 class="label"><Star size={11} /> Favourites</h2>
						<div class="od-grid">
							{#each favDeps as dep, i (dep.id)}
								<div {@attach motionStagger({ index: i, stride: 0.04, from: { y: 10 } })}>
									<DeploymentCard
										{dep}
										isFav={true}
										{orgSlug}
										isFavourite={favouriteIds.has(dep.id)}
										{failedFav}
										{openMenuId}
										{renderMenuId}
										onToggleFav={toggleFav}
										onToggleMenu={toggleMenu}
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
						<section
							class="section"
							{@attach motionStagger({ index: gi, stride: 0.05, from: { y: 14 } })}
						>
							<ProjectCard
								{group}
								meta={projectMetas.get(group.id)}
								{orgSlug}
								expanded={expandedProjects.has(group.id)}
								rendered={renderedProjectBodies.has(group.id)}
								favouriteIds={favouriteIds}
								{failedFav}
								{openMenuId}
								{renderMenuId}
								{projectBodyEls}
								getRenderedProjectBodies={() => renderedProjectBodies}
								setRenderedProjectBodies={(s) => (renderedProjectBodies = s)}
								onToggleExpand={toggleExpand}
								onToggleFav={toggleFav}
								onToggleMenu={toggleMenu}
								onRestart={restart}
								onCopyUrl={cpUrl}
								onVisit={visit}
								onFavErr={favErr}
							/>
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
