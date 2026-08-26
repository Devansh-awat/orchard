// Managed-database tuning derived from the container's memory limit.
//
// Every value here is a default, not a policy: if the user has set the knob by
// hand we hand their value straight back and never clamp it. The most we do is
// attach an advisory saying what we think will happen.
//
// This exists because the alternative — a constant — put `shared_buffers: 128MB`
// on a 128Mi container, i.e. 100% of the cgroup reserved as shared memory before
// Postgres served a single query. `barman-cloud-backup` then ran inside that same
// cgroup and OOMKilled the database, CNPG retried every 10 minutes, and seven
// production databases spent 18 days in that loop with no recoverable backup.

const MiB = 1024 * 1024;

// Postgres memory units are 1024-based and spelled differently from Kubernetes
// ones (`MB` here means 2^20, where k8s `M` means 10^6 and `Mi` means 2^20).
// quantity.ts#parseMemory returns 0 for "128MB" because `MB` isn't in its unit
// map, so these two need to stay separate.
const PG_MEM_UNITS: Record<string, number> = {
  kB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

export function parsePgMemory(value: string): number {
  const m = String(value ?? '').trim().match(/^(\d+)\s*(kB|MB|GB|TB)$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * PG_MEM_UNITS[m[2]];
}

export function formatPgMemory(bytes: number): string {
  for (const unit of ['GB', 'MB', 'kB'] as const) {
    const mult = PG_MEM_UNITS[unit];
    if (bytes >= mult && bytes % mult === 0) return `${bytes / mult}${unit}`;
  }
  return `${Math.max(1, Math.round(bytes / PG_MEM_UNITS.MB))}MB`;
}

// Postgres can't run its own backup inside less than this. Used both as the
// provisioning floor and as the assumed basis when a cluster has no resource
// block at all (the restore path builds one before the row is settled).
export const MANAGED_DB_MIN_MEMORY_BYTES = 256 * MiB;

// The conventional Postgres starting point. Deliberately conservative: the rest
// of the cgroup has to hold backends, work_mem, WAL buffers and whatever
// barman-cloud-backup needs while it streams.
const SHARED_BUFFERS_FRACTION = 0.25;

const SHARED_BUFFERS_MIN_BYTES = 16 * MiB;

// Past this share of the limit a manual value is worth warning about. Well above
// the derived 25% so ordinary hand-tuning stays quiet.
const SHARED_BUFFERS_ADVISE_FRACTION = 0.4;

// gzip on the *data* stream is what actually blows the memory budget during a
// base backup. Below this we trade backup size for a database that survives
// being backed up. WAL compression is unaffected: one 16MB segment at a time was
// never the problem, and it's the part that currently works.
const BACKUP_GZIP_MIN_MEMORY_BYTES = 512 * MiB;

export interface DbTuningAdvisory {
  key: string;
  message: string;
}

export interface DbTuning {
  sharedBuffers: string;
  /** null means "store the base backup uncompressed". */
  dataCompression: 'gzip' | null;
  advisories: DbTuningAdvisory[];
}

export interface DbTuningInput {
  /** Container memory limit in bytes. 0/undefined means "not configured yet". */
  memoryLimitBytes?: number | null;
  /** User-set values. Present means the user owns the knob; absent means we derive it. */
  overrides?: {
    /** From Database.pgParameters.shared_buffers. */
    sharedBuffers?: string | null;
    /** From Database.backupCompression. 'none' disables, 'gzip' forces. */
    backupCompression?: string | null;
  } | null;
}

export function deriveDbTuning(input: DbTuningInput): DbTuning {
  const limit = Number(input.memoryLimitBytes) || 0;
  const basis = limit > 0 ? limit : MANAGED_DB_MIN_MEMORY_BYTES;
  const advisories: DbTuningAdvisory[] = [];

  const derivedSharedBuffers = Math.max(
    SHARED_BUFFERS_MIN_BYTES,
    Math.floor((basis * SHARED_BUFFERS_FRACTION) / MiB) * MiB,
  );

  const override = input.overrides?.sharedBuffers?.trim();
  let sharedBuffers: string;
  if (override) {
    sharedBuffers = override;
    const overrideBytes = parsePgMemory(override);
    if (limit > 0 && overrideBytes > limit * SHARED_BUFFERS_ADVISE_FRACTION) {
      const pct = Math.round((overrideBytes / limit) * 100);
      advisories.push({
        key: 'shared_buffers',
        message:
          `shared_buffers is ${override}, ${pct}% of this database's memory limit. `
          + 'Postgres reserves that up front, so there may not be enough left for '
          + 'connections and backups, and the database can be OOMKilled. '
          + `The automatic value for this limit is ${formatPgMemory(derivedSharedBuffers)}. `
          + 'Clear the setting to go back to automatic.',
      });
    }
  } else {
    sharedBuffers = formatPgMemory(derivedSharedBuffers);
  }

  const compressionOverride = input.overrides?.backupCompression?.trim();
  let dataCompression: 'gzip' | null;
  if (compressionOverride === 'gzip') {
    dataCompression = 'gzip';
    if (basis < BACKUP_GZIP_MIN_MEMORY_BYTES) {
      advisories.push({
        key: 'backupCompression',
        message:
          'Backup compression is forced on below the memory level where it is safe. '
          + 'Compressing the base backup can OOMKill the database while it runs. '
          + 'Clear the setting to go back to automatic.',
      });
    }
  } else if (compressionOverride === 'none') {
    dataCompression = null;
  } else {
    dataCompression = basis >= BACKUP_GZIP_MIN_MEMORY_BYTES ? 'gzip' : null;
  }

  return { sharedBuffers, dataCompression, advisories };
}
