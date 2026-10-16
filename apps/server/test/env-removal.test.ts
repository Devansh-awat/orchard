import test from 'node:test';
import assert from 'node:assert/strict';
import * as k8s from '@kubernetes/client-node';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import {
  buildEnvReplacePatch,
  ENV_HASH_ANNOTATION,
  ENV_UPDATED_ANNOTATION
} from '../src/kubernetes/env-patch';

/**
 * Removing an env var in Orchard used to update the database and nothing else:
 * the pod spec was patched with application/strategic-merge-patch+json, and
 * `containers[].env` merges by name, so the apiserver kept every key the patch
 * left out. Containers went on serving variables their owner had deleted, and a
 * rebuild didn't help because it only patches the image.
 */

const NAMESPACE = 'ysws-demo';
const NAME = 'demo';

/**
 * The half of strategic-merge-patch semantics this bug lives in: containers and
 * env both carry patchMergeKey "name", so the apiserver unions the patch's
 * entries with the ones already present. Modelled here so that reverting the
 * fix reproduces the bug instead of merely skipping the assertion.
 */
function applyStrategicMerge(doc: any, patch: any): any {
  const next = structuredClone(doc);
  const container = patch?.spec?.template?.spec?.containers?.[0];
  const annotations = patch?.spec?.template?.metadata?.annotations;
  if (annotations) {
    const meta = (next.spec.template.metadata ??= {});
    meta.annotations = { ...(meta.annotations ?? {}), ...annotations };
  }
  if (container) {
    const live = next.spec.template.spec.containers.find((c: any) => c.name === container.name);
    assert.ok(live, `merge patch named a container that does not exist: ${container.name}`);
    for (const [key, value] of Object.entries(container)) {
      if (key === 'name') continue;
      if (key !== 'env') {
        live[key] = value;
        continue;
      }
      const merged = new Map((live.env ?? []).map((e: any) => [e.name, e]));
      for (const entry of value as any[]) merged.set(entry.name, entry);
      live.env = Array.from(merged.values());
    }
  }
  return next;
}

/** Minimal RFC 6902 applier — only the ops buildEnvReplacePatch emits. */
function applyJsonPatch(doc: any, ops: any[]): any {
  const next = structuredClone(doc);
  for (const op of ops) {
    assert.equal(op.op, 'add', `unexpected op ${op.op}`);
    const segments = op.path
      .split('/')
      .slice(1)
      .map((s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    const leaf = segments.pop()!;
    let cursor = next;
    for (const segment of segments) {
      cursor = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment];
      assert.ok(cursor !== undefined, `path ${op.path} has no parent at ${segment}`);
    }
    if (Array.isArray(cursor)) cursor[Number(leaf)] = op.value;
    else cursor[leaf] = op.value;
  }
  return next;
}

function liveDeployment(env: k8s.V1EnvVar[]): k8s.V1Deployment {
  return {
    metadata: { name: NAME, namespace: NAMESPACE },
    spec: {
      selector: { matchLabels: { 'app.kubernetes.io/name': NAME } },
      template: {
        metadata: {
          labels: { 'app.kubernetes.io/name': NAME },
          annotations: { 'kept/by': 'someone-else' }
        },
        spec: { containers: [{ name: NAME, image: 'registry.example/demo:v1', env }] }
      }
    }
  };
}

function rolls(calls: { body: any }[]): number {
  return calls.filter((c) => JSON.stringify(c.body).includes('/spec/template')).length;
}

/** Stands in for the cluster: records patches and replays them onto the object. */
function fakeCluster(deployment: k8s.V1Deployment) {
  const state = { deployment, secrets: new Map<string, Record<string, string>>() };
  const calls: { body: any; contentType: string }[] = [];

  const appsApi = {
    async readNamespacedDeployment() {
      return { body: state.deployment };
    },
    async patchNamespacedDeployment(_name: string, _ns: string, body: any, ..._rest: any[]) {
      const options = _rest[_rest.length - 1];
      const contentType = options?.headers?.['Content-Type'] ?? '';
      calls.push({ body, contentType });
      if (contentType === 'application/json-patch+json') {
        state.deployment = applyJsonPatch(state.deployment, body);
      } else if (contentType === 'application/strategic-merge-patch+json') {
        state.deployment = applyStrategicMerge(state.deployment, body);
      } else {
        assert.fail(`unexpected patch content type: ${contentType}`);
      }
      return { body: state.deployment };
    }
  };

  const coreApi = {
    async readNamespacedSecret(name: string) {
      const stored = state.secrets.get(name);
      if (!stored) {
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      }
      // The apiserver hands back base64 `data`, never the `stringData` we wrote.
      const data = Object.fromEntries(
        Object.entries(stored).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')])
      );
      return { body: { metadata: { name, resourceVersion: '1' }, data } };
    },
    async replaceNamespacedSecret(name: string, _ns: string, body: any) {
      state.secrets.set(name, body.stringData);
      return { body };
    },
    async createNamespacedSecret(_ns: string, body: any) {
      state.secrets.set(body.metadata.name, body.stringData);
      return { body };
    },
    async deleteNamespacedSecret(name: string) {
      if (!state.secrets.delete(name)) {
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      }
      return { body: {} };
    }
  };

  const kubernetes = {
    kc: {
      makeApiClient(type: any) {
        return type === k8s.CoreV1Api ? coreApi : appsApi;
      }
    },
    ensureKubeConfig() {}
  };

  const service = new K8sWorkloadService({} as any, kubernetes as any);
  return { service, state, calls };
}

function containerEnv(deployment: k8s.V1Deployment): k8s.V1EnvVar[] {
  return deployment.spec!.template.spec!.containers[0].env ?? [];
}

test('a variable removed from the config leaves the pod spec', async () => {
  const { service, state } = fakeCluster(
    liveDeployment([
      { name: 'HOST', value: '0.0.0.0' },
      { name: 'FORCE_COLOR', value: '1' },
      { name: 'REVIEW_IDS', value: '42,43' },
      { name: 'OPENAI_API_KEY', value: 'sk-proj-secret' }
    ])
  );

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'JOBS', value: '1' }]
  });

  const names = containerEnv(state.deployment)
    .map((e) => e.name)
    .sort();
  assert.deepEqual(names, ['FORCE_COLOR', 'HOST', 'JOBS']);
  assert.ok(!names.includes('REVIEW_IDS'), 'REVIEW_IDS survived the update');
  assert.ok(!names.includes('OPENAI_API_KEY'), 'OPENAI_API_KEY survived the update');
});

