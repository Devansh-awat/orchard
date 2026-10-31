export const DDL_GUARD_VERSION = 1;

export const DDL_GUARD_SCHEMA = '_orchard';

const DATA_BEARING_OBJECTS = [
  'table',
  'table column',
  'schema',
  'materialized view',
  'sequence',
  'type'
];

export type CheckpointKind = 'manual' | 'pre_deploy' | 'pre_op' | 'ddl';

export function restorePointName(kind: CheckpointKind, id: string): string {
  return `orchard-${kind.replace('_', '-')}-${id.replace(/-/g, '').slice(0, 20)}`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function createRestorePointSql(name: string): string {
  return [
    `SELECT lsn::text || '|' || pg_walfile_name(lsn) FROM pg_create_restore_point(${literal(name)}) AS lsn;`,
    'SELECT pg_switch_wal();'
  ].join(' ');
}

export interface CreatedRestorePoint {
  lsn: string;
  walFile: string;
}

export function parseRestorePoint(stdout: string): CreatedRestorePoint | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[0-9A-F]+\/[0-9A-F]+\|[0-9A-F]{24}$/i.test(l));
  if (!line) return null;
  const [lsn, walFile] = line.split('|');
  return { lsn, walFile };
}

export const LAST_ARCHIVED_WAL_SQL =
  "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver;";

export function walArchived(lastArchived: string, walFile: string): boolean {
  const last = lastArchived.trim().slice(0, 24);
  if (!/^[0-9A-F]{24}$/i.test(last) || !/^[0-9A-F]{24}$/i.test(walFile)) return false;
  return last.toUpperCase() >= walFile.toUpperCase();
}

export function ddlGuardInstallSql(): string {
  const types = DATA_BEARING_OBJECTS.map(literal).join(', ');
  return `
CREATE SCHEMA IF NOT EXISTS ${DDL_GUARD_SCHEMA};
GRANT USAGE ON SCHEMA ${DDL_GUARD_SCHEMA} TO PUBLIC;
CREATE TABLE IF NOT EXISTS ${DDL_GUARD_SCHEMA}.checkpoints (
  id bigserial PRIMARY KEY,
  restore_point text NOT NULL,
  lsn pg_lsn NOT NULL,
  wal_file text NOT NULL,
  command text NOT NULL,
  objects text NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON ${DDL_GUARD_SCHEMA}.checkpoints TO PUBLIC;
CREATE OR REPLACE FUNCTION ${DDL_GUARD_SCHEMA}.checkpoint_before_drop()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  dropped text;
  point text;
  at pg_lsn;
BEGIN
  IF pg_is_in_recovery() THEN
    RETURN;
  END IF;
  IF current_setting('orchard.checkpoint_xid', true) = txid_current()::text THEN
    RETURN;
  END IF;
  SELECT string_agg(DISTINCT coalesce(object_identity, object_type), ', ')
    INTO dropped
    FROM pg_event_trigger_dropped_objects()
   WHERE NOT is_temporary
     AND object_type IN (${types})
     AND (original OR object_type <> 'type');
  IF dropped IS NULL THEN
    RETURN;
  END IF;
  point := 'orchard-ddl-' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') || '-' || txid_current();
  at := pg_create_restore_point(point);
  PERFORM set_config('orchard.checkpoint_xid', txid_current()::text, true);
  INSERT INTO ${DDL_GUARD_SCHEMA}.checkpoints (restore_point, lsn, wal_file, command, objects, role)
  VALUES (point, at, pg_walfile_name(at), tg_tag, left(dropped, 2000), session_user);
EXCEPTION WHEN others THEN
  RAISE WARNING 'orchard checkpoint skipped: %', SQLERRM;
END
$fn$;
REVOKE ALL ON FUNCTION ${DDL_GUARD_SCHEMA}.checkpoint_before_drop() FROM PUBLIC;
DROP EVENT TRIGGER IF EXISTS orchard_checkpoint_before_drop;
CREATE EVENT TRIGGER orchard_checkpoint_before_drop ON sql_drop
  EXECUTE FUNCTION ${DDL_GUARD_SCHEMA}.checkpoint_before_drop();
`.trim();
}

export function ddlGuardRemoveSql(): string {
  return [
    'DROP EVENT TRIGGER IF EXISTS orchard_checkpoint_before_drop;',
    `DROP FUNCTION IF EXISTS ${DDL_GUARD_SCHEMA}.checkpoint_before_drop();`
  ].join(' ');
}

export interface GuardCheckpointRow {
  seq: number;
  restorePointName: string;
  lsn: string;
  walFile: string;
  command: string;
  objects: string;
  role: string;
  createdAt: string;
}

export function guardCheckpointsSql(afterSeq: number): string {
  const after = Number.isFinite(afterSeq) && afterSeq > 0 ? Math.floor(afterSeq) : 0;
  return `SELECT coalesce(json_agg(t ORDER BY t.id), '[]'::json) FROM (
    SELECT id, restore_point, lsn::text AS lsn, wal_file, command, objects, role,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM ${DDL_GUARD_SCHEMA}.checkpoints
     WHERE id > ${after}
     ORDER BY id
     LIMIT 100
  ) t;`;
}

export function parseGuardCheckpoints(stdout: string): GuardCheckpointRow[] {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('['));
  if (!line) return [];
  try {
    const rows = JSON.parse(line) as any[];
    return rows
      .filter((r) => r && typeof r.restore_point === 'string')
      .map((r) => ({
        seq: Number(r.id),
        restorePointName: r.restore_point,
        lsn: String(r.lsn),
        walFile: String(r.wal_file),
        command: String(r.command),
        objects: String(r.objects),
        role: String(r.role),
        createdAt: String(r.created_at)
      }));
  } catch {
    return [];
  }
}
