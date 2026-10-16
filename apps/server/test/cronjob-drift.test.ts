import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScheduleState,
  appliedScheduleAnnotation,
  cronJobForReplace,
  externalScheduleEdits,
  jobScheduleState,
  readAppliedSchedule,
  scheduleStateOf
} from '../src/jobs/cronjob-drift';

const desired = () =>
  ({
    metadata: {
      name: 'ojob-1234abcd',
      namespace: 'acme',
      labels: {
        'app.kubernetes.io/managed-by': 'orchard-job',
        'orchard/job-id': 'j1',
        'orchard/project-id': 'p1'
      },
      annotations: { 'orchard/spec-hash': 'new' }
    },
    spec: { schedule: '0 * * * *', suspend: false, jobTemplate: {} }
  }) as any;

test('a replace keeps labels and annotations added outside orchard', () => {
  const live = {
    metadata: {
      resourceVersion: '42',
      labels: { team: 'payments', 'orchard/job-id': 'j1' },
      annotations: {
        'orchard/spec-hash': 'old',
        'example.com/owner': 'ops',
        'kubectl.kubernetes.io/last-applied-configuration': '{}'
      }
    }
  } as any;
  const out = cronJobForReplace(desired(), live);
  assert.equal(out.metadata!.resourceVersion, '42');
  assert.deepEqual(out.metadata!.labels, {
    team: 'payments',
    'app.kubernetes.io/managed-by': 'orchard-job',
    'orchard/job-id': 'j1',
    'orchard/project-id': 'p1'
  });
  assert.equal(out.metadata!.annotations!['orchard/spec-hash'], 'new');
  assert.equal(out.metadata!.annotations!['example.com/owner'], 'ops');
  assert.equal(
    out.metadata!.annotations!['kubectl.kubernetes.io/last-applied-configuration'],
    '{}'
  );
});

test('orchard keys orchard no longer writes are dropped, not carried forward', () => {
  const live = {
    metadata: {
      labels: { 'orchard/legacy': 'x' },
      annotations: { 'orchard/retired': 'y' }
    }
  } as any;
  const out = cronJobForReplace(desired(), live);
  assert.equal(out.metadata!.labels!['orchard/legacy'], undefined);
  assert.equal(out.metadata!.annotations!['orchard/retired'], undefined);
});

test('orchard always wins on the keys it owns', () => {
  const live = {
    metadata: {
      labels: { 'app.kubernetes.io/managed-by': 'someone-else' },
      annotations: {}
    }
  } as any;
  const out = cronJobForReplace(desired(), live);
  assert.equal(out.metadata!.labels!['app.kubernetes.io/managed-by'], 'orchard-job');
});

test('the desired object is not mutated', () => {
  const d = desired();
  cronJobForReplace(d, { metadata: { resourceVersion: '1', labels: { a: 'b' } } } as any);
  assert.equal(d.metadata.resourceVersion, undefined);
  assert.equal(d.metadata.labels.a, undefined);
});

const state = (over: Partial<ScheduleState> = {}): ScheduleState => ({
  schedule: '0 * * * *',
  timeZone: null,
  suspend: false,
  concurrencyPolicy: 'Forbid',
  ...over
});

const withApplied = (applied: ScheduleState, spec: any) =>
  ({
    metadata: {
      resourceVersion: '7',
      annotations: { 'orchard/applied-schedule': appliedScheduleAnnotation(applied) }
    },
    spec
  }) as any;

test('an edit made in k8s is told apart from a change orchard has yet to push', () => {
  const applied = state();
  assert.deepEqual(externalScheduleEdits(state({ schedule: '*/5 * * * *' }), applied, state()), [
    'schedule'
  ]);
  assert.deepEqual(externalScheduleEdits(state(), applied, state({ schedule: '*/5 * * * *' })), []);
  assert.deepEqual(
    externalScheduleEdits(
      state({ schedule: '*/5 * * * *' }),
      applied,
      state({ schedule: '30 * * * *' })
    ),
    []
  );
  assert.deepEqual(externalScheduleEdits(state({ suspend: true }), applied, state()), ['suspend']);
});

test('a replace does not revert a schedule edited in k8s that is not adopted yet', () => {
  const d = desired();
  d.spec.concurrencyPolicy = 'Forbid';
  d.spec.jobTemplate = { spec: { template: { spec: { containers: [{ image: 'new' }] } } } };
  const live = withApplied(state(), {
    schedule: '*/5 * * * *',
    suspend: true,
    concurrencyPolicy: 'Forbid'
  });
  const out = cronJobForReplace(d, live);
  assert.equal(out.spec!.schedule, '*/5 * * * *');
  assert.equal(out.spec!.suspend, true);
  assert.equal(out.spec!.jobTemplate.spec!.template.spec!.containers[0].image, 'new');
  assert.equal(d.spec.schedule, '0 * * * *');
});

test('a change made in orchard is pushed even over an edit in k8s', () => {
  const d = desired();
  d.spec.schedule = '30 * * * *';
  d.spec.concurrencyPolicy = 'Forbid';
  const live = withApplied(state(), { schedule: '*/5 * * * *', suspend: false });
  assert.equal(cronJobForReplace(d, live).spec!.schedule, '30 * * * *');
});

test('a cronjob orchard never stamped is replaced as before', () => {
  const out = cronJobForReplace(desired(), {
    metadata: {},
    spec: { schedule: '*/5 * * * *' }
  } as any);
  assert.equal(out.spec!.schedule, '0 * * * *');
});

test('a removed time zone is carried over as removed', () => {
  const d = desired();
  d.spec.timeZone = 'Europe/Madrid';
  d.spec.concurrencyPolicy = 'Forbid';
  const live = withApplied(state({ timeZone: 'Europe/Madrid' }), {
    schedule: '0 * * * *',
    suspend: false,
    concurrencyPolicy: 'Forbid'
  });
  assert.equal(cronJobForReplace(d, live).spec!.timeZone, undefined);
});

test('the stamp round-trips and garbage reads as unstamped', () => {
  const s = state({ timeZone: 'UTC', suspend: true });
  assert.deepEqual(
    readAppliedSchedule({
      annotations: { 'orchard/applied-schedule': appliedScheduleAnnotation(s) }
    }),
    s
  );
  assert.equal(readAppliedSchedule({ annotations: { 'orchard/applied-schedule': '{' } }), null);
  assert.equal(readAppliedSchedule({ annotations: { 'orchard/applied-schedule': '{}' } }), null);
  assert.equal(readAppliedSchedule({}), null);
});

test('the k8s defaults map onto the same state orchard stores', () => {
  assert.deepEqual(
    scheduleStateOf({ schedule: '0 * * * *', jobTemplate: {} } as any),
    state({ concurrencyPolicy: 'Allow' })
  );
  assert.deepEqual(
    jobScheduleState({
      scheduleCron: '0 * * * *',
      timeZone: '',
      enabled: true,
      concurrencyPolicy: 'forbid'
    }),
    state()
  );
});
