<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import { Loader2, Activity } from 'lucide-svelte';

	interface UsageRow {
		organization: { id: string; name: string; slug: string; avatarUrl: string | null };
		cpuMilli: number;
		memoryBytes: number;
		pods: number;
		byNode: Array<{ nodeName: string; cpuMilli: number; memBytes: number; pods: number }>;
	}

	let rows = $state<UsageRow[]>([]);
	let loading = $state(true);
	let expanded = $state<Record<string, boolean>>({});

	async function load() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/admin/usage');
			if (!res.ok) throw new Error("Couldn't load usage");
			rows = await res.json();
			// Sort heaviest first
			rows.sort((a, b) => b.cpuMilli - a.cpuMilli);
		} catch (e) {
			toasts.add({ message: e instanceof Error ? e.message : 'Failed', variant: 'error' });
		} finally {
			loading = false;
		}
	}

	const totals = $derived({
		cpuMilli: rows.reduce((a, r) => a + r.cpuMilli, 0),
		memoryBytes: rows.reduce((a, r) => a + r.memoryBytes, 0),
		pods: rows.reduce((a, r) => a + r.pods, 0)
	});

	onMount(load);
</script>

{#if loading}
	<div class="flex justify-center py-12">
		<Loader2 class="h-8 w-8 animate-spin text-primary-600" />
	</div>
{:else if rows.length === 0}
	<div class="rounded-2xl border p-8 text-center" style="border-color: var(--surface-border);">
		<Activity class="h-10 w-10 mx-auto mb-2" style="color: var(--surface-muted);" />
		<p class="text-sm" style="color: var(--surface-muted);">No workloads running yet.</p>
	</div>
{:else}
	<div class="grid grid-cols-3 gap-3 mb-6">
		<div class="rounded-2xl border p-4" style="border-color: var(--surface-border);">
			<p class="text-xs" style="color: var(--surface-muted);">Total CPU requested</p>
			<p class="text-2xl font-bold">{formatCpuMilli(totals.cpuMilli)}</p>
		</div>
		<div class="rounded-2xl border p-4" style="border-color: var(--surface-border);">
			<p class="text-xs" style="color: var(--surface-muted);">Total memory requested</p>
			<p class="text-2xl font-bold">{formatMemoryBytes(totals.memoryBytes)}</p>
		</div>
		<div class="rounded-2xl border p-4" style="border-color: var(--surface-border);">
			<p class="text-xs" style="color: var(--surface-muted);">Total pods</p>
			<p class="text-2xl font-bold">{totals.pods}</p>
		</div>
	</div>

	<div class="rounded-2xl border overflow-x-auto" style="border-color: var(--surface-border);">
		<table class="w-full text-sm">
			<thead style="background-color: var(--control-bg);">
				<tr>
					<th class="text-left px-4 py-2 font-medium">Organization</th>
					<th class="text-left px-4 py-2 font-medium">CPU requested</th>
					<th class="text-left px-4 py-2 font-medium">Memory requested</th>
					<th class="text-left px-4 py-2 font-medium">Pods</th>
					<th class="text-left px-4 py-2 font-medium">Nodes</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.organization.id)}
					<tr
						class="border-t cursor-pointer hover:bg-[var(--control-bg)]"
						style="border-color: var(--surface-border);"
						onclick={() => (expanded[r.organization.id] = !expanded[r.organization.id])}
					>
						<td class="px-4 py-3 font-medium max-w-64 truncate" title={r.organization.name}>
							{r.organization.name}
						</td>
						<td class="px-4 py-3">{formatCpuMilli(r.cpuMilli)}</td>
						<td class="px-4 py-3">{formatMemoryBytes(r.memoryBytes)}</td>
						<td class="px-4 py-3">{r.pods}</td>
						<td class="px-4 py-3">{r.byNode.length}</td>
					</tr>
					{#if expanded[r.organization.id] && r.byNode.length > 0}
						<tr style="background-color: var(--control-bg);">
							<td colspan="5" class="px-4 py-3">
								<div class="space-y-1">
									{#each r.byNode as n (n.nodeName)}
										<div class="flex items-center justify-between gap-4 text-xs">
											<span class="font-mono min-w-0 truncate" title={n.nodeName}>{n.nodeName}</span
											>
											<span style="color: var(--surface-muted);">
												{formatCpuMilli(n.cpuMilli)} · {formatMemoryBytes(n.memBytes)} · {n.pods} pods
											</span>
										</div>
									{/each}
								</div>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
{/if}