test('the env update goes out as a JSON patch, never a strategic merge', async () => {
  const { service, calls } = fakeCluster(liveDeployment([{ name: 'GONE', value: 'x' }]));

  await service.updateDeploymentEnv({ namespace: NAMESPACE, deploymentName: NAME, env: [] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].contentType, 'application/json-patch+json');
});

test('clearing every variable empties the list instead of leaving it alone', async () => {
  const { service, state } = fakeCluster(
    liveDeployment([
      { name: 'REVIEW_IDS', value: '42' },
      { name: 'HOST', value: '0.0.0.0' }
    ])
  );

  await service.updateDeploymentEnv({ namespace: NAMESPACE, deploymentName: NAME, env: [] });

  // HOST/FORCE_COLOR are injected defaults, so "empty" means only those.
  assert.deepEqual(
    containerEnv(state.deployment)
      .map((e) => e.name)
      .sort(),
    ['FORCE_COLOR', 'HOST']
  );
});

test('a secret dropped from the config loses both its env entry and its Secret', async () => {
  const { service, state } = fakeCluster(liveDeployment([]));

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'TOKEN', value: 'shhh', secret: true }]
  });
  assert.deepEqual(state.secrets.get(`${NAME}-env`), { TOKEN: 'shhh' });
  assert.ok(
    containerEnv(state.deployment).some((e) => e.name === 'TOKEN' && e.valueFrom?.secretKeyRef),
    'secret should be referenced via secretKeyRef, not inline'
  );

  await service.updateDeploymentEnv({ namespace: NAMESPACE, deploymentName: NAME, env: [] });
  assert.equal(state.secrets.has(`${NAME}-env`), false, 'stale env Secret was left behind');
  assert.ok(!containerEnv(state.deployment).some((e) => e.name === 'TOKEN'));
});

test('values still update in place', async () => {
  const { service, state } = fakeCluster(liveDeployment([{ name: 'JOBS', value: '1' }]));

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'JOBS', value: '2' }]
  });

  assert.equal(containerEnv(state.deployment).find((e) => e.name === 'JOBS')?.value, '2');
});

test('re-asserting the same env does not roll the pods', async () => {
  const { service, calls, state } = fakeCluster(
    liveDeployment([
      { name: 'HOST', value: '0.0.0.0' },
      { name: 'FORCE_COLOR', value: '1' },
      { name: 'JOBS', value: '1' }
    ])
  );

  // What a rebuild now does: push the stored config back at the live object.
  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'JOBS', value: '1' }]
  });

  assert.equal(rolls(calls), 0, 'an unchanged env must not patch the pod template');
  assert.ok(
    state.deployment.metadata?.annotations?.[ENV_HASH_ANNOTATION],
    'the env Orchard wrote is stamped on the Deployment'
  );
});

