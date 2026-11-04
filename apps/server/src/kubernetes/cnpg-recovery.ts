import { pdbEnabledFor } from './cnpg-defaults';

export const BARMAN_PLUGIN = 'barman-cloud.cloudnative-pg.io';

export const BARMAN_GROUP = 'barmancloud.cnpg.io';

export const BARMAN_VERSION = 'v1';

export const OBJECT_STORE_PLURAL = 'objectstores';

export const RETENTION_POLICY = '30d';

export const ORIGIN = 'origin';

export type BackupMethod = 'barman' | 'plugin';

export interface ArchiveLocation {
  destinationPath: string;
  endpointURL: string;
  secretName: string;
  serverName: string;
}

export interface SidecarSizing {
  memoryRequest: string;
  memoryLimit: string;
  cpuRequest: string;
}

export const DEFAULT_SIDECAR: SidecarSizing = {
  memoryRequest: '64Mi',
  memoryLimit: '256Mi',
  cpuRequest: '20m'
};

export function clusterArchivesWithPlugin(spec: any): boolean {
  const plugins: any[] = Array.isArray(spec?.plugins) ? spec.plugins : [];
  return plugins.some(
    (p) => p?.name === BARMAN_PLUGIN && p?.isWALArchiver === true && p?.enabled !== false
  );
}

export function backupMethodSpec(method: BackupMethod) {
  return method === 'plugin'
    ? { method: 'plugin', pluginConfiguration: { name: BARMAN_PLUGIN } }
    : {};
}

export function objectStoreName(clusterName: string): string {
  return `${clusterName}-store`.slice(0, 63);
}

export function backupServerName(clusterName: string, databaseId: string): string {
  return `${clusterName}-${databaseId.replace(/-/g, '').slice(0, 6)}`.slice(0, 100);
}

function s3Credentials(secretName: string) {
  return {
    accessKeyId: { name: secretName, key: 'ACCESS_KEY_ID' },
    secretAccessKey: { name: secretName, key: 'ACCESS_SECRET_KEY' }
  };
}

export function objectStoreBody(
  namespace: string,
  name: string,
  location: Omit<ArchiveLocation, 'serverName'>,
  opts: {
    walMaxParallel: number;
    dataCompression: 'gzip' | null;
    sidecar?: SidecarSizing;
    labels?: Record<string, string>;
  }
) {
  const sidecar = opts.sidecar ?? DEFAULT_SIDECAR;
  return {
    apiVersion: `${BARMAN_GROUP}/${BARMAN_VERSION}`,
    kind: 'ObjectStore',
    metadata: { name, namespace, labels: opts.labels ?? {} },
    spec: {
      retentionPolicy: RETENTION_POLICY,
      configuration: {
        destinationPath: location.destinationPath,
        endpointURL: location.endpointURL,
        s3Credentials: s3Credentials(location.secretName),
        wal: { compression: 'gzip', maxParallel: opts.walMaxParallel },
        ...(opts.dataCompression ? { data: { compression: opts.dataCompression } } : {})
      },
      instanceSidecarConfiguration: {
        resources: {
          requests: { cpu: sidecar.cpuRequest, memory: sidecar.memoryRequest },
          limits: { memory: sidecar.memoryLimit }
        },
        env: [
          { name: 'AWS_REQUEST_CHECKSUM_CALCULATION', value: 'when_required' },
          { name: 'AWS_RESPONSE_CHECKSUM_VALIDATION', value: 'when_required' }
        ]
      }
    }
  };
}

export function walArchiverPlugin(objectStore: string, serverName: string) {
  return {
    name: BARMAN_PLUGIN,
    isWALArchiver: true,
    parameters: { barmanObjectName: objectStore, serverName }
  };
}

export function inTreeExternalCluster(location: ArchiveLocation, walMaxParallel: number) {
  return {
    name: ORIGIN,
    barmanObjectStore: {
      destinationPath: location.destinationPath,
      endpointURL: location.endpointURL,
      serverName: location.serverName,
      s3Credentials: s3Credentials(location.secretName),
      wal: { maxParallel: walMaxParallel }
    }
  };
}

