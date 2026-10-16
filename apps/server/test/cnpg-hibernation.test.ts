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
  return { adopt, state, suspended, audits };
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
