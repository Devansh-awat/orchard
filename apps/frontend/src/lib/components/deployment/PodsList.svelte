<script lang="ts">
	import { RotateCcw } from 'lucide-svelte';
	import { Button, SectionCard, StatusDot, Stepper, statusMeta } from '$lib/components/ui';
	import type { StatusMeta } from '$lib/components/ui';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { toasts } from '$lib/stores';
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

	const meta = statusMeta;

	const SHORT: Record<string, string> = {
		"Can't pull container image": 'Image pull failed',
		'Not ready for traffic': 'Not ready',
		'No available nodes': 'Waiting for room',
		"Couldn't place the pod on a node": 'Waiting for room',
		'Pod evicted': 'Evicted',
		'Health check failing': 'Failing health check',
		'App taking too long to start': 'Slow to start'
	};

	const STATUS_LABEL: Record<string, string> = {
		ready: 'Running',
		starting: 'Starting',
		scheduled: 'Starting',
		pending: 'Waiting to start',
		crashing: 'Crashing',
		terminating: 'Shutting down',
		failed: 'Stopped',
		succeeded: 'Finished'
	};

	const STATUS_HINT: Record<string, string> = {
		ready: 'Serving traffic',
		starting: 'Booting up',
		scheduled: 'Booting up',
		pending: 'Waiting for a place to run',
		terminating: 'Replaced by a newer pod'
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
		const pulse = kind === 'progress';
		if (status === 'ready' || status === 'terminating') {
			return {
				label: STATUS_LABEL[status],
				hint: STATUS_HINT[status],
				meta: meta(kind, STATUS_LABEL[status], pulse)
			};
		}
		const termination = pod.containers?.find((c) => c.lastTermination)?.lastTermination;
		if (termination?.reason === 'OOMKilled') {
			return {
				label: 'Out of memory',
				hint: humanizeWarning('OOMKilled')?.hint ?? null,
				meta: meta('error', 'Out of memory')
			};
		}
		const lines = warnings.filter((w) => w.podName === pod.name).map((w) => w.message);
		for (const line of lines) {
			const what = line.match(/(secret|configmap) "([^"]+)" not found/i);
			if (what) {
				const thing = what[1].toLowerCase() === 'secret' ? 'secret' : 'config';
				return {
					label: `Missing ${thing}`,
					hint: `Needs ${what[1].toLowerCase()} "${what[2]}", which does not exist.`,
					meta: meta('error', `Missing ${thing}`)
				};
			}
		}
		for (const line of lines) {
			const h = humanizeWarning(line);
			if (!h || h.severity === 'info') continue;
			const base = h.title.split(' — ')[0];
			const label = SHORT[base] ?? base;
			const tone = h.severity === 'warning' || kind === 'progress' ? 'warning' : 'error';
			return { label, hint: h.hint, meta: meta(tone, label) };
		}
		if (termination && termination.reason !== 'Completed') {
			const label =
				termination.exitCode != null ? `Exited with ${termination.exitCode}` : termination.reason;
			return { label, hint: null, meta: meta('error', label) };
		}
		const label =
			STATUS_LABEL[status] ?? (status ? status[0].toUpperCase() + status.slice(1) : 'Unknown');
		return { label, hint: STATUS_HINT[status] ?? null, meta: meta(kind, label, pulse) };
	}

	function uptime(start?: string | null) {
		if (!start) return null;
		const s = Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 1000));
		const d = Math.floor(s / 86400);
		const h = Math.floor((s % 86400) / 3600);
		const m = Math.floor((s % 3600) / 60);
		if (d) return h ? `${d}d ${h}h` : `${d}d`;
		if (h) return m ? `${h}h ${m}m` : `${h}h`;
		return m ? `${m}m` : 'just now';
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
		pods
			.map((pod) => {
				const state = stateOf(pod);
				const restarts = pod.restartCount ?? 0;
				const up = uptime(pod.startTime);
				const healthy = state.meta.kind === 'success' || state.meta.kind === 'neutral';
				const detail = healthy
					? up && `up ${up}`
					: restarts
						? `restarted ${restarts} ${restarts === 1 ? 'time' : 'times'}`
						: null;
				return { pod, name: podLabel(pod.name), state, restarts, detail };
			})
			.sort((a, b) => (RANK[a.state.meta.kind] ?? 5) - (RANK[b.state.meta.kind] ?? 5))
	);

	const ready = $derived(rows.filter((r) => r.state.meta.kind === 'success').length);
	const summary = $derived.by(() => {
		if (drift?.stopped) return 'Stopped';
		if (!rows.length) return 'None yet';
		return `${ready} of ${rows.length} running`;
	});
	const pending = $derived(scaleReplicas !== replicas);
	const menus: Record<string, PodMenu | undefined> = {};

	async function copyName(name: string) {
		await navigator.clipboard.writeText(name);
		toasts.add({ title: 'Pod name copied', color: 'success' });
	}

	function reset() {
		scaleReplicas = replicas;
		onChange(replicas);
	}
</script>

