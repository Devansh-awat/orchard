import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

export const NO_TRANSACTION_MARKER = '-- graft:no-transaction';

export type GraftMigration = {
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
  down: string | null;
};

export type MigrationPlan = { graftId: string; schema: string; pending: GraftMigration[] };

export type MigrationResult = {
  graftId: string;
  applied: string[];
  dryRun: boolean;
};

export function graftSchema(graftId: string): string {
  return `ext_${graftId.replace(/-/g, '_')}`;
}

export function graftRole(graftId: string): string {
  return `orchard_ext_${graftId.replace(/-/g, '_')}`;
}

export function readMigrations(graftDir: string): GraftMigration[] {
  const dir = join(graftDir, 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      const downPath = join(dir, name, 'down.sql');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
        transactional: !sql.trimStart().startsWith(NO_TRANSACTION_MARKER),
        down: existsSync(downPath) ? readFileSync(downPath, 'utf8') : null
      };
    });
}

export async function planMigrations(
  client: Client,
  graftId: string,
  migrations: GraftMigration[]
): Promise<MigrationPlan> {
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM graft_migrations WHERE graft_id = $1',
    [graftId]
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  for (const m of migrations) {
    const prior = applied.get(m.name);
    if (prior && prior !== m.checksum) {
      throw new Error(
        `migration ${m.name} was changed after it was applied (checksum mismatch); ship a new migration instead`
      );
    }
  }
  const known = new Set(migrations.map((m) => m.name));
  const vanished = [...applied.keys()].filter((name) => !known.has(name));
  if (vanished.length) {
    throw new Error(
      `applied migrations are missing from this version: ${vanished.join(', ')}; downgrades must use orchardctl graft rollback`
    );
  }
  return {
    graftId,
    schema: graftSchema(graftId),
    pending: migrations.filter((m) => !applied.has(m.name))
  };
}

function lockKey(graftId: string): string {
  return createHash('sha256')
    .update(`orchard-graft:${graftId}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

async function runBatch(
  client: Client,
  plan: MigrationPlan,
  batch: GraftMigration[],
  commit: boolean
) {
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${plan.schema}"`);
    await client.query(`SET LOCAL search_path TO "${plan.schema}", public`);
    for (const m of batch) {
      try {
        await client.query(m.sql);
      } catch (err) {
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
      await client.query(
        'INSERT INTO graft_migrations (graft_id, name, checksum) VALUES ($1, $2, $3)',
        [plan.graftId, m.name, m.checksum]
      );
    }
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

async function runStandalone(client: Client, plan: MigrationPlan, m: GraftMigration) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${plan.schema}"`);
  await client.query(`SET search_path TO "${plan.schema}", public`);
  try {
    await client.query(m.sql);
  } catch (err) {
    throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
  } finally {
    await client.query('RESET search_path');
  }
  await client.query(
    'INSERT INTO graft_migrations (graft_id, name, checksum) VALUES ($1, $2, $3)',
    [plan.graftId, m.name, m.checksum]
  );
}

export async function applyMigrations(
  client: Client,
  graftId: string,
  migrations: GraftMigration[],
  options: { dryRun?: boolean } = {}
): Promise<MigrationResult> {
  const key = lockKey(graftId);
  await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
  try {
    const plan = await planMigrations(client, graftId, migrations);
    if (options.dryRun) {
      const blocked = plan.pending.find((m) => !m.transactional);
      if (blocked)
        throw new Error(
          `dry run cannot rehearse ${blocked.name}: it is marked ${NO_TRANSACTION_MARKER}`
        );
      if (plan.pending.length) await runBatch(client, plan, plan.pending, false);
      return { graftId, applied: plan.pending.map((m) => m.name), dryRun: true };
    }
    let batch: GraftMigration[] = [];
    for (const m of plan.pending) {
      if (m.transactional) {
        batch.push(m);
        continue;
      }
      if (batch.length) await runBatch(client, plan, batch, true);
      batch = [];
      await runStandalone(client, plan, m);
    }
    if (batch.length) await runBatch(client, plan, batch, true);
    return { graftId, applied: plan.pending.map((m) => m.name), dryRun: false };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
  }
}

export async function ensureGraftRole(
  client: Client,
  graftId: string,
  coreReads: Record<string, string[]>
): Promise<string | null> {
  const role = graftRole(graftId);
  const schema = graftSchema(graftId);
  try {
    const { rows } = await client.query<{ can: boolean }>(
      'SELECT rolcreaterole OR rolsuper AS can FROM pg_roles WHERE rolname = current_user'
    );
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!existing.rowCount) {
      if (!rows[0]?.can) return null;
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${role}"`);
    await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${role}"`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON SEQUENCES TO "${role}"`
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    for (const [table, columns] of Object.entries(coreReads)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table) || columns.some((c) => !/^[a-z_][a-z0-9_]*$/.test(c))) {
        throw new Error(`invalid coreReads entry for ${table}`);
      }
      await client.query(
        `GRANT SELECT (${columns.map((c) => `"${c}"`).join(', ')}) ON TABLE public."${table}" TO "${role}"`
      );
    }
    await client.query(`GRANT "${role}" TO current_user`).catch(() => undefined);
    return role;
  } catch (err) {
    throw new Error(`could not prepare database role ${role}: ${(err as Error).message}`);
  }
}
