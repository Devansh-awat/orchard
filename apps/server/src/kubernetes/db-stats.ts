export const DATA_VOLUME_MOUNT = '/var/lib/postgresql/data';

export const STORAGE_PRESSURE_ENTER = 0.85;

export const STORAGE_PRESSURE_EXIT = 0.75;

export const WAL_BACKLOG_ENTER_SEGMENTS = 64;

export const WAL_BACKLOG_EXIT_SEGMENTS = 16;

export const WAL_SEGMENT_BYTES = 16 * 1024 * 1024;

export interface SampledDbStats {
  sizeBytes: number;
  connections: number;
  walPendingSegments: number | null;
  volumeCapacityBytes: number | null;
  volumeUsedBytes: number | null;
}

export function dbStatsCommand(dbName: string): string[] {
  const sql =
    `SELECT pg_database_size('${dbName}') || '|' || ` +
    `(SELECT count(*) FROM pg_stat_activity WHERE datname = '${dbName}') || '|' || ` +
    `(SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready')`;
  return [
    'sh',
    '-c',
    `psql -U postgres -tA -c "${sql}"; df -B1 --output=size,used ${DATA_VOLUME_MOUNT} 2>/dev/null | tail -n 1`
  ];
}

export function parseDbStatsOutput(stdout: string): SampledDbStats | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines.find((l) => l.includes('|'));
  if (!first) return null;
  const [sizeRaw, connRaw, pendingRaw] = first.split('|');
  const sizeBytes = Number(sizeRaw);
  if (!Number.isFinite(sizeBytes)) return null;
  const connections = parseInt(connRaw, 10);
  const pending = parseInt(pendingRaw, 10);
  const df = lines.find((l) => /^\d+\s+\d+$/.test(l));
  let volumeCapacityBytes: number | null = null;
  let volumeUsedBytes: number | null = null;
  if (df) {
    const [cap, used] = df.split(/\s+/).map(Number);
    if (cap > 0 && Number.isFinite(used)) {
      volumeCapacityBytes = cap;
      volumeUsedBytes = used;
    }
  }
  return {
    sizeBytes,
    connections: Number.isFinite(connections) ? connections : 0,
    walPendingSegments: Number.isFinite(pending) ? pending : null,
    volumeCapacityBytes,
    volumeUsedBytes
  };
}

export interface StoragePressureInput {
  volumeUsedBytes?: number | bigint | null;
  volumeCapacityBytes?: number | bigint | null;
  walPendingSegments?: number | null;
}

export function volumeFraction(input: StoragePressureInput): number | null {
  const cap = Number(input.volumeCapacityBytes ?? 0);
  const used = Number(input.volumeUsedBytes ?? -1);
  if (!(cap > 0) || used < 0) return null;
  return used / cap;
}

export function storagePressure(prev: boolean | undefined, input: StoragePressureInput): boolean {
  const fraction = volumeFraction(input);
  const pending = input.walPendingSegments ?? 0;
  if (prev) {
    const volumeClear = fraction == null || fraction < STORAGE_PRESSURE_EXIT;
    return !(volumeClear && pending < WAL_BACKLOG_EXIT_SEGMENTS);
  }
  return (
    (fraction != null && fraction >= STORAGE_PRESSURE_ENTER) ||
    pending >= WAL_BACKLOG_ENTER_SEGMENTS
  );
}

export function storagePressureDetail(input: StoragePressureInput): string {
  const parts: string[] = [];
  const fraction = volumeFraction(input);
  if (fraction != null && fraction >= STORAGE_PRESSURE_EXIT) {
    parts.push(`the volume is ${Math.round(fraction * 100)}% full`);
  }
  const pending = input.walPendingSegments ?? 0;
  if (pending >= WAL_BACKLOG_EXIT_SEGMENTS) {
    const gib = ((pending * WAL_SEGMENT_BYTES) / 1024 ** 3).toFixed(1);
    parts.push(`${pending} WAL segments (${gib} GiB) are waiting to be archived`);
  }
  return parts.join(' and ');
}
