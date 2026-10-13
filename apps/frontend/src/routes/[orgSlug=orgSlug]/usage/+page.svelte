<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/stores';
	import { fly, fade } from '$lib/utils/transitions';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { apiFetch, toasts, subscribeOrgEvents } from '$lib/stores';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import { BudgetMeter, UsageBreakdown, DataGrid } from '$lib/components/usage';
	import HorizontalBars from '$lib/components/HorizontalBars.svelte';
	import { Loader2, Activity, Gauge, Users, BarChart3, Pencil, Check, X } from 'lucide-svelte';
	import { Puzzle } from 'lucide-svelte';
	import GraftMount from '$lib/grafts/GraftMount.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';
	import { TabBar, SectionCard, EmptyState, Alert, PageHeader, Button } from '$lib/components/ui';

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

	type Tab = 'overview' | 'me' | 'members' | 'provisioning' | `graft-${string}`;

	const graftTabs = $derived(
		orgId
			? graftHost.slot('org.usage.tabs', { orgId, orgSlug }).map(({ graftId, host, item }) => ({
					key: `graft-${graftId}-${item.id}` as Tab,
					id: item.id,
					graftId,
					host,
					label: item.label,
					mount: item.mount
				}))
			: []
	);
	const activeGraftTab = $derived(graftTabs.find((t) => t.key === activeTab));

	const availableTabs = $derived.by<Array<{ id: Tab; label: string; icon: any }>>(() => {
		const tabs: Array<{ id: Tab; label: string; icon: any }> = [
			{ id: 'me', label: 'Yours', icon: Gauge }
		];
		if (isAdmin) {
			tabs.splice(1, 0, { id: 'overview', label: 'Organization', icon: Activity });
			tabs.push({ id: 'members', label: 'Members', icon: Users });
			tabs.push({ id: 'provisioning', label: 'Right-sizing', icon: BarChart3 });
		}
		for (const t of graftTabs) tabs.push({ id: t.key, label: t.label, icon: Puzzle });
		return tabs;
	});

	const urlTab = $derived(($page.url.searchParams.get('tab') as Tab | null) ?? null);
	const activeTab = $derived.by<Tab>(() => {
		if (urlTab && availableTabs.find((t) => t.id === urlTab)) return urlTab;
		const aliased = graftTabs.find((t) => t.id === urlTab);
		if (aliased) return aliased.key;
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
	<PageHeader title="Usage">
		{#snippet icon()}<Activity class="h-5 w-5" />{/snippet}
		{#snippet meta()}
			<span class="usage-subtitle">
				{isAdmin
					? 'What this organization is using, and how much room is left.'
					: 'What you are using, and how much room you have left.'}
			</span>
		{/snippet}
	</PageHeader>

	{#if loading}
		<div class="usage-loading">
			<Loader2 class="h-6 w-6 animate-spin" style="color: var(--button-bg);" />
		</div>
	{:else}
		<!-- Tab bar -->
		<div class="usage-tabs-row" class:usage-tabs-row--bare={availableTabs.length < 2}>
			{#if availableTabs.length > 1}
				<TabBar tabs={availableTabs} bind:value={() => activeTab, (v) => setTab(v as Tab)} />
			{/if}
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
					<SectionCard title="Capacity">
						<div class="budget-grid">
							<BudgetMeter
								label="CPU"
								used={orgQuota.usage.cpuMilli}
								limit={orgQuota.org.cpuLimitMilli}
								available={null}
								format={formatCpuMilli}
								index={0}
							/>
							<BudgetMeter
								label="Memory"
								used={orgQuota.usage.memoryBytes}
								limit={orgQuota.org.memoryLimitBytes}
								available={null}
								format={formatMemoryBytes}
								index={1}
							/>
							<BudgetMeter
								label="Pods"
								used={orgQuota.usage.pods}
								limit={orgQuota.org.maxPods}
								available={null}
								format={formatPods}
								index={2}
							/>
							<BudgetMeter
								label="Services"
								used={orgQuota.usage.services}
								limit={orgQuota.org.maxServices}
								available={null}
								format={formatPods}
								index={3}
							/>
						</div>
					</SectionCard>

					{#if projects.length === 0}
						<SectionCard title="By project">
							<EmptyState
								title="No projects yet"
								description="Once this organization has projects, their share of the cap shows up here."
							/>
						</SectionCard>
					{:else}
						{@const topCpu = Math.max(...projects.map((x) => x.usage.cpuMilli), 1)}
						<SectionCard
							title="By project"
							description="Ranked by reserved CPU. A project with its own cap shows it alongside."
						>
							<ul class="proj-list">
								{#each [...projects].sort((a, b) => b.usage.cpuMilli - a.usage.cpuMilli) as p, i (p.id)}
									<li {@attach motionStagger({ index: i, from: { y: 4, opacity: 0 } })}>
										<a class="proj-row" href={`/${orgSlug}/projects/${p.slug}`}>
											<span class="proj-bar" style="--share: {p.usage.cpuMilli / topCpu}"></span>
											<span class="proj-main">
												<span class="proj-name">{p.name}</span>
												<span class="proj-ns">{p.namespace}</span>
											</span>
											<span class="proj-nums">
												<span class="proj-primary">
													{formatCpuMilli(p.usage.cpuMilli)}{#if p.cpuLimitMilli}<span
															class="proj-cap"
														>
															/ {formatCpuMilli(p.cpuLimitMilli)}</span
														>{/if}
												</span>
												<span class="proj-secondary">
													{formatMemoryBytes(p.usage.memoryBytes)} &middot; {p.usage.pods}
													{p.usage.pods === 1 ? 'pod' : 'pods'}
												</span>
											</span>
										</a>
									</li>
								{/each}
							</ul>
						</SectionCard>
					{/if}
				{:else if activeTab === 'overview'}
					<SectionCard title="Organization">
						<EmptyState
							title="Could not load organization usage"
							description="This needs organization admin access. If you are an admin, reload the page."
						/>
					</SectionCard>
				{:else if activeTab === 'me' && myUsage}
					{@const userCpuCap = myUsage.allowance.cpuMilli}
					{@const userMemCap = myUsage.allowance.memoryBytes}
					{@const cpuCap = userCpuCap ?? myUsage.orgCap.cpuLimitMilli}
					{@const memCap = userMemCap ?? myUsage.orgCap.memoryLimitBytes}
					{@const effectiveCpu = myUsage.effectiveLimit?.cpuMilli ?? null}
					{@const effectiveMem = myUsage.effectiveLimit?.memoryBytes ?? null}
					{@const cpuTight =
						cpuCap !== null && cpuCap > 0 && myUsage.usage.cpuMilli / cpuCap >= 0.8}
					{@const memTight =
						memCap !== null && memCap > 0 && myUsage.usage.memoryBytes / memCap >= 0.8}

					<SectionCard title="Your budget">
						<div class="budget-grid">
							<BudgetMeter
								label="CPU"
								used={myUsage.usage.cpuMilli}
								limit={cpuCap}
								available={effectiveCpu}
								format={formatCpuMilli}
								index={0}
							/>
							<BudgetMeter
								label="Memory"
								used={myUsage.usage.memoryBytes}
								limit={memCap}
								available={effectiveMem}
								format={formatMemoryBytes}
								index={1}
							/>
						</div>

						{#if cpuTight || memTight}
							<div class="budget-note">
								<Alert tone="warning" title="You are close to your limit">
									New apps and scale-ups are checked against this budget, so a deploy can be refused
									once it runs out. Free room up by lowering CPU or memory on something below, or
									ask an organization admin to raise your allowance.
								</Alert>
							</div>
						{/if}
					</SectionCard>

					{#if myUsage.usage.breakdown.length === 0}
						<SectionCard title="Where it is going">
							<EmptyState
								title="Nothing is using your budget yet"
								description="Apps and databases you own show up here with what they reserve, ranked by size."
							>
								<Button variant="primary" href="/{orgSlug}/new">Deploy something</Button>
							</EmptyState>
						</SectionCard>
					{:else}
						<SectionCard
							title="Where it is going"
							description="Ranked by what each workload reserves, not what it happens to be using right now."
						>
							<UsageBreakdown items={myUsage.usage.breakdown} {orgSlug} />
						</SectionCard>
					{/if}
				{:else if activeTab === 'members' && isAdmin && membersData}
					<SectionCard
						title="Allowance committed"
						description="What member allowances add up to, against the organization cap. Over 100% is allowed: it is a bet that members will not all use their full allowance at once."
					>
						<div class="budget-grid">
							<BudgetMeter
								label="CPU committed"
								used={membersData.commitment.cpuMilli}
								limit={membersData.org.cpuLimitMilli}
								available={null}
								format={formatCpuMilli}
								index={0}
							/>
							<BudgetMeter
								label="Memory committed"
								used={membersData.commitment.memoryBytes}
								limit={membersData.org.memoryLimitBytes}
								available={null}
								format={formatMemoryBytes}
								index={1}
							/>
						</div>
						<p class="hint-text">
							Unlimited members do not add to these totals, but their real usage still counts
							against the organization cap.
						</p>
					</SectionCard>

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

					<SectionCard title="Members">
						{#snippet actions()}
							<span class="card-count">{membersData.members.length}</span>
						{/snippet}
						<DataGrid
							rows={membersData.members}
							rowKey={(m) => m.user.id}
							search={(m) => `${memberName(m)} ${m.user.email} ${m.role}`}
							searchPlaceholder="Filter members"
							initialSort={{ id: 'cpu', dir: 'desc' }}
							emptyTitle="No members yet"
							expanded={(m) => editingMemberId === m.user.id}
							columns={[
								{ id: 'member', label: 'Member', sort: (m) => memberName(m) },
								{ id: 'role', label: 'Role', width: '6rem', sort: (m) => m.role },
								{ id: 'cpu', label: 'CPU', sort: (m) => m.usage.cpuMilli },
								{ id: 'mem', label: 'Memory', sort: (m) => m.usage.memoryBytes },
								{ id: 'edit', label: '', width: '2.5rem', align: 'end' }
							]}
						>
							{#snippet row(m)}
								<span class="grid-cell">
									<span class="strong">{memberName(m)}</span>
									<span class="cell-sub">{m.user.email}</span>
								</span>
								<span class="pill pill-muted capitalize">{m.role}</span>
								<span class="grid-cell">
									<span class="strong">
										{formatCpuMilli(m.usage.cpuMilli)}
										<span class="cell-sub">
											/ {allowanceLabel(
												m.allowance.source.cpu,
												m.allowance.cpuMilli,
												formatCpuMilli
											)}</span
										>
									</span>
									{#if m.allowance.cpuMilli !== null}
										<span class="bar-track bar-track-sm bar-row-w">
											<span
												class="bar-fill"
												style="width: {pct(m.usage.cpuMilli, m.allowance.cpuMilli)}%;"
											></span>
										</span>
									{/if}
								</span>
								<span class="grid-cell">
									<span class="strong">
										{formatMemoryBytes(m.usage.memoryBytes)}
										<span class="cell-sub">
											/ {allowanceLabel(
												m.allowance.source.memory,
												m.allowance.memoryBytes,
												formatMemoryBytes
											)}</span
										>
									</span>
									{#if m.allowance.memoryBytes !== null}
										<span class="bar-track bar-track-sm bar-row-w">
											<span
												class="bar-fill"
												style="width: {pct(m.usage.memoryBytes, m.allowance.memoryBytes)}%;"
											></span>
										</span>
									{/if}
								</span>
								<span class="ta-right">
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
								</span>
							{/snippet}
							{#snippet detail()}
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
									<button class="btn btn-primary" onclick={saveMember} disabled={savingMember}>
										{#if savingMember}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check
												class="h-3.5 w-3.5"
											/>{/if}
										Save
									</button>
								</div>
							{/snippet}
						</DataGrid>
					</SectionCard>

					<!-- ───────── PROVISIONING ───────── -->
				{:else if activeTab === 'provisioning' && isAdmin}
					<div class="prov-overview">
						<SectionCard title="Workload health" class="prov-donut-card">
							<ul class="health-list">
								{#each [{ id: 'ok', label: 'Right-sized', n: provisioningSummary.counts.ok, tone: 'success' }, { id: 'over', label: 'Over-provisioned', n: provisioningSummary.counts.over, tone: 'warning' }, { id: 'under', label: 'Under-provisioned', n: provisioningSummary.counts.under, tone: 'error' }, { id: 'unknown', label: 'No data yet', n: provisioningSummary.counts.unknown, tone: 'neutral' }] as bucket (bucket.id)}
									<li class="health-row">
										<span class="health-dot health-dot--{bucket.tone}"></span>
										<span class="health-label">{bucket.label}</span>
										<span class="health-count">{bucket.n}</span>
										<span
											class="health-bar health-bar--{bucket.tone}"
											style="--share: {provisioning.length > 0
												? bucket.n / provisioning.length
												: 0}"
										></span>
									</li>
								{/each}
							</ul>
						</SectionCard>
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
						<SectionCard title="All workloads">
							<EmptyState
								title="Nothing to size yet"
								description="Once workloads have run for a while in this range, their actual usage shows up here next to what they reserve."
							/>
						</SectionCard>
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

						<SectionCard title="All workloads">
							{#snippet actions()}
								<span class="card-count">{provisioning.length}</span>
							{/snippet}
							<DataGrid
								rows={provisioning}
								rowKey={(r) => `${r.kind}:${r.id}`}
								search={(r) => `${r.name} ${r.projectName} ${r.kind} ${r.verdict}`}
								searchPlaceholder="Filter workloads"
								initialSort={{ id: 'cpu', dir: 'asc' }}
								emptyTitle="No workloads to size"
								columns={[
									{ id: 'name', label: 'Workload', sort: (r) => r.name },
									{
										id: 'cpu',
										label: 'CPU actual / requested',
										sort: (r) => r.cpuUtilization ?? -1
									},
									{
										id: 'mem',
										label: 'Memory actual / requested',
										sort: (r) => r.memoryUtilization ?? -1
									},
									{ id: 'verdict', label: 'Verdict', width: '9rem', sort: (r) => r.verdict }
								]}
							>
								{#snippet row(r)}
									<span class="grid-cell">
										<span class="strong">{r.name}</span>
										<span class="cell-sub">{r.projectName} &middot; {r.kind}</span>
									</span>
									<span class="util-cell">
										<span class="util-bar-track">
											<span
												class="util-bar-fill"
												style="width: {r.cpuUtilization === null
													? 0
													: Math.min(
															100,
															r.cpuUtilization * 100
														)}%; background-color: {verdictColor(r.verdict)};"
											></span>
										</span>
										<span class="util-text">
											<span class="util-actual">
												{r.actualCpuMilliP95 === null ? 'n/a' : formatCpuMilli(r.actualCpuMilliP95)}
											</span>
											<span class="util-sep">/</span>
											<span class="util-requested">{formatCpuMilli(r.requestedCpuMilli)}</span>
											<span class="util-pct">{utilPctStr(r.cpuUtilization)}</span>
										</span>
									</span>
									<span class="util-cell">
										<span class="util-bar-track">
											<span
												class="util-bar-fill"
												style="width: {r.memoryUtilization === null
													? 0
													: Math.min(
															100,
															r.memoryUtilization * 100
														)}%; background-color: {verdictColor(r.verdict)};"
											></span>
										</span>
										<span class="util-text">
											<span class="util-actual">
												{r.actualMemoryBytesP95 === null
													? 'n/a'
													: formatMemoryBytes(r.actualMemoryBytesP95)}
											</span>
											<span class="util-sep">/</span>
											<span class="util-requested">{formatMemoryBytes(r.requestedMemoryBytes)}</span
											>
											<span class="util-pct">{utilPctStr(r.memoryUtilization)}</span>
										</span>
									</span>
									<span
										class="pill"
										style="color: {verdictColor(r.verdict)}; background-color: {verdictBg(
											r.verdict
										)};"
									>
										{verdictLabel(r.verdict)}
									</span>
								{/snippet}
							</DataGrid>
						</SectionCard>
					{/if}
				{:else if activeGraftTab && orgId}
					<GraftMount
						graftId={activeGraftTab.graftId}
						mount={activeGraftTab.mount}
						props={{ orgId, orgSlug }}
						host={activeGraftTab.host}
					/>
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

	.proj-list {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.proj-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
		overflow: hidden;
		color: inherit;
		text-decoration: none;
	}
	.proj-row:hover {
		background-color: var(--bg-hover);
	}
	.proj-bar {
		position: absolute;
		inset: 0 auto 0 0;
		width: calc(var(--share) * 100%);
		background-color: var(--accent-subtle);
		border-radius: var(--radius-md);
		pointer-events: none;
	}
	.proj-main {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
		min-width: 0;
		flex: 1;
	}
	.proj-name {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.proj-ns {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.proj-nums {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.0625rem;
		flex-shrink: 0;
	}
	.proj-primary {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
	}
	.proj-cap {
		font-weight: 400;
		color: var(--text-faint);
	}
	.proj-secondary {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.health-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.health-row {
		display: grid;
		grid-template-columns: auto 1fr auto;
		grid-template-areas: 'dot label count' 'bar bar bar';
		align-items: center;
		gap: 0.375rem 0.5rem;
	}
	.health-dot {
		grid-area: dot;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
	}
	.health-label {
		grid-area: label;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.health-count {
		grid-area: count;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
	}
	.health-bar {
		grid-area: bar;
		height: 0.25rem;
		border-radius: var(--radius-pill);
		background-color: var(--bg-sunken);
		position: relative;
		overflow: hidden;
	}
	.health-bar::after {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: calc(var(--share) * 100%);
		border-radius: var(--radius-pill);
		background-color: currentColor;
	}
	.health-dot--success,
	.health-bar--success {
		color: var(--status-success);
		background-color: var(--status-success);
	}
	.health-bar--success {
		background-color: var(--bg-sunken);
	}
	.health-dot--warning,
	.health-bar--warning {
		color: var(--status-warning);
		background-color: var(--status-warning);
	}
	.health-bar--warning {
		background-color: var(--bg-sunken);
	}
	.health-dot--error,
	.health-bar--error {
		color: var(--status-error);
		background-color: var(--status-error);
	}
	.health-bar--error {
		background-color: var(--bg-sunken);
	}
	.health-dot--neutral,
	.health-bar--neutral {
		color: var(--status-neutral);
		background-color: var(--status-neutral);
	}
	.health-bar--neutral {
		background-color: var(--bg-sunken);
	}
	.grid-cell {
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
		min-width: 0;
	}
	.grid-cell .strong,
	.grid-cell .cell-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.budget-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: 1.5rem 2rem;
	}
	.budget-note {
		margin-top: 1.25rem;
	}
	.usage-tabs-row--bare {
		margin-bottom: 0;
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
</style>
