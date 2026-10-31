import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backupBefore,
  backupFieldsFromStatus,
  backupMethodSpec,
  clusterArchivesWithPlugin,
  clusterProgress,
  judgeDrill,
  lsnValue,
  normalizePoolerConfig,
  objectStoreBody,
  parseDrillSnapshot,
  poolerBody,
  poolerOnByDefault,
  recoveryBootstrap,
  recoveryClusterSpec,
  recoveryTargetSpec,
  walArchiverPlugin,
  BARMAN_PLUGIN
} from '../src/kubernetes/cnpg-recovery';
import {
  createRestorePointSql,
  ddlGuardInstallSql,
  parseGuardCheckpoints,
  parseRestorePoint,
  restorePointName,
  walArchived
} from '../src/kubernetes/cnpg-checkpoint';
import { migrationRegression } from '../src/projects/database-plugin-migration.service';
import { drillDue } from '../src/projects/database-drills.service';
import { targetFromRequest } from '../src/projects/database-recovery.service';

test('recovery targets map onto the CNPG fields, and named points carry the backup they start from', () => {
  assert.equal(recoveryTargetSpec({ type: 'latest' }), undefined);
  assert.deepEqual(recoveryTargetSpec({ type: 'time', time: '2026-10-30T12:00:00Z' }), {
    targetTime: '2026-10-30T12:00:00.000Z'
  });
  assert.deepEqual(
    recoveryTargetSpec({
      type: 'restore_point',
      name: 'orchard-manual-x',
      backupId: '20261030T030000'
    }),
    {
      targetName: 'orchard-manual-x',
      backupID: '20261030T030000'
    }
  );
  assert.deepEqual(recoveryTargetSpec({ type: 'backup', backupId: 'b1' }), {
    targetImmediate: true,
    backupID: 'b1'
  });
  const boot = recoveryBootstrap(
    { type: 'latest' },
    { database: 'app', owner: 'u_app', secretName: 'pg-x-app' }
  );
  assert.deepEqual(boot, {
    recovery: { source: 'origin', database: 'app', owner: 'u_app', secret: { name: 'pg-x-app' } }
  });
});

test('a checkpoint restores from the newest completed backup that ended before it', () => {
  const backups = [
    { barmanId: 'old', status: 'completed', endLsn: '0/3000000', completedAt: new Date(1) },
    { barmanId: 'mid', status: 'completed', endLsn: '0/9000000', completedAt: new Date(2) },
    { barmanId: 'after', status: 'completed', endLsn: '1/0', completedAt: new Date(3) },
    { barmanId: 'failed', status: 'failed', endLsn: '0/A000000', completedAt: new Date(4) },
    { barmanId: null, status: 'completed', endLsn: '0/A000001', completedAt: new Date(5) }
  ];
  assert.equal(backupBefore(backups, '0/B000000'), 'mid');
  assert.equal(backupBefore(backups, '0/1000000'), null);
  assert.equal(lsnValue('1/0')! > lsnValue('0/FFFFFFFF')!, true);
  assert.equal(lsnValue('garbage'), null);
});

test('backups and schedules use the plugin exactly when the plugin archives the cluster', () => {
  const plugin = { plugins: [walArchiverPlugin('pg-x-store', 'pg-x')] };
  assert.equal(clusterArchivesWithPlugin(plugin), true);
  assert.equal(
    clusterArchivesWithPlugin({ plugins: [{ ...plugin.plugins[0], enabled: false }] }),
    false
  );
  assert.equal(clusterArchivesWithPlugin({ backup: { barmanObjectStore: {} } }), false);
  assert.deepEqual(backupMethodSpec('plugin'), {
    method: 'plugin',
    pluginConfiguration: { name: BARMAN_PLUGIN }
  });
  assert.deepEqual(backupMethodSpec('barman'), {});
});

test('the object store gives the sidecar its own memory and the R2 checksum workaround', () => {
  const body = objectStoreBody(
    'ns',
    'pg-x-store',
    {
      destinationPath: 's3://b/ns/pg-x',
      endpointURL: 'http://r2-proxy:9000',
      secretName: 'pg-x-r2'
    },
    { walMaxParallel: 4, dataCompression: 'gzip' }
  );
  assert.equal(body.kind, 'ObjectStore');
  assert.equal(body.spec.retentionPolicy, '30d');
  assert.equal(body.spec.configuration.wal.maxParallel, 4);
  assert.equal(body.spec.instanceSidecarConfiguration.resources.limits.memory, '256Mi');
  assert.ok(
    body.spec.instanceSidecarConfiguration.env.some(
      (e) => e.name === 'AWS_REQUEST_CHECKSUM_CALCULATION'
    )
  );
});

