import type { PrismaClient } from '@prisma/client';

const EXCLUDED_TABLES = new Set([
  '_prisma_migrations',
  'audit_logs',
  'rate_limit_records',
  'otp_codes',
  'webauthn_challenges',
  'cluster_events',
  'notification_events',
  'notification_deliveries',
  'error_occurrences',
  'k8s_objects',
  'k8s_object_tombstones',
  'k8s_mirror_heartbeats',
  'k8s_workloads',
  'k8s_apply_items',
  'pod_transitions',
  'pods',
  'instance_settings',
  'graft_migrations',
  'graft_artifacts',
  'mcp_oauth_codes',
  'mcp_oauth_clients'
]);

const VOLATILE_KEYS = [
  'updated_at',
  'last_active_at',
  'last_used_at',
  'last_login_at',
  'touched_at'
];

export type RowSnapshot = Map<string, Set<string>>;

export interface RowDiff {
  added: { table: string; row: string }[];
  removed: { table: string; row: string }[];
}

export class Snapshotter {
  private query: string | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  private async build(): Promise<string> {
    if (this.query) return this.query;
    const tables = await this.prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    );
    const keys = VOLATILE_KEYS.map((key) => `'${key}'`).join(',');
    this.query = tables
      .map((row) => row.table_name)
      .filter((name) => !EXCLUDED_TABLES.has(name))
      .map(
        (name) =>
          `SELECT '${name}' AS t, (to_jsonb(x) - ARRAY[${keys}])::text AS r FROM "${name}" x`
      )
      .join(' UNION ALL ');
    return this.query;
  }

  async take(): Promise<RowSnapshot> {
    const rows = await this.prisma.$queryRawUnsafe<{ t: string; r: string }[]>(await this.build());
    const snapshot: RowSnapshot = new Map();
    for (const row of rows) {
      let set = snapshot.get(row.t);
      if (!set) snapshot.set(row.t, (set = new Set()));
      set.add(row.r);
    }
    return snapshot;
  }
}

export function diffSnapshots(before: RowSnapshot, after: RowSnapshot): RowDiff {
  const diff: RowDiff = { added: [], removed: [] };
  for (const table of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(table) ?? new Set<string>();
    const b = after.get(table) ?? new Set<string>();
    for (const row of b) if (!a.has(row)) diff.added.push({ table, row });
    for (const row of a) if (!b.has(row)) diff.removed.push({ table, row });
  }
  return diff;
}

export function diffTouchesMarkers(diff: RowDiff, markers: readonly string[]): string[] {
  const hits: string[] = [];
  for (const { table, row } of [...diff.added, ...diff.removed]) {
    const marker = markers.find((candidate) => row.includes(candidate));
    if (marker) hits.push(`${table} (${marker})`);
  }
  return [...new Set(hits)];
}
