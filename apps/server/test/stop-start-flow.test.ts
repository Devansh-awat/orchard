import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentsService } from '../src/projects/deployments.service';

function base(row: Record<string, unknown>) {
  const updates: any[] = [];
  const audits: any[] = [];
  const state = { ...row };
  const svc = Object.create(DeploymentsService.prototype) as any;
  Object.assign(svc, {
    logger: { warn() {} },
    prisma: {
      deployment: {
        findUnique: async () => ({ ...state }),
        update: async (args: any) => {
          updates.push(args.data);
          Object.assign(state, args.data);
          return { ...state };
        }
      }
    },
    audit: { log: async (entry: unknown) => audits.push(entry) },
    usersService: { findOrCreateByClerkId: async () => ({ id: 'u', email: 'u@x' }) },
    authz: { requireProjectEdit: async () => {} },
    assertNotComposeManaged: () => {},
    quotasService: {
      resolvePodResources: async () => ({ cpuMilli: 100, memoryBytes: 1 }),
      enforceOrgCapForNewPod: async () => {},
      enforceMemberAllowanceForNewPod: async () => {}
    },
    applyPipelineEnabled: () => true,
    applyQueue: { enqueue: async () => {} },
    syncDisruptionBudget: async () => {}
  });
  return { svc, updates, audits, state };
}

const stoppedApp = {
  id: 'dep-1',
  name: 'web',
  projectId: 'p',
  project: { id: 'p', organizationId: 'o', ownerId: 'u', organization: {} },
  githubRepo: 'https://github.com/team/app',
  githubBranch: 'main',
  autoDeployBranch: 'main',
  stopped: true,
  replicas: 2,
  pendingPush: null,
  image: 'img',
  cpuRequestMilli: null,
  memoryRequestBytes: null,
  createdBy: 'u'
};

test('a push to a stopped app is held and counted, not built', async () => {
  const { svc, updates, audits } = base(stoppedApp);
  let enqueued = 0;
  svc.buildQueue = { enqueue: async () => (enqueued += 1) };
  svc.reconcileScoreAsCreator = async () => {};
  const first = await svc.triggerAutoDeploy('dep-1', 'abc1234', 'first', 'ann', 'ann');
  const second = await svc.triggerAutoDeploy('dep-1', 'def5678', 'second', 'bob', 'bob');
  assert.equal(enqueued, 0);
  assert.equal(first.held, true);
  assert.equal(second.count, 2);
  assert.equal(updates.at(-1).pendingPush.sha, 'def5678');
  assert.equal(audits.filter((a) => a.action === 'deployment.push_held').length, 2);
});

test('starting with a held push clears it, flips stopped, and builds that commit', async () => {
  const { svc, updates, state } = base({
    ...stoppedApp,
    pendingPush: {
      sha: 'def5678',
      branch: 'main',
      author: 'bob',
      message: 'second',
      at: 'x',
      count: 2
    }
  });
  const built: string[] = [];
  svc.triggerAutoDeploy = async (_id: string, sha: string) => {
    built.push(sha);
    return { queued: false };
  };
  const result = await svc.startDeployment('dep-1', 'clerk');
  assert.equal(result.started, 'building');
  assert.deepEqual(built, ['def5678']);
  assert.equal(updates[0].stopped, false);
  assert.equal(updates[0].pendingPush, null);
  assert.equal(state.replicas, 2);
});

test('starting with nothing held is a plain scale-up', async () => {
  const { svc, updates } = base(stoppedApp);
  let enqueued: any = null;
  svc.applyQueue = { enqueue: async (input: unknown) => (enqueued = input) };
  const result = await svc.startDeployment('dep-1', 'clerk');
  assert.equal(result.started, undefined);
  assert.equal(updates[0].stopped, false);
  assert.equal(enqueued.opType, 'deployment.scale');
});

test('restart is still refused while stopped', async () => {
  const { svc } = base(stoppedApp);
  await assert.rejects(svc.restartDeployment('dep-1', 'clerk'), /Start the app before restarting/);
});
