import { STORAGE_PRESSURE_ENTER, WAL_BACKLOG_ENTER_SEGMENTS } from '../kubernetes/db-stats';

export type HealthTone = 'error' | 'warning' | 'neutral';

export interface HealthLine {
  tone: HealthTone;
  text: string;
}

export interface DatabaseHealthInput {
  status: string;
  hibernated: boolean;
  instances: number;
  readyInstances: number;
  lastSuccessfulBackup: string | null;
  backupsOff: boolean;
  volumeUsedBytes: number | null;
  volumeCapacityBytes: number | null;
  walPendingSegments: number | null;
  connections: number | null;
  maxConnections: number;
  replicationLagSeconds: number | null;
  now: number;
}

export interface DatabaseHealth {
  status: 'healthy' | 'warning' | 'error' | 'stopped';
  lines: HealthLine[];
}

export const BACKUP_STALE_MS = 26 * 60 * 60 * 1000;
export const DISK_READ_ONLY = 0.92;
export const REPLICA_LAG_SECONDS = 10;
export const CONNECTIONS_WARN = 0.9;

function ago(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function databaseHealth(input: DatabaseHealthInput): DatabaseHealth {
  if (input.hibernated || input.status === 'stopped') {
    return { status: 'stopped', lines: [{ tone: 'neutral', text: 'Stopped' }] };
  }
  const lines: HealthLine[] = [];
  if (input.instances > 0 && input.readyInstances === 0) {
    lines.push({ tone: 'error', text: 'Not running' });
  } else if (input.readyInstances < input.instances) {
    lines.push({
      tone: 'warning',
      text: `${input.readyInstances} of ${input.instances} instances ready`
    });
  }
  if (input.volumeUsedBytes != null && input.volumeCapacityBytes) {
    const fraction = input.volumeUsedBytes / input.volumeCapacityBytes;
    if (fraction >= STORAGE_PRESSURE_ENTER) {
      lines.push({
        tone: fraction >= DISK_READ_ONLY ? 'error' : 'warning',
        text: `Disk ${Math.round(fraction * 100)}% full`
      });
    }
  }
  if ((input.walPendingSegments ?? 0) >= WAL_BACKLOG_ENTER_SEGMENTS) {
    lines.push({
      tone: 'warning',
      text: `WAL archiving is behind (${input.walPendingSegments} files waiting)`
    });
  }
  if (input.backupsOff) {
    lines.push({ tone: 'warning', text: 'Backups are off' });
  } else if (!input.lastSuccessfulBackup) {
    lines.push({ tone: 'error', text: 'Never backed up' });
  } else {
    const age = input.now - Date.parse(input.lastSuccessfulBackup);
    if (Number.isFinite(age) && age > BACKUP_STALE_MS) {
      lines.push({ tone: 'warning', text: `Last backup ${ago(age)}` });
    }
  }
  if (input.replicationLagSeconds != null && input.replicationLagSeconds >= REPLICA_LAG_SECONDS) {
    lines.push({
      tone: 'warning',
      text: `Replica ${Math.round(input.replicationLagSeconds)}s behind`
    });
  }
  if (
    input.connections != null &&
    input.maxConnections > 0 &&
    input.connections >= input.maxConnections * CONNECTIONS_WARN
  ) {
    lines.push({
      tone: 'warning',
      text: `Connections ${input.connections} of ${input.maxConnections}`
    });
  }
  const order: Record<HealthTone, number> = { error: 0, warning: 1, neutral: 2 };
  lines.sort((a, b) => order[a.tone] - order[b.tone]);
  const status = lines.some((l) => l.tone === 'error')
    ? 'error'
    : lines.some((l) => l.tone === 'warning')
      ? 'warning'
      : 'healthy';
  return { status, lines };
}
