<script lang="ts">
	import { page } from '$app/stores';
	import { apiFetch, selectedOrganization, pinnedItems, toasts } from '$lib/stores';
	import {
		Plus, Search, Sparkles, GitBranch, Star, MoreVertical, ExternalLink,
		RefreshCw, Pin, PinOff, Copy, ChevronDown, Loader2, CheckCircle2,
		XCircle, Clock, Timer
	} from 'lucide-svelte';
	import { onDestroy } from 'svelte';

	const orgSlug = $derived($page.params.orgSlug);
	let loading = $state(true);

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

	async function fetchDeployments() {
		loading = true;
		try {
			const orgId = $selectedOrganization?.id;
			const url = orgId ? `/apiv1/deployments?orgId=${orgId}` : '/apiv1/deployments';
			const res = await apiFetch(url);
			if (res.ok) deployments = await res.json();
		} catch (e) { console.error('Failed to fetch deployments:', e); }
		finally { loading = false; }
	}

	// ── Builds ──
	interface ActiveBuild {
		id: string; name: string; image?: string; status: string; buildStatus: string;
		buildStep: string | null; updatedAt: string; githubRepo?: string; githubBranch?: string;
		ingresses: Array<{ host: string }>; project?: { name: string };
	}
	interface RecentBuild {
		id: string; commitSha: string | null; branch: string | null; triggerType: string | null;
		isActive: boolean; createdAt: string;
		deployment: { id: string; name: string; image?: string; buildStatus: string; ingresses: Array<{ host: string }>; project?: { name: string } };
	}

	let activeBuilds = $state<ActiveBuild[]>([]);
	let recentBuilds = $state<RecentBuild[]>([]);
	let buildsLoading = $state(true);
	let now = $state(Date.now());
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	function startTimer() { if (!timerInterval) timerInterval = setInterval(() => { now = Date.now(); }, 1000); }
	function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
	$effect(() => { if (activeBuilds.length > 0) startTimer(); else stopTimer(); });
	onDestroy(() => stopTimer());

	async function fetchBuilds() {
		buildsLoading = true;
		try {
			const orgId = $selectedOrganization?.id;
			const url = orgId ? `/apiv1/deployments/recent-builds?orgId=${orgId}` : '/apiv1/deployments/recent-builds';
			const res = await apiFetch(url);
			if (res.ok) { const d = await res.json(); activeBuilds = d.active ?? []; recentBuilds = d.recent ?? []; }
		} catch (e) { console.error('Failed to fetch builds:', e); }
		finally { buildsLoading = false; }
	}

	function fmtDuration(s: number): string { if (s < 60) return `${s}s`; const m = Math.floor(s / 60); return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`; }
	function elapsed(d: string): number { return Math.max(0, Math.floor((now - new Date(d).getTime()) / 1000)); }

	// ── Filtering ──
	let searchQuery = $state('');
	let openMenuId = $state<string | null>(null);

	let favouriteIds = $state<Set<string>>(new Set());
	pinnedItems.subscribe(items => { favouriteIds = new Set(items.filter(i => i.type === 'deployment').map(i => i.id)); });

	// Filtered deployments
	let filtered = $derived.by(() => {
		let r = deployments;
		const q = searchQuery.trim().toLowerCase();
		if (q) r = r.filter(d =>
			d.name.toLowerCase().includes(q) || (d.project?.name?.toLowerCase().includes(q) ?? false) ||
			(d.githubRepo?.toLowerCase().includes(q) ?? false) || d.ingresses.some(i => i.host.toLowerCase().includes(q))
		);
		return [...r].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	});

	let favDeps = $derived(filtered.filter(d => favouriteIds.has(d.id)));

	// Group non-fav deployments by project, preserving project order by most recent deployment
	interface ProjectGroup {
		id: string;
		name: string;
		slug: string;
		deps: DeploymentSummary[];
	}

	let projectGroups = $derived.by(() => {
		const nonFav = filtered.filter(d => !favouriteIds.has(d.id));
		const map = new Map<string, ProjectGroup>();
		for (const d of nonFav) {
			const p = d.project;
			if (!p) continue;
			if (!map.has(p.id)) {
				map.set(p.id, { id: p.id, name: p.name, slug: p.slug, deps: [] });
			}
			map.get(p.id)!.deps.push(d);
		}
		// Sort groups by most recent deployment
		return Array.from(map.values()).sort((a, b) => {
			const aT = Math.max(...a.deps.map(d => new Date(d.updatedAt).getTime()));
			const bT = Math.max(...b.deps.map(d => new Date(d.updatedAt).getTime()));
			return bT - aT;
		});
	});

	// ── Helpers ──
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
		const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
		const dy = Math.floor(h / 24); if (dy < 30) return `${dy}d ago`;
		return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	const IMG_ICONS: Record<string, string> = {
		postgres: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/postgresql/postgresql-original.svg',
		postgresql: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/postgresql/postgresql-original.svg',
		mysql: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/mysql/mysql-original.svg',
		redis: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/redis/redis-original.svg',
		mongo: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/mongodb/mongodb-original.svg',
		mongodb: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/mongodb/mongodb-original.svg',
		nginx: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nginx/nginx-original.svg',
		node: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nodejs/nodejs-original.svg',
		python: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/python/python-original.svg',
		go: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/go/go-original.svg',
		rust: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/rust/rust-original.svg',
		grafana: 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/grafana/grafana-original.svg',
	};
	function knownIcon(img?: string): string | null {
		if (!img) return null;
		const n = img.replace(/^[^/]+\.[^/]+\//, '').split(':')[0].split('/').pop()?.toLowerCase() ?? '';
		if (IMG_ICONS[n]) return IMG_ICONS[n];
		for (const [k, v] of Object.entries(IMG_ICONS)) { if (n.startsWith(k) || n.includes(k)) return v; }
		return null;
	}

	let failedFav = $state<Set<string>>(new Set());
	function favUrl(host: string) { return `/apiv1/deployments/favicon?domain=${encodeURIComponent(host)}`; }
	function favErr(id: string) { failedFav = new Set(failedFav).add(id); }

	function toggleFav(dep: DeploymentSummary, e: Event) {
		e.preventDefault(); e.stopPropagation();
		pinnedItems.toggle({ id: dep.id, name: dep.name, type: 'deployment', href: `/${orgSlug}/deployments/${dep.id}` });
	}
	function toggleMenu(id: string, e: Event) { e.preventDefault(); e.stopPropagation(); openMenuId = openMenuId === id ? null : id; }
	function closeAll() { openMenuId = null; }
	async function restart(dep: DeploymentSummary, e: Event) {
		e.preventDefault(); e.stopPropagation(); openMenuId = null;
		try { const r = await apiFetch(`/apiv1/deployments/${dep.id}/restart`, { method: 'POST' }); if (r.ok) { toasts.add({ title: `Restarting ${dep.name}...`, color: 'success' }); fetchDeployments(); } else toasts.add({ title: 'Restart failed', color: 'error' }); }
		catch { toasts.add({ title: 'Restart failed', color: 'error' }); }
	}
	function cpUrl(dep: DeploymentSummary, e: Event) { e.preventDefault(); e.stopPropagation(); openMenuId = null; if (dep.ingresses.length) { navigator.clipboard.writeText(`https://${dep.ingresses[0].host.split('/')[0]}`); toasts.add({ title: 'Copied', color: 'success' }); } }
	function visit(dep: DeploymentSummary, e: Event) { e.preventDefault(); e.stopPropagation(); openMenuId = null; if (dep.ingresses.length) window.open(`https://${dep.ingresses[0].host.split('/')[0]}`, '_blank'); }

	function buildIcon(img?: string, ings?: Array<{host:string}>, id?: string) {
		const k = knownIcon(img); if (k) return k;
		if (ings?.length && !failedFav.has('b-'+(id??''))) return favUrl(ings[0].host.split('/')[0]);
		return null;
	}

	$effect(() => { if ($selectedOrganization?.id) { fetchDeployments(); fetchBuilds(); } });
</script>

<svelte:window onclick={closeAll} />

<div class="page">
	<!-- Header -->
	<header class="header">
		<h1 class="title">Overview</h1>
		<a href="/{orgSlug}/new" class="btn-primary"><Plus size={15} /> Add New...</a>
	</header>

	<div class="layout">
	<main class="main">

	{#if loading}
		<div class="grid">
			{#each Array(6) as _}
				<div class="card card--skel">
					<div class="card-top"><div class="sk sk-icon"></div><div class="sk-col"><div class="sk" style="width:7rem;height:0.7rem"></div><div class="sk" style="width:10rem;height:0.5rem"></div></div></div>
					<div class="card-bot"><div class="sk" style="width:4rem;height:0.5rem"></div><div class="sk" style="width:3rem;height:0.5rem"></div></div>
				</div>
			{/each}
		</div>
	{:else if deployments.length === 0}
		<div class="empty">
			<div class="empty-icon"><Sparkles size={28} /></div>
			<h3 class="empty-h">Deploy your first app</h3>
			<p class="empty-p">Import a GitHub repo or deploy a Docker image.</p>
			<a href="/{orgSlug}/new" class="btn-primary" style="margin-top:0.5rem"><Plus size={15} /> New Deployment</a>
		</div>
	{:else}
		<!-- Toolbar -->
		<div class="bar">
			<div class="search-box">
				<Search size={13} class="search-ic" />
				<input type="search" placeholder="Search deployments..." class="search" bind:value={searchQuery} />
			</div>
			<a href="/{orgSlug}/new" class="btn-new-project"><Plus size={13} /> New Project</a>
		</div>

		<!-- Favourites -->
		{#if favDeps.length > 0}
			<section class="section">
				<h2 class="label"><Star size={11} /> Favourites</h2>
				<div class="grid">
					{#each favDeps as dep (dep.id)}
						{@render card(dep, true)}
					{/each}
				</div>
			</section>
		{/if}

		<!-- Projects -->
		{#if projectGroups.length > 0}
			{#each projectGroups as group (group.id)}
				<section class="section">
					<a href="/{orgSlug}/projects/{group.slug}" class="group-head">
						<span class="group-name">{group.name}</span>
						<span class="group-count">{group.deps.length} {group.deps.length === 1 ? 'deployment' : 'deployments'}</span>
					</a>
					<div class="grid">
						{#each group.deps as dep (dep.id)}
							{@render card(dep, false)}
						{/each}
					</div>
				</section>
			{/each}
		{/if}

		{#if filtered.length === 0}
			<p class="no-results">{searchQuery ? `No results for "${searchQuery}"` : 'No deployments here'}</p>
		{/if}
	{/if}
	</main>

	<!-- Builds sidebar -->
	<aside class="aside">
		<h2 class="label aside-label">Recent Builds</h2>
		{#if buildsLoading}
			{#each Array(3) as _}
				<div class="bld bld--skel"><div class="sk" style="width:1.5rem;height:1.5rem;border-radius:0.375rem"></div><div class="sk-col" style="flex:1"><div class="sk" style="width:5rem;height:0.6rem"></div><div class="sk" style="width:7rem;height:0.45rem"></div></div></div>
			{/each}
		{:else if activeBuilds.length === 0 && recentBuilds.length === 0}
			<p class="aside-empty">No recent builds</p>
		{:else}
			{#each activeBuilds as b (b.id)}
				{@const ic = buildIcon(b.image, b.ingresses, b.id)}
				<a href="/{orgSlug}/deployments/{b.id}" class="bld bld--live">
					<div class="bld-dot bld-dot--building"><Loader2 size={13} class="spin" /></div>
					<div class="bld-info">
						<span class="bld-row">{#if ic}<img src={ic} alt="" class="bld-ic" onerror={() => favErr('b-'+b.id)} />{/if}<span class="bld-name">{b.name}</span></span>
						<span class="bld-sub">{#if b.project?.name}<strong>{b.project.name}</strong> · {/if}{b.buildStep ?? 'Building'}</span>
					</div>
					<span class="bld-time bld-time--live"><Timer size={10} /> {fmtDuration(elapsed(b.updatedAt))}</span>
				</a>
			{/each}
			{#each recentBuilds as b (b.id)}
				{@const ok = b.deployment.buildStatus !== 'failed'}
				{@const ic = buildIcon(b.deployment.image, b.deployment.ingresses, b.deployment.id)}
				<a href="/{orgSlug}/deployments/{b.deployment.id}" class="bld">
					<div class="bld-dot" class:bld-dot--ok={ok} class:bld-dot--fail={!ok}>{#if ok}<CheckCircle2 size={13} />{:else}<XCircle size={13} />{/if}</div>
					<div class="bld-info">
						<span class="bld-row">{#if ic}<img src={ic} alt="" class="bld-ic" onerror={() => favErr('b-'+b.deployment.id)} />{/if}<span class="bld-name">{b.deployment.name}</span></span>
						<span class="bld-sub">{#if b.deployment.project?.name}<strong>{b.deployment.project.name}</strong>{/if}{#if b.commitSha}{#if b.deployment.project?.name} · {/if}{b.commitSha.slice(0,7)}{/if}{#if b.branch}{#if b.deployment.project?.name || b.commitSha} · {/if}{b.branch}{/if}</span>
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
	<a href="/{orgSlug}/deployments/{dep.id}" class="card" class:card--fav={isFav}>
		<div class="card-top">
			{#if icon}
				<img src={icon} alt="" class="card-ic" />
			{:else if dep.ingresses.length > 0 && !failedFav.has(dep.id)}
				<img src={favUrl(dep.ingresses[0].host.split('/')[0])} alt="" class="card-ic" onerror={() => favErr(dep.id)} />
			{:else}
				<div class="card-av">{dep.name.charAt(0).toUpperCase()}</div>
			{/if}
			<div class="card-text">
				<span class="card-name">{dep.name}</span>
				{#if dep.ingresses.length > 0}
					<span class="card-sub">{dep.ingresses[0].host.split('/')[0]}</span>
				{:else if dep.githubRepo}
					<span class="card-sub">{dep.githubRepo}</span>
				{/if}
			</div>
			<div class="card-acts">
				<button class="abtn fav" class:fav--on={favouriteIds.has(dep.id)} onclick={(e) => toggleFav(dep, e)} aria-label="Favourite"><Star size={13} /></button>
				<div class="menu-wrap">
					<button class="abtn" onclick={(e) => toggleMenu(dep.id, e)} aria-label="More"><MoreVertical size={13} /></button>
					{#if openMenuId === dep.id}
						<div class="menu">
							{#if dep.ingresses.length > 0}
								<button class="menu-item" onclick={(e) => visit(dep, e)}><ExternalLink size={14} /> Visit</button>
								<button class="menu-item" onclick={(e) => cpUrl(dep, e)}><Copy size={14} /> Copy URL</button>
							{/if}
							<button class="menu-item" onclick={(e) => restart(dep, e)}><RefreshCw size={14} /> Restart</button>
							<button class="menu-item" onclick={(e) => toggleFav(dep, e)}>{#if favouriteIds.has(dep.id)}<PinOff size={14} /> Unfavourite{:else}<Pin size={14} /> Favourite{/if}</button>
						</div>
					{/if}
				</div>
			</div>
		</div>
		{#if dep.githubRepo}
			<span class="card-repo"><GitBranch size={11} /> {dep.githubRepo}{#if dep.githubBranch} / {dep.githubBranch}{/if}</span>
		{/if}
		<div class="card-bot">
			<span class="card-status"><span class="dot {dotClass(dep.status, dep.buildStatus)}"></span> {statusText(dep.status, dep.buildStatus)}</span>
			<span class="card-meta">{timeAgo(dep.updatedAt)}</span>
		</div>
	</a>
{/snippet}

<style>
	.page { max-width: 80rem; margin: 0 auto; padding: 2.5rem 2.5rem 4rem; }

	/* Header */
	.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.75rem; }
	.title { font-size: 1.5rem; font-weight: 700; color: var(--center-channel-color); margin: 0; letter-spacing: -0.02em; }
	.btn-primary {
		display: inline-flex; align-items: center; gap: 0.375rem;
		padding: 0.5rem 1rem; border-radius: 0.5rem; font-size: 0.8125rem; font-weight: 600;
		background: var(--center-channel-color); color: var(--center-channel-bg);
		text-decoration: none; border: none; cursor: pointer; transition: opacity 0.15s;
	}
	.btn-primary:hover { opacity: 0.85; }

	/* Layout */
	.layout { display: flex; gap: 2rem; align-items: flex-start; }
	.main { flex: 1; min-width: 0; }

	/* Toolbar */
	.bar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.5rem; }

	.btn-new-project {
		display: inline-flex; align-items: center; gap: 0.25rem;
		padding: 0.4375rem 0.75rem; border-radius: 0.5rem; font-size: 0.75rem; font-weight: 500;
		border: 1px dashed color-mix(in srgb, var(--surface-border) 80%, transparent);
		background: none; color: var(--surface-muted);
		text-decoration: none; cursor: pointer; transition: all 0.12s; white-space: nowrap;
	}
	.btn-new-project:hover { border-color: var(--sidebar-text-active-border); color: var(--sidebar-text-active-border); }

	.search-box { position: relative; flex: 1; max-width: 18rem; }
	:global(.search-ic) { position: absolute; left: 0.625rem; top: 50%; transform: translateY(-50%); color: var(--surface-muted); pointer-events: none; }
	.search {
		width: 100%; padding: 0.4375rem 0.75rem 0.4375rem 2rem;
		border-radius: 0.5rem; border: 1px solid transparent;
		background: color-mix(in srgb, var(--surface-border) 30%, var(--center-channel-bg));
		color: var(--center-channel-color); font-size: 0.8125rem; transition: all 0.15s;
	}
	.search::placeholder { color: var(--surface-muted); }
	.search:focus { outline: none; border-color: var(--surface-muted); background: var(--center-channel-bg); }

	/* Section labels */
	.section { margin-bottom: 1.75rem; }
	.label {
		font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--surface-muted); margin: 0 0 0.75rem; display: flex; align-items: center; gap: 0.3rem;
	}

	/* Project group header */
	.group-head {
		display: flex; align-items: baseline; gap: 0.375rem;
		margin-bottom: 0.625rem; text-decoration: none; color: var(--center-channel-color); transition: opacity 0.12s;
	}
	.group-head:hover { opacity: 0.7; }
	.group-name { font-size: 0.8125rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 20rem; }
	.group-ws { font-size: 0.6875rem; font-weight: 400; color: var(--surface-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 10rem; }
	.group-count {
		font-size: 0.5625rem; font-weight: 600; color: var(--surface-muted);
		background: color-mix(in srgb, var(--surface-border) 50%, transparent);
		padding: 0.0625rem 0.3125rem; border-radius: 9999px; flex-shrink: 0;
	}

	/* Card grid */
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(16.5rem, 1fr)); gap: 0.75rem; }

	/* Card */
	.card {
		display: flex; flex-direction: column; gap: 0.375rem;
		padding: 0.875rem; border-radius: 0.625rem; background: var(--center-channel-bg);
		text-decoration: none; color: var(--center-channel-color);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--surface-border) 50%, transparent), 0 1px 3px rgba(0,0,0,0.04);
		transition: box-shadow 0.15s; cursor: pointer;
	}
	.card:hover { box-shadow: 0 0 0 1px color-mix(in srgb, var(--surface-border) 75%, transparent), 0 4px 12px rgba(0,0,0,0.07); }
	.card--fav { box-shadow: 0 0 0 1px color-mix(in srgb, var(--sidebar-text-active-border) 20%, var(--surface-border)), 0 1px 3px rgba(0,0,0,0.04); }
	.card--skel { pointer-events: none; }

	.card-top { display: flex; align-items: center; gap: 0.5rem; }
	.card-ic { width: 2rem; height: 2rem; border-radius: 0.375rem; flex-shrink: 0; object-fit: contain; }
	.card-av {
		width: 2rem; height: 2rem; border-radius: 0.375rem; flex-shrink: 0;
		display: flex; align-items: center; justify-content: center;
		background: linear-gradient(135deg, color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent), color-mix(in srgb, var(--sidebar-text-active-border) 5%, transparent));
		color: var(--sidebar-text-active-border); font-size: 0.8125rem; font-weight: 700;
	}
	.card-text { flex: 1; min-width: 0; }
	.card-name { display: block; font-size: 0.8125rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.card-sub { display: block; font-size: 0.6875rem; color: var(--surface-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.card-repo { display: block; font-size: 0.6875rem; color: var(--surface-muted); font-family: var(--font-mono, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.card-bot { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-top: 0.125rem; }
	.card-status { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.6875rem; color: var(--surface-muted); font-weight: 500; }
	.card-meta { font-size: 0.6875rem; color: var(--surface-muted); white-space: nowrap; }

	/* Hover actions */
	.card-acts { display: flex; align-items: center; gap: 0.0625rem; flex-shrink: 0; opacity: 0; transition: opacity 0.1s; }
	.card:hover .card-acts { opacity: 1; }
	.fav--on { opacity: 1 !important; }
	.abtn {
		display: flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem;
		border-radius: 0.25rem; border: none; background: none; color: var(--surface-muted); cursor: pointer; transition: all 0.1s;
	}
	.abtn:hover { background: color-mix(in srgb, var(--surface-border) 50%, transparent); color: var(--center-channel-color); }
	.fav--on { color: #eab308; }
	.fav--on:hover { color: #ca8a04; }

	/* Menus */
	.menu-wrap { position: relative; }
	.menu {
		position: absolute; top: calc(100% + 0.25rem); right: 0; z-index: 50;
		min-width: 10rem; padding: 0.25rem; border-radius: 0.5rem; background: var(--center-channel-bg);
		box-shadow: 0 6px 20px rgba(0,0,0,0.12), 0 0 0 1px color-mix(in srgb, var(--surface-border) 45%, transparent);
	}
	.menu--left { left: 0; right: auto; max-height: 20rem; overflow-y: auto; min-width: 11rem; }
	.menu-item {
		display: flex; align-items: center; gap: 0.5rem; width: 100%;
		padding: 0.4375rem 0.5rem; border: none; border-radius: 0.3rem; background: none;
		color: var(--center-channel-color); font-size: 0.8125rem; cursor: pointer; text-align: left; transition: background 0.1s;
	}
	.menu-item:hover { background: color-mix(in srgb, var(--surface-border) 30%, transparent); }
	.menu-item--on { font-weight: 600; color: var(--sidebar-text-active-border); }

	/* Dots */
	.dot { width: 0.375rem; height: 0.375rem; border-radius: 50%; flex-shrink: 0; display: inline-block; }
	.dot--green { background: #22c55e; box-shadow: 0 0 5px color-mix(in srgb, #22c55e 35%, transparent); }
	.dot--amber { background: #f59e0b; box-shadow: 0 0 5px color-mix(in srgb, #f59e0b 35%, transparent); }
	.dot--red { background: #ef4444; box-shadow: 0 0 5px color-mix(in srgb, #ef4444 35%, transparent); }
	.dot--gray { background: var(--surface-muted); opacity: 0.35; }

	/* Empty */
	.empty { display: flex; flex-direction: column; align-items: center; gap: 0.75rem; padding: 5rem 2rem; text-align: center; }
	.empty-icon { width: 3.5rem; height: 3.5rem; border-radius: 1rem; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--sidebar-text-active-border) 8%, transparent); color: var(--sidebar-text-active-border); }
	.empty-h { font-size: 1.125rem; font-weight: 600; color: var(--center-channel-color); margin: 0; }
	.empty-p { font-size: 0.8125rem; color: var(--surface-muted); max-width: 20rem; margin: 0; line-height: 1.5; }
	.no-results { text-align: center; padding: 3rem; color: var(--surface-muted); font-size: 0.8125rem; }

	/* Builds sidebar */
	.aside {
		flex: 0 0 17.5rem; position: sticky; top: 1.5rem; border-radius: 0.625rem;
		background: var(--center-channel-bg);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--surface-border) 50%, transparent), 0 1px 3px rgba(0,0,0,0.04);
		overflow: hidden;
	}
	.aside-label { padding: 0.875rem 0.875rem 0; margin-bottom: 0.375rem; }
	.aside-empty { padding: 2rem 1rem; text-align: center; color: var(--surface-muted); font-size: 0.75rem; margin: 0; }

	.bld {
		display: flex; align-items: flex-start; gap: 0.5rem;
		padding: 0.625rem 0.875rem; text-decoration: none; color: var(--center-channel-color); transition: background 0.1s; cursor: pointer;
	}
	.bld + .bld { box-shadow: inset 0 1px 0 color-mix(in srgb, var(--surface-border) 25%, transparent); }
	.bld:hover { background: color-mix(in srgb, var(--surface-border) 12%, transparent); }
	.bld--live { background: color-mix(in srgb, #f59e0b 3%, transparent); }
	.bld--skel { pointer-events: none; }

	.bld-dot { display: flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border-radius: 0.375rem; flex-shrink: 0; }
	.bld-dot--building { color: #f59e0b; background: color-mix(in srgb, #f59e0b 10%, transparent); }
	.bld-dot--ok { color: #22c55e; background: color-mix(in srgb, #22c55e 10%, transparent); }
	.bld-dot--fail { color: #ef4444; background: color-mix(in srgb, #ef4444 10%, transparent); }

	.bld-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.125rem; }
	.bld-row { display: flex; align-items: center; gap: 0.25rem; min-width: 0; }
	.bld-ic { width: 0.875rem; height: 0.875rem; border-radius: 0.125rem; flex-shrink: 0; object-fit: contain; }
	.bld-name { font-size: 0.75rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.bld-sub { font-size: 0.625rem; color: var(--surface-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.bld-sub strong { font-weight: 500; color: color-mix(in srgb, var(--center-channel-color) 65%, transparent); }

	.bld-time { display: inline-flex; align-items: center; gap: 0.1875rem; font-size: 0.625rem; color: var(--surface-muted); white-space: nowrap; flex-shrink: 0; margin-top: 0.125rem; }
	.bld-time--live { color: #f59e0b; font-weight: 600; font-variant-numeric: tabular-nums; }

	:global(.spin) { animation: spin 1s linear infinite; }

	/* Skeletons */
	.sk-icon { width: 2rem; height: 2rem; border-radius: 0.375rem; }
	.sk-col { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; }
	:global(.sk) {
		background: linear-gradient(90deg, color-mix(in srgb, var(--surface-border) 40%, transparent) 25%, color-mix(in srgb, var(--surface-border) 18%, transparent) 50%, color-mix(in srgb, var(--surface-border) 40%, transparent) 75%);
		background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 0.25rem;
	}
	@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
	@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

	/* Responsive */
	@media (max-width: 64rem) {
		.layout { flex-direction: column-reverse; }
		.aside { flex: none; width: 100%; position: static; }
	}
	@media (max-width: 48rem) {
		.page { padding: 1.5rem 1rem 3rem; }
		.bar { flex-wrap: wrap; }
		.search-box { max-width: none; flex: 1; min-width: 8rem; }
		.grid { grid-template-columns: 1fr; }
	}
</style>
