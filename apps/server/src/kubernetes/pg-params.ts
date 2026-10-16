export interface PgParamBound {
  kind: 'int' | 'memory' | 'string';
  min?: number;
  max?: number;
  enum?: string[];
  requiresRestart?: boolean;
}

export const PG_PARAM_BOUNDS: Record<string, PgParamBound> = {
  max_connections: { kind: 'int', min: 10, max: 500, requiresRestart: true },
  shared_buffers: { kind: 'memory', requiresRestart: true },
  work_mem: { kind: 'memory' },
  maintenance_work_mem: { kind: 'memory' },
  effective_cache_size: { kind: 'memory' },
  log_min_duration_statement: { kind: 'int', min: -1, max: 600000 },
  statement_timeout: { kind: 'int', min: 0, max: 3600000 },
  idle_in_transaction_session_timeout: { kind: 'int', min: 0, max: 3600000 },
  synchronous_commit: {
    kind: 'string',
    enum: ['on', 'off', 'local', 'remote_write', 'remote_apply']
  }
};

export const ORCHARD_PG_DEFAULTS: Readonly<Record<string, string>> = { max_connections: '100' };

export function normalizePgParam(key: string, raw: unknown): string | null {
  const bound = PG_PARAM_BOUNDS[key];
  if (!bound) return null;
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (bound.kind === 'int') {
    const n = parseInt(value, 10);
    if (!/^-?\d+$/.test(value) || n < (bound.min ?? -Infinity) || n > (bound.max ?? Infinity)) {
      return null;
    }
    return String(n);
  }
  if (bound.kind === 'memory') return /^\d+(kB|MB|GB)$/.test(value) ? value : null;
  return !bound.enum || bound.enum.includes(value) ? value : null;
}
