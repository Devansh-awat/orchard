<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatCpu, formatMemory, RESOURCE_PRESETS, matchPreset } from '$lib/presets';
	import { Loader2, Gauge, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-svelte';
	import { Dropdown } from '$lib/components/ui';

	interface Recommendation {
		cpuMilli: number;
		memoryBytes: number;
		presetId: string;
	}

	interface Row {
		kind: 'deployment' | 'database';
		id: string;
		name: string;
		namespace: string;
		project: { id: string; name: string; slug: string } | null;
		organization: { id: string; name: string; slug: string } | null;
		pods: number;
		observed: { cpuMilli: number; memoryBytes: number } | null;
		recommendation: Recommendation | null;
	}

	let rows = $state<Row[]>([]);
	let loading = $state(true);
	// Row id (`${kind}:${id}`) → chosen preset id, or 'skip', or 'custom'
	let choices = $state<Record<string, string>>({});
	let customCpu = $state<Record<string, string>>({});
	let customMem = $state<Record<string, string>>({});
	let applyingId = $state<string | null>(null);
	let bulkRunning = $state(false);
	let status = $state<Record<string, 'ok' | 'error' | undefined>>({});

	function rowKey(r: Row) {
		return `${r.kind}:${r.id}`;
	}

	async function load() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/admin/backfill/candidates');
			if (!res.ok) throw new Error('Failed to load candidates');
			rows = await res.json();
			// Default each row to its recommendation if present, else Micro.
			const defaults: Record<string, string> = {};
			for (const r of rows) {
				defaults[rowKey(r)] = r.recommendation?.presetId ?? 'micro';
			}
			choices = defaults;
			status = {};
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed',
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	function resolveChoice(r: Row): { cpuMilli: number; memoryBytes: number } | null {
		const key = rowKey(r);
		const choice = choices[key];
		if (!choice || choice === 'skip') return null;
		if (choice === 'custom') {
			const cpu = parseInt(customCpu[key] || '', 10);
			const mem = parseInt(customMem[key] || '', 10);
			if (!Number.isFinite(cpu) || cpu <= 0) return null;
			if (!Number.isFinite(mem) || mem <= 0) return null;
			return { cpuMilli: cpu, memoryBytes: mem * 1024 * 1024 };
		}
		const preset = RESOURCE_PRESETS.find((p) => p.id === choice);
		if (!preset) return null;
		return { cpuMilli: preset.cpuMilli, memoryBytes: preset.memoryBytes };
	}

	async function applyOne(r: Row) {
		const values = resolveChoice(r);
		if (!values) return;
		const key = rowKey(r);
		applyingId = key;
		status[key] = undefined;
		try {
			const res = await apiFetch('/apiv1/admin/backfill/apply', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					kind: r.kind,
					id: r.id,
					cpuMilli: values.cpuMilli,
					memoryBytes: values.memoryBytes
				})
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				throw new Error(data?.message || 'Apply failed');
			}
			status[key] = 'ok';
			// Remove from the list after a short delay so user sees the checkmark.
			setTimeout(() => {
				rows = rows.filter((x) => rowKey(x) !== key);
			}, 600);
		} catch (e) {
			status[key] = 'error';
			toasts.add({
				title: `${r.name} failed`,
				description: e instanceof Error ? e.message : 'Failed',
				color: 'error'
			});
		} finally {
			applyingId = null;
		}
	}

	async function applyAllRecommended() {
		bulkRunning = true;
		// Snapshot rows with a recommendation to avoid mutation during iteration.
		const targets = rows.filter((r) => r.recommendation && choices[rowKey(r)] !== 'skip');
		for (const r of targets) {
			await applyOne(r);
		}
		bulkRunning = false;
		toasts.add({ title: 'Backfill complete', color: 'success' });
	}

	const summary = $derived({
		total: rows.length,
		withRec: rows.filter((r) => r.recommendation).length,
		noMetrics: rows.filter((r) => !r.observed).length
	});

	onMount(load);
</script>

