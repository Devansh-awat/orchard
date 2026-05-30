<script lang="ts">
	import { animate } from 'motion';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { Zap, MemoryStick, RotateCcw, Cpu } from 'lucide-svelte';
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

	// --- Shake the alert container on OOM ---
	function shakeEntrance(el: HTMLElement) {
		// Initial slam-in from top
		animate(
			el,
			{ y: [-40, 0], opacity: [0, 1], scale: [1.03, 1] },
			{ type: 'spring', stiffness: 600, damping: 22, mass: 0.7 }
		);
		// Horizontal shake after landing
		setTimeout(() => {
			animate(
				el,
				{ x: [0, -6, 8, -8, 5, -3, 2, 0] },
				{ duration: 0.5, easing: 'ease-out' }
			);
		}, 150);
	}

	// --- Animate the restart counter ---
	function counterEntrance(el: HTMLElement) {
		animate(
			el,
			{ scale: [0, 1.3, 1], opacity: [0, 1] },
			{ type: 'spring', stiffness: 500, damping: 18, mass: 0.6, delay: 0.3 }
		);
	}
</script>

{#if hasAlert}
	<div class="dba-container" {@attach shakeEntrance}>
		{#if isOOM}
			<div class="dba-alert dba-alert--oom" {@attach motionStagger({ index: 0, stride: 0.06, from: { y: -12, opacity: 0, scale: 0.96 } })}>
				<div class="dba-oom-glow"></div>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--oom">
						<Zap size={20} strokeWidth={2.5} />
					</div>
					<div class="dba-body">
						<div class="dba-title-row">
							<span class="dba-title dba-glitch" data-text="OOMKilled">OOMKilled</span>
							{#if restartCount > 0}
								<span class="dba-restart-badge" {@attach counterEntrance}>
									<RotateCcw size={12} />
									{restartCount}x
								</span>
							{/if}
						</div>
						<p class="dba-desc">
							Your database was <strong>killed by the kernel</strong> for exceeding its memory limit ({#if database.memoryRequestBytes}{formatMemory(database.memoryRequestBytes)}{:else}128Mi{/if}).
							PostgreSQL needs more room to breathe.
						</p>
					</div>
					{#if onGoToResources}
						<button class="dba-action dba-action--oom" onclick={onGoToResources}>
							<MemoryStick size={14} />
							Increase Memory
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
			<div class="dba-alert dba-alert--crash" {@attach motionStagger({ index: isOOM ? 1 : 0, stride: 0.06, from: { y: -12, opacity: 0, scale: 0.96 } })}>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--crash">
						<RotateCcw size={20} strokeWidth={2.5} />
					</div>
					<div class="dba-body">
						<span class="dba-title">CrashLoopBackOff</span>
						<p class="dba-desc">
							The database keeps crashing on startup and Kubernetes is restarting it in a loop.
							Check the logs for the root cause.
						</p>
					</div>
					{#if onViewLogs}
						<button class="dba-action dba-action--crash" onclick={onViewLogs}>
							View Logs
						</button>
					{/if}
				</div>
			</div>
		{/if}

		{#if highRestarts && !isOOM && !isCrashLoop}
			<div class="dba-alert dba-alert--restarts" {@attach motionStagger({ index: 0, stride: 0.06, from: { y: -12, opacity: 0, scale: 0.96 } })}>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--restarts">
						<RotateCcw size={20} strokeWidth={2.5} />
					</div>
					<div class="dba-body">
						<div class="dba-title-row">
							<span class="dba-title">Frequent restarts</span>
							<span class="dba-restart-badge" {@attach counterEntrance}>
								<RotateCcw size={12} />
								{restartCount}x
							</span>
						</div>
						<p class="dba-desc">
							This database has restarted {restartCount} times. This may indicate instability,
							resource pressure, or configuration issues.
						</p>
					</div>
					{#if onViewLogs}
						<button class="dba-action dba-action--restarts" onclick={onViewLogs}>
							View Logs
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

	/* ---------- Shared alert ---------- */
	.dba-alert {
		position: relative;
		border-radius: 0.875rem;
		overflow: hidden;
		border: 1px solid;
	}
	.dba-alert-inner {
		display: flex;
		align-items: flex-start;
		gap: 0.875rem;
		padding: 1rem 1.25rem;
		position: relative;
		z-index: 1;
	}
	.dba-icon-wrap {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
	}
	.dba-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.dba-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.dba-title {
		font-size: 0.875rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.dba-desc {
		font-size: 0.8125rem;
		line-height: 1.5;
		margin: 0;
		opacity: 0.9;
	}
	.dba-action {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		border: 1px solid;
		background: none;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		align-self: center;
		transition: background-color 120ms, opacity 120ms;
	}
	.dba-action:hover {
		opacity: 1;
	}
	.dba-restart-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 700;
		font-family: var(--font-mono, 'Space Mono', monospace);
		letter-spacing: 0.04em;
	}

	/* ---------- OOM: the dramatic one ---------- */
	.dba-alert--oom {
		background: linear-gradient(135deg, #2a0a0e 0%, #1a0508 50%, #2a0a0e 100%);
		border-color: #ef4444;
		color: #fca5a5;
		box-shadow:
			0 0 20px color-mix(in srgb, #ef4444 30%, transparent),
			0 0 60px color-mix(in srgb, #ef4444 10%, transparent),
			inset 0 1px 0 color-mix(in srgb, #ef4444 20%, transparent);
		animation: dba-oom-pulse 2.5s ease-in-out infinite;
	}
	.dba-alert--oom .dba-title {
		color: #ff6b6b;
		font-size: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.dba-alert--oom .dba-desc {
		color: #f0a0a0;
	}
	.dba-alert--oom .dba-desc strong {
		color: #ff8080;
	}
	.dba-icon--oom {
		background: linear-gradient(135deg, #ef4444, #dc2626);
		color: white;
		box-shadow: 0 0 12px color-mix(in srgb, #ef4444 50%, transparent);
		animation: dba-icon-pulse 1.5s ease-in-out infinite;
	}
	.dba-restart-badge {
		background-color: color-mix(in srgb, #ef4444 25%, transparent);
		color: #ff8080;
		border: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
	}
	.dba-action--oom {
		background: color-mix(in srgb, #ef4444 15%, transparent);
		border-color: #ef4444;
		color: #fca5a5;
	}
	.dba-action--oom:hover {
		background: color-mix(in srgb, #ef4444 25%, transparent);
	}

	/* Animated OOM bar at bottom */
	.dba-oom-bar {
		position: relative;
		height: 1.5rem;
		background: #1a0508;
		border-top: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.dba-oom-bar-fill {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 100%;
		background: linear-gradient(90deg,
			transparent 0%,
			color-mix(in srgb, #ef4444 20%, transparent) 20%,
			color-mix(in srgb, #ef4444 40%, transparent) 50%,
			color-mix(in srgb, #ef4444 20%, transparent) 80%,
			transparent 100%
		);
		animation: dba-bar-sweep 3s linear infinite;
	}
	.dba-oom-bar-label {
		position: relative;
		z-index: 1;
		font-size: 0.5625rem;
		font-weight: 700;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: color-mix(in srgb, #ef4444 70%, transparent);
		font-family: var(--font-mono, 'Space Mono', monospace);
	}

	/* Ambient glow behind the card */
	.dba-oom-glow {
		position: absolute;
		inset: -2px;
		border-radius: 1rem;
		background: radial-gradient(
			ellipse at 30% 20%,
			color-mix(in srgb, #ef4444 15%, transparent),
			transparent 70%
		);
		z-index: 0;
		pointer-events: none;
		animation: dba-glow-shift 4s ease-in-out infinite alternate;
	}

	/* Glitch text effect */
	.dba-glitch {
		position: relative;
	}
	.dba-glitch::before,
	.dba-glitch::after {
		content: attr(data-text);
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	.dba-glitch::before {
		color: #00ffff;
		animation: dba-glitch-1 3s infinite linear alternate-reverse;
		clip-path: polygon(0 0, 100% 0, 100% 33%, 0 33%);
	}
	.dba-glitch::after {
		color: #ff00ff;
		animation: dba-glitch-2 2s infinite linear alternate-reverse;
		clip-path: polygon(0 67%, 100% 67%, 100% 100%, 0 100%);
	}

	/* ---------- CrashLoop ---------- */
	.dba-alert--crash {
		background-color: color-mix(in srgb, #f97316 8%, var(--surface-bg, #fff));
		border-color: color-mix(in srgb, #f97316 35%, transparent);
		color: #c2410c;
	}
	.dba-icon--crash {
		background: linear-gradient(135deg, #f97316, #ea580c);
		color: white;
		animation: dba-spin 2s linear infinite;
	}
	.dba-action--crash {
		border-color: #f97316;
		color: #c2410c;
	}
	.dba-action--crash:hover {
		background-color: color-mix(in srgb, #f97316 12%, transparent);
	}

	/* ---------- High restarts ---------- */
	.dba-alert--restarts {
		background-color: color-mix(in srgb, #eab308 8%, var(--surface-bg, #fff));
		border-color: color-mix(in srgb, #eab308 35%, transparent);
		color: #a16207;
	}
	.dba-icon--restarts {
		background: linear-gradient(135deg, #eab308, #ca8a04);
		color: white;
	}
	.dba-action--restarts {
		border-color: #eab308;
		color: #a16207;
	}
	.dba-action--restarts:hover {
		background-color: color-mix(in srgb, #eab308 12%, transparent);
	}

	/* ---------- Animations ---------- */
	@keyframes dba-oom-pulse {
		0%, 100% {
			box-shadow:
				0 0 20px color-mix(in srgb, #ef4444 30%, transparent),
				0 0 60px color-mix(in srgb, #ef4444 10%, transparent),
				inset 0 1px 0 color-mix(in srgb, #ef4444 20%, transparent);
		}
		50% {
			box-shadow:
				0 0 30px color-mix(in srgb, #ef4444 45%, transparent),
				0 0 80px color-mix(in srgb, #ef4444 15%, transparent),
				inset 0 1px 0 color-mix(in srgb, #ef4444 30%, transparent);
		}
	}
	@keyframes dba-icon-pulse {
		0%, 100% { box-shadow: 0 0 12px color-mix(in srgb, #ef4444 50%, transparent); }
		50% { box-shadow: 0 0 24px color-mix(in srgb, #ef4444 80%, transparent); }
	}
	@keyframes dba-bar-sweep {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(100%); }
	}
	@keyframes dba-glow-shift {
		0% { background: radial-gradient(ellipse at 30% 20%, color-mix(in srgb, #ef4444 15%, transparent), transparent 70%); }
		100% { background: radial-gradient(ellipse at 70% 80%, color-mix(in srgb, #ef4444 12%, transparent), transparent 70%); }
	}
	@keyframes dba-glitch-1 {
		0% { transform: translate(0); }
		20% { transform: translate(-2px, 1px); }
		40% { transform: translate(2px, -1px); }
		60% { transform: translate(-1px, 0); }
		80% { transform: translate(1px, 1px); }
		100% { transform: translate(0); }
	}
	@keyframes dba-glitch-2 {
		0% { transform: translate(0); }
		25% { transform: translate(2px, -1px); }
		50% { transform: translate(-1px, 2px); }
		75% { transform: translate(1px, -1px); }
		100% { transform: translate(0); }
	}
	@keyframes dba-spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
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
