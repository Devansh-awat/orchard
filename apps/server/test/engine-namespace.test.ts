import test from 'node:test';
import assert from 'node:assert/strict';
import { NamespaceConsumer } from '../src/engine/consumers/namespace.consumer';
import { RemovalPending } from '../src/engine/consumers/workload.consumer';

const OLD = new Date(Date.now() - 60 * 60 * 1000);
const YOUNG = new Date();

function build(opts: {
  projects?: { id: string; name: string; namespace: string; createdAt: Date }[];
  environments?: { id: string; name: string; namespace: string; createdAt: Date }[];
  live: Record<string, 'present' | 'absent' | 'unknown'>;
  observed?: string[];
}) {
  const removed: { kind: string; id: string; cause: any }[] = [];
  const prisma = {
    project: {
      findFirst: async ({ where }: any) =>
        opts.projects?.find((p) => p.namespace === where.namespace) ?? null,
      findMany: async () => (opts.projects ?? []).map((p) => ({ namespace: p.namespace }))
    },
    environment: {
      findUnique: async ({ where }: any) =>
        opts.environments?.find((e) => e.namespace === where.namespace) ?? null,
      findMany: async () => (opts.environments ?? []).map((e) => ({ namespace: e.namespace }))
    }
  };
  const moduleRef = {
    get: (token: any) => ({
      deleteProjectFromCluster: async (id: string, cause: any) => {
        removed.push({ kind: 'project', id, cause });
      },
      deleteEnvironmentFromCluster: async (id: string, cause: any) => {
        removed.push({ kind: 'environment', id, cause });
      },
      token
    })
  };
  const consumer = new NamespaceConsumer(prisma as any, {} as any, moduleRef as any);
  (consumer as any).confirmAfterMs = 0;
  (consumer as any).liveState = async (ns: string) => opts.live[ns] ?? 'absent';
  (consumer as any).observed = async (names: string[]) =>
    new Set(names.filter((n) => opts.observed === undefined || opts.observed.includes(n)));
  return { consumer, removed };
}

const gone = (name: string) => ({ metadata: { name } }) as any;

async function deleteEvent(consumer: NamespaceConsumer, name: string): Promise<'pending' | 'done'> {
  try {
    await consumer.onEvent('delete', gone(name));
    return 'done';
  } catch (err) {
    if (err instanceof RemovalPending) return 'pending';
    throw err;
  }
}

test('one delete signal is never enough: the first sighting only starts the clock', async () => {
  const { consumer, removed } = build({
    projects: [{ id: 'p1', name: 'acme', namespace: 'acme-prod', createdAt: OLD }],
    live: { 'acme-prod': 'absent' }
  });
  assert.equal(await deleteEvent(consumer, 'acme-prod'), 'pending');
  assert.deepEqual(removed, []);
  assert.equal(await deleteEvent(consumer, 'acme-prod'), 'done');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].kind, 'project');
  assert.equal(removed[0].cause.reason, 'resource deleted in k8s');
  consumer.onModuleDestroy();
});

