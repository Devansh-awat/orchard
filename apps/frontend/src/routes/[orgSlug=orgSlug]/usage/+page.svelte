<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/stores';
	import { fly, fade } from '$lib/utils/transitions';
	import { apiFetch, toasts, subscribeOrgEvents } from '$lib/stores';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import Speedometer from '$lib/components/Speedometer.svelte';
	import DonutChart from '$lib/components/DonutChart.svelte';
	import HorizontalBars from '$lib/components/HorizontalBars.svelte';
	import {
		Loader2,
		Activity,
		Gauge,
		Users,
		BarChart3,
		Pencil,
		Check,
		X,
		Sprout
	} from 'lucide-svelte';
	import { TabBar } from '$lib/components/ui';
	import { greenhouseFlag, sandboxEnabled } from '$lib/flags';
	import { SandboxUsageTab } from '$lib/components/sandbox';

	const formatPods = (n: number) => `${n}`;
	import type { PageData } from './$types';

	type Role = 'owner' | 'admin' | 'member' | 'guest';
	type AllowanceSource = 'explicit' | 'default' | 'unlimited';
	type Verdict = 'over' | 'under' | 'ok' | 'unknown';

	interface OrgQuota {
		org: {
			id: string;
			name: string;
			cpuLimitMilli: number | null;
			memoryLimitBytes: number | null;
			maxPods: number | null;
			maxServices: number | null;
		};
		usage: { cpuMilli: number; memoryBytes: number; pods: number; services: number };
	}
	interface ProjectRow {
		id: string;
		name: string;
		slug: string;
		namespace: string;
		cpuLimitMilli: number | null;
		memoryLimitBytes: number | null;
		maxPods: number | null;
		maxServices: number | null;
		usage: { cpuMilli: number; memoryBytes: number; pods: number };
	}
	interface MemberRow {
		user: {
			id: string;
			username: string;
			email: string;
			firstName: string | null;
			lastName: string | null;
			imageUrl: string | null;
		};
		role: string;
		allowance: {
			cpuMilli: number | null;
			memoryBytes: number | null;
			source: { cpu: AllowanceSource; memory: AllowanceSource };
		};
		usage: { cpuMilli: number; memoryBytes: number };
	}
	interface MembersData {
		org: {
			cpuLimitMilli: number | null;
			memoryLimitBytes: number | null;
			defaultMemberCpuMilli: number | null;
			defaultMemberMemoryBytes: number | null;
		};
		commitment: { cpuMilli: number; memoryBytes: number };
		members: MemberRow[];
	}
	interface MyUsage {
		allowance: {
			cpuMilli: number | null;
			memoryBytes: number | null;
			source: { cpu: AllowanceSource; memory: AllowanceSource };
		};
		usage: {
			cpuMilli: number;
			memoryBytes: number;
			breakdown: Array<{
				kind: 'deployment' | 'database' | 'templateInstance';
				id: string;
				name: string;
				projectId: string;
				projectName: string;
				cpuMilli: number;
				memoryBytes: number;
				replicas: number;
			}>;
		};
		orgCap: { cpuLimitMilli: number | null; memoryLimitBytes: number | null };
		effectiveLimit: { cpuMilli: number | null; memoryBytes: number | null };
	}
	interface ProvisioningRow {
		kind: 'deployment' | 'database';
		id: string;
		name: string;
		projectId: string;
		projectName: string;
		namespace: string;
		requestedCpuMilli: number;
		requestedMemoryBytes: number;
		actualCpuMilliP95: number | null;
		actualMemoryBytesP95: number | null;
		cpuUtilization: number | null;
		memoryUtilization: number | null;
		verdict: Verdict;
	}

	let { data } = $props<{ data: PageData }>();

	let role = $state<Role>('member');
	let isAdmin = $state(false);
	let orgId = $state<string | null>(null);
	let orgQuota = $state<OrgQuota | null>(null);
	let projects = $state<ProjectRow[]>([]);
	let membersData = $state<MembersData | null>(null);
	let myUsage = $state<MyUsage | null>(null);
	let provisioning = $state<ProvisioningRow[]>([]);
	let loading = $state(true);

	const orgSlug = $derived(data.orgSlug);
	const range = $derived(data.range);

	type Tab = 'overview' | 'me' | 'members' | 'provisioning' | 'sandbox';

	const availableTabs = $derived.by<Array<{ id: Tab; label: string; icon: any }>>(() => {
		const tabs: Array<{ id: Tab; label: string; icon: any }> = [
			{ id: 'overview', label: 'Overview', icon: Activity },
			{ id: 'me', label: 'My usage', icon: Gauge }
		];
		if (sandboxEnabled() && $greenhouseFlag) {
			tabs.push({ id: 'sandbox', label: 'Sandboxes', icon: Sprout });
		}
		if (isAdmin) {
			tabs.push({ id: 'members', label: 'Members', icon: Users });
			tabs.push({ id: 'provisioning', label: 'Provisioning', icon: BarChart3 });
		}
		return tabs;
	});

	const urlTab = $derived(($page.url.searchParams.get('tab') as Tab | null) ?? null);
	const activeTab = $derived.by<Tab>(() => {
		if (urlTab && availableTabs.find((t) => t.id === urlTab)) return urlTab;
		return isAdmin ? 'overview' : 'me';
	});

	function setTab(t: Tab) {
		const u = new URL($page.url);
		u.searchParams.set('tab', t);
		goto(u.pathname + u.search, { keepFocus: true, noScroll: true, replaceState: true });
	}
	function setRange(r: string) {
		const u = new URL($page.url);
		u.searchParams.set('range', r);
		goto(u.pathname + u.search, { keepFocus: true, noScroll: true });
	}

	function pct(used: number, cap: number | null): number {
		if (!cap || cap <= 0) return 0;
		return Math.min(100, Math.round((used / cap) * 100));
	}

	let usageUnsub: (() => void) | null = null;
	let usageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let hasLoadedOnce = false;

	$effect(() => {
		const promise = data.usagePromise;
		const isInitial = !hasLoadedOnce;
		if (isInitial) loading = true;
		promise
			.then((p: any) => {
				role = p.role;
				isAdmin = p.isAdmin;
				orgId = p.orgId;
				orgQuota = p.orgQuota;
				projects = p.projectsData?.projects ?? [];
				membersData = p.membersData ?? null;
				myUsage = p.myUsage ?? null;
				provisioning = p.provisioning?.rows ?? [];
				hasLoadedOnce = true;
				loading = false;
				usageUnsub?.();
				usageUnsub = subscribeOrgEvents(p.orgId, (ev) => {
					if (ev.type === 'deployment.metrics' || ev.type === 'heartbeat') return;
					if (usageRefreshTimer) return;
					usageRefreshTimer = setTimeout(() => {
						usageRefreshTimer = null;
						invalidate(`org:${orgSlug}:usage`);
					}, 2000);
				});
			})
			.catch((e: any) => {
				if (isInitial) loading = false;
				toasts.add({
					title: 'Error',
					description: e instanceof Error ? e.message : 'Failed to load usage',
					color: 'error'
				});
			});
	});

	onDestroy(() => {
		usageUnsub?.();
		if (usageRefreshTimer) clearTimeout(usageRefreshTimer);
	});

	// ---- Default member allowance editing ----
	let editingDefault = $state(false);
	let defaultCpuInput = $state('');
	let defaultMemInput = $state('');
	let defaultCpuUnlim = $state(false);
	let defaultMemUnlim = $state(false);
	let savingDefault = $state(false);

	function startEditDefault() {
		if (!membersData) return;
		defaultCpuInput =
			membersData.org.defaultMemberCpuMilli === null
				? ''
				: String(membersData.org.defaultMemberCpuMilli);
		defaultMemInput =
			membersData.org.defaultMemberMemoryBytes === null
				? ''
				: String(Math.round(membersData.org.defaultMemberMemoryBytes / (1024 * 1024)));
		defaultCpuUnlim = membersData.org.defaultMemberCpuMilli === null;
		defaultMemUnlim = membersData.org.defaultMemberMemoryBytes === null;
		editingDefault = true;
	}
	async function saveDefault() {
		if (!orgId) return;
		savingDefault = true;
		try {
			const cpuMilli = defaultCpuUnlim
				? null
				: String(defaultCpuInput).trim() === ''
					? null
					: Math.max(0, parseInt(String(defaultCpuInput), 10));
			const memoryBytes = defaultMemUnlim
				? null
				: String(defaultMemInput).trim() === ''
					? null
					: Math.max(0, parseInt(String(defaultMemInput), 10)) * 1024 * 1024;
			const res = await apiFetch(`/apiv1/organizations/${orgId}/quota/default-member-allowance`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cpuMilli, memoryBytes })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || `Failed to save default (${res.status})`);
			}
			editingDefault = false;
			invalidate(`org:${orgSlug}:usage`);
			toasts.add({ title: 'Saved', description: 'Default allowance updated', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to save',
				color: 'error'
			});
		} finally {
			savingDefault = false;
		}
	}

	// ---- Per-member editing ----
	let editingMemberId = $state<string | null>(null);
	let memCpuInput = $state('');
	let memMemInput = $state('');
	let memCpuUnlim = $state(false);
	let memMemUnlim = $state(false);
	let memCpuUseDefault = $state(false);
	let memMemUseDefault = $state(false);
	let savingMember = $state(false);

	function startEditMember(m: MemberRow) {
		editingMemberId = m.user.id;
		const isDefaultCpu = m.allowance.source.cpu === 'default';
		const isDefaultMem = m.allowance.source.memory === 'default';
		const isUnlimCpu = m.allowance.source.cpu === 'unlimited';
		const isUnlimMem = m.allowance.source.memory === 'unlimited';
		memCpuUseDefault = isDefaultCpu;
		memMemUseDefault = isDefaultMem;
		memCpuUnlim = isUnlimCpu;
		memMemUnlim = isUnlimMem;
		memCpuInput =
			!isDefaultCpu && !isUnlimCpu && m.allowance.cpuMilli !== null
				? String(m.allowance.cpuMilli)
				: '';
		memMemInput =
			!isDefaultMem && !isUnlimMem && m.allowance.memoryBytes !== null
				? String(Math.round(m.allowance.memoryBytes / (1024 * 1024)))
				: '';
	}
	async function saveMember() {
		if (!orgId || !editingMemberId) return;
		savingMember = true;
		try {
			const cpuMilli = memCpuUnlim
				? null
				: memCpuUseDefault
					? null
					: String(memCpuInput).trim() === ''
						? null
						: Math.max(0, parseInt(String(memCpuInput), 10));
			const memoryBytes = memMemUnlim
				? null
				: memMemUseDefault
					? null
					: String(memMemInput).trim() === ''
						? null
						: Math.max(0, parseInt(String(memMemInput), 10)) * 1024 * 1024;
			const res = await apiFetch(`/apiv1/organizations/${orgId}/quota/members/${editingMemberId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					cpuMilli,
					memoryBytes,
					cpuUnlimited: memCpuUnlim,
					memoryUnlimited: memMemUnlim
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || `Failed to save (${res.status})`);
			}
			editingMemberId = null;
			invalidate(`org:${orgSlug}:usage`);
			toasts.add({ title: 'Saved', description: 'Allowance updated', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to save',
				color: 'error'
			});
		} finally {
			savingMember = false;
		}
	}

	function memberName(m: MemberRow): string {
		const fn = [m.user.firstName, m.user.lastName].filter(Boolean).join(' ').trim();
		return fn || m.user.username || m.user.email;
	}
	function allowanceLabel(
		src: AllowanceSource,
		value: number | null,
		fmt: (n: number) => string
	): string {
		if (src === 'unlimited' || value === null) return 'Unlimited';
		return `${fmt(value)}${src === 'default' ? ' · default' : ''}`;
	}

	// ---- Provisioning helpers ----
	function verdictColor(v: Verdict): string {
		switch (v) {
			case 'over':
				return 'var(--warning-text)';
			case 'under':
				return 'var(--error-text-color)';
			case 'ok':
				return 'var(--success-text)';
			default:
				return 'var(--surface-muted)';
		}
	}
	function verdictBg(v: Verdict): string {
		switch (v) {
			case 'over':
				return 'var(--warning-bg)';
			case 'under':
				return 'color-mix(in srgb, var(--error-text-color) 12%, transparent)';
			case 'ok':
				return 'var(--success-bg)';
			default:
				return 'color-mix(in srgb, var(--surface-border) 35%, transparent)';
		}
	}
	function verdictLabel(v: Verdict): string {
		switch (v) {
			case 'over':
				return 'Over-provisioned';
			case 'under':
				return 'Under-provisioned';
			case 'ok':
				return 'OK';
			default:
				return 'No data';
		}
	}

	function utilPctStr(u: number | null): string {
		if (u === null) return 'n/a';
		return `${Math.round(u * 100)}%`;
	}

	function projectBreakdown(u: MyUsage) {
		const map = new Map<
			string,
			{ projectId: string; projectName: string; cpuMilli: number; memoryBytes: number }
		>();
		for (const item of u.usage.breakdown) {
			const cur = map.get(item.projectId) || {
				projectId: item.projectId,
				projectName: item.projectName,
				cpuMilli: 0,
				memoryBytes: 0
			};
			cur.cpuMilli += item.cpuMilli;
			cur.memoryBytes += item.memoryBytes;
			map.set(item.projectId, cur);
		}
		return Array.from(map.values()).sort((a, b) => b.cpuMilli - a.cpuMilli);
	}

	const topWasters = $derived.by(() => {
		const byCpu = [...provisioning]
			.filter((r) => r.actualCpuMilliP95 !== null && r.requestedCpuMilli > 0)
			.map((r) => ({
				row: r,
				wasted: Math.max(0, r.requestedCpuMilli - (r.actualCpuMilliP95 ?? 0))
			}))
			.filter((x) => x.wasted > 0)
			.sort((a, b) => b.wasted - a.wasted)
			.slice(0, 5);
		const byMem = [...provisioning]
			.filter((r) => r.actualMemoryBytesP95 !== null && r.requestedMemoryBytes > 0)
			.map((r) => ({
				row: r,
				wasted: Math.max(0, r.requestedMemoryBytes - (r.actualMemoryBytesP95 ?? 0))
			}))
			.filter((x) => x.wasted > 0)
			.sort((a, b) => b.wasted - a.wasted)
			.slice(0, 5);
		return { byCpu, byMem };
	});

	const provisioningSummary = $derived.by(() => {
		const counts = { over: 0, under: 0, ok: 0, unknown: 0 } as Record<Verdict, number>;
		let wastedCpu = 0;
		let wastedMem = 0;
		for (const r of provisioning) {
			counts[r.verdict] += 1;
			if (r.actualCpuMilliP95 !== null) {
				wastedCpu += Math.max(0, r.requestedCpuMilli - r.actualCpuMilliP95);
			}
			if (r.actualMemoryBytesP95 !== null) {
				wastedMem += Math.max(0, r.requestedMemoryBytes - r.actualMemoryBytesP95);
			}
		}
		return { counts, wastedCpu, wastedMem };
	});

	const RANGES = [
		{ value: '1h', label: '1h' },
		{ value: '24h', label: '24h' },
		{ value: '7d', label: '7d' }
	];
</script>

<div class="usage-page">
	<header class="usage-header">
		<div class="usage-header-icon">
			<Activity class="h-5 w-5" />
		</div>
		<div class="usage-header-text">
			<h1 class="usage-title">Usage</h1>
			<p class="usage-subtitle">
				Resource allowance, consumption, and right-sizing across this organization.
			</p>
		</div>
	</header>

	{#if loading}
		<div class="usage-loading">
			<Loader2 class="h-6 w-6 animate-spin" style="color: var(--button-bg);" />
		</div>
	{:else}
		<!-- Tab bar -->
		<div class="usage-tabs-row">
			<TabBar tabs={availableTabs} bind:value={() => activeTab, (v) => setTab(v as Tab)} />
			{#if activeTab === 'provisioning'}
				<div class="usage-range">
					{#each RANGES as r (r.value)}
						<button
							type="button"
							class="usage-range-btn"
							class:is-active={range === r.value}
							onclick={() => setRange(r.value)}>{r.label}</button
						>
					{/each}
				</div>
			{/if}
		</div>

		{#key activeTab}
			<div
				class="usage-tab-content"
				in:fly={{ y: 8, duration: 200, delay: 60 }}
				out:fade={{ duration: 100 }}
			>
				<!-- ───────── OVERVIEW ───────── -->
				{#if activeTab === 'overview' && orgQuota}
					<div class="card">
						<div class="card-head">
							<h2 class="card-title">Organization capacity</h2>
						</div>
						<div class="card-body">
							<div class="speedo-grid">
								<Speedometer
									label="CPU"
									value={orgQuota.usage.cpuMilli}
									max={orgQuota.org.cpuLimitMilli}
									formatValue={formatCpuMilli}
									size="md"
								/>
								<Speedometer
									label="Memory"
									value={orgQuota.usage.memoryBytes}
									max={orgQuota.org.memoryLimitBytes}
									formatValue={formatMemoryBytes}
									size="md"
								/>
								<Speedometer
									label="Pods"
									value={orgQuota.usage.pods}
									max={orgQuota.org.maxPods}
									formatValue={formatPods}
									size="md"
								/>
								<Speedometer
									label="Services"
									value={orgQuota.usage.services}
									max={orgQuota.org.maxServices}
									formatValue={formatPods}
									size="md"
								/>
							</div>
						</div>
					</div>

					{#if projects.length > 0}
						<div class="card">
							<div class="card-head">
								<h2 class="card-title">CPU by project</h2>
							</div>
							<div class="card-body">
								<DonutChart
									slices={projects
										.filter((p) => p.usage.cpuMilli > 0)
										.map((p) => ({ label: p.name, value: p.usage.cpuMilli }))}
									size={180}
									thickness={24}
									centerLabel={formatCpuMilli(orgQuota.usage.cpuMilli)}
									centerCaption="total"
									formatValue={formatCpuMilli}
								/>
							</div>
						</div>
					{/if}

					{#if projects.length > 0}
						<div class="card">
							<div class="card-head">
								<h2 class="card-title">By project</h2>
								<span class="card-count">{projects.length}</span>
							</div>
							<div class="table-wrap">
								<table class="data-table">
									<thead>
										<tr>
											<th>Project</th>
											<th>CPU</th>
											<th>Memory</th>
											<th>Pods</th>
										</tr>
									</thead>
									<tbody>
										{#each projects as p (p.id)}
											<tr>
												<td>
													<a href={`/${orgSlug}/projects/${p.slug}`} class="link-cell">{p.name}</a>
													<div class="cell-sub mono">{p.namespace}</div>
												</td>
												<td>
													{formatCpuMilli(p.usage.cpuMilli)}
													{#if p.cpuLimitMilli}<span class="cell-sub">
															/ {formatCpuMilli(p.cpuLimitMilli)}</span
														>{/if}
												</td>
												<td>
													{formatMemoryBytes(p.usage.memoryBytes)}
													{#if p.memoryLimitBytes}<span class="cell-sub">
															/ {formatMemoryBytes(p.memoryLimitBytes)}</span
														>{/if}
												</td>
												<td>
													{p.usage.pods}
													{#if p.maxPods}<span class="cell-sub"> / {p.maxPods}</span>{/if}
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}

					<!-- ───────── MY USAGE ───────── -->
				{:else if activeTab === 'me' && myUsage}
					{@const userCpuCap = myUsage.allowance.cpuMilli}
					{@const userMemCap = myUsage.allowance.memoryBytes}
					{@const effectiveCpu = myUsage.effectiveLimit?.cpuMilli ?? null}
					{@const effectiveMem = myUsage.effectiveLimit?.memoryBytes ?? null}
					{@const cpuCap = userCpuCap ?? myUsage.orgCap.cpuLimitMilli}
					{@const memCap = userMemCap ?? myUsage.orgCap.memoryLimitBytes}
					{@const myProjects = projectBreakdown(myUsage)}

					<div class="card">
						<div class="card-head">
							<h2 class="card-title">Your allowance</h2>
						</div>
						<div class="card-body">
							<div class="speedo-grid speedo-grid-2">
								<Speedometer
									label="CPU allowance"
									value={myUsage.usage.cpuMilli}
									max={cpuCap}
									formatValue={formatCpuMilli}
									size="lg"
									caption={userCpuCap === null && myUsage.orgCap.cpuLimitMilli !== null
										? `Unlimited, org cap ${formatCpuMilli(myUsage.orgCap.cpuLimitMilli)}`
										: effectiveCpu !== null
											? `${formatCpuMilli(effectiveCpu)} available to assign`
											: null}
								/>
								<Speedometer
									label="Memory allowance"
									value={myUsage.usage.memoryBytes}
									max={memCap}
									formatValue={formatMemoryBytes}
									size="lg"
									caption={userMemCap === null && myUsage.orgCap.memoryLimitBytes !== null
										? `Unlimited, org cap ${formatMemoryBytes(myUsage.orgCap.memoryLimitBytes)}`
										: effectiveMem !== null
											? `${formatMemoryBytes(effectiveMem)} available to assign`
											: null}
								/>
							</div>
						</div>
					</div>

					{#if myUsage.usage.breakdown.length === 0}
						<div class="empty-card">You don't own any projects with deployments yet.</div>
					{:else}
						<div class="card">
							<div class="card-head">
								<h2 class="card-title">Where it's going</h2>
								<span class="card-count">{myProjects.length}</span>
							</div>
							<div class="card-body">
								<DonutChart
									slices={myProjects.map((p) => ({ label: p.projectName, value: p.cpuMilli }))}
									size={200}
									thickness={26}
									centerLabel={formatCpuMilli(myUsage.usage.cpuMilli)}
									centerCaption="CPU total"
									formatValue={formatCpuMilli}
								/>
							</div>
						</div>

						<div class="card">
							<div class="card-head">
								<h2 class="card-title">By workload</h2>
								<span class="card-count">{myUsage.usage.breakdown.length}</span>
							</div>
							<div class="table-wrap">
								<table class="data-table">
									<thead>
										<tr>
											<th>Workload</th>
											<th>Project</th>
											<th>Kind</th>
											<th>Replicas</th>
											<th>CPU</th>
											<th>Memory</th>
										</tr>
									</thead>
									<tbody>
										{#each myUsage.usage.breakdown as item (`${item.kind}:${item.id}`)}
											<tr>
												<td class="strong">{item.name}</td>
												<td>{item.projectName}</td>
												<td><span class="pill pill-muted">{item.kind}</span></td>
												<td>{item.replicas}</td>
												<td>{formatCpuMilli(item.cpuMilli)}</td>
												<td>{formatMemoryBytes(item.memoryBytes)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}

					<!-- ───────── MEMBERS ───────── -->
				{:else if activeTab === 'sandbox'}
					<SandboxUsageTab />
				{:else if activeTab === 'members' && isAdmin && membersData}
					<div class="card">
						<div class="card-head">
							<div>
								<h2 class="card-title">Allowance committed</h2>
							</div>
						</div>
						<div class="card-body">
							<div class="speedo-grid speedo-grid-2">
								<Speedometer
									label="CPU committed"
									value={membersData.commitment.cpuMilli}
									max={membersData.org.cpuLimitMilli}
									formatValue={formatCpuMilli}
									size="md"
								/>
								<Speedometer
									label="Memory committed"
									value={membersData.commitment.memoryBytes}
									max={membersData.org.memoryLimitBytes}
									formatValue={formatMemoryBytes}
									size="md"
								/>
							</div>
							<p class="hint-text">
								Unlimited members don't contribute to these totals, but their actual usage still
								counts against the org cap.
							</p>
						</div>
					</div>

					<div class="card">
						<div class="card-head">
							<div>
								<h2 class="card-title">Default member allowance</h2>
							</div>
							{#if !editingDefault}
								<button class="btn-icon" onclick={startEditDefault}>
									<Pencil class="h-3.5 w-3.5" />
									Edit
								</button>
							{/if}
						</div>
						<div class="card-body">
							{#if editingDefault}
								<div class="form-grid">
									<label class="field">
										<span class="field-label">CPU (millicores)</span>
										<div class="field-row">
											<input
												type="number"
												min="0"
												class="input field-input"
												bind:value={defaultCpuInput}
												oninput={() => {
													if (defaultCpuInput) defaultCpuUnlim = false;
												}}
												placeholder={defaultCpuUnlim ? 'Unlimited' : 'e.g. 500'}
											/>
											<label class="toggle">
												<input
													type="checkbox"
													bind:checked={defaultCpuUnlim}
													onchange={() => {
														if (defaultCpuUnlim) defaultCpuInput = '';
													}}
												/> Unlimited
											</label>
										</div>
									</label>
									<label class="field">
										<span class="field-label">Memory (MiB)</span>
										<div class="field-row">
											<input
												type="number"
												min="0"
												class="input field-input"
												bind:value={defaultMemInput}
												oninput={() => {
													if (defaultMemInput) defaultMemUnlim = false;
												}}
												placeholder={defaultMemUnlim ? 'Unlimited' : 'e.g. 1024'}
											/>
											<label class="toggle">
												<input
													type="checkbox"
													bind:checked={defaultMemUnlim}
													onchange={() => {
														if (defaultMemUnlim) defaultMemInput = '';
													}}
												/> Unlimited
											</label>
										</div>
									</label>
								</div>
								<div class="form-actions">
									<button
										class="btn btn-secondary"
										onclick={() => (editingDefault = false)}
										disabled={savingDefault}>Cancel</button
									>
									<button class="btn btn-primary" onclick={saveDefault} disabled={savingDefault}>
										{#if savingDefault}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
										Save
									</button>
								</div>
							{:else}
								<div class="commit-grid">
									<div>
										<p class="stat-label">CPU</p>
										<p class="commit-value">
											{membersData.org.defaultMemberCpuMilli === null
												? 'Unlimited'
												: formatCpuMilli(membersData.org.defaultMemberCpuMilli)}
										</p>
									</div>
									<div>
										<p class="stat-label">Memory</p>
										<p class="commit-value">
											{membersData.org.defaultMemberMemoryBytes === null
												? 'Unlimited'
												: formatMemoryBytes(membersData.org.defaultMemberMemoryBytes)}
										</p>
									</div>
								</div>
								<p class="hint-text">Inherited by members who don't have a custom allowance.</p>
							{/if}
						</div>
					</div>

					<div class="card">
						<div class="card-head">
							<h2 class="card-title">Members</h2>
							<span class="card-count">{membersData.members.length}</span>
						</div>
						<div class="table-wrap">
							<table class="data-table">
								<thead>
									<tr>
										<th>Member</th>
										<th>Role</th>
										<th>CPU</th>
										<th>Memory</th>
										<th></th>
									</tr>
								</thead>
								<tbody>
									{#each membersData.members as m (m.user.id)}
										<tr class="align-top">
											<td>
												<div class="strong">{memberName(m)}</div>
												<div class="cell-sub">{m.user.email}</div>
											</td>
											<td><span class="pill pill-muted capitalize">{m.role}</span></td>
											<td>
												<div class="strong">
													{formatCpuMilli(m.usage.cpuMilli)}
													<span class="cell-sub"
														>/ {allowanceLabel(
															m.allowance.source.cpu,
															m.allowance.cpuMilli,
															formatCpuMilli
														)}</span
													>
												</div>
												{#if m.allowance.cpuMilli !== null}
													<div class="bar-track bar-track-sm bar-row-w">
														<div
															class="bar-fill"
															style="width: {pct(m.usage.cpuMilli, m.allowance.cpuMilli)}%;"
														></div>
													</div>
												{/if}
											</td>
											<td>
												<div class="strong">
													{formatMemoryBytes(m.usage.memoryBytes)}
													<span class="cell-sub"
														>/ {allowanceLabel(
															m.allowance.source.memory,
															m.allowance.memoryBytes,
															formatMemoryBytes
														)}</span
													>
												</div>
												{#if m.allowance.memoryBytes !== null}
													<div class="bar-track bar-track-sm bar-row-w">
														<div
															class="bar-fill"
															style="width: {pct(m.usage.memoryBytes, m.allowance.memoryBytes)}%;"
														></div>
													</div>
												{/if}
											</td>
											<td class="ta-right">
												{#if editingMemberId === m.user.id}
													<button
														class="btn-icon-sm"
														onclick={() => (editingMemberId = null)}
														disabled={savingMember}
														aria-label="Cancel"
													>
														<X class="h-4 w-4" />
													</button>
												{:else}
													<button
														class="btn-icon-sm"
														onclick={() => startEditMember(m)}
														aria-label="Edit allowance"
													>
														<Pencil class="h-4 w-4" />
													</button>
												{/if}
											</td>
										</tr>
										{#if editingMemberId === m.user.id}
											<tr class="edit-row">
												<td colspan="5">
													<div class="form-grid">
														<label class="field">
															<span class="field-label">CPU (millicores)</span>
															<div class="field-row">
																<input
																	type="number"
																	min="0"
																	class="input field-input"
																	bind:value={memCpuInput}
																	oninput={() => {
																		if (memCpuInput) {
																			memCpuUnlim = false;
																			memCpuUseDefault = false;
																		}
																	}}
																	placeholder={memCpuUnlim
																		? 'Unlimited'
																		: memCpuUseDefault
																			? 'Inherits default'
																			: 'e.g. 500'}
																/>
																<label class="toggle">
																	<input
																		type="checkbox"
																		bind:checked={memCpuUnlim}
																		onchange={() => {
																			if (memCpuUnlim) {
																				memCpuUseDefault = false;
																				memCpuInput = '';
																			}
																		}}
																	/> Unlimited
																</label>
																<label class="toggle">
																	<input
																		type="checkbox"
																		bind:checked={memCpuUseDefault}
																		onchange={() => {
																			if (memCpuUseDefault) {
																				memCpuUnlim = false;
																				memCpuInput = '';
																			}
																		}}
																	/> Use default
																</label>
															</div>
														</label>
														<label class="field">
															<span class="field-label">Memory (MiB)</span>
															<div class="field-row">
																<input
																	type="number"
																	min="0"
																	class="input field-input"
																	bind:value={memMemInput}
																	oninput={() => {
																		if (memMemInput) {
																			memMemUnlim = false;
																			memMemUseDefault = false;
																		}
																	}}
																	placeholder={memMemUnlim
																		? 'Unlimited'
																		: memMemUseDefault
																			? 'Inherits default'
																			: 'e.g. 1024'}
																/>
																<label class="toggle">
																	<input
																		type="checkbox"
																		bind:checked={memMemUnlim}
																		onchange={() => {
																			if (memMemUnlim) {
																				memMemUseDefault = false;
																				memMemInput = '';
																			}
																		}}
																	/> Unlimited
																</label>
																<label class="toggle">
																	<input
																		type="checkbox"
																		bind:checked={memMemUseDefault}
																		onchange={() => {
																			if (memMemUseDefault) {
																				memMemUnlim = false;
																				memMemInput = '';
																			}
																		}}
																	/> Use default
																</label>
															</div>
														</label>
													</div>
													<div class="form-actions">
														<button
															class="btn btn-secondary"
															onclick={() => (editingMemberId = null)}
															disabled={savingMember}>Cancel</button
														>
														<button
															class="btn btn-primary"
															onclick={saveMember}
															disabled={savingMember}
														>
															{#if savingMember}<Loader2
																	class="h-3.5 w-3.5 animate-spin"
																/>{:else}<Check class="h-3.5 w-3.5" />{/if}
															Save
														</button>
													</div>
												</td>
											</tr>
										{/if}
									{/each}
								</tbody>
							</table>
						</div>
					</div>

					<!-- ───────── PROVISIONING ───────── -->
				{:else if activeTab === 'provisioning' && isAdmin}
					<div class="prov-overview">
						<div class="card prov-donut-card">
							<div class="card-head">
								<h2 class="card-title">Workload health</h2>
							</div>
							<div class="card-body">
								<DonutChart
									slices={[
										{
											label: 'OK',
											value: provisioningSummary.counts.ok,
											color: 'var(--success-text)'
										},
										{
											label: 'Over-provisioned',
											value: provisioningSummary.counts.over,
											color: 'var(--warning-text)'
										},
										{
											label: 'Under-provisioned',
											value: provisioningSummary.counts.under,
											color: 'var(--error-text-color)'
										},
										{
											label: 'No data',
											value: provisioningSummary.counts.unknown,
											color: 'var(--surface-muted)'
										}
									]}
									size={170}
									thickness={22}
									centerLabel={String(provisioning.length)}
									centerCaption="workloads"
								/>
							</div>
						</div>
						<div class="card prov-headroom-card">
							<div class="card-head">
								<h2 class="card-title">Reclaimable headroom</h2>
							</div>
							<div class="card-body">
								<div class="headroom-row">
									<div class="headroom-cell">
										<p class="stat-label">CPU</p>
										<p class="headroom-value">{formatCpuMilli(provisioningSummary.wastedCpu)}</p>
									</div>
									<div class="headroom-cell">
										<p class="stat-label">Memory</p>
										<p class="headroom-value">{formatMemoryBytes(provisioningSummary.wastedMem)}</p>
									</div>
								</div>
								<p class="hint-text">
									Sum of requested minus p95 actual for every workload, across the selected range.
									Lower these requests to reclaim capacity.
								</p>
							</div>
						</div>
					</div>

					{#if provisioning.length === 0}
						<div class="empty-card">No workloads to analyze in this range.</div>
					{:else}
						{#if topWasters.byCpu.length > 0 || topWasters.byMem.length > 0}
							<div class="top-wasters-grid">
								<div class="card">
									<div class="card-head">
										<h2 class="card-title">Top CPU waste</h2>
										<span class="cell-sub">reclaimable per workload</span>
									</div>
									<div class="card-body">
										<HorizontalBars
											rows={topWasters.byCpu.map((w) => ({
												label: w.row.name,
												sublabel: `${w.row.projectName} · ${w.row.kind}`,
												value: w.wasted,
												fillValue: w.row.actualCpuMilliP95 ?? 0,
												color: 'var(--warning-bg)',
												fillColor: verdictColor(w.row.verdict)
											}))}
											formatValue={formatCpuMilli}
											emptyLabel="No waste detected"
										/>
									</div>
								</div>
								<div class="card">
									<div class="card-head">
										<h2 class="card-title">Top memory waste</h2>
										<span class="cell-sub">reclaimable per workload</span>
									</div>
									<div class="card-body">
										<HorizontalBars
											rows={topWasters.byMem.map((w) => ({
												label: w.row.name,
												sublabel: `${w.row.projectName} · ${w.row.kind}`,
												value: w.wasted,
												fillValue: w.row.actualMemoryBytesP95 ?? 0,
												color: 'var(--warning-bg)',
												fillColor: verdictColor(w.row.verdict)
											}))}
											formatValue={formatMemoryBytes}
											emptyLabel="No waste detected"
										/>
									</div>
								</div>
							</div>
						{/if}

						<div class="card">
							<div class="card-head">
								<h2 class="card-title">All workloads</h2>
								<span class="card-count">{provisioning.length}</span>
							</div>
							<div class="table-wrap">
								<table class="data-table">
									<thead>
										<tr>
											<th>Workload</th>
											<th>CPU (actual / requested)</th>
											<th>Memory (actual / requested)</th>
											<th>Verdict</th>
										</tr>
									</thead>
									<tbody>
										{#each provisioning as r (`${r.kind}:${r.id}`)}
											<tr>
												<td>
													<div class="strong">{r.name}</div>
													<div class="cell-sub">{r.projectName} · {r.kind}</div>
												</td>
												<td>
													<div class="util-cell">
														<div class="util-bar-track">
															<div
																class="util-bar-fill"
																style="width: {r.cpuUtilization === null
																	? 0
																	: Math.min(
																			100,
																			r.cpuUtilization * 100
																		)}%; background-color: {verdictColor(r.verdict)};"
															></div>
														</div>
														<div class="util-text">
															<span class="util-actual">
																{r.actualCpuMilliP95 === null
																	? 'n/a'
																	: formatCpuMilli(r.actualCpuMilliP95)}
															</span>
															<span class="util-sep">/</span>
															<span class="util-requested"
																>{formatCpuMilli(r.requestedCpuMilli)}</span
															>
															<span class="util-pct">{utilPctStr(r.cpuUtilization)}</span>
														</div>
													</div>
												</td>
												<td>
													<div class="util-cell">
														<div class="util-bar-track">
															<div
																class="util-bar-fill"
																style="width: {r.memoryUtilization === null
																	? 0
																	: Math.min(
																			100,
																			r.memoryUtilization * 100
																		)}%; background-color: {verdictColor(r.verdict)};"
															></div>
														</div>
														<div class="util-text">
															<span class="util-actual">
																{r.actualMemoryBytesP95 === null
																	? 'n/a'
																	: formatMemoryBytes(r.actualMemoryBytesP95)}
															</span>
															<span class="util-sep">/</span>
															<span class="util-requested"
																>{formatMemoryBytes(r.requestedMemoryBytes)}</span
															>
															<span class="util-pct">{utilPctStr(r.memoryUtilization)}</span>
														</div>
													</div>
												</td>
												<td>
													<span
														class="pill"
														style="color: {verdictColor(r.verdict)}; background-color: {verdictBg(
															r.verdict
														)};"
													>
														{verdictLabel(r.verdict)}
													</span>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{/key}
	{/if}
</div>

<style>
	.usage-page {
		padding: 2.5rem 2.5rem 3rem;
		max-width: 64rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.usage-header {
		display: flex;
		align-items: center;
		gap: 0.875rem;
	}
	.usage-header-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background-color: color-mix(in srgb, var(--button-bg) 15%, var(--surface-bg));
		color: var(--button-bg);
	}
	.usage-title {
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--center-channel-color);
		margin: 0;
	}
	.usage-subtitle {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		margin: 0.125rem 0 0;
	}

	.usage-loading {
		display: flex;
		justify-content: center;
		padding: 4rem 0;
	}

	.usage-tabs-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.usage-range {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.25rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--surface-border) 25%, transparent);
	}
	.usage-range-btn {
		padding: 0.25rem 0.75rem;
		border: none;
		background: transparent;
		color: color-mix(in srgb, var(--center-channel-color) 70%, var(--surface-muted));
		border-radius: var(--radius-xs);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		cursor: pointer;
		font-family: inherit;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.usage-range-btn:hover {
		color: var(--center-channel-color);
	}
	.usage-range-btn.is-active {
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: var(--elev-1);
	}

	.usage-tab-content {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.usage-tab-content > :global(*) {
		animation: tab-card-in 250ms ease both;
	}
	.usage-tab-content > :global(*:nth-child(2)) {
		animation-delay: 50ms;
	}
	.usage-tab-content > :global(*:nth-child(3)) {
		animation-delay: 100ms;
	}
	.usage-tab-content > :global(*:nth-child(4)) {
		animation-delay: 150ms;
	}
	@keyframes tab-card-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.stat-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		margin: 0 0 0.5rem;
	}

	/* Progress bars */
	.bar-track {
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		margin-top: 0.5rem;
		overflow: hidden;
	}
	.bar-track-sm {
		height: 0.25rem;
	}
	.bar-fill {
		height: 100%;
		border-radius: var(--radius-pill);
		background-color: var(--button-bg);
		transition: width var(--dur-base) ease;
	}
	.bar-row-w {
		width: 10rem;
		margin-top: 0.5rem;
	}

	/* Cards */
	.card {
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-lg);
		background-color: var(--surface-bg);
		overflow: hidden;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--surface-border);
	}
	.card-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0;
	}
	.card-count {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-pill);
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}
	.card-body {
		padding: 1.25rem;
	}

	.commit-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}
	.commit-value {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0.125rem 0 0.25rem;
	}
	.hint-text {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
		margin: 1rem 0 0;
	}

	/* Tables */
	.table-wrap {
		overflow-x: auto;
	}
	.data-table {
		width: 100%;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		border-collapse: collapse;
	}
	.data-table thead tr {
		background-color: color-mix(in srgb, var(--surface-border) 25%, var(--surface-bg));
	}
	.data-table thead th {
		text-align: left;
		padding: 0.75rem 1.25rem;
		font-weight: 600;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
	}
	.data-table tbody td {
		padding: 0.75rem 1.25rem;
		border-top: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		vertical-align: middle;
	}
	.data-table tr.edit-row td {
		background-color: color-mix(in srgb, var(--surface-border) 18%, var(--surface-bg));
		padding: 1rem 1.25rem;
	}
	.data-table tr.align-top td {
		vertical-align: top;
	}
	.cell-sub {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
	}
	.strong {
		font-weight: 600;
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.ta-right {
		text-align: right;
	}
	.link-cell {
		font-weight: 600;
		color: var(--center-channel-color);
		text-decoration: none;
	}
	.link-cell:hover {
		color: var(--link-color);
		text-decoration: underline;
	}

	/* Pills */
	.pill {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.pill-muted {
		color: var(--surface-muted);
		background-color: color-mix(in srgb, var(--surface-border) 45%, var(--surface-bg));
	}
	.capitalize {
		text-transform: capitalize;
		letter-spacing: 0;
	}

	/* Buttons */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		cursor: pointer;
		font-family: inherit;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease,
			border-color var(--dur-fast) ease,
			transform var(--dur-fast) ease;
	}
	.btn:active {
		transform: scale(0.98);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-primary {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.btn-primary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--button-bg) 88%, black);
	}
	.btn-secondary {
		background-color: var(--control-bg);
		color: var(--center-channel-color);
		border-color: var(--surface-border);
	}
	.btn-secondary:hover:not(:disabled) {
		background-color: var(--control-hover-bg);
	}
	.btn-icon {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3125rem 0.75rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		border-radius: var(--radius-sm);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--center-channel-color);
		cursor: pointer;
		font-family: inherit;
		transition: background-color var(--dur-fast) ease;
	}
	.btn-icon:hover {
		background-color: var(--control-hover-bg);
	}
	.btn-icon-sm {
		display: inline-flex;
		padding: 0.5rem;
		border: 1px solid transparent;
		background: transparent;
		border-radius: var(--radius-xs);
		color: var(--surface-muted);
		cursor: pointer;
		font-family: inherit;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease;
	}
	.btn-icon-sm:hover {
		background-color: var(--control-hover-bg);
		color: var(--center-channel-color);
	}

	/* Forms */
	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}
	@media (max-width: 640px) {
		.form-grid {
			grid-template-columns: 1fr;
		}
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.field-label {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}
	.field-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.field-input {
		flex: 1;
		min-width: 8rem;
	}
	.input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		border-radius: var(--radius-sm);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-family: inherit;
		transition:
			border-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}
	.input:focus {
		outline: none;
		border-color: var(--button-bg);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--button-bg) 20%, transparent);
	}
	.input:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--center-channel-color);
		cursor: pointer;
	}
	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	/* Provisioning */
	.top-wasters-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.25rem;
	}
	@media (max-width: 880px) {
		.top-wasters-grid {
			grid-template-columns: 1fr;
		}
	}

	.util-cell {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 11rem;
	}
	.util-bar-track {
		position: relative;
		height: 0.5rem;
		border-radius: var(--radius-pill);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
		overflow: hidden;
	}
	.util-bar-fill {
		height: 100%;
		border-radius: var(--radius-pill);
		transition: width var(--dur-base) ease;
		animation: util-bar-grow 500ms cubic-bezier(0.22, 1, 0.36, 1) both;
	}
	@keyframes util-bar-grow {
		from {
			width: 0 !important;
		}
	}
	.util-text {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-variant-numeric: tabular-nums;
	}
	.util-actual {
		font-weight: 700;
		color: var(--center-channel-color);
	}
	.util-sep {
		color: var(--surface-muted);
	}
	.util-requested {
		color: var(--surface-muted);
	}
	.util-pct {
		margin-left: auto;
		color: var(--surface-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
	}

	.speedo-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
		gap: 1rem 0.5rem;
		justify-items: center;
	}
	.speedo-grid-2 {
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1.5rem 1rem;
	}

	.prov-overview {
		display: grid;
		grid-template-columns: 2fr 1fr;
		gap: 1.25rem;
	}
	@media (max-width: 720px) {
		.prov-overview {
			grid-template-columns: 1fr;
		}
	}
	.headroom-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
		margin-bottom: 0.75rem;
	}
	.headroom-cell {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.headroom-value {
		font-size: var(--text-title-2);
		line-height: var(--lh-title-2);
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.empty-card {
		border: 1px dashed var(--surface-border);
		border-radius: var(--radius-lg);
		padding: 2.5rem 1rem;
		text-align: center;
		color: var(--surface-muted);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		background-color: color-mix(in srgb, var(--surface-bg) 60%, transparent);
	}
</style>
