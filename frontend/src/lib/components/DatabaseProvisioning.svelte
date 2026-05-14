<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Check, X, Loader2, Database, AlertTriangle, ChevronDown } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';

	type StepStatus = 'pending' | 'running' | 'done' | 'error';
	interface Step {
		id: string;
		label: string;
		description: string;
		status: StepStatus;
		detail?: string;
	}
	interface KEvent {
		type: string;
		reason: string;
		message: string;
		kind?: string;
		name?: string;
		count?: number;
		lastTimestamp?: string | null;
	}
	interface Provisioning {
		databaseId: string;
		status: string;
		mode: string;
		done: boolean;
		failed: boolean;
		phase?: string;
		hasImport: boolean;
		importStatus?: 'pending' | 'running' | 'completed' | 'failed';
		importLogs?: string;
		steps: Step[];
		events: KEvent[];
		pod?: { name?: string; phase?: string; waiting?: { reason?: string; message?: string } | null } | null;
		importPod?: { name?: string; phase?: string; status?: string } | null;
	}

	interface Props {
		dbId: string;
		dbName: string;
		onDone?: () => void;
	}
	let { dbId, dbName, onDone }: Props = $props();

	let data = $state<Provisioning | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let logsOpen = $state(true);
	let warningsOpen = $state(true);
	let logsRef: HTMLPreElement | null = $state(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let prevLogsLen = 0;
	let firedDone = false;

	async function fetchOnce() {
		try {
			const r = await apiFetch(`/apiv1/databases/${dbId}/provisioning`);
			if (!r.ok) {
				error = `Failed to load provisioning status (${r.status})`;
				return;
			}
			const j = (await r.json()) as Provisioning;
			data = j;
			error = null;
			if (j.done && !firedDone) {
				firedDone = true;
				onDone?.();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load provisioning status';
		} finally {
			loading = false;
		}
	}

	function scheduleNext() {
		if (pollTimer) clearTimeout(pollTimer);
		// Poll faster while not done; stop once it's done or failed.
		if (data?.done) return;
		pollTimer = setTimeout(async () => {
			await fetchOnce();
			scheduleNext();
		}, 2500);
	}

	onMount(() => {
		fetchOnce().then(scheduleNext);
	});
	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
	});

	$effect(() => {
		const logs = data?.importLogs ?? '';
		if (logs.length > prevLogsLen && logsRef) {
			setTimeout(() => {
				if (logsRef) logsRef.scrollTop = logsRef.scrollHeight;
			}, 0);
		}
		prevLogsLen = logs.length;
	});

	const warnings = $derived((data?.events ?? []).filter((e) => e.type === 'Warning'));
	const overallStatus = $derived.by(() => {
		if (!data) return 'loading';
		if (data.failed) return 'failed';
		if (data.done) return 'ready';
		return 'provisioning';
	});
	const completedCount = $derived(data?.steps.filter((s) => s.status === 'done').length ?? 0);
	const totalCount = $derived(data?.steps.length ?? 0);
	const percent = $derived(totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100));

	function relTime(ts?: string | null): string {
		if (!ts) return '';
		const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
		if (s < 60) return `${s}s ago`;
		const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}
</script>