test('a recovered cluster archives to its own prefix with the plugin or in-tree barman', () => {
  const base = {
    instances: 1,
    imageName: 'postgres:17',
    storageSize: '1Gi',
    storageClass: 'longhorn',
    parameters: { shared_buffers: '64MB' },
    bootstrap: { recovery: { source: 'origin' } },
    externalClusters: [{ name: 'origin' }]
  };
  const plugin = recoveryClusterSpec({
    ...base,
    archive: { kind: 'plugin', objectStore: 'pg-y-store', serverName: 'pg-y' }
  }) as any;
  assert.equal(plugin.plugins[0].parameters.barmanObjectName, 'pg-y-store');
  assert.equal(plugin.backup, undefined);
  const inTree = recoveryClusterSpec({
    ...base,
    archive: { kind: 'barman', backup: { retentionPolicy: '30d' } }
  }) as any;
  assert.deepEqual(inTree.backup, { retentionPolicy: '30d' });
  const drill = recoveryClusterSpec({ ...base, archive: null }) as any;
  assert.equal(drill.backup, undefined);
  assert.equal(drill.plugins, undefined);
});

test('recovery progress reads ready, failed and still-working clusters', () => {
  assert.equal(clusterProgress(null).state, 'pending');
  assert.equal(
    clusterProgress({
      spec: { instances: 1 },
      status: { phase: 'Cluster in healthy state', readyInstances: 1 }
    }).state,
    'ready'
  );
  assert.equal(
    clusterProgress({ spec: { instances: 1 }, status: { phase: 'Setting up primary' } }).state,
    'pending'
  );
  assert.equal(
    clusterProgress({
      spec: { instances: 1 },
      status: { phase: 'Unrecoverable', phaseReason: 'bad backup' }
    }).message,
    'bad backup'
  );
});

test('a restore test passes when the copy answers and its tables match', () => {
  const source = {
    inRecovery: false,
    sizeBytes: 100,
    tables: { 'public.users': 5000, 'public.posts': 20 }
  };
  const good = parseDrillSnapshot(
    JSON.stringify({
      inRecovery: false,
      sizeBytes: 99,
      tables: { 'public.users': 4900, 'public.posts': 20 }
    })
  );
  assert.deepEqual(judgeDrill(source, good).reasons, []);
  assert.equal(judgeDrill(source, good).passed, true);
  const missing = { inRecovery: false, sizeBytes: 1, tables: { 'public.posts': 20 } };
  assert.equal(judgeDrill(source, missing).passed, false);
  assert.equal(judgeDrill(source, null).passed, false);
  const drift = {
    inRecovery: false,
    sizeBytes: 1,
    tables: { 'public.users': 1, 'public.posts': 20 }
  };
  assert.equal(judgeDrill(source, drift).rowDrift[0].table, 'public.users');
});

