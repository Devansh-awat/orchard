import type { GraftRecord } from './graft-registry';

export const DEFAULT_GRAFT_POOL = 3;
export const MAX_GRAFT_POOL = 50;
const TIGHT_SHARE = 0.8;

export type PoolSource = 'values' | 'graft' | 'default';

export type GraftPoolSize = { size: number; source: PoolSource };

export type DbBudgetLevel = 'ok' | 'tight' | 'over';

export type DbBudget = {
  maxConnections: number;
  reserved: number;
  usable: number;
  inUse: number;
  pods: { server: number; workers: number };
  corePerPod: number;
  grafts: { id: string; pool: number; source: PoolSource }[];
  perPod: number;
  steadyPeak: number;
  rolloutPeak: number;
  level: DbBudgetLevel;
  summary: string;
};

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function poolOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, number> {
  const raw = env.ORCHARD_GRAFT_POOLS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed ?? {})) {
      const n = positiveInt(value);
      if (n) out[id] = Math.min(n, MAX_GRAFT_POOL);
    }
    return out;
  } catch {
    return {};
  }
}

export function graftPoolSize(
  record: Pick<GraftRecord, 'id' | 'manifest'>,
  env: NodeJS.ProcessEnv = process.env
): GraftPoolSize {
  const override = poolOverrides(env)[record.id];
  if (override) return { size: override, source: 'values' };
  const declared = positiveInt(record.manifest?.database.pool);
  if (declared) return { size: Math.min(declared, MAX_GRAFT_POOL), source: 'graft' };
  const fallback = positiveInt(env.ORCHARD_GRAFT_DB_POOL);
  return { size: fallback ?? DEFAULT_GRAFT_POOL, source: 'default' };
}

function usesDatabase(record: GraftRecord): boolean {
  return record.status === 'loaded' && !!record.manifest?.capabilities.includes('db');
}

export function planDbBudget(
  server: { maxConnections: number; reserved: number; inUse: number },
  records: readonly GraftRecord[],
  env: NodeJS.ProcessEnv = process.env
): DbBudget {
  const pods = {
    server: positiveInt(env.ORCHARD_DB_SERVER_PODS) ?? 1,
    workers: positiveInt(env.ORCHARD_DB_WORKER_PODS) ?? 0
  };
  const pooled = positiveInt(env.ORCHARD_DB_POOLER_CONNECTIONS);
  const corePerPod = pooled ? 0 : (positiveInt(env.DATABASE_CONNECTION_LIMIT) ?? 10);
  const grafts = records.filter(usesDatabase).map((r) => {
    const { size, source } = graftPoolSize(r, env);
    return { id: r.id, pool: size, source };
  });
  const perPod = corePerPod + grafts.reduce((sum, g) => sum + g.pool, 0);
  const steadyPeak = (pooled ?? 0) + perPod * (pods.server + pods.workers);
  const rolloutPeak = steadyPeak + perPod * pods.server;
  const usable = Math.max(0, server.maxConnections - server.reserved);
  const level: DbBudgetLevel =
    rolloutPeak > usable ? 'over' : rolloutPeak > usable * TIGHT_SHARE ? 'tight' : 'ok';
  const summary =
    `At peak, Orchard${grafts.length ? ' and its grafts' : ''} could open ${steadyPeak} of the ` +
    `database's ${usable} connections, and ${rolloutPeak} while an update runs old and new pods side by side.`;
  return {
    maxConnections: server.maxConnections,
    reserved: server.reserved,
    usable,
    inUse: server.inUse,
    pods,
    corePerPod,
    grafts,
    perPod,
    steadyPeak,
    rolloutPeak,
    level,
    summary
  };
}

type Query = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

export async function measureDbBudget(
  query: Query,
  records: readonly GraftRecord[],
  env: NodeJS.ProcessEnv = process.env
): Promise<DbBudget> {
  const max = await query('SHOW max_connections');
  const reserved = await query('SHOW superuser_reserved_connections');
  const active = await query(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()'
  );
  return planDbBudget(
    {
      maxConnections: Number(max.rows[0]?.max_connections ?? 100),
      reserved: Number(reserved.rows[0]?.superuser_reserved_connections ?? 3),
      inUse: Number(active.rows[0]?.n ?? 0)
    },
    records,
    env
  );
}
