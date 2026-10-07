export const MISSING_CR_GRACE_MS = 10 * 60 * 1000;
export const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const WAL_ARCHIVING_GRACE_MS = 15 * 60 * 1000;

export const WAL_ARCHIVING_FAILING_MESSAGE =
  'WAL archiving is failing, so this database cannot be backed up';

export interface LiveBackupLike {
  status?: { phase?: string; error?: string; stoppedAt?: string } | null;
}

export interface BackupTransition {
  status: 'completed' | 'failed' | 'running';
  errorMessage: string | null;
}

function detail(live: LiveBackupLike): string | null {
  return String(live.status?.error || '').substring(0, 2000) || null;
}

export function backupTransition(
  row: { status: string; createdAt: Date },
  live: LiveBackupLike | null | undefined,
  now = Date.now()
): BackupTransition | null {
  const ageMs = now - row.createdAt.getTime();
  if (!live) {
    return ageMs > MISSING_CR_GRACE_MS
      ? { status: 'failed', errorMessage: 'Backup resource not found in cluster' }
      : null;
  }
  const phase = live.status?.phase;
  if (phase === 'completed') return { status: 'completed', errorMessage: null };
  if (phase === 'failed') return { status: 'failed', errorMessage: detail(live) };
  if (phase === 'walArchivingFailing' && ageMs > WAL_ARCHIVING_GRACE_MS) {
    const reason = detail(live);
    return {
      status: 'failed',
      errorMessage: reason
        ? `${WAL_ARCHIVING_FAILING_MESSAGE}: ${reason}`
        : WAL_ARCHIVING_FAILING_MESSAGE
    };
  }
  if ((phase === 'running' || phase === 'started') && row.status === 'pending') {
    return { status: 'running', errorMessage: null };
  }
  if (ageMs > BACKUP_TIMEOUT_MS) return { status: 'failed', errorMessage: 'Backup timed out' };
  return null;
}

export const SUPERSEDED_GRACE_MS = 30 * 60 * 1000;
export const SUPERSEDED_MESSAGE = 'Superseded by a newer scheduled backup before it could start';

export interface QueuedBackupLike {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
  };
  status?: { phase?: string } | null;
}

const WAITING_PHASES = new Set(['', 'pending', 'walArchivingFailing']);

export function supersededBackups(items: QueuedBackupLike[], now = Date.now()): string[] {
  const waiting = items
    .filter((b) => b.metadata?.name && b.metadata.labels?.['cnpg.io/scheduled-backup'])
    .filter((b) => WAITING_PHASES.has(b.status?.phase ?? ''))
    .map((b) => ({
      name: b.metadata!.name!,
      createdAt: Date.parse(b.metadata!.creationTimestamp ?? '') || 0
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return waiting
    .slice(1)
    .filter((b) => now - b.createdAt > SUPERSEDED_GRACE_MS)
    .map((b) => b.name);
}