<div class="prov">
	<div class="prov-header">
		<div class="prov-title-row">
			<div class="prov-icon" data-status={overallStatus}>
				{#if overallStatus === 'ready'}
					<Check class="h-4 w-4" />
				{:else if overallStatus === 'failed'}
					<X class="h-4 w-4" />
				{:else}
					<Database class="h-4 w-4" />
				{/if}
			</div>
			<div>
				<h1 class="prov-title">{dbName}</h1>
				<div class="prov-subtitle">
					{#if overallStatus === 'ready'}
						Database is ready
					{:else if overallStatus === 'failed'}
						Provisioning failed — see details below
					{:else if data?.hasImport}
						Provisioning database & migrating data
					{:else}
						Provisioning database
					{/if}
					{#if data?.phase}<span class="prov-phase">· {data.phase}</span>{/if}
				</div>
			</div>
		</div>

		<div class="prov-progress">
			<div class="prov-bar"><div class="prov-bar-fill" data-failed={data?.failed} style="width: {percent}%"></div></div>
			<span class="prov-count">{completedCount} / {totalCount}</span>
		</div>
	</div>

	{#if loading && !data}
		<div class="prov-loading"><Loader2 class="h-5 w-5 animate-spin" /> Loading provisioning status…</div>
	{:else if error}
		<div class="prov-error">{error}</div>
	{:else if data}
		<div class="prov-steps">
			{#each data.steps as step (step.id)}
				<div class="prov-step prov-step-{step.status}">
					<div class="prov-step-icon" data-status={step.status}>
						{#if step.status === 'done'}
							<Check class="h-3.5 w-3.5" />
						{:else if step.status === 'error'}
							<X class="h-3.5 w-3.5" />
						{:else if step.status === 'running'}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<span class="prov-step-dot"></span>
						{/if}
					</div>
					<div class="prov-step-body">
						<div class="prov-step-label">{step.label}</div>
						<div class="prov-step-desc">{step.description}</div>
						{#if step.detail}
							<div class="prov-step-detail" class:prov-step-detail-error={step.status === 'error'}>
								{step.detail}
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>

		{#if data.hasImport && (data.importLogs || data.importPod)}
			<div class="prov-panel">
				<button class="prov-panel-header" onclick={() => (logsOpen = !logsOpen)} type="button">
					<ChevronDown class="h-3.5 w-3.5 prov-chev" style={logsOpen ? '' : 'transform: rotate(-90deg)'} />
					<span class="prov-panel-title">Migration logs</span>
					{#if data.importPod?.phase}
						<span class="prov-pill prov-pill-{data.importStatus === 'failed' ? 'error' : data.importStatus === 'completed' ? 'done' : 'running'}">
							{data.importPod.phase}
						</span>
					{/if}
					{#if data.importPod?.name}
						<span class="prov-panel-sub">{data.importPod.name}</span>
					{/if}
				</button>
				{#if logsOpen}
					<pre class="prov-logs" bind:this={logsRef}>{data.importLogs || 'Waiting for migration job to start…'}</pre>
				{/if}
			</div>
		{/if}

		{#if warnings.length > 0}
			<div class="prov-panel prov-panel-warning">
				<button class="prov-panel-header" onclick={() => (warningsOpen = !warningsOpen)} type="button">
					<ChevronDown class="h-3.5 w-3.5 prov-chev" style={warningsOpen ? '' : 'transform: rotate(-90deg)'} />
					<AlertTriangle class="h-3.5 w-3.5" style="color: rgb(245, 158, 11);" />
					<span class="prov-panel-title">Kubernetes warnings ({warnings.length})</span>
				</button>
				{#if warningsOpen}
					<div class="prov-warnings">
						{#each warnings.slice(-25) as w}
							<div class="prov-warn">
								<div class="prov-warn-row">
									<span class="prov-warn-reason">{w.reason}</span>
									{#if w.kind}<span class="prov-warn-kind">{w.kind}/{w.name}</span>{/if}
									{#if w.count && w.count > 1}<span class="prov-warn-count">×{w.count}</span>{/if}
									<span class="prov-warn-time">{relTime(w.lastTimestamp)}</span>
								</div>
								<div class="prov-warn-msg">{w.message}</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<style>
	.prov {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.prov-header {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.prov-title-row {
		display: flex;
		align-items: center;
		gap: 0.875rem;
	}

	.prov-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--button-bg) 14%, transparent);
		color: var(--button-bg, rgb(59, 130, 246));
	}
	.prov-icon[data-status='ready'] {
		background-color: rgba(34, 197, 94, 0.18);
		color: rgb(34, 197, 94);
	}
	.prov-icon[data-status='failed'] {
		background-color: rgba(239, 68, 68, 0.18);
		color: rgb(239, 68, 68);
	}

	.prov-title {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
	}

	.prov-subtitle {
		margin-top: 0.125rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}

	.prov-phase {
		margin-left: 0.25rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
	}

	.prov-progress {
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}

	.prov-bar {
		flex: 1;
		height: 0.4rem;
		border-radius: 999px;
		background-color: color-mix(in srgb, var(--surface-border) 70%, transparent);
		overflow: hidden;
	}

	.prov-bar-fill {
		height: 100%;
		background-color: var(--button-bg, rgb(59, 130, 246));
		transition: width 400ms ease;
	}
	.prov-bar-fill[data-failed='true'] {
		background-color: rgb(239, 68, 68);
	}

	.prov-count {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.prov-loading,
	.prov-error {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem 1.125rem;
		border-radius: 0.625rem;
		background-color: var(--control-bg);
		border: 1px solid var(--surface-border);
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}
	.prov-error {
		color: rgb(239, 68, 68);
		border-color: rgba(239, 68, 68, 0.4);
	}

	.prov-steps {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--control-bg);
		overflow: hidden;
	}

	.prov-step {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.875rem;
		padding: 0.875rem 1rem;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}
	.prov-step:last-child {
		border-bottom: none;
	}
	.prov-step-running {
		background-color: color-mix(in srgb, var(--button-bg) 5%, transparent);
	}
	.prov-step-error {
		background-color: color-mix(in srgb, rgb(239, 68, 68) 7%, transparent);
	}

	.prov-step-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}
	.prov-step-icon[data-status='done'] {
		background-color: rgb(34, 197, 94);
		color: white;
	}
	.prov-step-icon[data-status='error'] {
		background-color: rgb(239, 68, 68);
		color: white;
	}
	.prov-step-icon[data-status='running'] {
		color: var(--button-bg, rgb(59, 130, 246));
	}
	.prov-step-icon[data-status='pending'] {
		background-color: transparent;
	}

	.prov-step-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 999px;
		background-color: var(--surface-muted);
		opacity: 0.5;
	}

	.prov-step-label {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.prov-step-desc {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.prov-step-detail {
		margin-top: 0.375rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 40%, transparent);
		padding: 0.375rem 0.5rem;
		border-radius: 0.375rem;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.prov-step-detail-error {
		color: rgb(239, 68, 68);
		background-color: rgba(239, 68, 68, 0.1);
	}

	.prov-panel {
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--control-bg);
		overflow: hidden;
	}
	.prov-panel-warning {
		border-color: color-mix(in srgb, rgb(245, 158, 11) 40%, var(--surface-border));
	}

	.prov-panel-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.625rem 0.875rem;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--surface-border);
		cursor: pointer;
		color: var(--center-channel-color);
		font-family: inherit;
		font-size: 0.8125rem;
		text-align: left;
	}
	.prov-panel-header:hover {
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}

	.prov-chev {
		color: var(--surface-muted);
		transition: transform 150ms;
	}

	.prov-panel-title {
		font-weight: 600;
	}

	.prov-panel-sub {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
		color: var(--surface-muted);
		margin-left: auto;
	}

	.prov-pill {
		font-size: 0.65rem;
		font-weight: 600;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.prov-pill-done {
		background-color: rgba(34, 197, 94, 0.18);
		color: rgb(34, 197, 94);
	}
	.prov-pill-running {
		background-color: color-mix(in srgb, var(--button-bg) 18%, transparent);
		color: var(--button-bg, rgb(59, 130, 246));
	}
	.prov-pill-error {
		background-color: rgba(239, 68, 68, 0.18);
		color: rgb(239, 68, 68);
	}

	.prov-logs {
		margin: 0;
		padding: 0.875rem 1rem;
		max-height: 22rem;
		overflow-y: auto;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		line-height: 1.5;
		color: var(--center-channel-color);
		white-space: pre-wrap;
		word-break: break-word;
		background-color: color-mix(in srgb, var(--surface-border) 25%, transparent);
	}

	.prov-warnings {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 0.875rem;
	}

	.prov-warn {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.75rem;
	}

	.prov-warn-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.prov-warn-reason {
		font-weight: 600;
		color: rgb(245, 158, 11);
	}

	.prov-warn-kind {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
		color: var(--surface-muted);
	}

	.prov-warn-count {
		font-size: 0.7rem;
		color: var(--surface-muted);
	}

	.prov-warn-time {
		margin-left: auto;
		font-size: 0.7rem;
		color: var(--surface-muted);
	}

	.prov-warn-msg {
		color: var(--center-channel-color);
		word-break: break-word;
	}
</style>