test('restore point names fit Postgres and parse back with their WAL file', () => {
  const name = restorePointName('pre_deploy', '0e1f9c1a-7b2d-4c3e-9f00-1234567890ab');
  assert.ok(name.length <= 63);
  assert.ok(name.startsWith('orchard-pre-deploy-'));
  assert.match(createRestorePointSql(name), /pg_create_restore_point\('orchard-pre-deploy-/);
  assert.match(createRestorePointSql("it's"), /'it''s'/);
  assert.deepEqual(parseRestorePoint('0/3000060|000000010000000000000003\n0/4000000\n'), {
    lsn: '0/3000060',
    walFile: '000000010000000000000003'
  });
  assert.equal(parseRestorePoint('ERROR: recovery is in progress'), null);
});

test('a checkpoint is durable once the archiver has passed its WAL file', () => {
  assert.equal(walArchived('000000010000000000000004', '000000010000000000000003'), true);
  assert.equal(walArchived('000000010000000000000003.partial', '000000010000000000000003'), true);
  assert.equal(walArchived('000000010000000000000002', '000000010000000000000003'), false);
  assert.equal(walArchived('', '000000010000000000000003'), false);
});

test('the drop guard fires on sql_drop, runs as its owner and never blocks the drop', () => {
  const sql = ddlGuardInstallSql();
  assert.match(sql, /ON sql_drop/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, pg_temp/);
  assert.match(sql, /EXCEPTION WHEN others THEN/);
  assert.match(sql, /NOT is_temporary/);
  const rows = parseGuardCheckpoints(
    '[{"id":3,"restore_point":"orchard-ddl-20261031-9","lsn":"0/5000028","wal_file":"000000010000000000000005","command":"DROP TABLE","objects":"public.users","role":"u_app","created_at":"2026-10-31T10:00:00.000Z"}]'
  );
  assert.equal(rows[0].seq, 3);
  assert.equal(rows[0].objects, 'public.users');
  assert.deepEqual(parseGuardCheckpoints('garbage'), []);
});

test('the plugin migration halts on a cluster that stopped archiving after the move, not on old failures', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const cluster = (since: string, plugin = true) => ({
    metadata: { namespace: 'ns', name: 'pg' },
    spec: plugin
      ? { plugins: [walArchiverPlugin('s', 'pg')] }
      : { backup: { barmanObjectStore: {} } },
    status: {
      conditions: [
        { type: 'ContinuousArchiving', status: 'False', lastTransitionTime: since, message: 'boom' }
      ]
    }
  });
  assert.match(
    migrationRegression([cluster('2026-10-31T11:30:00Z')], now) ?? '',
    /ns\/pg stopped archiving/
  );
  assert.equal(migrationRegression([cluster('2026-10-30T11:30:00Z')], now), null);
  assert.equal(migrationRegression([cluster('2026-10-31T11:30:00Z', false)], now), null);
});

test('restore drills come round weekly', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(drillDue(null, now), true);
  assert.equal(drillDue(new Date(now - 6 * 86_400_000), now), false);
  assert.equal(drillDue(new Date(now - 8 * 86_400_000), now), true);
});

test('restore requests pick their target', () => {
  assert.deepEqual(targetFromRequest({ checkpointId: 'c' }, true), {
    type: 'checkpoint',
    checkpointId: 'c'
  });
  assert.deepEqual(targetFromRequest({}, true), { type: 'latest' });
  assert.deepEqual(targetFromRequest({}, false), { type: 'now' });
  assert.deepEqual(targetFromRequest({ at: '2026-10-30T12:00:00Z' }, true), {
    type: 'time',
    time: '2026-10-30T12:00:00.000Z'
  });
  assert.throws(() => targetFromRequest({ at: 'yesterday' }, true));
  assert.throws(() =>
    targetFromRequest({ at: new Date(Date.now() + 86_400_000).toISOString() }, true)
  );
});

test('poolers are small, transaction mode, and on by default only for databases up to 1Gi', () => {
  const cfg = normalizePoolerConfig({ instances: 9, poolMode: 'session', defaultPoolSize: 0 });
  assert.deepEqual(cfg, {
    instances: 3,
    poolMode: 'session',
    defaultPoolSize: 1,
    maxClientConn: 500
  });
  const body = poolerBody('ns', 'pg-x', normalizePoolerConfig(null));
  assert.equal(body.metadata.name, 'pg-x-pooler-rw');
  assert.equal(body.spec.pgbouncer.poolMode, 'transaction');
  assert.equal(body.spec.pgbouncer.parameters.max_prepared_statements, '200');
  assert.equal(poolerOnByDefault(512 * 1024 * 1024), true);
  assert.equal(poolerOnByDefault(2 * 1024 * 1024 * 1024), false);
});

test('backup rows record what a restore by id needs', () => {
  const fields = backupFieldsFromStatus({
    spec: { method: 'plugin' },
    status: {
      backupId: '20261030T030141',
      beginLSN: '0/2000028',
      endLSN: '0/2000100',
      startedAt: '2026-10-30T03:01:41Z',
      serverName: 'pg-x',
      destinationPath: 's3://b/ns/pg-x'
    }
  });
  assert.equal(fields.barmanId, '20261030T030141');
  assert.equal(fields.endLsn, '0/2000100');
  assert.equal(fields.method, 'plugin');
  assert.equal(backupFieldsFromStatus(null).barmanId, null);
});

