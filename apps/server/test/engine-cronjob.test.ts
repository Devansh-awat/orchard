import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoptionDeferred, CronJobConsumer } from '../src/engine/consumers/cronjob.consumer';
import { RemovalPending } from '../src/engine/consumers/workload.consumer';
import {
  appliedScheduleAnnotation,
  jobScheduleState,
  missingCronJobAction
} from '../src/jobs/cronjob-drift';

const JOB_ID = '1234abcd-0000-4000-8000-000000000001';
const NAME = 'ojob-1234abcd';

interface Row {
  id: string;
  projectId: string;
  name: string;
  scheduleCron: string | null;
  timeZone: string | null;
  enabled: boolean;
  concurrencyPolicy: string;
  cronJobName: string | null;
  project: { namespace: string; organizationId: string };
}

const baseRow = (over: Partial<Row> = {}): Row => ({
  id: JOB_ID,
  projectId: 'p1',
  name: 'nightly',
  scheduleCron: '0 * * * *',
  timeZone: null,
  enabled: true,
  concurrencyPolicy: 'forbid',
  cronJobName: NAME,
  project: { namespace: 'acme', organizationId: 'o1' },
  ...over
});

function build(opts: {
  row: Row | null;
  syncing?: boolean;
  raceWith?: Partial<Row>;
  live?: 'present' | 'absent' | 'unknown';
  namespace?: 'present' | 'absent' | 'unknown';
}) {
  const audits: any[] = [];
  const events: any[] = [];
  const state = { row: opts.row ? { ...opts.row } : null };
  const prisma = {
    job: {
      findUnique: async ({ where }: any) =>
        state.row && state.row.id === where.id ? { ...state.row } : null,
      updateMany: async ({ where, data }: any) => {
        if (opts.raceWith && state.row) Object.assign(state.row, opts.raceWith);
        const row = state.row;
        if (!row || row.id !== where.id) return { count: 0 };
        for (const [key, value] of Object.entries(where)) {
          if (key !== 'id' && (row as any)[key] !== value) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }
    }
  };
  const consumer = new CronJobConsumer(
    prisma as any,
    {} as any,
    { log: async (entry: any) => audits.push(entry) } as any,
    { emitJobChanged: (...args: any[]) => events.push(args) } as any,
    { isSyncingCronJob: () => opts.syncing ?? false } as any
  );
  (consumer as any).confirmAfterMs = 0;
  (consumer as any).liveCronJob = async () => opts.live ?? 'absent';
  (consumer as any).liveNamespace = async () => opts.namespace ?? 'present';
  return { consumer, state, audits, events };
}

async function deleteEvent(consumer: CronJobConsumer, obj: any): Promise<'pending' | 'done'> {
  try {
    await consumer.onEvent('delete', obj);
    return 'done';
  } catch (err) {
    if (err instanceof RemovalPending) return 'pending';
    throw err;
  }
}

const cronJob = (spec: any, applied: Row | null, over: any = {}) =>
  ({
    metadata: {
      name: NAME,
      namespace: 'acme',
      labels: { 'orchard/job-id': JOB_ID },
      annotations: applied
        ? { 'orchard/applied-schedule': appliedScheduleAnnotation(jobScheduleState(applied)) }
        : {},
      ...over
    },
    spec: { concurrencyPolicy: 'Forbid', suspend: false, ...spec }
  }) as any;

test('a schedule and suspend edited with kubectl land on the job', async () => {
  const row = baseRow();
  const { consumer, state, audits, events } = build({ row });
  await consumer.onEvent('update', cronJob({ schedule: '*/5 * * * *', suspend: true }, row));
  assert.equal(state.row!.scheduleCron, '*/5 * * * *');
  assert.equal(state.row!.enabled, false);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'job.updated');
  assert.equal(audits[0].actorUserId, undefined);
  assert.equal(audits[0].metadata.reason, 'schedule edited in k8s');
  assert.deepEqual(audits[0].metadata.scheduleCron, ['0 * * * *', '*/5 * * * *']);
  assert.deepEqual(audits[0].metadata.enabled, [true, false]);
  assert.deepEqual(events, [['o1', JOB_ID, 'p1']]);
});

