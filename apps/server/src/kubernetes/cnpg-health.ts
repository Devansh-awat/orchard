import { STORAGE_PRESSURE_ENTER, WAL_BACKLOG_ENTER_SEGMENTS } from './db-stats';

export type DbVerdict = 'healthy' | 'degraded' | 'unprotected' | 'down' | 'hibernated';

export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000;

export interface DbVerdictInput {
  hibernated: boolean;
  instances: number;
  readyInstances: number;
  message?: string;
  writeGuard?: boolean;
  volumeFraction?: number | null;
  walPendingSegments?: number | null;
  archiving: { ok: boolean } | null;
  firstRecoverabilityPoint: string | null;
  lastSuccessfulBackup: string | null;
}

export interface DbVerdictResult {
  verdict: DbVerdict;
  reasons: string[];
}

export function databaseVerdict(input: DbVerdictInput, now = Date.now()): DbVerdictResult {
  if (input.hibernated) return { verdict: 'hibernated', reasons: ['Stopped'] };
  const down: string[] = [];
  const degraded: string[] = [];
  const unprotected: string[] = [];

  if (input.readyInstances === 0) down.push('No instance is ready');
  else if (input.readyInstances < input.instances) {
    degraded.push(`${input.readyInstances} of ${input.instances} instances ready`);
  }
  if (input.message) degraded.push(`Last restart: ${input.message}`);
  if (input.writeGuard) degraded.push('Writes paused, disk nearly full');
  else if ((input.volumeFraction ?? 0) >= STORAGE_PRESSURE_ENTER) {
    degraded.push(`Disk ${Math.round((input.volumeFraction ?? 0) * 100)}% full`);
  }
  if ((input.walPendingSegments ?? 0) >= WAL_BACKLOG_ENTER_SEGMENTS) {
    degraded.push(`${input.walPendingSegments} WAL segments waiting to be archived`);
  }

  if (!input.archiving) unprotected.push('No backups configured');
  else if (!input.archiving.ok) unprotected.push('WAL archiving is failing');
  if (!input.firstRecoverabilityPoint) unprotected.push('No base backup to restore from');
  else {
    const last = Date.parse(input.lastSuccessfulBackup ?? '');
    if (!last || now - last > BACKUP_STALE_MS) unprotected.push('No successful backup in 48 hours');
  }

  const reasons = [...down, ...degraded, ...unprotected];
  if (down.length) return { verdict: 'down', reasons };
  if (degraded.length) return { verdict: 'degraded', reasons };
  if (unprotected.length) return { verdict: 'unprotected', reasons };
  return { verdict: 'healthy', reasons };
}
