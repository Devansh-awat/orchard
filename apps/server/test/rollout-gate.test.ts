import assert from 'node:assert/strict';
import test from 'node:test';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import {
  assessRollout,
  blueGreenBlocker,
  buildGreenDeployment,
  greenName,
  k8sStrategyFor,
  selectorPointsAt,
  slotSelector
} from '../src/kubernetes/rollout-strategy';

const NOW = Date.parse('2026-09-22T10:00:00.000Z');

function dep(
  status: Record<string, unknown>,
  spec: Record<string, unknown> = {},
  generation = 2
): any {
  return {
    metadata: { name: 'web', generation },
    spec: { replicas: 2, template: { spec: { containers: [{ image: 'a' }] } }, ...spec },
    status: { observedGeneration: generation, ...status }
  };
}

function pod(name: string, createdMs: number, containerStatus: Record<string, unknown>): any {
  return {
    metadata: { name, creationTimestamp: new Date(createdMs).toISOString() },
    status: { containerStatuses: [containerStatus] }
  };
}

test('a rollout is ready only when every replica is updated, ready, available and the old ones are gone', () => {
  assert.deepEqual(
    assessRollout(
      dep({ replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 }),
      [],
      NOW
    ),
    { state: 'ready' }
  );
  const surge = assessRollout(
    dep({ replicas: 3, updatedReplicas: 2, readyReplicas: 3, availableReplicas: 3 }),
    [],
    NOW
  );
  assert.equal(surge.state, 'progressing');
  const half = assessRollout(
    dep({ replicas: 2, updatedReplicas: 2, readyReplicas: 1, availableReplicas: 1 }),
    [],
    NOW
  );
  assert.equal(half.state, 'progressing');
});

test('a stopped app has nothing to wait for', () => {
  assert.deepEqual(assessRollout(dep({}, { replicas: 0 }), [], NOW), { state: 'ready' });
});

test('a change the controller has not observed yet is still progressing even if the counts look right', () => {
  const d = dep({ replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 });
  d.status.observedGeneration = 1;
  assert.equal(assessRollout(d, [], NOW).state, 'progressing');
});

test('a crashlooping new pod fails the rollout immediately with the exit code', () => {
  const crashing = pod('web-new-1', NOW + 5_000, {
    restartCount: 3,
    state: { waiting: { reason: 'CrashLoopBackOff' } },
    lastState: { terminated: { exitCode: 1, reason: 'Error' } }
  });
  const verdict = assessRollout(
    dep({ replicas: 3, updatedReplicas: 1, readyReplicas: 2, availableReplicas: 2 }),
    [crashing],
    NOW
  );
  assert.equal(verdict.state, 'failed');
  assert.match((verdict as any).reason, /web-new-1 is CrashLoopBackOff \(exit 1, Error\)/);
});

test('an image that cannot be pulled fails without waiting for the deadline', () => {
  const pulling = pod('web-new-1', NOW + 5_000, {
    restartCount: 0,
    state: { waiting: { reason: 'ImagePullBackOff' } }
  });
  const verdict = assessRollout(
    dep({ replicas: 3, updatedReplicas: 1, readyReplicas: 2, availableReplicas: 2 }),
    [pulling],
    NOW
  );
  assert.equal(verdict.state, 'failed');
});

test('old pods crashing do not fail a rollout that is replacing them', () => {
  const old = pod('web-old-1', NOW - 60_000, {
    restartCount: 9,
    state: { waiting: { reason: 'CrashLoopBackOff' } }
  });
  const verdict = assessRollout(
    dep({ replicas: 3, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }),
    [old],
    NOW
  );
  assert.equal(verdict.state, 'progressing');
});

test('the controller giving up is a failure, not a slow success', () => {
  const d = dep({
    replicas: 3,
    updatedReplicas: 1,
    readyReplicas: 2,
    availableReplicas: 2,
    conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }]
  });
  assert.equal(assessRollout(d, [], NOW).state, 'failed');
});

