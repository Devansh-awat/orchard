<script lang="ts" module>
	function formatMemory(bytes: number | null | undefined): string {
		if (!bytes) return '—';
		const mb = bytes / (1024 * 1024);
		if (mb < 1024) return `${Math.round(mb)}Mi`;
		return `${(mb / 1024).toFixed(1)}Gi`;
	}
</script>

<script lang="ts">
	import { motionStagger } from '$lib/utils/motion.svelte';
	import {
		Zap,
		MemoryStick,
		RotateCcw,
		CloudOff,
		DatabaseBackup,
		HardDrive,
		ServerCrash
	} from 'lucide-svelte';
	import type { DatabaseDetail } from './types';

	let {
		database,
		onGoToResources,
		onViewLogs,
		onGoToBackups
	}: {
		database: DatabaseDetail;
		onGoToResources?: () => void;
		onViewLogs?: () => void;
		onGoToBackups?: () => void;
	} = $props();

	// --- Detect conditions from liveStatus ---
	// Check both `message` (current condition) and `lastTerminationReason` (history),
	// so OOMs surface even when the pod is currently "running" between restarts.
	const lastTerminationAgoMs = $derived.by(() => {
		const at = database.liveStatus?.lastTerminationAt;
		const t = at ? Date.parse(at) : NaN;
		return Number.isFinite(t) ? Date.now() - t : Infinity;
	});
	const recentTermination = $derived(lastTerminationAgoMs < 60 * 60 * 1000);
	const lastTerminationAgo = $derived.by(() => {
		const minutes = Math.max(1, Math.round(lastTerminationAgoMs / 60000));
		return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
	});

	const isOOM = $derived(
		/oomkilled|out of memory/i.test(database.liveStatus?.message || '') ||
			(recentTermination &&
				/oomkilled|out of memory/i.test(database.liveStatus?.lastTerminationReason || ''))
	);

	const isCrashLoop = $derived(
		/crashloopbackoff|back-?off/i.test(database.liveStatus?.message || '')
	);

	const restartCount = $derived(database.liveStatus?.restartCount ?? 0);
	const highRestarts = $derived(restartCount >= 1 && recentTermination);
	const isRestarting = $derived(database.status === 'restarting');

	const archiving = $derived(database.liveStatus?.archiving);
	const archivingFailing = $derived(
		!!archiving && !archiving.ok && database.mode === 'cnpg' && database.status !== 'stopped'
	);
	const archivingMessage = $derived((archiving?.message || '').split('\n')[0].slice(0, 180));

	const volume = $derived(database.liveStatus?.volume ?? null);
	const storageFull = $derived(
		database.mode === 'cnpg' &&
			database.status !== 'stopped' &&
			volume != null &&
			volume.percent >= 85
	);
	const writesPaused = $derived(
		database.mode === 'cnpg' && database.status !== 'stopped' && !!database.liveStatus?.writeGuard
	);
	const walPending = $derived(database.liveStatus?.walPendingSegments ?? 0);
	const walBacklog = $derived(
		database.mode === 'cnpg' && database.status !== 'stopped' && walPending >= 64
	);
	const walBacklogGib = $derived(((walPending * 16) / 1024).toFixed(1));

	const noBackups = $derived(
		database.mode === 'cnpg' &&
			!!database.backupsEnabled &&
			!database.backupScheduleCron &&
			!database.liveStatus?.firstRecoverabilityPoint &&
			database.status === 'ready' &&
			!archivingFailing
	);

	// CNPG happily reports "Cluster in healthy state" while holding a dangling
	// PVC and running no pod at all, so none of the conditions above fire and the
	// page reads as merely quiet. Two production databases sat like that for over
	// a month. Trust the counts, not the phase string.
	const noPods = $derived(
		database.mode === 'cnpg' &&
			database.liveStatus?.exists === true &&
			!database.liveStatus?.ready &&
			(database.liveStatus?.readyReplicas ?? 0) === 0 &&
			!isRestarting &&
			database.status !== 'stopped' &&
			database.status !== 'provisioning' &&
			database.status !== 'restoring'
	);
	const stuckPvc = $derived(
		[...(database.liveStatus?.danglingPVC ?? []), ...(database.liveStatus?.unusablePVC ?? [])].join(
			', '
		)
	);

	const hasAlert = $derived(
		(!isRestarting && (isOOM || isCrashLoop || highRestarts || noPods)) ||
			archivingFailing ||
			storageFull ||
			writesPaused ||
			walBacklog ||
			noBackups
	);
