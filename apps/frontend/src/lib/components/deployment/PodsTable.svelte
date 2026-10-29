<script lang="ts">
	import { Button, SectionCard, StatusDot, Stepper, Table, statusMeta } from '$lib/components/ui';
	import type { StatusMeta } from '$lib/components/ui';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { toasts } from '$lib/stores';
	import type { TableColumn, TableSort } from '$lib/components/ui/Table.svelte';
	import { stateEcho } from '$lib/utils/motion.svelte';
	import { formatCpu, formatMemory, humanizeWarning } from '$lib/utils/format';
	import type { Pod } from '$lib/types/deployment';
	import PodSimulator from './PodSimulator.svelte';
	import PodMenu from './PodMenu.svelte';

	type PodWarning = { podName?: string; message: string };

	let {
		deploymentId,
		pods,
		warnings,
		replicas,
		scaleReplicas = $bindable(),
		scaling,
		drift,
		selectedPod,
		podLabel,
		podHref,
		onScale,
		onChange,
		onSelect,
		onCrashLogs,
		onShell,
		onDelete,
		onSimulated
	}: {
		deploymentId: string;
		pods: Pod[];
		warnings: PodWarning[];
		replicas: number;
		scaleReplicas: number;
		scaling: boolean;
		drift: { stopped: boolean; observed: number; desired: number } | null;
		selectedPod: string;
		podLabel: (name: string) => string;
		podHref: (name: string) => string;
		onScale: () => void;
		onChange: (value: number) => void;
		onSelect: (pod: Pod) => void;
		onCrashLogs: (pod: Pod) => void;
		onShell: (podName: string, container: string) => void;
		onDelete: (name: string) => void;
		onSimulated: () => void;
	} = $props();

	type PodState = { label: string; hint: string | null; meta: StatusMeta };

	const STATUS_LABEL: Record<string, string> = {
		ready: 'Running',
		starting: 'Starting',
		scheduled: 'Starting',
		pending: 'Pending',
		crashing: 'Crashing',
		terminating: 'Terminating',
		failed: 'Failed',
		succeeded: 'Completed'
	};

	const meta = statusMeta;

	const SHORT: Record<string, string> = {
		'Crash loop': 'Crash loop',
		"Can't pull container image": 'Image pull failed',
		'Not ready for traffic': 'Not ready',
		'No available nodes': 'Waiting for room',
		"Couldn't place the pod on a node": 'Waiting for room',
		'Pod evicted': 'Evicted',
		'Health check failing': 'Failing health check',
		'App taking too long to start': 'Slow to start'
	};

	function kindOf(status: string): StatusMeta['kind'] {
		if (status === 'ready' || status === 'succeeded') return 'success';
		if (status === 'crashing' || status === 'failed') return 'error';
		if (status === 'terminating') return 'neutral';
		return 'progress';
	}

	function stateOf(pod: Pod): PodState {
		const status = (pod.status ?? '').toLowerCase();
		const kind = kindOf(status);
		const pulse = kind === 'progress' || status === 'terminating';
		if (status === 'ready' || status === 'terminating') {
			return {
				label: STATUS_LABEL[status],
				hint: null,
				meta: meta(kind, STATUS_LABEL[status], pulse)
			};
		}
		const termination = pod.containers?.find((c) => c.lastTermination)?.lastTermination;
		if (termination?.reason === 'OOMKilled') {
			const h = humanizeWarning('OOMKilled');
			return {
				label: 'Out of memory',
				hint: h?.hint ?? null,
				meta: meta('error', 'Out of memory')
			};
		}
		const lines = warnings.filter((w) => w.podName === pod.name).map((w) => w.message);
		for (const line of lines) {
			if (/secret ".+" not found|configmap ".+" not found/i.test(line)) {
				const what = line.match(/(secret|configmap) "([^"]+)"/i);
				return {
					label: what?.[1].toLowerCase() === 'secret' ? 'Missing secret' : 'Missing config',
					hint: what
						? `The pod needs ${what[1].toLowerCase()} "${what[2]}", which does not exist.`
						: null,
					meta: meta('error', 'Missing secret')
				};
			}
		}
		for (const line of lines) {
			const h = humanizeWarning(line);
			if (!h || h.severity === 'info') continue;
			const label = SHORT[h.title.split(' — ')[0]] ?? h.title.split(' — ')[0];
			const tone = h.severity === 'warning' ? 'warning' : kind === 'progress' ? 'warning' : 'error';
			return { label, hint: h.hint, meta: meta(tone, label) };
		}
		if (termination && termination.reason !== 'Completed') {
			const label =
				termination.exitCode != null ? `Exited ${termination.exitCode}` : termination.reason;
			return { label, hint: null, meta: meta('error', label) };
		}
		const label =
			STATUS_LABEL[status] ?? (status ? status[0].toUpperCase() + status.slice(1) : 'Unknown');
		return { label, hint: null, meta: meta(kind, label, pulse) };
	}

	const RANK: Record<string, number> = {
		error: 0,
		warning: 1,
		progress: 2,
		neutral: 3,
		info: 3,
		success: 4
	};

	const rows = $derived(
		pods.map((pod) => ({
			pod,
			name: podLabel(pod.name),
			state: stateOf(pod),
			cpu: pod.cpuUsage ?? null,
			mem: pod.memoryUsage ?? null,
			restarts: pod.restartCount ?? 0
		}))
	);
	type Row = (typeof rows)[number];

	const columns: TableColumn<Row>[] = [
		{ id: 'name', label: 'Pod', width: 'max-content', sortable: true },
		{
			id: 'state',
			label: 'State',
			width: 'minmax(0, 1fr)',
			sortable: true,
			sortValue: (r) => RANK[r.state.meta.kind] ?? 5
		},
		{ id: 'cpu', label: 'CPU', numeric: true, sortable: true },
		{ id: 'mem', label: 'Mem', numeric: true, sortable: true },
		{ id: 'menu', width: '2.25rem' }
	];

	let sort = $state<TableSort | null>({ id: 'state', dir: 'asc' });
	const menus: Record<string, PodMenu | undefined> = {};

	const ready = $derived(rows.filter((r) => r.state.meta.kind === 'success').length);
	const summary = $derived.by(() => {
		if (drift?.stopped) return 'Stopped';
		if (!rows.length) return 'None running yet';
		if (drift) return `${drift.observed} of ${drift.desired} running`;
		const bad = rows.length - ready;
		return bad ? `${ready} of ${rows.length} ready` : `${ready} ready`;
	});
	const pending = $derived(scaleReplicas !== replicas);

	async function copyName(name: string) {
		await navigator.clipboard.writeText(name);
		toasts.add({ title: 'Pod name copied', color: 'success' });
	}
