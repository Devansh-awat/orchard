import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseCheckpointsService } from '../src/projects/database-checkpoints.service';
import { CnpgConsumer } from '../src/engine/consumers/cnpg.consumer';

const routed = {
  project: {
    organization: {
      backupR2Endpoint: 'https://s3.test',
      backupR2Bucket: 'b',
      backupR2AccessKey: 'k',
      backupR2SecretKey: 's'
    }
  }
};

function harness(rows: any[], opts: { toggle?: boolean; fail?: boolean } = {}) {
  const psql: string[] = [];
  const updates: any[] = [];
  const service = Object.create(DatabaseCheckpointsService.prototype) as any;
  service.logger = { warn: () => undefined };
  service.guardSeq = new Map();
  service.guardRetryAt = new Map();
  service.settings = { isDatabaseToggleOn: async () => opts.toggle ?? true };
  service.k8sCnpg = {
    runPsqlInCnpg: async (_ns: string, cluster: string) => {
      psql.push(cluster);
      return opts.fail ? { success: false, stderr: 'not ready' } : { success: true, stdout: '' };
    }
  };
  service.prisma = {
    database: {
      findMany: async ({ where }: any) =>
        rows.filter(
          (r) =>
            (where.ddlGuardVersion === undefined || r.ddlGuardVersion === where.ddlGuardVersion) &&
            (where.ddlCheckpoints === undefined || r.ddlCheckpoints === where.ddlCheckpoints) &&
            (where.id === undefined || r.id === where.id)
        ),
      update: async ({ where, data }: any) => {
        updates.push([where.id, data.ddlGuardVersion]);
        Object.assign(
          rows.find((r) => r.id === where.id),
          data
        );
      }
    }
  };
  return { service, psql, updates };
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    namespace: 'ns',
    clusterName: `pg-${id}`,
    dbName: 'app',
    ddlCheckpoints: true,
    ddlGuardVersion: null,
    backupServerName: id,
    ...routed,
    ...overrides
  };
}

test('every tick installs the guard on a database that has none, and only there', async () => {
  const { service, psql, updates } = harness([
    row('new'),
    row('done', { ddlGuardVersion: 1 }),
    row('off', { ddlCheckpoints: false })
  ]);
  await service.installMissingGuards();
  assert.deepEqual(psql, ['pg-new']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 'new');
  assert.ok(updates[0][1]);

  await service.installMissingGuards();
  assert.deepEqual(psql, ['pg-new']);
});

test('nothing is installed when the instance turned the guard off', async () => {
  const { service, psql } = harness([row('new')], { toggle: false });
  await service.installMissingGuards();
  await service.ensureGuard('new');
  assert.deepEqual(psql, []);
});

test('a failed install waits before trying again', async () => {
  const { service, psql, updates } = harness([row('new')], { fail: true });
  await service.installMissingGuards();
  await service.installMissingGuards();
  assert.deepEqual(psql, ['pg-new']);
  assert.deepEqual(updates, []);
});

test('a database reaching ready gets its guard straight away', async () => {
  const ensured: string[] = [];
  const row = { status: 'provisioning' };
  const consumer: any = new CnpgConsumer(
    {
      database: {
        findUnique: async () => row,
        update: async ({ data }: any) => Object.assign(row, data)
      }
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { get: () => ({ ensureGuard: async (id: string) => ensured.push(id) }) } as any,
    {} as any
  );
  const cluster = { spec: { instances: 1 }, status: { readyInstances: 1, instances: 1 } };
  await consumer.writebackStatus({ databaseId: 'd1' }, { cluster });
  assert.equal(row.status, 'ready');
  assert.deepEqual(ensured, ['d1']);

  await consumer.writebackStatus({ databaseId: 'd1' }, { cluster });
  assert.deepEqual(ensured, ['d1']);
});
