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
  shared?: { dataDirBytes: number | null };
}

export const DATA_DIR_DU_TIMEOUT_SECONDS = 30;

export function dbStatsCommand(dbName: string, opts: { measureDataDir?: boolean } = {}): string[] {
  const measure =
    opts.measureDataDir !== false
      ? `$(timeout ${DATA_DIR_DU_TIMEOUT_SECONDS} nice -n 19 du -sxb ${DATA_VOLUME_MOUNT} 2>/dev/null | cut -f1)`
      : '';
  const sql =
    `SELECT pg_database_size('${dbName}') || '|' || ` +
    `(SELECT count(*) FROM pg_stat_activity WHERE datname = '${dbName}') || '|' || ` +
    `(SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready')`;
  return [
    'sh',
    '-c',
    `psql -U postgres -tA -c "${sql}"; df -B1 --output=size,used ${DATA_VOLUME_MOUNT} 2>/dev/null | tail -n 1; ` +
      `ds=$(df -B1 --output=size ${DATA_VOLUME_MOUNT} 2>/dev/null | tail -n 1 | tr -d ' '); ` +
      `rs=$(df -B1 --output=size / 2>/dev/null | tail -n 1 | tr -d ' '); ` +
      `if [ -n "$ds" ] && [ "$ds" = "$rs" ]; then echo "shared ${measure}"; fi`
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
  const shared = lines.map((l) => /^shared(?:\s+(\d+))?$/.exec(l)).find(Boolean);
  return {
    sizeBytes,
    connections: Number.isFinite(connections) ? connections : 0,
    walPendingSegments: Number.isFinite(pending) ? pending : null,
    volumeCapacityBytes,
    volumeUsedBytes,
    ...(shared ? { shared: { dataDirBytes: shared[1] ? Number(shared[1]) : null } } : {})
  };
}

export interface StoragePressureInput {
  volumeUsedBytes?: number | bigint | null;
  volumeCapacityBytes?: number | bigint | null;
  walPendingSegments?: number | null;
  nodeDiskUsedBytes?: number | bigint | null;
  nodeDiskCapacityBytes?: number | bigint | null;
}

function fractionOf(
  usedBytes: number | bigint | null | undefined,
  capacityBytes: number | bigint | null | undefined
): number | null {
  const cap = Number(capacityBytes ?? 0);
  const used = Number(usedBytes ?? -1);
  if (!(cap > 0) || used < 0) return null;
  return used / cap;
}

export function volumeFraction(input: StoragePressureInput): number | null {
  const own = fractionOf(input.volumeUsedBytes, input.volumeCapacityBytes);
  const node = fractionOf(input.nodeDiskUsedBytes, input.nodeDiskCapacityBytes);
  if (own == null) return node;
  if (node == null) return own;
  return Math.max(own, node);
}

export function nodeDiskPressure(input: StoragePressureInput): boolean {
  const own = fractionOf(input.volumeUsedBytes, input.volumeCapacityBytes);
  const node = fractionOf(input.nodeDiskUsedBytes, input.nodeDiskCapacityBytes);
  return node != null && node >= STORAGE_PRESSURE_EXIT && (own == null || node > own);
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
  const own = fractionOf(input.volumeUsedBytes, input.volumeCapacityBytes);
  if (own != null && own >= STORAGE_PRESSURE_EXIT) {
    parts.push(`the volume is ${Math.round(own * 100)}% full`);
  }
  const node = fractionOf(input.nodeDiskUsedBytes, input.nodeDiskCapacityBytes);
  if (node != null && node >= STORAGE_PRESSURE_EXIT) {
    parts.push(`the node disk it shares is ${Math.round(node * 100)}% full`);
  }
  const pending = input.walPendingSegments ?? 0;
  if (pending >= WAL_BACKLOG_EXIT_SEGMENTS) {
    const gib = ((pending * WAL_SEGMENT_BYTES) / 1024 ** 3).toFixed(1);
    parts.push(`${pending} WAL segments (${gib} GiB) are waiting to be archived`);
  }
  return parts.join(' and ');
}

export interface MetricSample {
  metric: Record<string, string>;
  value: number;
}

export const DB_STATS_METRIC_QUERIES = {
  size: 'max by (namespace, pod, datname) (cnpg_pg_database_size_bytes)',
  connections: 'sum by (namespace, pod, datname) (cnpg_backends_total)',
  walPending: 'max by (namespace, pod) (cnpg_collector_pg_wal_archive_status{value="ready"})'
} as const;

export function dbStatsFromMetrics(
  primaries: { namespace: string; pod: string; dbName: string }[],
  samples: { size: MetricSample[]; connections: MetricSample[]; walPending: MetricSample[] }
): Map<string, SampledDbStats> {
  const key = (...parts: (string | undefined)[]) => parts.join('/');
  const index = (list: MetricSample[], withDb: boolean) => {
    const out = new Map<string, number>();
    for (const s of list) {
      const { namespace, pod, datname } = s.metric;
      if (!namespace || !pod || (withDb && !datname)) continue;
      out.set(withDb ? key(namespace, pod, datname) : key(namespace, pod), s.value);
    }
    return out;
  };
  const size = index(samples.size, true);
  const connections = index(samples.connections, true);
  const walPending = index(samples.walPending, false);
  const out = new Map<string, SampledDbStats>();
  for (const p of primaries) {
    const sizeBytes = size.get(key(p.namespace, p.pod, p.dbName));
    const pending = walPending.get(key(p.namespace, p.pod));
    if (sizeBytes == null || pending == null) continue;
    out.set(key(p.namespace, p.pod), {
      sizeBytes,
      connections: Math.round(connections.get(key(p.namespace, p.pod, p.dbName)) ?? 0),
      walPendingSegments: Math.round(pending),
      volumeCapacityBytes: null,
      volumeUsedBytes: null
    });
  }
  return out;
}
