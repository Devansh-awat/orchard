import test from 'node:test';
import assert from 'node:assert/strict';
import { hibernationTransition } from '../src/kubernetes/cnpg-spec-sync';
import { CnpgConsumer } from '../src/engine/consumers/cnpg.consumer';

const cluster = (hibernation?: string) => ({
  metadata: { annotations: hibernation ? { 'cnpg.io/hibernation': hibernation } : {} }
});

test('hibernating in k8s stops the database, waking it restarts it', () => {
  assert.equal(hibernationTransition(cluster('on'), 'ready'), 'stopped');
  assert.equal(hibernationTransition(cluster('on'), 'error'), 'stopped');
  assert.equal(hibernationTransition(cluster('off'), 'stopped'), 'restarting');
  assert.equal(hibernationTransition(cluster(), 'stopped'), 'restarting');
});

test('states Orchard is driving are left alone', () => {
  for (const status of ['deleting', 'provisioning', 'restoring']) {
    assert.equal(hibernationTransition(cluster('on'), status), null);
  }
  assert.equal(hibernationTransition(cluster('on'), 'stopped'), null);
  assert.equal(hibernationTransition(cluster('off'), 'ready'), null);
});

function harness(row: { status: string; backupScheduleDisabled?: boolean }) {
  const suspended: boolean[] = [];
  const audits: any[] = [];
  const state = { ...row };
  const prisma = {
    database: {
      findUnique: async () => ({
        status: state.status,
        name: 'db',
        projectId: 'p1',
        clusterName: 'pg-db',
        backupScheduleDisabled: state.backupScheduleDisabled ?? false,
        project: { organizationId: 'o1' }
      }),
      updateMany: async ({ where, data }: any) => {
        if (where.status !== state.status) return { count: 0 };
        state.status = data.status;
        return { count: 1 };
      }
    }
  };
  const cnpg = {
    setScheduledBackupSuspended: async (_ns: string, _name: string, value: boolean) => {
      suspended.push(value);
    }
  };
  const consumer = new CnpgConsumer(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    cnpg as any,
    {} as any,
    { log: async (entry: any) => audits.push(entry) } as any
  );
  const adopt = (c: any) =>
    (consumer as any).adoptHibernation({ databaseId: 'd1' }, 'ns', 'pg-db', c) as Promise<void>;
  return { adopt, consumer, state, suspended, audits };
}

test('a kubectl hibernation stops the row, suspends backups and audits', async () => {
  const h = harness({ status: 'ready' });
  await h.adopt(cluster('on'));
  assert.equal(h.state.status, 'stopped');
  assert.deepEqual(h.suspended, [true]);
  assert.equal(h.audits[0].action, 'database.stopped');
  assert.equal(h.audits[0].metadata.reason, 'hibernation changed in k8s');
});

test('waking resumes backups unless the user turned them off', async () => {
  const on = harness({ status: 'stopped' });
  await on.adopt(cluster('off'));
  assert.equal(on.state.status, 'restarting');
  assert.deepEqual(on.suspended, [false]);

  const off = harness({ status: 'stopped', backupScheduleDisabled: true });
  await off.adopt(cluster('off'));
  assert.equal(off.state.status, 'restarting');
  assert.deepEqual(off.suspended, []);
});

test('a retired cluster hibernating after a restore does not touch the database', async () => {
  const row: any = {
    id: 'd1',
    status: 'ready',
    namespace: 'ns',
    clusterName: 'pg-db',
    clusterStatus: null,
    backupScheduleDisabled: false,
    name: 'db',
    projectId: 'p1',
    pgParameters: {},
    project: { organizationId: 'o1' }
  };
  const prisma = {
    database: {
      findFirst: async ({ where }: any) => (where.clusterName === row.clusterName ? row : null),
      findUnique: async () => row,
      update: async ({ data }: any) => Object.assign(row, data),
      updateMany: async ({ data }: any) => {
        Object.assign(row, data);
        return { count: 1 };
      }
    }
  };
  const suspended: string[] = [];
  const consumer: any = new CnpgConsumer(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {
      setScheduledBackupSuspended: async (_ns: string, name: string) => suspended.push(name)
    } as any,
    { get: () => null } as any,
    { log: async () => undefined } as any
  );
  consumer.scheduleEmit = () => undefined;
  consumer.syncSpecColumns = async () => undefined;
  consumer.adoptSettings = async () => undefined;

  const event = (name: string, hibernation?: string, readyInstances = 1) => ({
    metadata: {
      namespace: 'ns',
      name,
      annotations: hibernation ? { 'cnpg.io/hibernation': hibernation } : {}
    },
    spec: { instances: 1 },
    status: { readyInstances, instances: 1, phase: 'Cluster in healthy state' }
  });

  await consumer.onClusterEvent('update', event('pg-db'));
  assert.equal(row.clusterStatus.hibernated, false);

  row.clusterName = 'pg-db-restored';
  await consumer.onClusterEvent('update', event('pg-db', 'on', 0));
  assert.equal(row.status, 'ready');
  assert.equal(row.clusterStatus.hibernated, false);
  assert.deepEqual(suspended, []);

  await consumer.onClusterEvent('delete', event('pg-db', 'on', 0));
  assert.equal(row.status, 'ready');

  await consumer.onClusterEvent('update', event('pg-db-restored'));
  assert.equal(row.status, 'ready');
  assert.equal(row.clusterStatus.readyInstances, 1);
});

test('only the current cluster can stop the row or touch a backup schedule', async () => {
  const h = harness({ status: 'ready' });
  await (h as any).consumer.adoptHibernation({ databaseId: 'd1' }, 'ns', 'pg-old', cluster('on'));
  assert.equal(h.state.status, 'ready');
  assert.deepEqual(h.suspended, []);
  assert.deepEqual(h.audits, []);
});

test('a database wrongly stopped by a retired cluster heals on the next event', async () => {
  const h = harness({ status: 'stopped' });
  await h.adopt(cluster());
  assert.equal(h.state.status, 'restarting');
});
