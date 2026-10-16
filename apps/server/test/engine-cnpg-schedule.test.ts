import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronFromSchedule, scheduleCronUpdate } from '../src/kubernetes/cnpg-spec-sync';
import { CnpgConsumer, ScheduleRemovalPending } from '../src/engine/consumers/cnpg.consumer';
import { K8S_DELETED_REASON } from '../src/engine/consumers/workload.consumer';

type Live = 'present' | 'absent' | 'unknown';

interface Row {
  name: string;
  status: string;
  namespace: string;
  clusterName: string;
  backupScheduleCron: string | null;
  backupScheduleDisabled: boolean;
}

function build(row: Row | null, live: { schedule?: Live; cluster?: Live } = {}) {
  const updates: any[] = [];
  const audits: any[] = [];
  const svc = Object.create(CnpgConsumer.prototype) as any;
  Object.assign(svc, {
    logger: { log() {}, warn() {} },
    ctxCache: new Map(),
    lastEmit: new Map(),
    pending: new Map(),
    scheduleAbsentSince: new Map(),
    confirmAfterMs: 0,
    prisma: {
      database: {
        findFirst: async ({ where }: any) =>
          row && row.namespace === where.namespace && row.clusterName === where.clusterName
            ? { id: 'db-1', projectId: 'p1', project: { organizationId: 'o1' } }
            : null,
        findUnique: async () => row,
        update: async ({ data }: any) => {
          updates.push(data);
          if (row) Object.assign(row, data);
          return {};
        }
      }
    },
    orgEvents: { emit() {} },
    audit: {
      log: async (entry: any) => {
        audits.push(entry);
      }
    },
    liveScheduledBackup: async () => live.schedule ?? 'absent',
    liveCluster: async () => live.cluster ?? 'present'
  });
  return { svc, updates, audits };
}

const scheduled = (schedule: string, name = 'pg-a-schedule', extra: any = {}) => ({
  metadata: { namespace: 'ns', name, ...extra },
  spec: { schedule, cluster: { name: 'pg-a' } }
});

const row = (extra: Partial<Row> = {}): Row => ({
  name: 'main-db',
  status: 'ready',
  namespace: 'ns',
  clusterName: 'pg-a',
  backupScheduleCron: '0 3 * * *',
  backupScheduleDisabled: false,
  ...extra
});

test('a quartz schedule is stored the way orchard stores a cron, and an unchanged one is left alone', () => {
  assert.equal(cronFromSchedule('0 0 4 * * *'), '0 4 * * *');
  assert.equal(cronFromSchedule('30 0 4 * * *'), '30 0 4 * * *');
  const on = { backupScheduleCron: '0 3 * * *', backupScheduleDisabled: false };
  assert.equal(scheduleCronUpdate(on, '0 0 3 * * *'), null);
  assert.equal(scheduleCronUpdate(on, ' 0  0 3 * * * '), null);
  assert.equal(scheduleCronUpdate(on, '0 0 5 * * *'), '0 5 * * *');
  assert.equal(scheduleCronUpdate({ ...on, backupScheduleCron: null }, '0 0 3 * * *'), '0 3 * * *');
  assert.equal(
    scheduleCronUpdate({ ...on, backupScheduleDisabled: true }, '0 0 3 * * *'),
    '0 3 * * *'
  );
  assert.equal(scheduleCronUpdate(on, ''), null);
  assert.equal(scheduleCronUpdate(on, undefined), null);
});

test('a schedule edited with kubectl lands on the row', async () => {
  const { svc, updates } = build(row());
  await svc.onScheduledBackupEvent('update', scheduled('0 0 5 * * *'));
  assert.deepEqual(updates, [{ backupScheduleCron: '0 5 * * *', backupScheduleDisabled: false }]);

  const again = build(row({ backupScheduleCron: '0 5 * * *' }));
  await again.svc.onScheduledBackupEvent('update', scheduled('0 0 5 * * *'));
  assert.deepEqual(again.updates, []);
});

test('a schedule that orchard never recorded is adopted, a stale one after orchard turned it off is not', async () => {
  const legacy = build(row({ backupScheduleCron: null }));
  await legacy.svc.onScheduledBackupEvent('add', scheduled('0 0 3 * * *'));
  assert.deepEqual(legacy.updates, [
    { backupScheduleCron: '0 3 * * *', backupScheduleDisabled: false }
  ]);

  const stale = build(row({ backupScheduleCron: null, backupScheduleDisabled: true }), {
    schedule: 'absent'
  });
  await stale.svc.onScheduledBackupEvent('update', scheduled('0 0 3 * * *'));
  assert.deepEqual(stale.updates, []);

  const recreated = build(row({ backupScheduleCron: null, backupScheduleDisabled: true }), {
    schedule: 'present'
  });
  await recreated.svc.onScheduledBackupEvent('add', scheduled('0 0 2 * * *'));
  assert.deepEqual(recreated.updates, [
    { backupScheduleCron: '0 2 * * *', backupScheduleDisabled: false }
  ]);

  const unreadable = build(row({ backupScheduleCron: null, backupScheduleDisabled: true }), {
    schedule: 'unknown'
  });
  await assert.rejects(unreadable.svc.onScheduledBackupEvent('add', scheduled('0 0 2 * * *')));
});

test('schedules orchard did not name and ones being deleted are ignored', async () => {
  const { svc, updates } = build(row());
  await svc.onScheduledBackupEvent('update', scheduled('0 0 5 * * *', 'pg-a-hourly'));
  await svc.onScheduledBackupEvent(
    'update',
    scheduled('0 0 5 * * *', 'pg-a-schedule', { deletionTimestamp: '2026-10-16T00:00:00Z' })
  );
  assert.deepEqual(updates, []);
});

test('a schedule deleted with kubectl turns scheduled backups off once confirmed twice', async () => {
  const { svc, updates, audits } = build(row());
  await assert.rejects(
    svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *')),
    ScheduleRemovalPending
  );
  assert.deepEqual(updates, []);
  await svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *'));
  assert.deepEqual(updates, [{ backupScheduleCron: null, backupScheduleDisabled: true }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'database.backup_schedule.deleted');
  assert.equal(audits[0].actorUserId, undefined);
  assert.equal(audits[0].metadata.reason, K8S_DELETED_REASON);
  assert.equal(audits[0].metadata.previousCron, '0 3 * * *');
});

test('a delete is dropped when the schedule is back, the cluster is gone, or orchard already turned it off', async () => {
  const back = build(row(), { schedule: 'present' });
  await back.svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *'));
  assert.deepEqual(back.updates, []);

  const clusterGone = build(row(), { cluster: 'absent' });
  await clusterGone.svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *'));
  await clusterGone.svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *'));
  assert.deepEqual(clusterGone.updates, []);

  const ownDelete = build(row({ backupScheduleCron: null, backupScheduleDisabled: true }));
  await ownDelete.svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *'));
  assert.deepEqual(ownDelete.updates, []);

  const deleting = build(row({ status: 'deleting' }));
  await deleting.svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *'));
  assert.deepEqual(deleting.updates, []);

  const unreadable = build(row(), { schedule: 'unknown' });
  await assert.rejects(
    unreadable.svc.onScheduledBackupEvent('delete', scheduled('0 0 3 * * *')),
    ScheduleRemovalPending
  );
});