<div class="flex items-center justify-between mb-4">
	<div>
		<h2 class="text-lg font-semibold">Unsized resources</h2>
		<p class="text-sm" style="color: var(--surface-muted);">
			Apps and databases created before resource limits existed. Pick a size and apply it. The app
			restarts with the new limits.
		</p>
	</div>
	<div class="flex gap-2">
		<button class="btn btn-secondary" onclick={load} disabled={loading || bulkRunning}>
			<RefreshCw class="h-4 w-4" />
			Refresh
		</button>
		<button
			class="btn btn-primary"
			disabled={loading || bulkRunning || summary.withRec === 0}
			onclick={applyAllRecommended}
		>
			{#if bulkRunning}<Loader2 class="h-4 w-4 animate-spin" />{/if}
			Apply recommended to all ({summary.withRec})
		</button>
	</div>
</div>

{#if loading}
	<div class="flex justify-center py-12"><Loader2 class="h-8 w-8 animate-spin" /></div>
{:else if rows.length === 0}
	<div class="rounded-2xl border p-8 text-center" style="border-color: var(--surface-border);">
		<CheckCircle2 class="h-10 w-10 mx-auto mb-2" style="color: #16a34a;" />
		<p class="font-medium">Nothing to backfill</p>
		<p class="text-sm mt-1" style="color: var(--surface-muted);">
			Every app and database has resource requests set.
		</p>
	</div>
{:else}
	<div class="grid grid-cols-3 gap-3 mb-4">
		<div class="rounded-xl border p-3" style="border-color: var(--surface-border);">
			<p class="text-xs" style="color: var(--surface-muted);">Unsized total</p>
			<p class="text-xl font-bold">{summary.total}</p>
		</div>
		<div class="rounded-xl border p-3" style="border-color: var(--surface-border);">
			<p class="text-xs" style="color: var(--surface-muted);">With live metrics</p>
			<p class="text-xl font-bold">{summary.withRec}</p>
		</div>
		<div class="rounded-xl border p-3" style="border-color: var(--surface-border);">
			<p class="text-xs" style="color: var(--surface-muted);">Missing metrics</p>
			<p class="text-xl font-bold">{summary.noMetrics}</p>
		</div>
	</div>

	<div class="rounded-2xl border overflow-x-auto" style="border-color: var(--surface-border);">
		<table class="w-full text-sm">
			<thead style="background-color: var(--control-bg);">
				<tr>
					<th class="text-left px-3 py-2 font-medium">Target</th>
					<th class="text-left px-3 py-2 font-medium">Organization / project</th>
					<th class="text-left px-3 py-2 font-medium">Observed (per pod)</th>
					<th class="text-left px-3 py-2 font-medium">Apply size</th>
					<th class="px-3 py-2"></th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (rowKey(r))}
					{@const key = rowKey(r)}
					<tr class="border-t align-top" style="border-color: var(--surface-border);">
						<td class="px-3 py-3">
							<div class="font-medium max-w-64 truncate" title={r.name}>{r.name}</div>
							<div class="text-xs" style="color: var(--surface-muted);">
								<span
									class="inline-block rounded px-1.5 py-0.5 mr-1"
									style="background-color: var(--control-bg);">{r.kind}</span
								>
								<span class="font-mono">{r.namespace}</span>
							</div>
						</td>
						<td class="px-3 py-3 text-xs">
							{#if r.organization}
								<div class="max-w-48 truncate" title={r.organization.name}>
									{r.organization.name}
								</div>
							{/if}
							{#if r.project}
								<div
									class="max-w-48 truncate"
									style="color: var(--surface-muted);"
									title={r.project.name}
								>
									{r.project.name}
								</div>
							{/if}
						</td>
						<td class="px-3 py-3 text-xs">
							{#if r.observed}
								<div>{formatCpu(r.observed.cpuMilli)} · {formatMemory(r.observed.memoryBytes)}</div>
								<div style="color: var(--surface-muted);">
									{r.pods} pod{r.pods === 1 ? '' : 's'}
								</div>
							{:else}
								<span style="color: var(--surface-muted);">No metrics</span>
							{/if}
						</td>
						<td class="px-3 py-3">
							<div class="w-52">
								<Dropdown
									size="sm"
									bind:value={choices[key]}
									options={[
										...RESOURCE_PRESETS.map((p) => ({
											value: p.id,
											label: p.label,
											description: `${formatCpu(p.cpuMilli)} · ${formatMemory(p.memoryBytes)}${
												r.recommendation?.presetId === p.id ? ' · recommended' : ''
											}`
										})),
										{ value: 'custom', label: 'Custom…' },
										{ value: 'skip', label: 'Skip' }
									]}
								/>
							</div>
							{#if choices[key] === 'custom'}
								<div class="mt-2 flex gap-2">
									<input
										type="number"
										placeholder="CPU m"
										bind:value={customCpu[key]}
										class="w-24 rounded-lg border px-2 py-1 text-sm"
										style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
									/>
									<input
										type="number"
										placeholder="Memory MiB"
										bind:value={customMem[key]}
										class="w-28 rounded-lg border px-2 py-1 text-sm"
										style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
									/>
								</div>
							{/if}
						</td>
						<td class="px-3 py-3 text-right">
							{#if status[key] === 'ok'}
								<CheckCircle2 class="h-5 w-5 ml-auto" style="color: #16a34a;" />
							{:else if status[key] === 'error'}
								<AlertCircle class="h-5 w-5 ml-auto" style="color: #dc2626;" />
							{:else}
								<button
									class="btn btn-primary"
									disabled={!!applyingId ||
										bulkRunning ||
										choices[key] === 'skip' ||
										!resolveChoice(r)}
									onclick={() => applyOne(r)}
								>
									{#if applyingId === key}<Loader2 class="h-4 w-4 animate-spin" />{/if}
									Apply
								</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
