<script lang="ts" module>
	function formatMemory(bytes: number | null | undefined): string {
		if (!bytes) return 'its limit';
		const mb = bytes / (1024 * 1024);
		if (mb < 1024) return `${Math.round(mb)} MiB`;
		return `${(mb / 1024).toFixed(1)} GiB`;
	}
</script>

<script lang="ts">
	import AlertStack, { type StackAlert } from '$lib/components/patterns/AlertStack.svelte';
	import type { DatabaseDetail } from './types';

	let {
		database,
		memoryBytes = null,
		memoryUpgrade = null,
		onGoToResources,
		onViewLogs,
		onGoToBackups
	}: {
		database: DatabaseDetail;
		memoryBytes?: number | null;
		memoryUpgrade?: { toBytes: number; busy: boolean; run: () => void } | null;
		onGoToResources?: () => void;
		onViewLogs?: () => void;
		onGoToBackups?: () => void;
	} = $props();

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

	const backupsStarved = $derived(
		!!database.backupsEnabled && memoryBytes != null && memoryBytes < 512 * 1024 * 1024
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
			!!database.liveStatus &&
			!database.liveStatus.firstRecoverabilityPoint &&
			database.status === 'ready' &&
			!archivingFailing
	);

	const noPods = $derived(
		database.mode === 'cnpg' &&
			database.liveStatus?.exists === true &&
			!database.liveStatus?.ready &&
			(database.liveStatus?.readyReplicas ?? 0) === 0 &&
			!isRestarting &&
			database.status !== 'stopped' &&
			database.status !== 'provisioning' &&
			database.status !== 'restoring' &&
			database.status !== 'upgrading'
	);
	const stuckPvc = $derived(
		[...(database.liveStatus?.danglingPVC ?? []), ...(database.liveStatus?.unusablePVC ?? [])].join(
			', '
		)
	);

	const alerts = $derived.by((): StackAlert[] => {
		const out: StackAlert[] = [];
		const logs = onViewLogs ? [{ label: 'Logs', onclick: onViewLogs }] : [];
		const resources = (label: string) =>
			onGoToResources ? [{ label, onclick: onGoToResources }] : [];
		const backups = (label: string) => (onGoToBackups ? [{ label, onclick: onGoToBackups }] : []);
		if (!isRestarting && noPods)
			out.push({
				id: 'no-pods',
				tone: 'error',
				title: 'No instance is running',
				hint: stuckPvc
					? `Apps can't connect. A volume is stuck: ${stuckPvc}.`
					: "Apps can't connect until an instance starts.",
				actions: logs
			});
		if (!isRestarting && isOOM)
			out.push({
				id: 'oom',
				tone: 'error',
				title: 'Out of memory',
				hint: `It needs more than ${formatMemory(memoryBytes)} and keeps restarting${restartCount > 1 ? ` (${restartCount} times, last ${lastTerminationAgo})` : ''}.${backupsStarved ? ' Under 512 MiB its backups never finish either.' : ''}`,
				actions: memoryUpgrade
					? [
							{
								label: `Upgrade to ${formatMemory(memoryUpgrade.toBytes)}`,
								primary: true,
								loading: memoryUpgrade.busy,
								onclick: memoryUpgrade.run
							},
							...logs
						]
					: resources('Raise memory')
			});
		if (!isRestarting && isCrashLoop && !isOOM)
			out.push({
				id: 'crashloop',
				tone: 'error',
				title: 'Keeps crashing on start',
				hint: 'The output from before the crash says why.',
				actions: logs
			});
		if (!isRestarting && highRestarts && !isOOM && !isCrashLoop)
			out.push({
				id: 'restarts',
				tone: 'warning',
				title: `Restarted ${restartCount} ${restartCount === 1 ? 'time' : 'times'}`,
				hint: `Last restart ${lastTerminationAgo}.`,
				actions: logs
			});
		if (writesPaused)
			out.push({
				id: 'writes-paused',
				tone: 'error',
				title: 'Writes are paused',
				hint: `The disk is ${volume ? `${volume.percent}%` : 'almost'} full. Reads still work; writes resume below 85%.`,
				actions: resources('Grow the disk')
			});
		if (storageFull && volume && !writesPaused)
			out.push({
				id: 'storage',
				tone: 'warning',
				title: `Disk is ${volume.percent}% full`,
				hint: 'Writes pause at 92%.',
				actions: resources('Grow the disk')
			});
		if (archivingFailing)
			out.push({
				id: 'archiving',
				tone: 'error',
				title: 'Backups are failing',
				hint: archivingMessage || "WAL can't be archived, so recent changes aren't protected.",
				actions: backups('Backups')
			});
		if (walBacklog && !archivingFailing)
			out.push({
				id: 'wal',
				tone: 'warning',
				title: 'Backups are falling behind',
				hint: `${walBacklogGib} GiB of WAL is waiting to be archived.`,
				actions: backups('Backups')
			});
		if (noBackups)
			out.push({
				id: 'no-backups',
				tone: 'warning',
				title: 'No backups yet',
				hint: 'Nothing can be restored if data is lost.',
				actions: backups('Set a schedule')
			});
		return out;
	});
</script>

{#if alerts.length}<AlertStack {alerts} />{/if}
