import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoptionDeferred, CronJobConsumer } from '../src/engine/consumers/cronjob.consumer';
import { appliedScheduleAnnotation, jobScheduleState } from '../src/jobs/cronjob-drift';

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

function build(opts: { row: Row | null; syncing?: boolean; raceWith?: Partial<Row> }) {
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
    { log: async (entry: any) => audits.push(entry) } as any,
    { emitJobChanged: (...args: any[]) => events.push(args) } as any,
    { isSyncingCronJob: () => opts.syncing ?? false } as any
  );
  return { consumer, state, audits, events };
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
