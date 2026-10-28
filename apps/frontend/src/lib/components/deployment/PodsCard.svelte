<script lang="ts">
	import { FileText, SquareArrowOutUpRight, Trash2 } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import Stepper from '$lib/components/ui/Stepper.svelte';
	import { podStatus } from '$lib/components/ui/status';
	import { stateEcho } from '$lib/utils/motion.svelte';
	import { explainExitCode, formatCpu, formatMemory } from '$lib/utils/format';
	import type { Pod } from '$lib/types/deployment';

	let {
		pods,
		replicas,
		scaleReplicas = $bindable(),
		scaling,
		drift,
		selectedPod,
		deletingPod,
		podLabel,
		podHref,
		onScale,
		onChange,
		onSelect,
		onCrashLogs,
		onDelete
	}: {
		pods: Pod[];
		replicas: number;
		scaleReplicas: number;
		scaling: boolean;
		drift: { stopped: boolean; observed: number; desired: number } | null;
		selectedPod: string;
		deletingPod: string | null;
		podLabel: (name: string) => string;
		podHref: (name: string) => string;
		onScale: () => void;
		onChange: (value: number) => void;
		onSelect: (pod: Pod) => void;
		onCrashLogs: (pod: Pod) => void;
		onDelete: (name: string) => void;
	} = $props();

	function termination(pod: Pod) {
		for (const c of pod.containers ?? []) {
			if (c.lastTermination?.reason && c.lastTermination.reason !== 'Completed') {
				return { reason: c.lastTermination.reason, exitCode: c.lastTermination.exitCode };
			}
		}
		return null;
	}

	function crashLine(restarts: number, term: { reason: string; exitCode?: number | null }) {
		const cause =
			term.reason === 'OOMKilled'
				? 'Out of memory'
				: term.exitCode != null
					? `Exit ${term.exitCode}`
					: term.reason;
		if (restarts === 0) return cause;
		return `${cause} · ${restarts} ${restarts === 1 ? 'restart' : 'restarts'}`;
	}

	const ready = $derived(pods.filter((p) => p.status?.toLowerCase() === 'ready').length);
	const summary = $derived.by(() => {
		if (drift?.stopped) return 'Stopped';
		if (drift) return `Running ${drift.observed} of ${drift.desired}`;
		if (!pods.length) return 'None reporting yet';
		const rest = pods.length - ready;
		return rest ? `${ready} ready, ${rest} not ready` : `${ready} ready`;
	});
	const pending = $derived(scaleReplicas !== replicas);
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
	title="Replicas"
	description={summary}
	flush
	fill
	footer={pending ? scaleBar : undefined}
>
	{#snippet actions()}
		<Stepper
			bind:value={scaleReplicas}
			min={0}
			max={20}
			label="Replicas"
			disabled={scaling}
			onchange={onChange}
		/>
	{/snippet}
	{#if pods.length}
		<List inset={false} label="Pods">
			{#each pods as pod (pod.name)}
				{@const meta = podStatus(pod.status)}
				{@const term = termination(pod)}
				{@const usage = !term && pod.cpuUsage != null && pod.memoryUsage != null}
				<ListRow
					title={podLabel(pod.name)}
					selected={selectedPod === pod.name}
					onclick={() => onSelect(pod)}
				>
					{#snippet leading()}
						<span class="dot" {@attach stateEcho(() => meta.kind)}>
							<StatusDot {meta} size={8} />
						</span>
					{/snippet}
					{#snippet titleSuffix()}
						{#if meta.kind !== 'success'}
							<span class="state state--{meta.kind}">{meta.label}</span>
						{/if}
					{/snippet}
					{#snippet subtitle()}
						{#if term}
							{@const why = explainExitCode(term.exitCode, term.reason)}
							<span class="crash" title={why?.short}>{crashLine(pod.restartCount ?? 0, term)}</span>
						{:else if pod.startTime}
							<span>Started <RelativeTime date={pod.startTime} /></span>
						{/if}
					{/snippet}
					{#snippet trailing()}
						{#if usage}
							<span class="usage">{formatCpu(pod.cpuUsage)} · {formatMemory(pod.memoryUsage)}</span>
						{/if}
					{/snippet}
					{#snippet actions()}
						{#if term}
							<Button
								size="sm"
								variant="ghost"
								icon={FileText}
								label="Crash logs for {podLabel(pod.name)}"
								onclick={() => onCrashLogs(pod)}
							/>
						{/if}
						<Button
							size="sm"
							variant="ghost"
							icon={SquareArrowOutUpRight}
							label="Open {podLabel(pod.name)}"
							href={podHref(pod.name)}
						/>
						<Button
							size="sm"
							variant="ghost"
							icon={Trash2}
							label="Delete {podLabel(pod.name)}"
							loading={deletingPod === pod.name}
							onclick={() => onDelete(pod.name)}
						/>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	{:else}
		<p class="empty">Pods show up here once the first one is scheduled.</p>
	{/if}
</SectionCard>

<style>
	.dot {
		position: relative;
		display: grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
	}
	.state {
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	.state--error {
		color: var(--status-error);
	}
	.state--warning {
		color: var(--status-warning);
	}
	.state--progress {
		color: var(--status-progress);
	}
	.state--info,
	.state--neutral {
		color: var(--text-muted);
	}
	.crash {
		color: var(--status-error);
	}
	.usage {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.empty {
		padding: 1.5rem 1.25rem;
		font-size: var(--text-callout);
		color: var(--text-muted);
		text-align: center;
	}
</style>
