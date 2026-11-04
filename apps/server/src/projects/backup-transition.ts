export const MISSING_CR_GRACE_MS = 10 * 60 * 1000;
export const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const WAL_ARCHIVING_GRACE_MS = 15 * 60 * 1000;

export const WAL_ARCHIVING_FAILING_MESSAGE =
  "WAL archiving is failing, so this database can't be backed up";

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

export const FAILED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export function recoveredBackups<
  Row extends { backupName: string; status: string; createdAt: Date },
  Live extends LiveBackupLike & { metadata?: { name?: string } }
>(rows: Row[], liveBackups: Live[], now = Date.now()): { row: Row; live: Live }[] {
  const completed = new Map(
    liveBackups
      .filter((b) => b.metadata?.name && b.status?.phase === 'completed')
      .map((b) => [b.metadata!.name!, b])
  );
  return rows.flatMap((row) => {
    const live = completed.get(row.backupName);
    if (!live || row.status !== 'failed') return [];
    return now - row.createdAt.getTime() <= FAILED_RECHECK_MS ? [{ row, live }] : [];
  });
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

export const ORPHAN_CONFIRM_MS = 90 * 1000;

const TERMINAL_PHASES = new Set(['completed', 'failed']);

interface ClusterRefLike {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  spec?: { cluster?: { name?: string } };
  status?: { phase?: string } | null;
}

export interface OrphanCandidate {
  kind: 'backup' | 'schedule';
  namespace: string;
  name: string;
  cluster: string;
}

export function orphanCandidates(
  clusters: ClusterRefLike[],
  backups: ClusterRefLike[],
  schedules: ClusterRefLike[],
  now = Date.now()
): OrphanCandidate[] {
  const live = new Set(
    clusters.map((c) => `${c.metadata?.namespace ?? ''}/${c.metadata?.name ?? ''}`)
  );
  const pick = (kind: OrphanCandidate['kind'], item: ClusterRefLike): OrphanCandidate | null => {
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;
    const cluster = item.spec?.cluster?.name;
    if (!namespace || !name || !cluster) return null;
    if (live.has(`${namespace}/${cluster}`)) return null;
    const createdAt = Date.parse(item.metadata?.creationTimestamp ?? '') || 0;
    if (now - createdAt < MISSING_CR_GRACE_MS) return null;
    return { kind, namespace, name, cluster };
  };
  return [
    ...schedules.map((s) => pick('schedule', s)),
    ...backups
      .filter((b) => !TERMINAL_PHASES.has(b.status?.phase ?? ''))
      .map((b) => pick('backup', b))
  ].filter((c): c is OrphanCandidate => c !== null);
}

export function orphanKey(c: OrphanCandidate): string {
  return `${c.kind}:${c.namespace}/${c.name}`;
}

export function confirmedOrphans(
  candidates: OrphanCandidate[],
  missing: ReadonlySet<string>,
  firstMissingAt: Map<string, number>,
  now = Date.now()
): OrphanCandidate[] {
  const seen = new Set(candidates.map(orphanKey));
  for (const key of [...firstMissingAt.keys()]) {
    if (!seen.has(key) || !missing.has(key)) firstMissingAt.delete(key);
  }
  const confirmed: OrphanCandidate[] = [];
  for (const c of candidates) {
    const key = orphanKey(c);
    if (!missing.has(key)) continue;
    const first = firstMissingAt.get(key);
    if (first === undefined) {
      firstMissingAt.set(key, now);
      continue;
    }
    if (now - first >= ORPHAN_CONFIRM_MS) confirmed.push(c);
  }
  return confirmed;
}
