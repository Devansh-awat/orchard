import { Eraser, Flag, RefreshCcw, Rocket } from 'lucide-svelte';
import { statusMeta, type StatusMeta } from '$lib/components/ui/status';
import type { DotStep } from '$lib/components/ui/StatusDot.svelte';
import { formatWhen } from './BackupFormat';
import type {
	CheckpointKind,
	DatabaseCheckpoint,
	DatabaseOperation,
	OperationPhase,
	RecoveryBackup,
	RecoveryTarget
} from './types';

export const KIND_ICON: Record<CheckpointKind, typeof Flag> = {
	manual: Flag,
	pre_deploy: Rocket,
	pre_op: RefreshCcw,
	ddl: Eraser
};

export const CHECKPOINT_KIND: Record<CheckpointKind, string> = {
	manual: 'Manual',
	pre_deploy: 'Before a deploy',
	pre_op: 'Before a change',
	ddl: 'Before a drop'
};

export function checkpointTitle(c: DatabaseCheckpoint): string {
	if (c.label) return c.label;
	if (c.kind === 'ddl' && c.detail)
		return `Before dropping ${c.detail.replace(/\s*\(by .*\)$/, '')}`;
	return CHECKPOINT_KIND[c.kind];
}

export function checkpointDetail(c: DatabaseCheckpoint): string | null {
	if (!c.detail) return null;
	if (c.kind === 'ddl' && !c.label) return /\((by .*)\)$/.exec(c.detail)?.[1] ?? null;
	return c.detail;
}

export function checkpointStatus(c: DatabaseCheckpoint): StatusMeta {
	switch (c.status) {
		case 'durable':
			return statusMeta('success', 'Restorable');
		case 'pending':
			return statusMeta('progress', 'Saving', true);
		case 'expired':
			return statusMeta('neutral', 'Expired');
		default:
			return statusMeta('error', 'Failed');
	}
}

const PHASES: Record<DatabaseOperation['kind'] | 'in_place', OperationPhase[]> = {
	in_place: ['queued', 'provisioning', 'recovering', 'cutting_over'],
	restore: ['queued', 'provisioning', 'recovering', 'finalizing'],
	fork: ['queued', 'provisioning', 'recovering', 'finalizing'],
	undelete: ['queued', 'provisioning', 'recovering', 'finalizing'],
	drill: ['queued', 'provisioning', 'recovering', 'verifying', 'cleaning_up'],
	upgrade: [
		'queued',
		'rehearsal_provisioning',
		'rehearsal_cloning',
		'rehearsal_upgrading',
		'upgrading',
		'upgrade_waiting',
		'upgrade_finishing'
	]
};

export const PHASE_LABEL: Record<OperationPhase, string> = {
	queued: 'Queued',
	provisioning: 'Creating a cluster',
	recovering: 'Recovering data',
	verifying: 'Checking tables',
	cleaning_up: 'Cleaning up',
	cutting_over: 'Switching over',
	finalizing: 'Finishing',
	rehearsal_provisioning: 'Copying for a rehearsal',
	rehearsal_cloning: 'Copying for a rehearsal',
	rehearsal_upgrading: 'Rehearsing the upgrade',
	upgrading: 'Upgrading',
	upgrade_waiting: 'Upgrading (offline)',
	upgrade_finishing: 'Taking a fresh backup',
	done: 'Done'
};

export function phasesOf(op: DatabaseOperation): OperationPhase[] {
	if (op.kind === 'upgrade' && op.request?.rehearse === false && !op.phase.startsWith('rehearsal'))
		return PHASES.upgrade.filter((p) => !p.startsWith('rehearsal'));
	return op.kind === 'restore' && op.mode === 'in_place' ? PHASES.in_place : PHASES[op.kind];
}

export function opActive(op: DatabaseOperation) {
	return op.status === 'pending' || op.status === 'running';
}

export function opSteps(op: DatabaseOperation): DotStep[] {
	const phases = phasesOf(op);
	const at = phases.indexOf(op.phase);
	return phases.map((_, i) => {
		if (op.status === 'succeeded') return 'done';
		if (i < at) return 'done';
		if (i === at) return op.status === 'failed' ? 'failed' : 'active';
		return 'pending';
	});
}

export function opStatus(op: DatabaseOperation): StatusMeta {
	if (op.status === 'succeeded') return statusMeta('success', 'Done');
	if (op.status === 'failed')
		return op.error === 'Canceled'
			? statusMeta('neutral', 'Canceled')
			: statusMeta('error', 'Failed');
	if (op.status === 'pending') return statusMeta('info', 'Queued');
	return statusMeta('progress', PHASE_LABEL[op.phase], true);
}

export function stepLabel(op: DatabaseOperation): string {
	const phases = phasesOf(op);
	const at = Math.max(0, phases.indexOf(op.phase));
	return `Step ${at + 1} of ${phases.length}, ${PHASE_LABEL[op.phase].toLowerCase()}`;
}

export function copyName(op: DatabaseOperation): string {
	return (op.targetClusterName ?? '').replace(/-cluster$/, '') || 'a new database';
}

export function pointLabel(
	target: RecoveryTarget | null | undefined,
	backups: RecoveryBackup[],
	checkpoints: DatabaseCheckpoint[]
): string {
	if (!target) return 'the latest point';
	switch (target.type) {
		case 'latest':
			return 'the latest point';
		case 'now':
			return 'right now';
		case 'time':
			return formatWhen(target.time);
		case 'backup': {
			const b = backups.find((x) => x.id === target.backupId);
			return b?.completedAt ? `the ${formatWhen(b.completedAt)} backup` : 'a backup';
		}
		case 'checkpoint': {
			const c = checkpoints.find((x) => x.id === target.checkpointId);
			return c ? `“${checkpointTitle(c)}”` : 'a checkpoint';
		}
		case 'major':
			return `Postgres ${target.major}`;
	}
}

export function opTitle(
	op: DatabaseOperation,
	backups: RecoveryBackup[],
	checkpoints: DatabaseCheckpoint[]
): string {
	const point = pointLabel(op.target, backups, checkpoints);
	if (op.kind === 'drill') return 'Restore test';
	if (op.kind === 'upgrade')
		return op.target?.type === 'major' ? `Upgrade to Postgres ${op.target.major}` : 'Upgrade';
	if (op.kind === 'undelete') return `Bring back ${op.source?.name ?? 'database'}`;
	if (op.kind === 'fork' || op.mode === 'fork')
		return op.target?.type === 'now' || !op.target
			? `Copy into ${copyName(op)}`
			: `Copy into ${copyName(op)} from ${point}`;
	return `Restore to ${point}`;
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rest = s % 60;
	return rest ? `${m}m ${rest}s` : `${m}m`;
}

export function undoable(op: DatabaseOperation, now = Date.now()) {
	const retired = op.result?.retired;
	return (
		op.kind === 'restore' &&
		op.mode === 'in_place' &&
		op.status === 'succeeded' &&
		!!retired &&
		!retired.deleted &&
		Date.parse(retired.retireAfter) > now
	);
}

export function toLocalInput(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
	if (!v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function errorMessage(res: Response, fallback: string) {
	const data = await res.json().catch(() => null);
	const m = data?.message;
	return Array.isArray(m) ? m.join(', ') : typeof m === 'string' && m ? m : fallback;
}
