<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import { Loader2, Gauge, Save } from 'lucide-svelte';

	interface OrgQuota {
		org: {
			id: string;
			name: string;
			cpuLimitMilli: number | null;
			memoryLimitBytes: number | null;
			maxPods: number | null;
			maxServices: number | null;
			defaultPodCpuMilli: number | null;
			defaultPodMemoryBytes: number | null;
		};
		usage: { cpuMilli: number; memoryBytes: number; pods: number; services: number };
	}

	interface ProjectCap {
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

	let orgQuota = $state<OrgQuota | null>(null);
	let projects = $state<ProjectCap[]>([]);
	let loading = $state(true);
	let orgId = $state<string>('');

	// Draft edits keyed by projectId
	let drafts = $state<Record<string, { cpu: string; memMi: string; pods: string; services: string }>>({});
	let savingId = $state<string | null>(null);

	const orgSlug = $derived($page.params.orgSlug);

	function toDraft(p: ProjectCap) {
		return {
			cpu: p.cpuLimitMilli ? String(p.cpuLimitMilli) : '',
			memMi: p.memoryLimitBytes ? String(Math.round(p.memoryLimitBytes / (1024 * 1024))) : '',
			pods: p.maxPods ? String(p.maxPods) : '',
			services: p.maxServices ? String(p.maxServices) : '',
		};
	}

	async function load() {
		loading = true;
		try {
			const orgRes = await apiFetch(`/apiv1/organizations/slug/${orgSlug}`);
			if (!orgRes.ok) throw new Error('Failed to load org');
			const orgData = await orgRes.json();
			orgId = orgData.id;

			const [qRes, pRes] = await Promise.all([
				apiFetch(`/apiv1/organizations/${orgId}/quota`),
				apiFetch(`/apiv1/organizations/${orgId}/quota/projects`),
			]);
			if (!qRes.ok) throw new Error('Failed to load quota');
			if (!pRes.ok) throw new Error('Failed to load projects');
			orgQuota = await qRes.json();
			const pdata = await pRes.json();
			projects = pdata.projects;
			drafts = Object.fromEntries(projects.map((p) => [p.id, toDraft(p)]));
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			loading = false;
		}
	}

	function parseIntOrNull(v: string): number | null {
		const t = v.trim();
		if (!t) return null;
		const n = parseInt(t, 10);
		return Number.isFinite(n) && n > 0 ? n : null;
	}

	async function savePr(p: ProjectCap) {
		const d = drafts[p.id];
		if (!d) return;
		savingId = p.id;
		try {
			const memMi = parseIntOrNull(d.memMi);
			const body = {
				cpuLimitMilli: parseIntOrNull(d.cpu),
				memoryLimitBytes: memMi === null ? null : memMi * 1024 * 1024,
				maxPods: parseIntOrNull(d.pods),
				maxServices: parseIntOrNull(d.services),
			};
			const res = await apiFetch(`/apiv1/organizations/${orgId}/quota/projects/${p.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Save failed');
			}
			toasts.add({ title: 'Saved', description: `${p.name} quotas applied`, color: 'success' });
			await load();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			savingId = null;
		}
	}

	function pct(used: number, cap: number | null): number | null {
		if (!cap || cap <= 0) return null;
		return Math.min(100, Math.round((used / cap) * 100));
	}

	onMount(load);
</script>

<div class="p-6 max-w-5xl mx-auto">
	<div class="flex items-center gap-3 mb-6">
		<div
			class="flex h-10 w-10 items-center justify-center rounded-xl"
			style="background-color: var(--primary-100); color: var(--primary-700);"
		>
			<Gauge class="h-5 w-5" />
		</div>
		<div>
			<h1 class="text-2xl font-bold">Resource quotas</h1>
			<p class="text-sm" style="color: var(--surface-muted);">
				Cap how much CPU, memory, and pods each project can consume. Leave blank to inherit the org-level cap.
			</p>
		</div>
	</div>

	{#if loading}
		<div class="flex justify-center py-12"><Loader2 class="h-8 w-8 animate-spin" /></div>
	{:else if orgQuota}
		<!-- Org usage summary -->
		{@const cpuCap = orgQuota.org.cpuLimitMilli}
		{@const memCap = orgQuota.org.memoryLimitBytes}
		{@const podsCap = orgQuota.org.maxPods}
		{@const svcCap = orgQuota.org.maxServices}
		<div class="rounded-2xl border p-5 mb-6" style="border-color: var(--surface-border); background-color: var(--surface-bg);">
			<h2 class="text-sm font-semibold mb-3">Organization total</h2>
			<div class="grid grid-cols-4 gap-4">
				<div>
					<p class="text-xs" style="color: var(--surface-muted);">CPU</p>
					<p class="text-lg font-bold">
						{formatCpuMilli(orgQuota.usage.cpuMilli)}
						{#if cpuCap}<span class="text-sm font-normal" style="color: var(--surface-muted);"> / {formatCpuMilli(cpuCap)}</span>{/if}
					</p>
					{#if pct(orgQuota.usage.cpuMilli, cpuCap) !== null}
						<div class="h-1.5 rounded-full mt-1" style="background-color: var(--control-bg);">
							<div class="h-full rounded-full" style="width: {pct(orgQuota.usage.cpuMilli, cpuCap)}%; background-color: var(--primary-600);"></div>
						</div>
					{/if}
				</div>
				<div>
					<p class="text-xs" style="color: var(--surface-muted);">Memory</p>
					<p class="text-lg font-bold">
						{formatMemoryBytes(orgQuota.usage.memoryBytes)}
						{#if memCap}<span class="text-sm font-normal" style="color: var(--surface-muted);"> / {formatMemoryBytes(memCap)}</span>{/if}
					</p>
					{#if pct(orgQuota.usage.memoryBytes, memCap) !== null}
						<div class="h-1.5 rounded-full mt-1" style="background-color: var(--control-bg);">
							<div class="h-full rounded-full" style="width: {pct(orgQuota.usage.memoryBytes, memCap)}%; background-color: var(--primary-600);"></div>
						</div>
					{/if}
				</div>
				<div>
					<p class="text-xs" style="color: var(--surface-muted);">Pods</p>
					<p class="text-lg font-bold">
						{orgQuota.usage.pods}
						{#if podsCap}<span class="text-sm font-normal" style="color: var(--surface-muted);"> / {podsCap}</span>{/if}
					</p>
				</div>
				<div>
					<p class="text-xs" style="color: var(--surface-muted);">Services</p>
					<p class="text-lg font-bold">
						{orgQuota.usage.services}
						{#if svcCap}<span class="text-sm font-normal" style="color: var(--surface-muted);"> / {svcCap}</span>{/if}
					</p>
				</div>
			</div>
		</div>

		<!-- Per-project table -->
		<h2 class="text-sm font-semibold mb-2">Per-project overrides</h2>
		<p class="text-xs mb-3" style="color: var(--surface-muted);">
			Overrides take precedence over org-level caps. Saving pushes a ResourceQuota to the project's namespace — Kubernetes rejects new pods that would breach it.
		</p>

		{#if projects.length === 0}
			<div class="rounded-2xl border p-8 text-center" style="border-color: var(--surface-border);">
				<p class="text-sm" style="color: var(--surface-muted);">No projects in this organization yet.</p>
			</div>
		{:else}
			<div class="space-y-3">
				{#each projects as p (p.id)}
					<div class="rounded-2xl border p-4" style="border-color: var(--surface-border); background-color: var(--surface-bg);">
						<div class="flex items-start justify-between mb-3">
							<div>
								<p class="font-semibold">{p.name}</p>
								<p class="text-xs font-mono" style="color: var(--surface-muted);">{p.namespace}</p>
							</div>
							<div class="text-xs text-right" style="color: var(--surface-muted);">
								<div>{formatCpuMilli(p.usage.cpuMilli)} CPU · {formatMemoryBytes(p.usage.memoryBytes)} · {p.usage.pods} pods</div>
							</div>
						</div>
						<div class="grid grid-cols-4 gap-3">
							<label class="text-xs">
								CPU (millicores)
								<input
									type="number"
									bind:value={drafts[p.id].cpu}
									placeholder={orgQuota.org.cpuLimitMilli ? `inherit (${orgQuota.org.cpuLimitMilli})` : 'unlimited'}
									class="input w-full mt-1"
								/>
							</label>
							<label class="text-xs">
								Memory (MiB)
								<input
									type="number"
									bind:value={drafts[p.id].memMi}
									placeholder={orgQuota.org.memoryLimitBytes ? `inherit (${Math.round(orgQuota.org.memoryLimitBytes / (1024 * 1024))})` : 'unlimited'}
									class="input w-full mt-1"
								/>
							</label>
							<label class="text-xs">
								Max pods
								<input
									type="number"
									bind:value={drafts[p.id].pods}
									placeholder={orgQuota.org.maxPods ? `inherit (${orgQuota.org.maxPods})` : 'unlimited'}
									class="input w-full mt-1"
								/>
							</label>
							<label class="text-xs">
								Max services
								<input
									type="number"
									bind:value={drafts[p.id].services}
									placeholder={orgQuota.org.maxServices ? `inherit (${orgQuota.org.maxServices})` : 'unlimited'}
									class="input w-full mt-1"
								/>
							</label>
						</div>
						<div class="mt-3 flex justify-end">
							<button
								class="flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium"
								style="background-color: var(--primary-600); color: white;"
								disabled={savingId === p.id}
								onclick={() => savePr(p)}
							>
								{#if savingId === p.id}
									<Loader2 class="h-4 w-4 animate-spin" />
								{:else}
									<Save class="h-4 w-4" />
								{/if}
								Save
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>