test('time zone and concurrency policy are adopted too', async () => {
  const row = baseRow();
  const { consumer, state } = build({ row });
  await consumer.onEvent(
    'update',
    cronJob({ schedule: '0 * * * *', timeZone: 'Europe/Madrid', concurrencyPolicy: 'Allow' }, row)
  );
  assert.equal(state.row!.timeZone, 'Europe/Madrid');
  assert.equal(state.row!.concurrencyPolicy, 'allow');
});

test('a cronjob that matches what orchard wrote changes nothing', async () => {
  const row = baseRow();
  const { consumer, state, audits } = build({ row });
  await consumer.onEvent('update', cronJob({ schedule: '0 * * * *' }, row));
  assert.deepEqual(state.row, row);
  assert.equal(audits.length, 0);
});

test('a change saved in orchard and not pushed yet is not undone by the old cronjob', async () => {
  const pushed = baseRow();
  const row = baseRow({ scheduleCron: '30 * * * *', enabled: false });
  const { consumer, state, audits } = build({ row });
  await consumer.onEvent('update', cronJob({ schedule: '0 * * * *' }, pushed));
  assert.equal(state.row!.scheduleCron, '30 * * * *');
  assert.equal(state.row!.enabled, false);
  assert.equal(audits.length, 0);
});

test('values orchard cannot represent stay in the cluster and are not adopted', async () => {
  const row = baseRow();
  const { consumer, state, audits } = build({ row });
  await consumer.onEvent(
    'update',
    cronJob({ schedule: '@hourly', concurrencyPolicy: 'Replace', timeZone: 'Mars/Olympus' }, row)
  );
  assert.deepEqual(state.row, row);
  assert.equal(audits.length, 0);

  await consumer.onEvent('update', cronJob({ schedule: '@hourly', suspend: true }, row));
  assert.equal(state.row!.enabled, false);
  assert.equal(state.row!.scheduleCron, '0 * * * *');
});

test('adoption waits while orchard is writing the cronjob', async () => {
  const row = baseRow();
  const { consumer, state } = build({ row, syncing: true });
  await assert.rejects(
    consumer.onEvent('update', cronJob({ schedule: '*/5 * * * *' }, row)),
    AdoptionDeferred
  );
  assert.equal(state.row!.scheduleCron, '0 * * * *');
});

test('a job edited in orchard mid-adoption wins and the adoption retries', async () => {
  const row = baseRow();
  const { consumer, state, audits } = build({ row, raceWith: { enabled: false } });
  await assert.rejects(
    consumer.onEvent('update', cronJob({ schedule: '*/5 * * * *' }, row)),
    AdoptionDeferred
  );
  assert.equal(state.row!.scheduleCron, '0 * * * *');
  assert.equal(audits.length, 0);
});

test('a cronjob orchard has not stamped yet is left for the sweep to stamp', async () => {
  const row = baseRow();
  const { consumer, state } = build({ row });
  await consumer.onEvent('update', cronJob({ schedule: '*/5 * * * *' }, null));
  assert.equal(state.row!.scheduleCron, '0 * * * *');
});

test('copies, foreign namespaces and unknown jobs are ignored', async () => {
  const row = baseRow();
  const { consumer, state } = build({ row });
  await consumer.onEvent('update', cronJob({ schedule: '*/5 * * * *' }, row, { name: 'copy' }));
  await consumer.onEvent(
    'update',
    cronJob({ schedule: '*/5 * * * *' }, row, { namespace: 'other' })
  );
  await consumer.onEvent(
    'update',
    cronJob({ schedule: '*/5 * * * *' }, row, { labels: { 'orchard/job-id': 'nope' } })
  );
  assert.equal(state.row!.scheduleCron, '0 * * * *');

  const missing = build({ row: null });
  await missing.consumer.onEvent('update', cronJob({ schedule: '*/5 * * * *' }, row));
  assert.equal(missing.audits.length, 0);
});