test('the disaster recovery catalog names every archive without secrets', async () => {
  const { buildCatalog } = await import('../src/projects/database-catalog.service');
  const catalog = buildCatalog(
    [
      {
        id: 'd1',
        name: 'postgres',
        projectId: 'p',
        environmentId: null,
        namespace: 'ysws-x',
        clusterName: 'pg-x',
        backupServerName: 'pg-x-abc123',
        backupMethod: 'plugin',
        pgMajor: 17,
        storageSize: '5Gi',
        replicas: 1,
        dbName: 'x',
        dbUser: 'u_x',
        project: { organizationId: 'o', organization: { backupR2Bucket: null } }
      }
    ],
    [],
    'hackclub-orchard-backups',
    new Date('2026-10-31T00:00:00Z')
  );
  assert.equal(catalog.databases[0].destinationPath, 's3://hackclub-orchard-backups/ysws-x/pg-x');
  assert.equal(catalog.databases[0].serverName, 'pg-x-abc123');
  assert.ok(!JSON.stringify(catalog).toLowerCase().includes('password'));
});

test('replication modes and extra users map onto CNPG and refuse reserved names', async () => {
  const m = await import('../src/projects/database-recovery.service');
  assert.equal(m.synchronousSpec('async'), null);
  assert.deepEqual(m.synchronousSpec('required'), {
    method: 'any',
    number: 1,
    dataDurability: 'required'
  });
  assert.equal(m.replicationModeOf(m.synchronousSpec('preferred')), 'preferred');
  assert.equal(m.replicationModeOf(undefined), 'async');
  assert.throws(() => m.assertRoleName('postgres', 'u_app'));
  assert.throws(() => m.assertRoleName('u_app', 'u_app'));
  assert.throws(() => m.assertRoleName('pg_monitor', 'u_app'));
  assert.throws(() => m.assertRoleName('Bad-Name', 'u_app'));
  m.assertRoleName('metabase', 'u_app');
  const role = m.managedRole('metabase', 'read', 'pg-x-user-metabase');
  assert.deepEqual(role.inRoles, ['pg_read_all_data']);
  const roles = m.withRole([{ name: 'datadog' }, { ...role, comment: 'other' }], role);
  assert.equal(roles.length, 2);
  assert.equal(m.managedUserRoles(roles).length, 1);
  assert.equal(m.roleAccess(m.managedRole('w', 'write', 's')), 'write');
});

test('postgres advisories parse from the official page and match the running minor', async () => {
  const { readFileSync } = await import('node:fs');
  const a = await import('../src/kubernetes/postgres-advisories');
  const advisories = a.parseAdvisories(
    readFileSync(new URL('./fixtures/postgres-security.html', import.meta.url), 'utf8')
  );
  assert.equal(advisories.length, 4);
  assert.equal(advisories[0].cve, 'CVE-2026-19385');
  assert.equal(advisories[0].fixedIn[17], 11);
  assert.equal(advisories[0].score, 8.8);
  assert.equal(advisories[0].component, 'client');
  const releases = a.parseReleases([
    { major: '17', latestMinor: '11', supported: true, current: false, eolDate: '2029-11-08' },
    { major: '13', latestMinor: '23', supported: false, current: false, eolDate: '2025-11-13' }
  ]);
  const old = a.securityReport(
    { major: 17, minor: 9 },
    advisories,
    releases,
    Date.parse('2026-10-31')
  );
  assert.ok(old.vulnerabilities.length > 0);
  assert.equal(old.vulnerabilities[0].fixedInVersion, '17.11');
  assert.equal(old.action, 'minor_update');
  const fresh = a.securityReport(
    { major: 17, minor: 11 },
    advisories,
    releases,
    Date.parse('2026-10-31')
  );
  assert.equal(fresh.vulnerabilities.length, 0);
  assert.equal(fresh.action, 'none');
  const eol = a.securityReport(
    { major: 13, minor: 23 },
    advisories,
    releases,
    Date.parse('2026-10-31')
  );
  assert.equal(eol.action, 'major_upgrade');
  assert.equal(eol.supported, false);
  assert.deepEqual(
    a.versionFromImage(
      'ghcr.io/cloudnative-pg/postgresql:17.11-202610190957-system-trixie@sha256:ab'
    ),
    { major: 17, minor: 11 }
  );
  assert.deepEqual(a.versionFromImage('ghcr.io/cloudnative-pg/postgresql:17'), {
    major: 17,
    minor: null
  });
  assert.deepEqual(a.versionFromServerVersionNum('170011\n'), { major: 17, minor: 11 });
});