test('ordering alone is not a change, but a changed value is', async () => {
  const { service, calls } = fakeCluster(
    liveDeployment([
      { name: 'JOBS', value: '1' },
      { name: 'FORCE_COLOR', value: '1' },
      { name: 'HOST', value: '0.0.0.0' }
    ])
  );

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'JOBS', value: '1' }]
  });
  assert.equal(rolls(calls), 0, 'reordering is not a change');

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'JOBS', value: '2' }]
  });
  assert.equal(rolls(calls), 1, 'a changed value must roll the pods');
});

test('a rotated secret rolls the pods even though the pod spec is identical', async () => {
  const { service, calls } = fakeCluster(liveDeployment([]));

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'TOKEN', value: 'old', secret: true }]
  });
  const afterFirst = calls.length;

  // Same key, same secretKeyRef in the spec — only the Secret's contents move.
  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'TOKEN', value: 'rotated', secret: true }]
  });
  assert.equal(calls.length, afterFirst + 1, 'a rotated secret must still roll the pods');

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'TOKEN', value: 'rotated', secret: true }]
  });
  assert.equal(calls.length, afterFirst + 1, 'an unchanged secret must not');
});

test('env lands on the app container, not on a sidecar that happens to be first', async () => {
  const deployment = liveDeployment([{ name: 'REVIEW_IDS', value: '42' }]);
  const app = deployment.spec!.template.spec!.containers[0];
  deployment.spec!.template.spec!.containers = [
    {
      name: 'logging-sidecar',
      image: 'sidecar:v1',
      env: [{ name: 'SIDECAR_ONLY', value: 'keep' }]
    },
    app
  ];
  const { service, state } = fakeCluster(deployment);

  await service.updateDeploymentEnv({
    namespace: NAMESPACE,
    deploymentName: NAME,
    env: [{ key: 'JOBS', value: '1' }]
  });

  const containers = state.deployment.spec!.template.spec!.containers;
  assert.deepEqual(
    containers[0].env,
    [{ name: 'SIDECAR_ONLY', value: 'keep' }],
    'the sidecar env must be left alone'
  );
  assert.deepEqual(containers[1].env!.map((e) => e.name).sort(), ['FORCE_COLOR', 'HOST', 'JOBS']);
});

test('the rollout annotation is bumped without clobbering the others', () => {
  const ops = buildEnvReplacePatch({
    containerIndex: 0,
    env: [],
    stamp: '2026-08-11T19:41:56.000Z',
    templateMetadata: { annotations: { 'kept/by': 'someone-else' } }
  });

  assert.deepEqual(ops[0], {
    op: 'add',
    path: '/spec/template/metadata/annotations',
    value: { 'kept/by': 'someone-else', [ENV_UPDATED_ANNOTATION]: '2026-08-11T19:41:56.000Z' }
  });
});

test('a pod template with no metadata gets one seeded rather than a broken path', () => {
  const ops = buildEnvReplacePatch({
    containerIndex: 0,
    env: [],
    stamp: 'now',
    templateMetadata: null
  });

  assert.deepEqual(ops[0], {
    op: 'add',
    path: '/spec/template/metadata',
    value: { annotations: { [ENV_UPDATED_ANNOTATION]: 'now' } }
  });
});

test('the container env op targets the container by index and replaces the whole list', () => {
  const ops = buildEnvReplacePatch({
    containerIndex: 0,
    env: [{ name: 'A', value: '1' }],
    stamp: 'now',
    templateMetadata: {}
  });

  const envOp = ops.find((o) => o.path.endsWith('/env'));
  assert.deepEqual(envOp, {
    op: 'add',
    path: '/spec/template/spec/containers/0/env',
    value: [{ name: 'A', value: '1' }]
  });
});

/**
 * The other direction. `syncNamespaceToDatabase` pulls live cluster state into
 * the DB, and it used to pull env with it: every inline `containers[0].env`
 * entry was upserted over the stored config and every stored key absent from
 * the live spec was deleted. Two things fall out of that, and both destroy a
 * user's configuration rather than merely showing it wrong:
 *
 *  - secrets reach the container through a secretKeyRef and carry no inline
 *    value, so they were skipped on the way in and then deleted on the way out;
 *  - HOST and FORCE_COLOR are injected at the k8s layer, so they came back as
 *    if the user had typed them.
 *
 * Env belongs to the deployment record. The cluster only gets to seed it for a
 * Deployment we are adopting, which is the one case where the DB knows nothing.
 */

