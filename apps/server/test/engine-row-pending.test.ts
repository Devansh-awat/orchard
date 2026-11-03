import test from 'node:test';
import assert from 'node:assert/strict';
import { PodConsumer } from '../src/engine/consumers/pod.consumer';
import { rowMayBePending } from '../src/engine/consumers/row-pending';

const MINUTE = 60 * 1000;

function consumer() {
  let row: any = null;
  let lookups = 0;
  const prisma = {
    deployment: {
      findFirst: async () => {
        lookups += 1;
        return row;
      }
    }
  };
  return {
    pods: new PodConsumer(prisma as any, {} as any, {} as any, {} as any),
    commit: () => {
      row = { id: 'd1', projectId: 'p1', project: { organizationId: 'o1' } };
    },
    lookups: () => lookups
  };
}

function pod(ageMs: number) {
  return {
    metadata: {
      name: 'web-abc',
      namespace: 'acme',
      labels: { 'app.kubernetes.io/name': 'web' },
      creationTimestamp: new Date(Date.now() - ageMs)
    }
  } as any;
}

test('a pod seen before its deployment row is committed still maps once the row lands', async () => {
  const c = consumer();
  assert.deepEqual(await c.pods.mapRefs(pod(1000)), {});
  c.commit();
  assert.deepEqual(await c.pods.mapRefs(pod(2000)), { deploymentId: 'd1', projectId: 'p1' });
});

test('an old pod with no deployment is remembered, so it costs one lookup', async () => {
  const c = consumer();
  await c.pods.mapRefs(pod(10 * MINUTE));
  await c.pods.mapRefs(pod(10 * MINUTE));
  assert.equal(c.lookups(), 1);
});

test('a pod with a known deployment is cached whatever its age', async () => {
  const c = consumer();
  c.commit();
  await c.pods.mapRefs(pod(1000));
  await c.pods.mapRefs(pod(1000));
  assert.equal(c.lookups(), 1);
});

test('only recently created objects may still be waiting on their row', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.equal(rowMayBePending(new Date(now - MINUTE), now), true);
  assert.equal(rowMayBePending(new Date(now - 3 * MINUTE), now), false);
  assert.equal(rowMayBePending(undefined, now), false);
  assert.equal(rowMayBePending('not a date', now), false);
});