test('the apiserver still having the namespace cancels the removal', async () => {
  const { consumer, removed } = build({
    environments: [{ id: 'e1', name: 'staging', namespace: 'acme-staging', createdAt: OLD }],
    live: { 'acme-staging': 'present' }
  });
  await consumer.onEvent('delete', gone('acme-staging'));
  await consumer.onEvent('delete', gone('acme-staging'));
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('an apiserver that cannot answer never counts as a deletion', async () => {
  const { consumer, removed } = build({
    environments: [{ id: 'e1', name: 'staging', namespace: 'acme-staging', createdAt: OLD }],
    live: { 'acme-staging': 'unknown' }
  });
  assert.equal(await deleteEvent(consumer, 'acme-staging'), 'pending');
  assert.equal(await deleteEvent(consumer, 'acme-staging'), 'pending');
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('a namespace seen again between sightings resets the clock', async () => {
  const { consumer, removed } = build({
    environments: [{ id: 'e1', name: 'staging', namespace: 'acme-staging', createdAt: OLD }],
    live: { 'acme-staging': 'absent' }
  });
  assert.equal(await deleteEvent(consumer, 'acme-staging'), 'pending');
  await consumer.onEvent('update', gone('acme-staging'));
  assert.equal(await deleteEvent(consumer, 'acme-staging'), 'pending');
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('rows younger than the settle window are left alone', async () => {
  const { consumer, removed } = build({
    environments: [{ id: 'e1', name: 'fresh', namespace: 'acme-fresh', createdAt: YOUNG }],
    live: { 'acme-fresh': 'absent' }
  });
  assert.equal(await deleteEvent(consumer, 'acme-fresh'), 'pending');
  assert.equal(await deleteEvent(consumer, 'acme-fresh'), 'pending');
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('many namespaces vanishing at once trips the breaker instead of deleting', async () => {
  const envs = ['a', 'b', 'c', 'd'].map((n) => ({
    id: `e-${n}`,
    name: n,
    namespace: `ns-${n}`,
    createdAt: OLD
  }));
  const { consumer, removed } = build({ environments: envs, live: {} });
  const seen = [{ namespace: '', name: 'kube-system', refs: {} }];
  await consumer.pruneMissing(seen);
  await consumer.pruneMissing(seen);
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('a single namespace missing from a complete list is removed after confirmation', async () => {
  const { consumer, removed } = build({
    environments: [
      { id: 'e1', name: 'staging', namespace: 'acme-staging', createdAt: OLD },
      { id: 'e2', name: 'qa', namespace: 'acme-qa', createdAt: OLD }
    ],
    live: { 'acme-staging': 'absent', 'acme-qa': 'present' }
  });
  const seen = [{ namespace: '', name: 'acme-qa', refs: { projectId: 'p1' } }];
  await consumer.pruneMissing(seen);
  assert.deepEqual(removed, []);
  await consumer.pruneMissing(seen);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 'e1');
  assert.equal(removed[0].cause.source, 'mirror.list');
  consumer.onModuleDestroy();
});

test('an incomplete or unresolved list never prunes', async () => {
  const { consumer, removed } = build({
    environments: [{ id: 'e1', name: 'staging', namespace: 'acme-staging', createdAt: OLD }],
    live: { 'acme-staging': 'absent' }
  });
  await consumer.pruneMissing([]);
  await consumer.pruneMissing([]);
  await consumer.pruneMissing([{ namespace: '', name: 'x', refs: null }]);
  await consumer.pruneMissing([{ namespace: '', name: 'x', refs: null }]);
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('a namespace this cluster never had keeps its project after a restore', async () => {
  const { consumer, removed } = build({
    projects: [
      { id: 'p1', name: 'acme', namespace: 'acme-prod', createdAt: OLD },
      { id: 'p2', name: 'globex', namespace: 'globex-prod', createdAt: OLD }
    ],
    live: {},
    observed: []
  });
  const seen = [{ namespace: '', name: 'kube-system', refs: {} }];
  await consumer.pruneMissing(seen);
  await consumer.pruneMissing(seen);
  assert.deepEqual(removed, []);
  consumer.onModuleDestroy();
});

test('a tombstoned namespace missing from the list is still removed', async () => {
  const { consumer, removed } = build({
    projects: [
      { id: 'p1', name: 'acme', namespace: 'acme-prod', createdAt: OLD },
      { id: 'p2', name: 'globex', namespace: 'globex-prod', createdAt: OLD }
    ],
    live: {},
    observed: ['acme-prod']
  });
  const seen = [{ namespace: '', name: 'kube-system', refs: {} }];
  await consumer.pruneMissing(seen);
  await consumer.pruneMissing(seen);
  assert.deepEqual(
    removed.map((r) => r.id),
    ['p1']
  );
  consumer.onModuleDestroy();
});

test('a removal cut short by a restart is finished from its tombstone', async () => {
  const projects = [{ id: 'p1', name: 'acme', namespace: 'acme-prod', createdAt: OLD }];
  const first = build({ projects, live: {} });
  assert.equal(await deleteEvent(first.consumer, 'acme-prod'), 'pending');
  first.consumer.onModuleDestroy();

  const second = build({ projects, live: {} });
  assert.equal(await deleteEvent(second.consumer, 'acme-prod'), 'pending');
  assert.equal(await deleteEvent(second.consumer, 'acme-prod'), 'done');
  assert.equal(second.removed.length, 1);
  assert.equal(first.removed.length, 0);
  second.consumer.onModuleDestroy();
});