{#snippet replicaBar()}
	<div class="replicas">
		<div class="replicas-copy">
			<span class="replicas-label" id="{deploymentId}-replicas">Replicas</span>
			<span class="replicas-hint"
				>{pending ? `Running ${replicas} now` : 'How many pods to keep running'}</span
			>
		</div>
		<div class="replicas-controls">
			{#if pending}
				<Button
					variant="ghost"
					size="sm"
					icon={RotateCcw}
					label="Undo"
					disabled={scaling}
					onclick={reset}
				/>
			{/if}
			<Stepper
				bind:value={scaleReplicas}
				min={0}
				max={20}
				label="Replicas"
				disabled={scaling}
				onchange={onChange}
			/>
			{#if pending}
				<Button variant="primary" size="sm" loading={scaling} onclick={onScale}>Apply</Button>
			{/if}
		</div>
	</div>
{/snippet}

<SectionCard title="Pods" size="sm" flush class="pods" footer={replicaBar}>
	{#snippet actions()}
		<span class="summary" class:summary--bad={ready < rows.length}>{summary}</span>
		{#if __ORCHARD_MOCK__}
			<PodSimulator {deploymentId} {podLabel} onchange={onSimulated} />
		{/if}
	{/snippet}
	{#if rows.length}
		<ul class="list" aria-label="Pods">
			{#each rows as r (r.pod.name)}
				{@const container = r.pod.containers?.[0]?.name ?? ''}
				<li
					class="pod"
					class:pod--selected={r.pod.name === selectedPod}
					onclick={(e) => {
						if (!(e.target as HTMLElement).closest('.menu, .hit')) onSelect(r.pod);
					}}
					oncontextmenu={(e) => {
						e.preventDefault();
						menus[r.pod.name]?.open();
					}}
				>
					<button
						type="button"
						class="hit"
						aria-label="Show logs for {r.name}"
						aria-current={r.pod.name === selectedPod ? 'true' : undefined}
						onclick={() => onSelect(r.pod)}
					></button>
					<span class="dot" {@attach stateEcho(() => r.state.meta.kind)}>
						<StatusDot meta={r.state.meta} size={8} />
					</span>
					<span class="text">
						{#if r.state.hint}
							<Tooltip text={r.state.hint} delay={200}>
								<span class="state state--{r.state.meta.kind}">{r.state.label}</span>
							</Tooltip>
						{:else}
							<span class="state state--{r.state.meta.kind}">{r.state.label}</span>
						{/if}
						<span class="sub">
							<span class="mono">{r.name}</span>{#if r.detail}<span class="sep">·</span
								>{r.detail}{/if}
						</span>
					</span>
					<span class="usage" aria-label="CPU and memory">
						{#if r.pod.cpuUsage}
							<span>{formatCpu(r.pod.cpuUsage)}</span>
							<span>{formatMemory(r.pod.memoryUsage)}</span>
						{/if}
					</span>
					<span class="menu">
						<PodMenu
							bind:this={menus[r.pod.name]}
							label={r.name}
							crashed={!!r.pod.containers?.some((c) => c.lastTermination)}
							canShell={r.pod.status?.toLowerCase() === 'ready' && !!container}
							href={podHref(r.pod.name)}
							onLogs={() => onSelect(r.pod)}
							onCrashLogs={() => onCrashLogs(r.pod)}
							onShell={() => onShell(r.pod.name, container)}
							onCopy={() => copyName(r.pod.name)}
							onDelete={() => onDelete(r.pod.name)}
						/>
					</span>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="empty">Pods show up here once the first one is scheduled.</p>
	{/if}
</SectionCard>

<style>
	.summary {
		font-size: var(--text-footnote);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.summary--bad {
		color: var(--status-warning);
	}
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.pod {
		position: relative;
		display: grid;
		grid-template-columns: 0.5rem minmax(0, 1fr) auto 1.75rem;
		align-items: center;
		column-gap: 0.75rem;
		min-height: 3.25rem;
		padding: 0.5rem 0.8125rem 0.5rem 1.25rem;
	}
	.pod + .pod::before {
		content: '';
		position: absolute;
		top: 0;
		left: 1.25rem;
		right: 1.25rem;
		height: 1px;
		background: var(--border-default);
	}
	.pod:hover {
		background: var(--bg-hover);
	}
	.pod--selected,
	.pod--selected:hover {
		background: var(--bg-active);
	}
	.pod:hover::before,
	.pod:hover + .pod::before,
	.pod--selected::before,
	.pod--selected + .pod::before {
		opacity: 0;
	}
	.hit {
		position: absolute;
		inset: 0;
		border: none;
		background: none;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.dot,
	.text,
	.usage,
	.menu {
		position: relative;
	}
	.pod {
		cursor: pointer;
	}
	.dot {
		display: grid;
		place-items: center;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.state {
		width: fit-content;
		max-width: 100%;
		overflow: hidden;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: var(--weight-medium);
		color: var(--text-default);
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
	.sub {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		overflow: hidden;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.sep {
		color: var(--text-faint);
	}
	.usage {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.menu {
		display: flex;
		justify-content: flex-end;
	}
	.empty {
		padding: 1.5rem 1.25rem;
		font-size: var(--text-callout);
		color: var(--text-muted);
		text-align: center;
	}
	.replicas {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-width: 0;
	}
	.replicas-copy {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.replicas-label {
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.replicas-hint {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.replicas-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
</style>