test('a confirmed delete disables the job and unlinks the cronjob, keeping the job', async () => {
  const row = baseRow();
  const { consumer, state, audits, events } = build({ row });
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'pending');
  assert.equal(state.row!.enabled, true);
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'done');
  assert.ok(state.row);
  assert.equal(state.row!.enabled, false);
  assert.equal(state.row!.cronJobName, null);
  assert.equal(state.row!.scheduleCron, '0 * * * *');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].metadata.reason, 'resource deleted in k8s');
  assert.deepEqual(audits[0].metadata.enabled, [true, false]);
  assert.deepEqual(events, [['o1', JOB_ID, 'p1']]);
});

test('the apiserver still having the cronjob is a false alarm', async () => {
  const row = baseRow();
  const { consumer, state, audits } = build({ row, live: 'present' });
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'done');
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'done');
  assert.equal(state.row!.enabled, true);
  assert.equal(audits.length, 0);
});

test('an apiserver that cannot answer never counts as a delete', async () => {
  const row = baseRow();
  const { consumer, state } = build({ row, live: 'unknown' });
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'pending');
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'pending');
  assert.equal(state.row!.enabled, true);
});

test('a deleted namespace is left to the namespace consumer', async () => {
  const row = baseRow();
  const { consumer, state } = build({ row, namespace: 'absent' });
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'done');
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'done');
  assert.equal(state.row!.enabled, true);
});

test('a cronjob orchard removed itself, or of a disabled job, changes nothing', async () => {
  const unlinked = build({ row: baseRow({ cronJobName: null }) });
  assert.equal(await deleteEvent(unlinked.consumer, cronJob({}, baseRow())), 'done');
  assert.equal(await deleteEvent(unlinked.consumer, cronJob({}, baseRow())), 'done');
  assert.equal(unlinked.state.row!.enabled, true);
  assert.equal(unlinked.audits.length, 0);

  const disabled = build({ row: baseRow({ enabled: false }) });
  assert.equal(await deleteEvent(disabled.consumer, cronJob({}, baseRow())), 'done');
  assert.equal(disabled.audits.length, 0);
});

test('the cronjob coming back between the two checks cancels the removal', async () => {
  const row = baseRow();
  const opts = { row, live: 'absent' as 'absent' | 'present' };
  const { consumer, state } = build(opts);
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'pending');
  (consumer as any).liveCronJob = async () => 'present';
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'done');
  (consumer as any).liveCronJob = async () => 'absent';
  assert.equal(await deleteEvent(consumer, cronJob({}, row)), 'pending');
  assert.equal(state.row!.enabled, true);
});

test('many deletes in a short window trip the breaker', async () => {
  let removals: number[] = [];
  const outcomes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const id = `1234abc${i}-0000-4000-8000-000000000001`;
    const row = baseRow({ id, cronJobName: `ojob-1234abc${i}` });
    const single = build({ row });
    (single.consumer as any).removals = removals;
    const obj = cronJob({}, row, {
      name: `ojob-1234abc${i}`,
      labels: { 'orchard/job-id': id }
    });
    await deleteEvent(single.consumer, obj);
    outcomes.push(await deleteEvent(single.consumer, obj));
    removals = (single.consumer as any).removals;
  }
  assert.deepEqual(outcomes, ['done', 'done', 'done', 'done', 'done', 'pending', 'pending']);
});

test('the sweep waits for the engine before recreating a cronjob that vanished', () => {
  const base = {
    enabled: true,
    linked: true,
    recreate: false,
    engineWatching: true,
    missingForMs: 0
  };
  assert.equal(missingCronJobAction(base), 'wait');
  assert.equal(missingCronJobAction({ ...base, missingForMs: 11 * 60 * 1000 }), 'create');
  assert.equal(missingCronJobAction({ ...base, recreate: true }), 'create');
  assert.equal(missingCronJobAction({ ...base, engineWatching: false }), 'create');
  assert.equal(missingCronJobAction({ ...base, linked: false }), 'create');
  assert.equal(missingCronJobAction({ ...base, enabled: false }), 'unlink');
  assert.equal(missingCronJobAction({ ...base, enabled: false, linked: false }), 'skip');
});