</script>

{#if hasAlert}
	<div class="dba-container">
		{#if noPods}
			<div
				class="dba-alert dba-alert--crash"
				{@attach motionStagger({ index: 0, from: { y: -8, opacity: 0 } })}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--crash">
						<ServerCrash size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<div class="dba-title-row">
							<span class="dba-title">No instance running</span>
						</div>
						<span class="dba-desc">
							{#if stuckPvc}
								This database has no running pod. Its storage volume ({stuckPvc}) is not attached to
								anything, so Kubernetes will not start it back up on its own. An administrator needs
								to look at the cluster.
							{:else}
								This database has no running pod, so nothing can connect to it.
							{/if}
						</span>
					</div>
					{#if onViewLogs}
						<button class="dba-action" onclick={onViewLogs}> View logs </button>
					{/if}
				</div>
			</div>
		{/if}

		{#if isOOM}
			<div
				class="dba-alert dba-alert--oom"
				{@attach motionStagger({
					index: 0,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--oom">
						<Zap size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<div class="dba-title-row">
							<span class="dba-title">OOMKilled: out of memory</span>
							{#if restartCount > 0}
								<span class="dba-restart-badge">
									<RotateCcw size={11} />
									{restartCount}x
								</span>
							{/if}
						</div>
						<span class="dba-desc">
							Your database was killed by the kernel for exceeding its memory limit ({#if database.memoryRequestBytes}{formatMemory(
									database.memoryRequestBytes
								)}{:else}128Mi{/if}). Increase memory in Resources.
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
			<div
				class="dba-alert dba-alert--crash"
				{@attach motionStagger({
					index: 0,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--crash">
						<RotateCcw size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<span class="dba-title">CrashLoopBackOff: keeps restarting</span>
						<span class="dba-desc">
							The database keeps crashing on startup and Kubernetes is restarting it in a loop.
							Check the logs for the root cause.
						</span>
					</div>
					{#if onViewLogs}
						<button class="dba-action" onclick={onViewLogs}> View logs </button>
					{/if}
				</div>
			</div>
		{/if}

		{#if highRestarts && !isOOM && !isCrashLoop}
			<div
				class="dba-alert dba-alert--restarts"
				{@attach motionStagger({
					index: 0,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap dba-icon--restarts">
						<RotateCcw size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<div class="dba-title-row">
							<span class="dba-title"
								>Restarted {restartCount}
								{restartCount === 1 ? 'time' : 'times'}, last {lastTerminationAgo}</span
							>
						</div>
						<span class="dba-desc">
							Frequent restarts often mean resource pressure or instability. Check logs for errors.
						</span>
					</div>
					{#if onViewLogs}
						<button class="dba-action" onclick={onViewLogs}> View logs </button>
					{/if}
				</div>
			</div>
		{/if}

		{#if writesPaused}
			<div
				class="dba-alert dba-alert--storage"
				{@attach motionStagger({
					index: 1,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap">
						<HardDrive size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<span class="dba-title"
							>Writes paused: the volume is {volume ? `${volume.percent}%` : 'almost'} full</span
						>
						<span class="dba-desc">
							Orchard switched this database to read-only so it stays up instead of crashing on a
							full disk. Reads and backups keep working. Writes resume on their own once the volume
							is under 85% full{database.liveStatus?.resumeWritesAt
								? `: expand storage to at least ${database.liveStatus.resumeWritesAt} or free space.`
								: '.'}
						</span>
					</div>
					{#if onGoToResources}
						<button class="dba-action" onclick={onGoToResources}>
							<HardDrive size={13} />
							Expand storage
						</button>
					{/if}
				</div>
			</div>
		{/if}

		{#if storageFull && volume && !writesPaused}
			<div
				class="dba-alert dba-alert--storage"
				{@attach motionStagger({
					index: 1,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap">
						<HardDrive size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<span class="dba-title">Storage almost full: {volume.percent}% used</span>
						<span class="dba-desc">
							{volume.used} of {volume.capacity} is in use, including WAL. PostgreSQL refuses to start
							once the volume fills, so expand storage before it does.
						</span>
					</div>
					{#if onGoToResources}
						<button class="dba-action" onclick={onGoToResources}>
							<HardDrive size={13} />
							Expand storage
						</button>
					{/if}
				</div>
			</div>
		{/if}

		{#if walBacklog && !archivingFailing}
			<div
				class="dba-alert dba-alert--archiving"
				{@attach motionStagger({
					index: 1,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap">
						<CloudOff size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<span class="dba-title">Backup archiving is falling behind</span>
						<span class="dba-desc">
							{walPending} WAL segments ({walBacklogGib} GiB) are waiting to be uploaded. PostgreSQL cannot
							recycle them until they are archived, so they take up volume space until the upload catches
							up.
						</span>
					</div>
					{#if onGoToBackups}
						<button class="dba-action" onclick={onGoToBackups}> View backups </button>
					{/if}
				</div>
			</div>
		{/if}

		{#if archivingFailing}
			<div
				class="dba-alert dba-alert--archiving"
				{@attach motionStagger({
					index: 1,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap">
						<CloudOff size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<span class="dba-title">Backup archiving is failing</span>
						<span class="dba-desc">
							WAL segments are not reaching the backup store, so restores are falling behind and
							files will pile up on disk until archiving recovers.
						</span>
						{#if archivingMessage}
							<span class="dba-detail">{archivingMessage}</span>
						{/if}
					</div>
					{#if onGoToBackups}
						<button class="dba-action" onclick={onGoToBackups}> View backups </button>
					{/if}
				</div>
			</div>
		{/if}

		{#if noBackups}
			<div
				class="dba-alert dba-alert--nobackups"
				{@attach motionStagger({
					index: 1,
					from: { y: -8, opacity: 0 }
				})}
			>
				<div class="dba-alert-inner">
					<div class="dba-icon-wrap">
						<DatabaseBackup size={16} strokeWidth={2.25} />
					</div>
					<div class="dba-body">
						<span class="dba-title">No backups configured</span>
						<span class="dba-desc">
							This database has no backup schedule and no backups yet. Restores are only possible
							from a backup.
						</span>
					</div>
					{#if onGoToBackups}
						<button class="dba-action" onclick={onGoToBackups}> Set a schedule </button>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}

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
		border-radius: var(--radius-md);
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
		font-size: var(--text-footnote);
		font-weight: 600;
		line-height: 1.3;
	}
	.dba-desc {
		font-size: var(--text-caption);
		opacity: 0.85;
		line-height: 1.4;
	}
	.dba-action {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3125rem 0.75rem;
		border-radius: var(--radius-xs);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		border: 1px solid currentColor;
		background: none;
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		opacity: 0.9;
		align-self: center;
		transition:
			opacity var(--dur-fast),
			background-color var(--dur-fast);
	}
	.dba-action:hover {
		opacity: 1;
		background-color: color-mix(in srgb, currentColor 8%, transparent);
	}
	.dba-restart-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.0625rem 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 700;
		font-family: var(--font-mono);
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
		background: linear-gradient(
			90deg,
			transparent 0%,
			color-mix(in srgb, var(--error-text-color) 25%, transparent) 50%,
			transparent 100%
		);
		animation: dba-bar-sweep 2.8s linear infinite;
	}
	.dba-oom-bar-label {
		position: relative;
		z-index: 1;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 700;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--error-text-color) 85%, transparent);
		font-family: var(--font-mono);
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

	.dba-alert--archiving {
		background-color: color-mix(in srgb, var(--status-error) 6%, transparent);
		border-color: color-mix(in srgb, var(--status-error) 18%, transparent);
		color: var(--status-error);
	}

	.dba-alert--storage {
		background-color: color-mix(in srgb, var(--status-error) 6%, transparent);
		border-color: color-mix(in srgb, var(--status-error) 18%, transparent);
		color: var(--status-error);
	}

	.dba-alert--nobackups {
		background-color: color-mix(in srgb, var(--status-warning) 6%, transparent);
		border-color: color-mix(in srgb, var(--status-warning) 18%, transparent);
		color: var(--status-warning);
	}

	.dba-detail {
		font-size: var(--text-micro);
		font-family: var(--font-mono);
		opacity: 0.7;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	@keyframes dba-bar-sweep {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(100%);
		}
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
