<script lang="ts">
	import { onDestroy } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { apiFetch, toasts, subscribeOrgEvents } from '$lib/stores';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import { Loader2, Activity } from 'lucide-svelte';
	import type { PageData } from './$types';

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

	let { data } = $props<{ data: PageData }>();
	let orgQuota = $state<OrgQuota | null>(null);
	let projects = $state<ProjectRow[]>([]);
	let loading = $state(true);
	let orgId = $state<string | null>(null);

	const orgSlug = $derived(data.orgSlug);

	function pct(used: number, cap: number | null): number | null {
		if (!cap || cap <= 0) return null;
		return Math.min(100, Math.round((used / cap) * 100));
	}

	const cpuCap = $derived(orgQuota?.org.cpuLimitMilli ?? null);
	const memCap = $derived(orgQuota?.org.memoryLimitBytes ?? null);
	const podsCap = $derived(orgQuota?.org.maxPods ?? null);
	const svcCap = $derived(orgQuota?.org.maxServices ?? null);
	const cpuPct = $derived(orgQuota ? pct(orgQuota.usage.cpuMilli, cpuCap) : null);
	const memPct = $derived(orgQuota ? pct(orgQuota.usage.memoryBytes, memCap) : null);

	let usageUnsub: (() => void) | null = null;

	$effect(() => {
		const promise = data.usagePromise;
		loading = true;
		promise
			.then((p) => {
				orgQuota = p.orgQuota;
				projects = p.projects;
				orgId = p.orgId;
				loading = false;
				usageUnsub?.();
				usageUnsub = subscribeOrgEvents(
					p.orgId,
					() => invalidate(`org:${orgSlug}:usage`),
					{ invalidateDependencies: [`org:${orgSlug}:usage`] },
				);
			})
			.catch((e) => {
				loading = false;
				toasts.add({
					title: 'Error',
					description: e instanceof Error ? e.message : 'Failed to load usage',
					color: 'error',
				});
			});
	});

	onDestroy(() => usageUnsub?.());
</script>

<div class="p-6 max-w-6xl mx-auto">
	<div class="flex items-center gap-3 mb-6">
		<div
			class="flex h-10 w-10 items-center justify-center rounded-xl"
			style="background-color: var(--primary-100); color: var(--primary-700);"
		>
			<Activity class="h-5 w-5" />
		</div>
		<div>
			<h1 class="text-2xl font-bold">Usage</h1>
			<p class="text-sm" style="color: var(--surface-muted);">
				Current resource consumption across this organization's projects.
			</p>
		</div>
	</div>

	{#if loading}
		<div class="flex justify-center py-12"><Loader2 class="h-8 w-8 animate-spin" /></div>
	{:else if orgQuota}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
			<div class="rounded-2xl border p-4" style="border-color: var(--surface-border); background-color: var(--surface-bg);">
				<p class="text-xs" style="color: var(--surface-muted);">CPU requested</p>
				<p class="text-2xl font-bold">{formatCpuMilli(orgQuota.usage.cpuMilli)}</p>
				{#if cpuCap !== null}
					<p class="text-xs mt-1" style="color: var(--surface-muted);">
						of {formatCpuMilli(cpuCap)} cap
					</p>
					<div class="h-1.5 rounded-full mt-2" style="background-color: var(--control-bg);">
						<div class="h-full rounded-full" style="width: {cpuPct}%; background-color: var(--primary-600);"></div>
					</div>
				{:else}
					<p class="text-xs mt-1" style="color: var(--surface-muted);">no cap set</p>
				{/if}
			</div>

			<div class="rounded-2xl border p-4" style="border-color: var(--surface-border); background-color: var(--surface-bg);">
				<p class="text-xs" style="color: var(--surface-muted);">Memory requested</p>
				<p class="text-2xl font-bold">{formatMemoryBytes(orgQuota.usage.memoryBytes)}</p>
				{#if memCap !== null}
					<p class="text-xs mt-1" style="color: var(--surface-muted);">
						of {formatMemoryBytes(memCap)} cap
					</p>
					<div class="h-1.5 rounded-full mt-2" style="background-color: var(--control-bg);">
						<div class="h-full rounded-full" style="width: {memPct}%; background-color: var(--primary-600);"></div>
					</div>
				{:else}
					<p class="text-xs mt-1" style="color: var(--surface-muted);">no cap set</p>
				{/if}
			</div>

			<div class="rounded-2xl border p-4" style="border-color: var(--surface-border); background-color: var(--surface-bg);">
				<p class="text-xs" style="color: var(--surface-muted);">Pods</p>
				<p class="text-2xl font-bold">
					{orgQuota.usage.pods}{#if podsCap} <span class="text-sm font-normal" style="color: var(--surface-muted);">/ {podsCap}</span>{/if}
				</p>
			</div>

			<div class="rounded-2xl border p-4" style="border-color: var(--surface-border); background-color: var(--surface-bg);">
				<p class="text-xs" style="color: var(--surface-muted);">Services</p>
				<p class="text-2xl font-bold">
					{orgQuota.usage.services}{#if svcCap} <span class="text-sm font-normal" style="color: var(--surface-muted);">/ {svcCap}</span>{/if}
				</p>
			</div>
		</div>

		<h2 class="text-sm font-semibold mb-2">By project</h2>
		{#if projects.length === 0}
			<div class="rounded-2xl border p-8 text-center" style="border-color: var(--surface-border);">
				<p class="text-sm" style="color: var(--surface-muted);">No projects yet.</p>
			</div>
		{:else}
			<div class="rounded-2xl border overflow-hidden" style="border-color: var(--surface-border);">
				<table class="w-full text-sm">
					<thead style="background-color: var(--control-bg);">
						<tr>
							<th class="text-left px-4 py-2 font-medium">Project</th>
							<th class="text-left px-4 py-2 font-medium">CPU</th>
							<th class="text-left px-4 py-2 font-medium">Memory</th>
							<th class="text-left px-4 py-2 font-medium">Pods</th>
						</tr>
					</thead>
					<tbody>
						{#each projects as p}
							<tr class="border-t" style="border-color: var(--surface-border);">
								<td class="px-4 py-3">
									<a
										href={`/${orgSlug}/projects/${p.slug}`}
										class="font-medium hover:underline"
									>{p.name}</a>
									<div class="text-xs font-mono" style="color: var(--surface-muted);">{p.namespace}</div>
								</td>
								<td class="px-4 py-3">
									{formatCpuMilli(p.usage.cpuMilli)}
									{#if p.cpuLimitMilli}
										<span class="text-xs" style="color: var(--surface-muted);"> / {formatCpuMilli(p.cpuLimitMilli)}</span>
									{/if}
								</td>
								<td class="px-4 py-3">
									{formatMemoryBytes(p.usage.memoryBytes)}
									{#if p.memoryLimitBytes}
										<span class="text-xs" style="color: var(--surface-muted);"> / {formatMemoryBytes(p.memoryLimitBytes)}</span>
									{/if}
								</td>
								<td class="px-4 py-3">
									{p.usage.pods}
									{#if p.maxPods}
										<span class="text-xs" style="color: var(--surface-muted);"> / {p.maxPods}</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</div>
