import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BuildQueueService,
  claimFairnessLimits,
  fcBuildsPerVm,
  orgBuildLimit
} from '../src/projects/build-queue.service';

test('an org may use half of a pool by default, and small pools are not split', () => {
  assert.equal(orgBuildLimit(15, undefined), 8);
  assert.equal(orgBuildLimit(16, undefined), 8);
  assert.equal(orgBuildLimit(5, undefined), 3);
  assert.equal(orgBuildLimit(4, undefined), 0);
  assert.equal(orgBuildLimit(1, undefined), 0);
});

test('MAX_CONCURRENT_BUILDS_PER_ORG overrides the share and 0 turns it off', () => {
  assert.equal(orgBuildLimit(15, '3'), 3);
  assert.equal(orgBuildLimit(15, '0'), 0);
  assert.equal(orgBuildLimit(15, 'nonsense'), 8);
  assert.equal(orgBuildLimit(15, ''), 8);
});

test('claim limits map every pool and an unlimited org becomes a huge bound', () => {
  const shared = claimFairnessLimits({ local: 15, depot: 4, fc: 16 });
  assert.equal(shared.local, 8);
  assert.equal(shared.fc, 8);
  assert.ok(shared.depot > 1_000_000);
  const saved = process.env.MAX_CONCURRENT_BUILDS_PER_ORG;
  process.env.MAX_CONCURRENT_BUILDS_PER_ORG = '0';
  try {
    const off = claimFairnessLimits({ local: 15, depot: 4, fc: 16 });
    assert.ok(off.local > 1_000_000 && off.depot > 1_000_000 && off.fc > 1_000_000);
  } finally {
    if (saved === undefined) delete process.env.MAX_CONCURRENT_BUILDS_PER_ORG;
    else process.env.MAX_CONCURRENT_BUILDS_PER_ORG = saved;
  }
});

function queueService(
  counts: { forDep: number; inPool: number; forOrg: number; forVm?: number },
  pool: 'kubernetes' | 'firecracker' = 'kubernetes'
) {
  const created: any[] = [];
  const tx: any = {
    $executeRaw: async () => 0,
    buildRun: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      count: async ({ where }: any) => {
        if (where.deploymentId) return counts.forDep;
        if (where.AND?.[1]?.deployment?.namespace) return counts.forVm ?? 0;
        if (where.AND) return counts.forOrg;
        if (where.status === 'scheduled') return 0;
        return counts.inPool;
      },
      create: async ({ data }: any) => {
        created.push(data);
        return { id: 'run-1' };
      }
    },
    deployment: {
      findUnique: async () => ({
        buildStatus: 'succeeded',
        buildWithDepot: false,
        name: 'app',
        githubRepo: null,
        githubInstallationId: null,
        namespace: 'ns-1',
        project: { organizationId: 'org-1', organization: { slug: 'acme' } }
      }),
      updateMany: async () => ({ count: 1 })
    }
  };
  const svc = Object.create(BuildQueueService.prototype) as any;
  svc.logger = { warn() {}, error() {}, log() {} };
  svc.workerId = 'w1';
  svc.LOCK_KEY = 1;
  svc.txOpts = {};
  svc.maxConcurrent = 15;
  svc.maxConcurrentDepot = 4;
  svc.maxConcurrentFc = 16;
  svc.maxFcPerVm = 2;
  svc.moduleRef = { get: () => ({ pick: async () => pool }) };
  svc.prisma = {
    deployment: {
      findUnique: async () => ({
        buildWithDepot: false,
        builderOverride: null,
        projectId: 'p1',
        project: { slug: 'p', organizationId: 'org-1', organization: { slug: 'acme' } }
      })
    },
    $transaction: async (fn: any) => fn(tx)
  };
  return { svc, created };
}

test('an org below its share starts its build immediately', async () => {
  const { svc, created } = queueService({ forDep: 0, inPool: 3, forOrg: 3 });
  const result = await svc.enqueue({ deploymentId: 'd1', triggerType: 'manual' });
  assert.equal(result.startNow, true);
  assert.equal(created[0].status, 'building');
  assert.equal(result.queue.blockedByOrgCap, false);
});

test('an org at its share waits even though the pool has free slots', async () => {
  const { svc, created } = queueService({ forDep: 0, inPool: 8, forOrg: 8 });
  const result = await svc.enqueue({ deploymentId: 'd1', triggerType: 'manual' });
  assert.equal(result.startNow, false);
  assert.equal(created[0].status, 'scheduled');
  assert.equal(result.queue.blockedByOrgCap, true);
});

test('a full pool still queues an org that is under its share', async () => {
  const { svc, created } = queueService({ forDep: 0, inPool: 15, forOrg: 1 });
  const result = await svc.enqueue({ deploymentId: 'd1', triggerType: 'manual' });
  assert.equal(result.startNow, false);
  assert.equal(created[0].status, 'scheduled');
  assert.equal(result.queue.blockedByOrgCap, false);
});

test('fast builds get 2 slots per builder VM unless MAX_CONCURRENT_FC_BUILDS_PER_VM says otherwise', () => {
  assert.equal(fcBuildsPerVm(undefined), 2);
  assert.equal(fcBuildsPerVm(''), 2);
  assert.equal(fcBuildsPerVm('1'), 1);
  assert.equal(fcBuildsPerVm('4'), 4);
  assert.equal(fcBuildsPerVm('0'), 2);
  assert.equal(fcBuildsPerVm('nonsense'), 2);
});

test('a fast build queues when its environment VM has no slots left', async () => {
  const { svc, created } = queueService(
    { forDep: 0, inPool: 2, forOrg: 2, forVm: 2 },
    'firecracker'
  );
  const result = await svc.enqueue({ deploymentId: 'd1', triggerType: 'auto' });
  assert.equal(result.startNow, false);
  assert.equal(created[0].status, 'scheduled');
  assert.equal(created[0].builder, 'firecracker');
  assert.equal(result.queue.blockedByVmCap, true);
});

test('a fast build starts when its environment VM has a free slot', async () => {
  const { svc, created } = queueService(
    { forDep: 0, inPool: 1, forOrg: 1, forVm: 1 },
    'firecracker'
  );
  const result = await svc.enqueue({ deploymentId: 'd1', triggerType: 'auto' });
  assert.equal(result.startNow, true);
  assert.equal(created[0].status, 'building');
  assert.equal(result.queue.blockedByVmCap, false);
});

test('the per-VM cap never holds back a standard build', async () => {
  const { svc } = queueService({ forDep: 0, inPool: 1, forOrg: 1, forVm: 9 });
  const result = await svc.enqueue({ deploymentId: 'd1', triggerType: 'auto' });
  assert.equal(result.startNow, true);
  assert.equal(result.queue.blockedByVmCap, false);
});