export function pluginExternalCluster(objectStore: string, serverName: string) {
  return {
    name: ORIGIN,
    plugin: {
      name: BARMAN_PLUGIN,
      parameters: { barmanObjectName: objectStore, serverName }
    }
  };
}

export type RecoveryTarget =
  | { type: 'latest' }
  | { type: 'time'; time: string }
  | { type: 'restore_point'; name: string; backupId: string }
  | { type: 'backup'; backupId: string }
  | { type: 'lsn'; lsn: string };

export function postgresTimestamp(value: string | Date): string {
  const iso = new Date(value).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000+00`;
}

export function recoveryTargetSpec(target: RecoveryTarget): Record<string, unknown> | undefined {
  switch (target.type) {
    case 'latest':
      return undefined;
    case 'time':
      return { targetTime: postgresTimestamp(target.time) };
    case 'restore_point':
      return { targetName: target.name, backupID: target.backupId };
    case 'backup':
      return { targetImmediate: true, backupID: target.backupId };
    case 'lsn':
      return { targetLSN: target.lsn };
  }
}

export function recoveryBootstrap(
  target: RecoveryTarget,
  owner: { database: string; owner: string; secretName: string }
) {
  const recoveryTarget = recoveryTargetSpec(target);
  return {
    recovery: {
      source: ORIGIN,
      database: owner.database,
      owner: owner.owner,
      secret: { name: owner.secretName },
      ...(recoveryTarget ? { recoveryTarget } : {})
    }
  };
}

export function liveCloneSecretNames(targetCluster: string) {
  return {
    replication: `${targetCluster}-origin-replication`.slice(0, 63),
    ca: `${targetCluster}-origin-ca`.slice(0, 63)
  };
}

export function liveCloneSource(sourceHost: string, targetCluster: string) {
  const secrets = liveCloneSecretNames(targetCluster);
  return {
    name: ORIGIN,
    connectionParameters: {
      host: sourceHost,
      user: 'streaming_replica',
      dbname: 'postgres',
      sslmode: 'verify-full'
    },
    sslKey: { name: secrets.replication, key: 'tls.key' },
    sslCert: { name: secrets.replication, key: 'tls.crt' },
    sslRootCert: { name: secrets.ca, key: 'ca.crt' }
  };
}

export function liveCloneBootstrap(owner: { database: string; owner: string; secretName: string }) {
  return {
    pg_basebackup: {
      source: ORIGIN,
      database: owner.database,
      owner: owner.owner,
      secret: { name: owner.secretName }
    }
  };
}

export function lsnValue(lsn: string | null | undefined): bigint | null {
  const m = /^([0-9A-F]+)\/([0-9A-F]+)$/i.exec(String(lsn ?? '').trim());
  if (!m) return null;
  return (BigInt(`0x${m[1]}`) << 32n) + BigInt(`0x${m[2]}`);
}

export interface BackupPoint {
  barmanId: string | null;
  status: string;
  endLsn: string | null;
  completedAt: Date | null;
}

export function backupBefore(backups: BackupPoint[], lsn: string): string | null {
  const at = lsnValue(lsn);
  if (at === null) return null;
  let best: { id: string; end: bigint } | null = null;
  for (const b of backups) {
    if (b.status !== 'completed' || !b.barmanId) continue;
    const end = lsnValue(b.endLsn);
    if (end === null || end > at) continue;
    if (!best || end > best.end) best = { id: b.barmanId, end };
  }
  return best?.id ?? null;
}

export function earliestRecoverable(backups: BackupPoint[]): Date | null {
  let earliest: Date | null = null;
  for (const b of backups) {
    if (b.status !== 'completed' || !b.completedAt) continue;
    if (!earliest || b.completedAt < earliest) earliest = b.completedAt;
  }
  return earliest;
}

export interface RecordedBackupFields {
  barmanId: string | null;
  beginLsn: string | null;
  endLsn: string | null;
  startedAt: Date | null;
  serverName: string | null;
  destinationPath: string | null;
  method: string | null;
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

export function backupFieldsFromStatus(live: { spec?: any; status?: any } | null | undefined) {
  const status = live?.status ?? {};
  const fields: RecordedBackupFields = {
    barmanId: str(status.backupId, 64),
    beginLsn: str(status.beginLSN, 32),
    endLsn: str(status.endLSN, 32),
    startedAt: date(status.startedAt),
    serverName: str(status.serverName, 100),
    destinationPath: str(status.destinationPath, 500),
    method: str(status.method ?? live?.spec?.method, 20)
  };
  return fields;
}

export interface PoolerConfig {
  instances: number;
  poolMode: 'transaction' | 'session';
  defaultPoolSize: number;
  maxClientConn: number;
}

export const DEFAULT_POOLER: PoolerConfig = {
  instances: 1,
  poolMode: 'transaction',
  defaultPoolSize: 10,
  maxClientConn: 500
};

export function poolerName(clusterName: string): string {
  return `${clusterName}-pooler-rw`.slice(0, 63);
}

export function normalizePoolerConfig(
  input: Partial<PoolerConfig> | null | undefined
): PoolerConfig {
  const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
    const v = Number(n);
    return Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  return {
    instances: clamp(input?.instances, 1, 3, DEFAULT_POOLER.instances),
    poolMode: input?.poolMode === 'session' ? 'session' : 'transaction',
    defaultPoolSize: clamp(input?.defaultPoolSize, 1, 100, DEFAULT_POOLER.defaultPoolSize),
    maxClientConn: clamp(input?.maxClientConn, 10, 5000, DEFAULT_POOLER.maxClientConn)
  };
}

export function poolerBody(
  namespace: string,
  clusterName: string,
  config: PoolerConfig,
  labels: Record<string, string> = {}
) {
  return {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Pooler',
    metadata: { name: poolerName(clusterName), namespace, labels },
    spec: {
      cluster: { name: clusterName },
      instances: config.instances,
      type: 'rw',
      pgbouncer: {
        poolMode: config.poolMode,
        parameters: {
          default_pool_size: String(config.defaultPoolSize),
          max_client_conn: String(config.maxClientConn),
          max_prepared_statements: '200'
        }
      },
      template: {
        spec: {
          containers: [
            {
              name: 'pgbouncer',
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { memory: '64Mi' }
              }
            }
          ]
        }
      }
    }
  };
}

export const POOLER_DEFAULT_MAX_MEMORY_BYTES = 1024 * 1024 * 1024;

export function poolerOnByDefault(memoryLimitBytes: number): boolean {
  return memoryLimitBytes > 0 && memoryLimitBytes <= POOLER_DEFAULT_MAX_MEMORY_BYTES;
}

export interface RecoveryClusterInput {
  instances: number;
  imageName: string;
  storageSize: string;
  storageClass?: string;
  resources?: { requests: Record<string, string>; limits?: Record<string, string> };
  parameters: Record<string, string>;
  sharedPreloadLibraries?: string[];
  affinity?: unknown;
  primaryUpdateStrategy?: string;
  bootstrap: unknown;
  externalClusters: unknown[];
  archive?:
    | { kind: 'plugin'; objectStore: string; serverName: string }
    | { kind: 'barman'; backup: unknown }
    | null;
}

export function recoveryClusterSpec(input: RecoveryClusterInput): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    instances: Math.max(1, Math.trunc(input.instances)),
    enablePDB: pdbEnabledFor(input.instances),
    imageName: input.imageName,
    primaryUpdateStrategy: input.primaryUpdateStrategy || 'unsupervised',
    storage: { size: input.storageSize, storageClass: input.storageClass },
    bootstrap: input.bootstrap,
    externalClusters: input.externalClusters,
    postgresql: {
      parameters: input.parameters,
      ...(input.sharedPreloadLibraries?.length
        ? { shared_preload_libraries: input.sharedPreloadLibraries }
        : {})
    },
    enableSuperuserAccess: true
  };
  if (input.resources) spec.resources = input.resources;
  if (input.affinity) spec.affinity = input.affinity;
  if (input.archive?.kind === 'plugin') {
    spec.plugins = [walArchiverPlugin(input.archive.objectStore, input.archive.serverName)];
  } else if (input.archive?.kind === 'barman') {
    spec.backup = input.archive.backup;
  }
  return spec;
}

export type ClusterProgress = 'ready' | 'failed' | 'pending';

export function clusterProgress(cluster: any): { state: ClusterProgress; message: string | null } {
  if (!cluster) return { state: 'pending', message: null };
  const status = cluster.status ?? {};
  const phase = String(status.phase ?? '');
  const ready = Number(status.readyInstances ?? 0);
  const wanted = Number(cluster.spec?.instances ?? 1);
  if (ready >= Math.max(1, wanted) && /healthy/i.test(phase))
    return { state: 'ready', message: phase };
  if (/fail|unrecoverable|cannot/i.test(phase) && !/healthy/i.test(phase)) {
    return { state: 'failed', message: status.phaseReason || phase };
  }
  return { state: 'pending', message: status.phaseReason || phase || null };
}

export const DRILL_CHECK_SQL = `SELECT json_build_object(
  'inRecovery', pg_is_in_recovery(),
  'sizeBytes', pg_database_size(current_database()),
  'tables', (
    SELECT coalesce(json_object_agg(n.nspname || '.' || c.relname, greatest(c.reltuples, 0)::bigint), '{}'::json)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', '_orchard')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp%'
  )
)::text;`;

export interface DrillSnapshot {
  inRecovery: boolean;
  sizeBytes: number;
  tables: Record<string, number>;
}

export function parseDrillSnapshot(stdout: string): DrillSnapshot | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'));
  if (!line) return null;
  try {
    const j = JSON.parse(line);
    return {
      inRecovery: Boolean(j.inRecovery),
      sizeBytes: Number(j.sizeBytes) || 0,
      tables: j.tables && typeof j.tables === 'object' ? j.tables : {}
    };
  } catch {
    return null;
  }
}

export interface DrillVerdict {
  passed: boolean;
  tablesChecked: number;
  missingTables: string[];
  rowDrift: { table: string; source: number; restored: number }[];
  reasons: string[];
}

export function judgeDrill(
  source: DrillSnapshot | null,
  restored: DrillSnapshot | null
): DrillVerdict {
  const reasons: string[] = [];
  if (!restored) {
    return {
      passed: false,
      tablesChecked: 0,
      missingTables: [],
      rowDrift: [],
      reasons: ["The restored database couldn't be queried"]
    };
  }
  if (restored.inRecovery) reasons.push('The restored database never left recovery');
  const sourceTables = Object.keys(source?.tables ?? {});
  const missingTables = sourceTables.filter((t) => !(t in restored.tables));
  const rowDrift: DrillVerdict['rowDrift'] = [];
  for (const t of sourceTables) {
    if (!(t in restored.tables)) continue;
    const a = Number(source!.tables[t]) || 0;
    const b = Number(restored.tables[t]) || 0;
    const tolerance = Math.max(1000, a * 0.1);
    if (Math.abs(a - b) > tolerance) rowDrift.push({ table: t, source: a, restored: b });
  }
  if (
    sourceTables.length > 0 &&
    missingTables.length > Math.max(0, Math.floor(sourceTables.length * 0.1))
  ) {
    reasons.push(
      `${missingTables.length} of ${sourceTables.length} tables are missing from the restore`
    );
  }
  return {
    passed: reasons.length === 0,
    tablesChecked: sourceTables.length,
    missingTables: missingTables.slice(0, 50),
    rowDrift: rowDrift.slice(0, 50),
    reasons
  };
}