function syncFixture(options: { existingRecord: any; env: k8s.V1EnvVar[] }) {
  const calls: { method: string; args: any[] }[] = [];
  const record =
    (method: string) =>
    (...args: any[]) => {
      calls.push({ method, args });
      return Promise.resolve(method === 'deploymentEnvVar.createMany' ? { count: 0 } : []);
    };

  const prisma = {
    project: {
      findFirst: async () => ({ id: 'p1', organizationId: 'o1', namespace: NAMESPACE })
    },
    environment: {
      findUnique: async () => ({
        id: 'e1',
        projectId: 'p1',
        project: { organizationId: 'o1' }
      }),
      findFirst: async () => ({ id: 'e1' })
    },
    deployment: {
      findFirst: async () => options.existingRecord,
      update: async () => options.existingRecord,
      create: async () => ({ id: 'd-new' }),
      findMany: async () => [],
      delete: record('deployment.delete')
    },
    deploymentEnvVar: {
      createMany: record('deploymentEnvVar.createMany'),
      upsert: record('deploymentEnvVar.upsert'),
      deleteMany: record('deploymentEnvVar.deleteMany')
    }
  };

  const appsApi = {
    async listNamespacedDeployment() {
      return {
        body: {
          items: [
            {
              metadata: { name: NAME },
              spec: {
                replicas: 1,
                template: {
                  spec: { containers: [{ name: NAME, image: 'demo:v1', env: options.env }] }
                }
              },
              status: { availableReplicas: 1 }
            }
          ]
        }
      };
    }
  };
  // No Service object: the ports half of the sync is not what these pin.
  const coreApi = {
    async readNamespacedService() {
      throw Object.assign(new Error('not found'), { response: { statusCode: 404 } });
    }
  };
  const kubernetes = {
    kc: { makeApiClient: (type: any) => (type === k8s.CoreV1Api ? coreApi : appsApi) },
    ensureKubeConfig() {}
  };

  const service = new K8sWorkloadService(prisma as any, kubernetes as any, {} as any);
  return { service, calls };
}

const LIVE_ENV: k8s.V1EnvVar[] = [
  { name: 'HOST', value: '0.0.0.0' },
  { name: 'FORCE_COLOR', value: '1' },
  { name: 'JOBS', value: '1' },
  { name: 'TOKEN', valueFrom: { secretKeyRef: { name: `${NAME}-env`, key: 'TOKEN' } } }
];

test('syncing a namespace never rewrites the env of an app Orchard already owns', async () => {
  const { service, calls } = syncFixture({ existingRecord: { id: 'd1' }, env: LIVE_ENV });

  await service.syncNamespaceToDatabase(NAMESPACE);

  const envWrites = calls.filter((c) => c.method.startsWith('deploymentEnvVar.'));
  assert.deepEqual(envWrites, [], 'the live pod spec must not write to deployment_env_vars');
});

test('a secret var is never deleted just because the pod spec has no inline value', async () => {
  const { service, calls } = syncFixture({
    existingRecord: { id: 'd1' },
    // Everything routes through the Secret, which is what emptied the whole set.
    env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: `${NAME}-env`, key: 'TOKEN' } } }]
  });

  await service.syncNamespaceToDatabase(NAMESPACE);

  assert.ok(
    !calls.some((c) => c.method === 'deploymentEnvVar.deleteMany'),
    'syncing must never delete stored env vars'
  );
});

test('adopting a Deployment Orchard did not create seeds its inline env once', async () => {
  const { service, calls } = syncFixture({ existingRecord: null, env: LIVE_ENV });

  await service.syncNamespaceToDatabase(NAMESPACE);

  const created = calls.filter((c) => c.method === 'deploymentEnvVar.createMany');
  assert.equal(created.length, 1, 'an adopted deployment should be seeded exactly once');
  assert.deepEqual(
    created[0].args[0].data.map((row: any) => row.key).sort(),
    ['FORCE_COLOR', 'HOST', 'JOBS'],
    'only inline values can be adopted; a secretKeyRef has no value to read'
  );
  assert.ok(
    !calls.some((c) => c.method === 'deploymentEnvVar.deleteMany'),
    'seeding a fresh record has nothing to delete'
  );
});