test('green is blue with its own name and selector, the candidate image, and no server fields', () => {
  const blue: any = {
    metadata: {
      name: 'web',
      uid: 'u',
      resourceVersion: '9',
      generation: 4,
      labels: { 'app.kubernetes.io/name': 'web', 'app.kubernetes.io/managed-by': 'orchard' },
      annotations: { 'deployment.kubernetes.io/revision': '4', keep: 'me' }
    },
    spec: {
      replicas: 2,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': 'web' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'web' } },
        spec: { containers: [{ name: 'web', image: 'old', args: ['a'] }] }
      }
    },
    status: { readyReplicas: 2 }
  };
  const green = buildGreenDeployment(blue, { image: 'new', args: null });
  assert.equal(green.metadata?.name, 'web--green');
  assert.equal(green.metadata?.uid, undefined);
  assert.equal(green.metadata?.resourceVersion, undefined);
  assert.equal(green.metadata?.annotations?.['deployment.kubernetes.io/revision'], undefined);
  assert.equal(green.metadata?.annotations?.keep, 'me');
  assert.equal(green.status, undefined);
  assert.deepEqual(green.spec?.selector, {
    matchLabels: { 'app.kubernetes.io/name': 'web--green' }
  });
  assert.deepEqual(green.spec?.template?.metadata?.labels, {
    'app.kubernetes.io/name': 'web--green',
    'orchard.my/app': 'web',
    'orchard.my/slot': 'green'
  });
  assert.equal(green.spec?.strategy?.type, 'RollingUpdate');
  assert.equal(green.spec?.template?.spec?.containers?.[0]?.image, 'new');
  assert.equal(green.spec?.template?.spec?.containers?.[0]?.args, undefined);
  assert.equal(blue.spec.template.spec.containers[0].image, 'old');
});

test('a ReadWriteOnce claim blocks blue/green before anything is created', () => {
  const withPvc: any = {
    spec: {
      template: { spec: { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'x' } }] } }
    }
  };
  assert.match(blueGreenBlocker(withPvc) ?? '', /ReadWriteOnce/);
  assert.equal(
    blueGreenBlocker({
      spec: { template: { spec: { volumes: [{ name: 'tmp', emptyDir: {} }] } } }
    } as any),
    null
  );
});

test('the service selector names exactly one slot and the read-back check sees it', () => {
  assert.deepEqual(slotSelector('web', 'green'), { 'app.kubernetes.io/name': 'web--green' });
  assert.deepEqual(slotSelector('web', 'blue'), { 'app.kubernetes.io/name': 'web' });
  const svc: any = { spec: { selector: { 'app.kubernetes.io/name': greenName('web') } } };
  assert.equal(selectorPointsAt(svc, 'web', 'green'), true);
  assert.equal(selectorPointsAt(svc, 'web', 'blue'), false);
});

test('blue/green renders as a rolling update on the object itself', () => {
  assert.equal(k8sStrategyFor('blueGreen').type, 'RollingUpdate');
  assert.equal(k8sStrategyFor('recreate').type, 'Recreate');
});

function fakeService(apps: Record<string, any>, core: Record<string, any> = {}) {
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.kubernetes = {
    kc: {
      makeApiClient: (kind: any) => (kind.name === 'AppsV1Api' ? apps : core)
    },
    ensureKubeConfig: () => undefined
  };
  service.prisma = { project: { findFirst: async () => null } };
  return service;
}

test('waitForRollout returns as soon as the rollout is ready and reports progress once per change', async () => {
  let reads = 0;
  const apps = {
    readNamespacedDeployment: async () => {
      reads += 1;
      return {
        body: dep(
          reads < 3
            ? { replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }
            : { replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 }
        )
      };
    }
  };
  const core = { listNamespacedPod: async () => ({ body: { items: [] } }) };
  const service = fakeService(apps, core);
  const progress: string[] = [];
  const verdict = await service.waitForRollout('web', 'ns', {
    sinceMs: NOW,
    pollMs: 1,
    onProgress: (d: string) => progress.push(d)
  });
  assert.deepEqual(verdict, { state: 'ready' });
  assert.equal(reads, 3);
  assert.equal(progress.length, 1);
});