</script>

{#snippet scaleBar()}
	<Button
		variant="ghost"
		size="sm"
		disabled={scaling}
		onclick={() => {
			scaleReplicas = replicas;
			onChange(replicas);
		}}>Cancel</Button
	>
	<Button variant="primary" size="sm" loading={scaling} onclick={onScale}
		>Scale to {scaleReplicas}</Button
	>
{/snippet}

<SectionCard
	title="Pods"
	description={summary}
	flush
	fill
	class="pods"
	footer={pending ? scaleBar : undefined}
>
	{#snippet actions()}
		{#if __ORCHARD_MOCK__}
			<PodSimulator {deploymentId} {podLabel} onchange={onSimulated} />
		{/if}
		<span class="replicas-label" id="replicas-label">Replicas</span>
		<Stepper
			bind:value={scaleReplicas}
			min={0}
			max={20}
			label="Replicas"
			disabled={scaling}
			onchange={onChange}
		/>
	{/snippet}
	<Table
		{columns}
		{rows}
		dense
		compact
		inset={false}
		label="Pods"
		bind:sort
		rowKey={(r) => r.pod.name}
		rowLabel={(r) => `Show logs for ${r.name}`}
		rowSelected={(r) => r.pod.name === selectedPod}
		onRowClick={(r) => onSelect(r.pod)}
		onRowContextMenu={(r, e) => {
			e.preventDefault();
			menus[r.pod.name]?.open();
		}}
		emptyText="Pods show up here once the first one is scheduled"
	>
		{#snippet cell(r, col)}
			{#if col.id === 'name'}
				<span class="pod">
					<span class="dot" {@attach stateEcho(() => r.state.meta.kind)}>
						<StatusDot meta={r.state.meta} size={8} />
					</span>
					<span class="pod-name">{r.name}</span>
				</span>
			{:else if col.id === 'state'}
				{#if r.state.hint}
					<Tooltip text={r.state.hint} delay={0}>
						<span class="state state--{r.state.meta.kind}"
							>{r.state.label}{#if r.restarts}<span class="restarts">
									· {r.restarts}×</span
								>{/if}</span
						>
					</Tooltip>
				{:else}
					<span class="state state--{r.state.meta.kind}"
						>{r.state.label}{#if r.restarts}<span class="restarts">
								· {r.restarts}×</span
							>{/if}</span
					>
				{/if}
			{:else if col.id === 'cpu'}
				<span class="num" class:num--off={!r.cpu}>{r.cpu ? formatCpu(r.cpu) : '—'}</span>
			{:else if col.id === 'mem'}
				<span class="num" class:num--off={!r.mem}>{r.mem ? formatMemory(r.mem) : '—'}</span>
			{:else if col.id === 'menu'}
				{@const name = r.pod.name}
				{@const container = r.pod.containers?.[0]?.name ?? ''}
				<PodMenu
					bind:this={menus[name]}
					label={r.name}
					crashed={!!r.pod.containers?.some((c) => c.lastTermination)}
					canShell={r.pod.status?.toLowerCase() === 'ready' && !!container}
					href={podHref(name)}
					onLogs={() => onSelect(r.pod)}
					onCrashLogs={() => onCrashLogs(r.pod)}
					onShell={() => onShell(name, container)}
					onCopy={() => copyName(name)}
					onDelete={() => onDelete(name)}
				/>
			{/if}
		{/snippet}
	</Table>
</SectionCard>

<style>
	.replicas-label {
		margin-left: 0.25rem;
		font-size: var(--text-footnote);
		color: var(--text-muted);
	}
	.pod {
		display: inline-flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
	}
	.dot {
		position: relative;
		display: grid;
		place-items: center;
		width: 0.875rem;
		height: 0.875rem;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.pod-name {
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		color: var(--text-default);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.state {
		overflow: hidden;
		font-size: var(--text-footnote);
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.state--error {
		color: var(--status-error);
		font-weight: var(--weight-semibold);
	}
	.state--warning {
		color: var(--status-warning);
	}
	.state--progress {
		color: var(--status-progress);
	}
	.num {
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		font-variant-numeric: tabular-nums;
		color: var(--text-default);
	}
	.num--quiet,
	.num--off {
		color: var(--text-faint);
	}
	.num--warn {
		color: var(--status-warning);
	}
	.num--bad {
		color: var(--status-error);
		font-weight: var(--weight-semibold);
	}
	.restarts {
		font-family: var(--font-mono);
		font-weight: var(--weight-regular);
		opacity: 0.8;
	}
</style>
