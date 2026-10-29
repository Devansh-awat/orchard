<script lang="ts">
	import { untrack } from 'svelte';
	import { Globe } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import { EmptyState, LogViewer, Modal, StatusBadge, Table } from '$lib/components/ui';
	import type { TableColumn } from '$lib/components/ui/Table.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { httpStatus } from '$lib/components/ui/status';
	import { entryLine, type LogEntry } from './logs.svelte';

	type RequestRow = {
		t: string;
		method: string;
		host: string;
		path: string;
		route: string;
		status: number;
		durationMs: number;
		bytes: number | null;
		clientIp: string;
		userAgent: string;
		pod: string | null;
	};

	let {
		deploymentId,
		active,
		windowMs = 60 * 60_000,
		custom = null
	}: {
		deploymentId: string;
		active: boolean;
		windowMs?: number;
		custom?: { from: number; to: number } | null;
	} = $props();

	const MAX = 500;
	const COLUMNS: TableColumn<RequestRow>[] = [
		{ id: 'time', label: 'Time', width: '7rem' },
		{ id: 'method', label: 'Method', width: '5rem' },
		{ id: 'path', label: 'Path' },
		{ id: 'status', label: 'Status', width: '6rem' },
		{ id: 'duration', label: 'Duration', width: '6rem', align: 'end', numeric: true },
		{ id: 'client', label: 'Client', width: '9rem' }
	];

	let rows = $state<RequestRow[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let picked = $state<RequestRow | null>(null);
	let contextOpen = $state(false);
	let context = $state<LogEntry[]>([]);
	let contextLoading = $state(false);

	const time = (t: string) =>
		new Date(t).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		});

	const key = (r: RequestRow) => `${r.t}|${r.method}|${r.path}|${r.clientIp}|${r.status}`;

	async function load(id: string) {
		loading = true;
		const end = custom ? custom.to : Date.now();
		const start = custom ? custom.from : end - windowMs;
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(id)}/requests?view=recent&start=${start}&end=${end}&limit=${MAX}`
			);
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
			rows = body?.requests ?? [];
			error = null;
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const id = deploymentId;
		void windowMs;
		void custom;
		if (!id || !active) return;
		untrack(() => load(id));
	});

	$effect(() => {
		const id = deploymentId;
		if (!id || !active || custom || error) return;
		const es = new EventSource(
			`/apiv1/observe/deployments/${encodeURIComponent(id)}/requests/stream`
		);
		es.onmessage = (e) => {
			try {
				const fresh: RequestRow[] = JSON.parse(e.data)?.requests ?? [];
				if (!fresh.length) return;
				const known = new Set(rows.map(key));
				const next = fresh.filter((r) => !known.has(key(r)));
				if (next.length) rows = [...next.reverse(), ...rows].slice(0, MAX);
			} catch {
				return;
			}
		};
		return () => es.close();
	});

	async function open(row: RequestRow) {
		picked = row;
		contextOpen = true;
		contextLoading = true;
		context = [];
		const at = Date.parse(row.t);
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(deploymentId)}/logs/context?at=${at}&before=30000&after=30000`
			);
			const body = await res.json().catch(() => null);
			context = res.ok ? (body?.entries ?? []) : [];
		} finally {
			contextLoading = false;
		}
	}

	const contextLines = $derived(context.map(entryLine));
</script>

{#snippet cell(r: RequestRow, col: TableColumn<RequestRow>)}
	{#if col.id === 'time'}
		<span class="mono faint">{time(r.t)}</span>
	{:else if col.id === 'method'}
		<span class="mono">{r.method}</span>
	{:else if col.id === 'path'}
		<span class="mono path" title="{r.host}{r.path}">{r.path}</span>
	{:else if col.id === 'status'}
		<StatusBadge meta={httpStatus(r.status)} />
	{:else if col.id === 'duration'}
		<span class="mono">{Math.round(r.durationMs)} ms</span>
	{:else}
		<span class="mono faint" title={r.userAgent}>{r.clientIp}</span>
	{/if}
{/snippet}

{#if loading && rows.length === 0}
	<Skeleton height="20rem" rounded="calc(var(--radius-widget) * var(--corner-scale))" />
{:else if error}
	<EmptyState title="Requests aren't recorded here" description={error}>
		{#snippet icon()}<Globe size={18} />{/snippet}
	</EmptyState>
{:else if rows.length === 0}
	<EmptyState
		title="No requests in this range"
		description="Requests show up here as they reach the app through its domains."
	>
		{#snippet icon()}<Globe size={18} />{/snippet}
	</EmptyState>
{:else}
	<Table
		label="Requests"
		dense
		columns={COLUMNS}
		{rows}
		{cell}
		rowKey={key}
		rowLabel={(r) => `${r.method} ${r.path} ${r.status}`}
		onRowClick={open}
	/>
{/if}

<Modal
	bind:open={contextOpen}
	title={picked ? `${picked.method} ${picked.path}` : 'Request'}
	size="lg"
>
	<div class="context">
		<LogViewer
			lines={contextLines}
			loading={contextLoading}
			toolbar
			filename="request-context"
			sourceLabel="Pod"
		/>
	</div>
</Modal>

<style>
	.mono {
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
	}
	.faint {
		color: var(--text-faint);
	}
	.path {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.context {
		height: 24rem;
		display: flex;
		flex-direction: column;
	}
</style>