test('waitForRollout gives up at the deadline with the last known counts', async () => {
  const apps = {
    readNamespacedDeployment: async () => ({
      body: dep({ replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 })
    })
  };
  const core = { listNamespacedPod: async () => ({ body: { items: [] } }) };
  const service = fakeService(apps, core);
  const verdict = await service.waitForRollout('web', 'ns', {
    sinceMs: NOW,
    pollMs: 1,
    timeoutMs: 5
  });
  assert.equal(verdict.state, 'failed');
  assert.match(verdict.reason, /weren't ready after 1 minutes \(1\/2 ready/);
});

test('a green that never comes up is removed and blue is never touched', async () => {
  const calls: string[] = [];
  let greenExists = false;
  const apps = {
    readNamespacedDeployment: async (name: string) => {
      if (name === 'web--green') {
        if (!greenExists) throw { response: { statusCode: 404 } };
        return {
          body: {
            ...dep(
              { replicas: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0 },
              { replicas: 1 }
            ),
            metadata: { name: 'web--green', generation: 1 }
          }
        };
      }
      return { body: dep({}, { replicas: 1 }) };
    },
    createNamespacedDeployment: async (_ns: string, body: any) => {
      calls.push(`create:${body.metadata.name}`);
      greenExists = true;
    },
    deleteNamespacedDeployment: async (name: string) => {
      if (!greenExists) throw { response: { statusCode: 404 } };
      calls.push(`delete:${name}`);
      greenExists = false;
    },
    patchNamespacedDeployment: async (name: string) => {
      calls.push(`patch:${name}`);
    }
  };
  const core = {
    listNamespacedPod: async () => ({
      body: {
        items: [
          pod('web--green-1', Date.now() + 1000, {
            restartCount: 4,
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } }
          })
        ]
      }
    }),
    patchNamespacedService: async () => {
      calls.push('service');
    },
    readNamespacedService: async () => ({ body: { spec: { selector: {} } } })
  };
  const service = fakeService(apps, core);
  const result = await service.deployBlueGreen({
    deploymentName: 'web',
    namespace: 'ns',
    image: 'new',
    pollMs: 1,
    timeoutMs: 50
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /CrashLoopBackOff \(exit 137, OOMKilled\)/);
  assert.deepEqual(calls, ['create:web--green', 'delete:web--green']);
});

test('a healthy green takes traffic, blue follows it, and traffic returns to blue', async () => {
  const calls: string[] = [];
  let greenExists = false;
  let selector: Record<string, string> = { 'app.kubernetes.io/name': 'web' };
  let blueImage = 'old';
  const ready = (name: string, image: string) => ({
    body: {
      ...dep(
        { replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
        { replicas: 1 }
      ),
      metadata: { name, generation: 1 },
      spec: {
        replicas: 1,
        template: {
          metadata: { labels: { 'app.kubernetes.io/name': name } },
          spec: { containers: [{ name: 'web', image }] }
        }
      }
    }
  });
  const apps = {
    readNamespacedDeployment: async (name: string) => {
      if (name === 'web--green') {
        if (!greenExists) throw { response: { statusCode: 404 } };
        return ready('web--green', 'new');
      }
      return ready('web', blueImage);
    },
    createNamespacedDeployment: async (_ns: string, body: any) => {
      calls.push(`create:${body.metadata.name}`);
      greenExists = true;
    },
    deleteNamespacedDeployment: async (name: string) => {
      if (!greenExists) throw { response: { statusCode: 404 } };
      calls.push(`delete:${name}`);
      greenExists = false;
    },
    patchNamespacedDeployment: async (name: string, _ns: string, patch: any) => {
      calls.push(`patch:${name}:${patch.spec.template.spec.containers[0].image}`);
      blueImage = patch.spec.template.spec.containers[0].image;
    }
  };
  const core = {
    listNamespacedPod: async () => ({ body: { items: [] } }),
    patchNamespacedService: async (_n: string, _ns: string, patch: any) => {
      selector = patch.spec.selector;
      calls.push(`service:${selector['app.kubernetes.io/name']}`);
    },
    readNamespacedService: async () => ({ body: { spec: { selector } } })
  };
  const service = fakeService(apps, core);
  const result = await service.deployBlueGreen({
    deploymentName: 'web',
    namespace: 'ns',
    image: 'new',
    pollMs: 1,
    timeoutMs: 200
  });
  assert.deepEqual(result, { ok: true, settled: true });
  assert.deepEqual(calls, [
    'create:web--green',
    'service:web--green',
    'patch:web:new',
    'service:web',
    'delete:web--green'
  ]);
});
