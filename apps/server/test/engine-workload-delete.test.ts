import test from 'node:test';
import assert from 'node:assert/strict';
import { RemovalPending, WorkloadConsumer } from '../src/engine/consumers/workload.consumer';

const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

interface Row {
  id: string;
  name: string;
  namespace: string;
  buildStatus: string | null;
}

function build(opts: {
  rows: Row[];
  live?: Record<string, 'present' | 'absent' | 'unknown'>;
  namespaces?: Record<string, 'present' | 'absent' | 'unknown'>;
  pendingApply?: number;
}) {
  const removed: { id: string; cause: any }[] = [];
  const prisma = {
    deployment: {
      findFirst: async ({ where }: any) => {
        const row = opts.rows.find((r) => r.namespace === where.namespace && r.name === where.name);
        return row ? { id: row.id, projectId: 'p1', project: { organizationId: 'o1' } } : null;
      },
      findUnique: async ({ where }: any) => opts.rows.find((r) => r.id === where.id) ?? null
    },
    k8sWorkload: { deleteMany: async () => ({ count: 1 }) },
    k8sApplyItem: { count: async () => opts.pendingApply ?? 0 }
  };
  const moduleRef = {
    get: () => ({
      deleteDeploymentFromCluster: async (id: string, cause: any) => {
        removed.push({ id, cause });
        opts.rows = opts.rows.filter((r) => r.id !== id);
      }
    })
  };
  const consumer = new WorkloadConsumer(
    prisma as any,
    { emit: () => {} } as any,
    {} as any,
    { log: async () => {} } as any,
    {} as any,
    moduleRef as any
  );
  (consumer as any).confirmAfterMs = 0;
  (consumer as any).liveDeployment = async (ns: string, name: string) =>
    opts.live?.[`${ns}/${name}`] ?? 'absent';
  (consumer as any).liveNamespace = async (ns: string) => opts.namespaces?.[ns] ?? 'present';
  return { consumer, removed };
}

const dep = (name: string, namespace = 'acme', created = OLD) =>
  ({
    metadata: { name, namespace, creationTimestamp: created }
  }) as any;

const row = (id: string, name: string, extra: Partial<Row> = {}): Row => ({
  id,
  name,
  namespace: 'acme',
  buildStatus: 'succeeded',
  ...extra
});

async function deleteEvent(consumer: WorkloadConsumer, obj: any): Promise<'pending' | 'done'> {
  try {
    await consumer.onEvent('delete', obj);
    return 'done';
  } catch (err) {
    if (err instanceof RemovalPending) return 'pending';
    throw err;
  }
}

test('one delete signal only starts the clock; the second removes the deployment', async () => {
  const { consumer, removed } = build({ rows: [row('d1', 'web')] });
  assert.equal(await deleteEvent(consumer, dep('web')), 'pending');
  assert.deepEqual(removed, []);
  assert.equal(await deleteEvent(consumer, dep('web')), 'done');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 'd1');
  assert.equal(removed[0].cause.reason, 'resource deleted in k8s');
  assert.equal(removed[0].cause.namespace, 'acme');
  consumer.onModuleDestroy();
});

test('the apiserver still having the deployment is a false alarm', async () => {
  const { consumer, removed } = build({
    rows: [row('d1', 'web')],
    live: { 'acme/web': 'present' }
  });
  assert.equal(await deleteEvent(consumer, dep('web')), 'done');
  assert.equal(await deleteEvent(consumer, dep('web')), 'done');
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('an apiserver that cannot answer never counts as a delete', async () => {
  const { consumer, removed } = build({
    rows: [row('d1', 'web')],
    live: { 'acme/web': 'unknown' }
  });
  assert.equal(await deleteEvent(consumer, dep('web')), 'pending');
  assert.equal(await deleteEvent(consumer, dep('web')), 'pending');
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('a deleted namespace is left to the namespace consumer', async () => {
  const { consumer, removed } = build({
    rows: [row('d1', 'web')],
    namespaces: { acme: 'absent' }
  });
  assert.equal(await deleteEvent(consumer, dep('web')), 'done');
  assert.equal(await deleteEvent(consumer, dep('web')), 'done');
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('a build or a queued apply holds the removal back', async () => {
  const building = build({ rows: [row('d1', 'web', { buildStatus: 'building' })] });
  assert.equal(await deleteEvent(building.consumer, dep('web')), 'pending');
  assert.equal(await deleteEvent(building.consumer, dep('web')), 'pending');
  assert.deepEqual(building.removed, []);

  const applying = build({ rows: [row('d1', 'web')], pendingApply: 1 });
  assert.equal(await deleteEvent(applying.consumer, dep('web')), 'pending');
  assert.equal(await deleteEvent(applying.consumer, dep('web')), 'pending');
  assert.deepEqual(applying.removed, []);
});

test('a deployment removed right after it was created is a rollback, not a delete', async () => {
  const { consumer, removed } = build({ rows: [row('d1', 'web')] });
  const fresh = dep('web', 'acme', new Date().toISOString());
  assert.equal(await deleteEvent(consumer, fresh), 'done');
  assert.equal(await deleteEvent(consumer, fresh), 'done');
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('a row that was renamed away from the deleted object is not touched', async () => {
  const { consumer } = build({ rows: [row('d1', 'web')] });
  assert.equal(await deleteEvent(consumer, dep('web')), 'pending');
  (consumer as any).ctxCache.set('acme/web', {
    ctx: { deploymentId: 'd1', orgId: 'o1', projectId: 'p1' },
    exp: Date.now() + 60_000
  });
  const renamed = build({ rows: [row('d1', 'api')] });
  (renamed.consumer as any).ctxCache = (consumer as any).ctxCache;
  assert.equal(await deleteEvent(renamed.consumer, dep('web')), 'done');
  assert.deepEqual(renamed.removed, []);
  consumer.onModuleDestroy();
});

test('many deletes in a short window trip the breaker', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(`d${i}`, `app-${i}`));
  const { consumer, removed } = build({ rows });
  for (let i = 0; i < 7; i++) await deleteEvent(consumer, dep(`app-${i}`));
  const outcomes = [];
  for (let i = 0; i < 7; i++) outcomes.push(await deleteEvent(consumer, dep(`app-${i}`)));
  assert.equal(removed.length, 5);
  assert.deepEqual(outcomes.slice(5), ['pending', 'pending']);
  consumer.onModuleDestroy();
});
