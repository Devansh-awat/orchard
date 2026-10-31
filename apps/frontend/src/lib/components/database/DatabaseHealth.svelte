<script lang="ts">
	import { CheckList, StatusDot, statusMeta } from '$lib/components/ui';
	import type { CheckItem } from '$lib/components/ui';
	import type { StatusMeta } from '$lib/components/ui/status';
	import Widget from '$lib/components/ui/Widget.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import { onMount } from 'svelte';
	import { apiFetch } from '$lib/stores';
	import { securityHeadline } from './versions';
	import type { DatabaseDetail, DatabasePod, DatabaseSecurity } from './types';

	let {
		database,
		maxConnections = null,
		backupsHref,
		versionHref = undefined,
		settingsHref = undefined
	}: {
		database: DatabaseDetail;
		maxConnections?: number | null;
		backupsHref: string;
		versionHref?: string;
		settingsHref?: string;
	} = $props();

	let security = $state<DatabaseSecurity | null>(null);

	onMount(async () => {
		if (database.mode !== 'cnpg') return;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/security`);
			if (res.ok) security = await res.json();
		} catch {
			security = null;
		}
	});

	const securityLine = $derived(security ? securityHeadline(security) : null);
	const securityBad = $derived(
		!!security &&
			(security.supported === false ||
				security.action === 'major_upgrade' ||
				(security.highestScore ?? 0) >= 7)
	);

	const WAL_SEGMENT = 16 * 1024 ** 2;
	const WAL_ALERT = 64;

	function bytes(v: number) {
		if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
		if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
		return `${Math.round(v / 1024)} KB`;
	}

	function amount(used: number, max: number, format: (v: number) => string) {
		const a = format(used);
		const b = format(max);
		const unit = b.split(' ')[1];
		return unit && a.endsWith(` ${unit}`) ? `${a.split(' ')[0]} of ${b}` : `${a} of ${b}`;
	}

	function gauge(
		id: string,
		label: string,
		used: number | null | undefined,
		max: number | null | undefined,
		format: (v: number) => string
	): CheckItem {
		if (used == null || !max) {
			return {
				id,
				label,
				value: 'Not measured',
				ratio: null,
				meta: statusMeta('neutral', 'Not measured')
			};
		}
		const ratio = used / max;
		const pct = `${Math.round(ratio * 100)}%`;
		const meta =
			ratio >= 0.85
				? statusMeta('error', `${label} ${pct} full`)
				: ratio >= 0.75
					? statusMeta('warning', `${label} ${pct} full`)
					: statusMeta('success', `${label} ${pct} used`);
		return { id, label, value: amount(used, max, format), ratio, meta };
	}

	function podReady(pod: DatabasePod) {
		const list = pod.containerStatuses ?? pod.containers ?? [];
		return list.length > 0 && list.every((c) => c.ready);
	}

	function podMeta(pod: DatabasePod): StatusMeta {
		if (podReady(pod)) return statusMeta('success', 'Ready');
		if (pod.status === 'Pending' || pod.status === 'Running')
			return statusMeta('progress', 'Starting', true);
		return statusMeta('error', pod.status ?? 'Not ready');
	}

	const primaryName = $derived(
		database.liveStatus?.currentPrimary ??
			database.pods?.find(
				(p) => p.role === 'primary' || p.labels?.['cnpg.io/instanceRole'] === 'primary'
			)?.name ??
			null
	);

	const pods = $derived(
		database.mode === 'cnpg'
			? [...(database.pods ?? [])].sort(
					(a, b) =>
						Number(b.name === primaryName) - Number(a.name === primaryName) ||
						a.name.localeCompare(b.name)
				)
			: []
	);

	const live = $derived(database.liveStatus);
	const wal = $derived(live?.walPendingSegments ?? 0);

	const checks = $derived.by((): CheckItem[] => {
		const out: CheckItem[] = pods.map((pod) => {
			const meta = podMeta(pod);
			const restarts = (pod.containerStatuses ?? []).reduce((n, c) => n + (c.restartCount ?? 0), 0);
			return {
				id: `pod:${pod.name}`,
				label: pod.name === primaryName ? 'Primary' : 'Standby',
				detail: pod.name,
				value: restarts ? `${restarts} ${restarts === 1 ? 'restart' : 'restarts'}` : meta.label,
				meta
			};
		});
		out.push(gauge('disk', 'Disk', live?.volume?.usedBytes, live?.volume?.capacityBytes, bytes));
		out.push(
			gauge('connections', 'Connections', live?.connections, maxConnections, (v) =>
				String(Math.round(v))
			)
		);
		if (wal > 0) {
			out.push({
				...gauge('wal', 'WAL to archive', wal * WAL_SEGMENT, WAL_ALERT * WAL_SEGMENT, bytes),
				value: `${wal} ${wal === 1 ? 'file' : 'files'}`
			});
		}
		if (database.mode === 'cnpg') {
			if (live?.archiving && !live.archiving.ok) {
				out.push({
					id: 'backups',
					label: 'Backups',
					detail: live.archiving.message ?? null,
					value: 'Archiving failed',
					meta: statusMeta('error', 'Archiving failed'),
					href: backupsHref
				});
			} else if (live?.lastSuccessfulBackup) {
				out.push({
					id: 'backups',
					label: 'Backups',
					detail: live.firstRecoverabilityPoint
						? `since ${new Date(live.firstRecoverabilityPoint).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
						: null,
					value: formatRelativeTime(new Date(live.lastSuccessfulBackup)).replace(
						/^(\d+\w) \d+m ago$/,
						'$1 ago'
					),
					meta: statusMeta('success', 'Backed up'),
					href: backupsHref
				});
			} else {
				out.push({
					id: 'backups',
					label: 'Backups',
					value: 'None yet',
					meta: statusMeta('warning', 'No backups'),
					href: backupsHref
				});
			}
		}
		if (securityLine && versionHref) {
			out.push({
				id: 'version',
				label: 'Version',
				detail: securityLine,
				meta: statusMeta(securityBad ? 'error' : 'warning', 'Version needs attention'),
				href: versionHref
			});
		}
		return out;
	});

	const VERDICTS = {
		healthy: statusMeta('success', 'Healthy'),
		degraded: statusMeta('warning', 'Degraded'),
		unprotected: statusMeta('warning', 'Unprotected'),
		down: statusMeta('error', 'Down'),
		hibernated: statusMeta('neutral', 'Stopped')
	} as const;

	const verdict = $derived.by(() => {
		const v = live?.verdict;
		return v && v !== 'unknown' ? VERDICTS[v] : null;
	});
	const reasons = $derived((live?.verdictReasons ?? []).slice(0, 3));
</script>

{#snippet verdictMeta()}
	{#if verdict}
		<span class="verdict" class:verdict--bad={verdict.kind === 'error'}>
			<StatusDot meta={verdict} label={verdict.label} />
			{verdict.label}
		</span>
	{/if}
{/snippet}

<Widget title="Health" meta={verdict ? verdictMeta : undefined}>
	<div class="health">
		{#if reasons.length}
			<ul class="reasons">
				{#each reasons as reason (reason)}
					<li>{reason}</li>
				{/each}
			</ul>
		{/if}
		<CheckList label="Health checks" items={checks} />
		{#if pods.length === 1 && settingsHref}
			<p class="note">
				No standby takes over if this instance fails. <a href={settingsHref}>Add one</a>
			</p>
		{/if}
	</div>
</Widget>

<style>
	.verdict {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-callout);
		color: var(--text-muted);
	}
	.verdict--bad {
		font-weight: var(--weight-semibold);
		color: var(--status-error);
	}
	.health {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.reasons {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.note {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}
	.note a {
		color: var(--text-default);
		text-decoration: underline;
		text-decoration-color: var(--border-default);
		text-underline-offset: 2px;
	}
</style>
