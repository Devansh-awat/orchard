<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatCpu, formatMemory, RESOURCE_PRESETS } from '$lib/presets';
	import { RefreshCw } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Card,
		Dropdown,
		EmptyState,
		Input,
		ItemLabel,
		SectionCard,
		Skeleton,
		Stack,
		StatusBadge,
		Swap,
		Table,
		statusMeta
	} from '$lib/components/ui';
	import type { TableColumn } from '$lib/components/ui/Table.svelte';
	import Metric from '$lib/components/ui/Metric.svelte';

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

	const COLUMNS: TableColumn<Row>[] = [
		{ id: 'target', label: 'Target', width: 'minmax(6.5rem, 1fr)' },
		{ id: 'owner', label: 'Organization', width: 'minmax(6.5rem, 0.6fr)' },
		{ id: 'observed', label: 'Observed per pod', width: '8.5rem' },
		{ id: 'size', label: 'Apply size', width: '12.5rem' },
		{ id: 'apply', width: '5.75rem', align: 'end' }
	];

	let rows = $state<Row[]>([]);
	let loaded = $state(false);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let choices = $state<Record<string, string>>({});
	let customCpu = $state<Record<string, string>>({});
	let customMem = $state<Record<string, string>>({});
	let applyingId = $state<string | null>(null);
	let bulkRunning = $state(false);
	let status = $state<Record<string, 'ok' | 'error' | undefined>>({});

	const stage = $derived(
		error && !loaded ? 'error' : !loaded ? 'loading' : rows.length === 0 ? 'empty' : 'ready'
	);

	function rowKey(r: Row) {
		return `${r.kind}:${r.id}`;
	}

	function sizeOptions(r: Row) {
		return [
			...RESOURCE_PRESETS.map((p) => ({
				value: p.id,
				label: r.recommendation?.presetId === p.id ? `${p.label} · recommended` : p.label,
				description: `${formatCpu(p.cpuMilli)} · ${formatMemory(p.memoryBytes)}`
			})),
			{ value: 'custom', label: 'Custom…' },
			{ value: 'skip', label: 'Skip' }
		];
	}

	async function load() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/admin/backfill/candidates');
			if (!res.ok) throw new Error(`The server answered ${res.status}.`);
			rows = await res.json();
			const defaults: Record<string, string> = {};
			for (const r of rows) {
				defaults[rowKey(r)] = r.recommendation?.presetId ?? 'micro';
			}
			choices = defaults;
			status = {};
			loaded = true;
			error = null;
		} catch (e) {
			const message = e instanceof Error ? e.message : "Couldn't load candidates";
			if (loaded) {
				toasts.add({ title: "Couldn't load candidates", description: message, color: 'error' });
			}
			error = message;
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

{#snippet headerActions()}
	<Button
		variant="ghost"
		size="sm"
		icon={RefreshCw}
		label="Refresh"
		{loading}
		disabled={bulkRunning}
		onclick={load}
	/>
	<Button
		variant="primary"
		size="sm"
		loading={bulkRunning}
		disabled={loading || summary.withRec === 0}
		onclick={applyAllRecommended}
	>
		Apply recommended to all ({summary.withRec})
	</Button>
{/snippet}

<Swap key={stage}>
	{#if stage === 'loading'}
		<Stack gap="md">
			<Skeleton height="5.5rem" rounded="var(--radius-card)" />
			<Skeleton height="16rem" rounded="var(--radius-card)" />
		</Stack>
	{:else if stage === 'error'}
		<Alert tone="error" title="Couldn't load candidates">
			{error}
			{#snippet actions()}
				<Button variant="secondary" size="sm" {loading} onclick={load}>Try again</Button>
			{/snippet}
		</Alert>
	{:else if stage === 'empty'}
		<SectionCard flush>
			<EmptyState
				title="Nothing to backfill"
				description="Every app and database has resource requests set."
			>
				<Button variant="secondary" icon={RefreshCw} {loading} onclick={load}>Refresh</Button>
			</EmptyState>
		</SectionCard>
	{:else}
		<Stack gap="md">
			<div class="metrics">
				<Card><Metric label="Unsized total" value={summary.total} /></Card>
				<Card><Metric label="With live metrics" value={summary.withRec} /></Card>
				<Card><Metric label="Missing metrics" value={summary.noMetrics} /></Card>
			</div>

			<SectionCard
				title="Unsized resources"
				description="Created before resource limits existed. Applying a size restarts them with the new limits."
				actions={headerActions}
				flush
			>
				<Table columns={COLUMNS} {rows} {rowKey} inset={false} label="Unsized resources">
					{#snippet cell(r, col)}
						{@const key = rowKey(r)}
						{#if col.id === 'target'}
							<ItemLabel
								title={r.name}
								detail="{r.kind === 'database' ? 'Database' : 'App'} · {r.namespace}"
							/>
						{:else if col.id === 'owner'}
							{#if r.organization || r.project}
								<ItemLabel
									title={r.organization?.name ?? r.project?.name ?? ''}
									detail={r.organization ? r.project?.name : null}
								/>
							{:else}
								<span class="quiet">None</span>
							{/if}
						{:else if col.id === 'observed'}
							{#if r.observed}
								<ItemLabel
									title="{formatCpu(r.observed.cpuMilli)} · {formatMemory(r.observed.memoryBytes)}"
									detail="{r.pods} pod{r.pods === 1 ? '' : 's'}"
								/>
							{:else}
								<span class="quiet">No metrics</span>
							{/if}
						{:else if col.id === 'size'}
							<div class="size">
								<Dropdown
									size="sm"
									bind:value={choices[key]}
									ariaLabel="Size for {r.name}"
									options={sizeOptions(r)}
								/>
								{#if choices[key] === 'custom'}
									<div class="custom">
										<Input
											size="sm"
											type="number"
											min="1"
											placeholder="CPU m"
											aria-label="CPU in millicores for {r.name}"
											bind:value={
												() => customCpu[key] ?? '', (v) => (customCpu[key] = String(v ?? ''))
											}
										/>
										<Input
											size="sm"
											type="number"
											min="1"
											placeholder="Memory MiB"
											aria-label="Memory in MiB for {r.name}"
											bind:value={
												() => customMem[key] ?? '', (v) => (customMem[key] = String(v ?? ''))
											}
										/>
									</div>
								{/if}
							</div>
						{:else if status[key] === 'ok'}
							<StatusBadge meta={statusMeta('success', 'Applied')} variant="plain" />
						{:else}
							<Button
								variant="secondary"
								size="sm"
								loading={applyingId === key}
								disabled={!!applyingId || bulkRunning || !resolveChoice(r)}
								onclick={() => applyOne(r)}
							>
								{status[key] === 'error' ? 'Retry' : 'Apply'}
							</Button>
						{/if}
					{/snippet}
				</Table>
			</SectionCard>
		</Stack>
	{/if}
</Swap>

<style>
	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: var(--space-3);
	}
	.quiet {
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.size {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 100%;
		min-width: 0;
		padding-block: var(--space-2);
	}
	.custom {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-2);
	}
</style>