test('the default major is the newest supported one in the catalog unless pinned', async () => {
  const { defaultMajor } = await import('../src/projects/postgres-security.service');
  const versions = [
    { major: 19, supported: null },
    { major: 18, supported: true },
    { major: 13, supported: false }
  ];
  assert.equal(defaultMajor(versions, {}), 19);
  assert.equal(defaultMajor(versions, { POSTGRES_DEFAULT_MAJOR: '18' }), 18);
  assert.equal(
    defaultMajor([{ major: 18, supported: true }], { POSTGRES_DEFAULT_MAJOR: '19' }),
    18
  );
});

test('a major upgrade archives into a fresh server name for either backup method', async () => {
  const m = await import('../src/projects/database-operations.service');
  const plugin = {
    metadata: { name: 'pg-x' },
    spec: {
      plugins: [
        {
          name: 'barman-cloud.cloudnative-pg.io',
          isWALArchiver: true,
          parameters: { barmanObjectName: 's', serverName: 'pg-x-abc123' }
        }
      ]
    }
  };
  const inTree = {
    metadata: { name: 'pg-y' },
    spec: { backup: { barmanObjectStore: { destinationPath: 's3://b/n/pg-y' } } }
  };
  assert.equal(m.currentServerName(plugin), 'pg-x-abc123');
  assert.equal(m.currentServerName(inTree), 'pg-y');
  assert.equal(m.currentServerName({ spec: {} }), null);
  assert.equal(m.upgradedServerName('pg-x-abc123', 18), 'pg-x-abc123-pg18');
  assert.equal(m.upgradedServerName('pg-x-abc123-pg17', 18), 'pg-x-abc123-pg18');
  assert.deepEqual((m.serverNamePatch(plugin, 'pg-x-abc123-pg18') as any).plugins[0].parameters, {
    barmanObjectName: 's',
    serverName: 'pg-x-abc123-pg18'
  });
  assert.deepEqual(m.serverNamePatch(inTree, 'pg-y-pg18'), {
    backup: { barmanObjectStore: { serverName: 'pg-y-pg18' } }
  });
  assert.deepEqual(m.serverNamePatch({ spec: {} }, 'x'), {});
});

test('fleet security gauges report the worst CVE and days to end of life per cluster', async () => {
  const { securityGauges } = await import('../src/projects/postgres-security.service');
  const advisories = [
    {
      cve: 'CVE-1',
      affectedMajors: [17],
      fixedIn: { 17: 11 },
      component: 'core server',
      score: 8.8,
      vector: null,
      description: 'x',
      url: 'u'
    }
  ];
  const releases = [
    { major: 17, latestMinor: 11, supported: true, current: false, eolDate: '2029-11-08' }
  ];
  const gauges = securityGauges(
    [
      {
        metadata: { namespace: 'ns', name: 'old' },
        status: { image: 'ghcr.io/cloudnative-pg/postgresql:17.9-1-system-trixie' }
      },
      {
        metadata: { namespace: 'ns', name: 'new' },
        status: { image: 'ghcr.io/cloudnative-pg/postgresql:17.11-1-system-trixie' }
      },
      {
        metadata: { namespace: 'ns', name: 'floating' },
        spec: { imageName: 'ghcr.io/cloudnative-pg/postgresql:17' }
      }
    ],
    advisories,
    releases,
    Date.parse('2026-10-31T00:00:00Z')
  );
  const get = (metric: string, name: string) =>
    gauges.find((g) => g.metric === metric && g.tags.includes(`cnpg_cluster:${name}`))?.value;
  assert.equal(get('orchard.postgres.cve_max_score', 'old'), 8.8);
  assert.equal(get('orchard.postgres.cve_max_score', 'new'), 0);
  assert.equal(get('orchard.postgres.cves', 'floating'), undefined);
  assert.equal(get('orchard.postgres.days_to_eol', 'new'), 1104);
});
