<script lang="ts">
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { Zap, MemoryStick, RotateCcw } from 'lucide-svelte';
	import type { DatabaseDetail } from './types';

	let {
		database,
		onGoToResources,
		onViewLogs,
	}: {
		database: DatabaseDetail;
		onGoToResources?: () => void;
		onViewLogs?: () => void;
	} = $props();

	// --- Detect conditions from liveStatus ---
	// Check both `message` (current condition) and `lastTerminationReason` (history),
	// so OOMs surface even when the pod is currently "running" between restarts.
	const oomSignal = $derived(
		(database.liveStatus?.message || '') + ' ' + (database.liveStatus?.lastTerminationReason || '')
	);
	const isOOM = $derived(
		/oomkilled|out of memory/i.test(oomSignal)
	);

	const isCrashLoop = $derived(
		/crashloopbackoff|back-?off/i.test(database.liveStatus?.message || '')
	);

	const restartCount = $derived(database.liveStatus?.restartCount ?? 0);
	const highRestarts = $derived(restartCount >= 5);
	const hasAlert = $derived(isOOM || isCrashLoop || highRestarts);

</script>

{#if hasAlert}
	<div class="dba-container">
		{#if isOOM}
			<div class="dba-alert dba-alert--oom" {@attach motionStagger({ index: 0, stride: 0.06, from: { y: -8, opacity: 0, scale: 0.98 } })}>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--oom">
						<Zap size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<div class="dba-title-row">
							<span class="dba-title">OOMKilled — out of memory</span>
							{#if restartCount > 0}
								<span class="dba-restart-badge">
									<RotateCcw size={11} />
									{restartCount}x
								</span>
							{/if}
						</div>
						<span class="dba-desc">
							Your database was killed by the kernel for exceeding its memory limit ({#if database.memoryRequestBytes}{formatMemory(database.memoryRequestBytes)}{:else}128Mi{/if}).
							Increase memory in Resources or fix the memory leak.
						</span>
					</div>
					{#if onGoToResources}
						<button class="dba-action" onclick={onGoToResources}>
							<MemoryStick size={13} />
							Increase memory
						</button>
					{/if}
				</div>
				<div class="dba-oom-bar">
					<div class="dba-oom-bar-fill"></div>
					<span class="dba-oom-bar-label">MEMORY LIMIT EXCEEDED</span>
				</div>
			</div>
		{/if}

		{#if isCrashLoop && !isOOM}
			<div class="dba-alert dba-alert--crash" {@attach motionStagger({ index: 0, stride: 0.06, from: { y: -8, opacity: 0, scale: 0.98 } })}>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--crash">
						<RotateCcw size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<span class="dba-title">CrashLoopBackOff — keeps restarting</span>
						<span class="dba-desc">
							The database keeps crashing on startup and Kubernetes is restarting it in a loop.
							Check the logs for the root cause.
						</span>
					</div>
					{#if onViewLogs}
						<button class="dba-action" onclick={onViewLogs}>
							View logs
						</button>
					{/if}
				</div>
			</div>
		{/if}

		{#if highRestarts && !isOOM && !isCrashLoop}
			<div class="dba-alert dba-alert--restarts" {@attach motionStagger({ index: 0, stride: 0.06, from: { y: -8, opacity: 0, scale: 0.98 } })}>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--restarts">
						<RotateCcw size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<div class="dba-title-row">
							<span class="dba-title">Restarted {restartCount} times</span>
						</div>
						<span class="dba-desc">
							Frequent restarts often mean resource pressure or instability. Check logs for errors.
						</span>
					</div>
					{#if onViewLogs}
						<button class="dba-action" onclick={onViewLogs}>
							View logs
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}

<script lang="ts" module>
	function formatMemory(bytes: number | null | undefined): string {
		if (!bytes) return '—';
		const mb = bytes / (1024 * 1024);
		if (mb < 1024) return `${Math.round(mb)}Mi`;
		return `${(mb / 1024).toFixed(1)}Gi`;
	}
</script>

<style>
	.dba-container {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 1.25rem;
	}

	/* ---------- Shared alert — matches DeploymentAlerts look ---------- */
	.dba-alert {
		position: relative;
		border-radius: 0.75rem;
		overflow: hidden;
		border: 1px solid;
	}
	.dba-alert-inner {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
	}
	.dba-icon-wrap {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-top: 0.0625rem;
	}
	.dba-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.dba-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.dba-title {
		font-size: 0.8125rem;
		font-weight: 600;
		line-height: 1.3;
	}
	.dba-desc {
		font-size: 0.75rem;
		opacity: 0.85;
		line-height: 1.4;
	}
	.dba-action {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.3125rem 0.625rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 600;
		border: 1px solid currentColor;
		background: none;
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		opacity: 0.9;
		align-self: center;
		transition: opacity 120ms, background-color 120ms;
	}
	.dba-action:hover {
		opacity: 1;
		background-color: color-mix(in srgb, currentColor 8%, transparent);
	}
	.dba-restart-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.0625rem 0.4375rem;
		border-radius: 9999px;
		font-size: 0.625rem;
		font-weight: 700;
		font-family: var(--font-mono, 'Space Mono', monospace);
		letter-spacing: 0.04em;
		background-color: color-mix(in srgb, currentColor 12%, transparent);
		border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
	}

	/* ---------- OOM: error-styled card + cyberpunk sweep bar ---------- */
	.dba-alert--oom {
		background-color: color-mix(in srgb, var(--error-text-color) 6%, transparent);
		border-color: color-mix(in srgb, var(--error-text-color) 25%, transparent);
		color: var(--error-text-color);
	}

	/* Animated OOM bar at bottom — keeps the cyberpunk vibe */
	.dba-oom-bar {
		position: relative;
		height: 1.25rem;
		background: color-mix(in srgb, var(--error-text-color) 14%, transparent);
		border-top: 1px solid color-mix(in srgb, var(--error-text-color) 22%, transparent);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.dba-oom-bar-fill {
		position: absolute;
		inset: 0;
		background: linear-gradient(90deg,
			transparent 0%,
			color-mix(in srgb, var(--error-text-color) 25%, transparent) 50%,
			transparent 100%
		);
		animation: dba-bar-sweep 2.8s linear infinite;
	}
	.dba-oom-bar-label {
		position: relative;
		z-index: 1;
		font-size: 0.5625rem;
		font-weight: 700;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--error-text-color) 85%, transparent);
		font-family: var(--font-mono, 'Space Mono', monospace);
	}

	/* ---------- CrashLoop ---------- */
	.dba-alert--crash {
		background-color: color-mix(in srgb, var(--error-text-color) 6%, transparent);
		border-color: color-mix(in srgb, var(--error-text-color) 18%, transparent);
		color: var(--error-text-color);
	}

	/* ---------- High restarts ---------- */
	.dba-alert--restarts {
		background-color: color-mix(in srgb, var(--warning-text) 6%, transparent);
		border-color: color-mix(in srgb, var(--warning-text) 18%, transparent);
		color: var(--warning-text);
	}

	@keyframes dba-bar-sweep {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(100%); }
	}

	@media (max-width: 640px) {
		.dba-alert-inner {
			flex-wrap: wrap;
		}
		.dba-action {
			width: 100%;
			justify-content: center;
			margin-top: 0.25rem;
		}
	}
</style>
