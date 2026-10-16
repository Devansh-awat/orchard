import test from 'node:test';
import assert from 'node:assert/strict';
import { JobConsumer } from '../src/engine/consumers/job.consumer';
import { CnpgConsumer } from '../src/engine/consumers/cnpg.consumer';

const k8sJob = {
  metadata: {
    uid: 'u1',
    name: 'ojr-1',
    namespace: 'acme',
    labels: { 'orchard/job-id': 'j1', 'orchard/run-id': 'r1' }
  }
} as any;

function jobHarness(live: 'present' | 'absent' | 'unknown') {
  const writes: any[] = [];
  const prisma = {
    jobRunStep: {
      findUnique: async () => ({
        runId: 'r1',
        stepOrder: 0,
        status: 'running',
        run: {
          status: 'running',
          jobId: 'j1',
          job: { project: { id: 'p1', namespace: 'acme', organizationId: 'o1' } }
        }
      }),
      updateMany: async (args: any) => {
        writes.push(args);
        return { count: 1 };
      }
    }
  };
  const orchestrator = { finishRun: async (...args: any[]) => writes.push(args) };
  const consumer = new JobConsumer(prisma as any, orchestrator as any, {} as any);
  (consumer as any).liveJob = async () => live;
  return { consumer, writes };
}

test('a job that still exists does not fail its run', async () => {
  const { consumer, writes } = jobHarness('present');
  await consumer.onEvent('delete', k8sJob);
  assert.deepEqual(writes, []);
});

test('an apiserver that cannot answer never fails a run', async () => {
  const { consumer, writes } = jobHarness('unknown');
  await assert.rejects(consumer.onEvent('delete', k8sJob));
  assert.deepEqual(writes, []);
});

test('a job confirmed gone fails its run', async () => {
  const { consumer, writes } = jobHarness('absent');
  await consumer.onEvent('delete', k8sJob);
  assert.ok(writes.length > 0);
});

function cnpgHarness(live: 'present' | 'absent' | 'unknown') {
  const written: any[] = [];
  const consumer = new CnpgConsumer(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  (consumer as any).resolveCtx = async () => ({ databaseId: 'db1', orgId: 'o1', projectId: 'p1' });
  (consumer as any).liveCluster = async () => live;
  (consumer as any).writebackStatus = async (_ctx: any, input: any) => written.push(input);
  (consumer as any).writebackSnapshot = async () => {};
  (consumer as any).scheduleEmit = () => {};
  return { consumer, written };
}

const cluster = { metadata: { name: 'pg-db', namespace: 'acme' } };

test('a cluster that still exists is not marked deleted', async () => {
  const { consumer, written } = cnpgHarness('present');
  await consumer.onClusterEvent('delete', cluster);
  assert.deepEqual(written, []);
});

test('an apiserver that cannot answer never marks a cluster deleted', async () => {
  const { consumer, written } = cnpgHarness('unknown');
  await assert.rejects(consumer.onClusterEvent('delete', cluster));
  assert.deepEqual(written, []);
});

test('a cluster confirmed gone is marked deleted', async () => {
  const { consumer, written } = cnpgHarness('absent');
  await consumer.onClusterEvent('delete', cluster);
  assert.deepEqual(written, [{ deleted: true }]);
});
