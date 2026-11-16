import test from 'node:test';
import assert from 'node:assert/strict';
import * as k8s from '@kubernetes/client-node';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import { MANAGED_VOLUMES_ANNOTATION } from '../src/kubernetes/volume-patch';
import { blueGreenBlocker, rollingUpdateStrategy } from '../src/kubernetes/rollout-strategy';

const managed = { name: 'data', persistentVolumeClaim: { claimName: 'demo-data' } };
const cache = { name: 'cache', emptyDir: {} };
const secret = { name: 'credentials', secret: { secretName: 'credentials' } };

function deployment(names: string[] | null = ['data', 'cache']): k8s.V1Deployment {
  return {
    metadata: { name: 'demo', namespace: 'project', resourceVersion: '12' },
    spec: {
      selector: { matchLabels: { app: 'demo' } },
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels: { app: 'demo' },
          annotations: {
            unrelated: 'preserve',
            ...(names === null ? {} : { [MANAGED_VOLUMES_ANNOTATION]: JSON.stringify(names) })
          }
        },
        spec: {
          containers: [
            {
              name: 'demo',
              image: 'demo:v1',
              env: [{ name: 'SECRET', valueFrom: { secretKeyRef: { name: 'env', key: 'KEY' } } }],
              securityContext: { runAsNonRoot: true },
              readinessProbe: { httpGet: { path: '/healthz', port: 8080 } },
              volumeMounts: [
                { name: 'data', mountPath: '/data' },
                { name: 'cache', mountPath: '/cache' },
                { name: 'credentials', mountPath: '/credentials', readOnly: true }
              ]
            }
          ],
          volumes: [managed, cache, secret]
        }
      }
    }
  };
}

function patchObject(doc: any, body: any, contentType: string) {
  const next = structuredClone(doc);
  if (contentType === 'application/strategic-merge-patch+json') {
    const pod = next.spec.template.spec;
    const patch = body.spec.template.spec;
    for (const volume of patch.volumes ?? []) {
      const old = pod.volumes.find((entry: any) => entry.name === volume.name);
      if (old) Object.assign(old, volume);
      else pod.volumes.push(volume);
    }
    for (const container of patch.containers ?? []) {
      const old = pod.containers.find((entry: any) => entry.name === container.name);
      for (const mount of container.volumeMounts ?? []) {
        const mounted = old.volumeMounts.find((entry: any) => entry.mountPath === mount.mountPath);
        if (mounted) Object.assign(mounted, mount);
        else old.volumeMounts.push(mount);
      }
    }
    return next;
  }
  assert.equal(contentType, 'application/json-patch+json');
  for (const operation of body) {
    const parts = operation.path
      .split('/')
      .slice(1)
      .map((part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const key = parts.pop()!;
    const parent = parts.reduce((value: any, part: string) => value[part], next);
    if (operation.op === 'test') assert.deepEqual(parent[key], operation.value);
    else {
      assert.equal(operation.op, 'add');
      parent[key] = structuredClone(operation.value);
    }
  }
  next.metadata.resourceVersion = String(Number(next.metadata.resourceVersion) + 1);
  return next;
}

function cluster(initial = deployment(), claimOwner: string | null = 'orchard') {
  const state = { deployment: initial, patches: [] as any[], claims: [] as string[] };
  const appsApi = {
    readNamespacedDeployment: async () => ({ body: structuredClone(state.deployment) }),
    patchNamespacedDeployment: async (
      _name: string,
      _namespace: string,
      body: any,
      ...args: any[]
    ) => {
      const contentType = args.at(-1).headers['Content-Type'];
      const next = patchObject(state.deployment, body, contentType);
      state.patches.push({ body, contentType });
      state.deployment = next;
      return { body: next };
    }
  };
  const prisma = {
    k8sObject: {
      findFirst: async ({ where }: any) => {
        assert.equal(where.kind, 'Deployment');
        return { manifest: structuredClone(state.deployment) };
      },
      findMany: async ({ where }: any) => {
        assert.equal(where.kind, 'PersistentVolumeClaim');
        state.claims.push(...where.name.in);
        if (claimOwner === null) return [];
        return where.name.in.map((name: string) => ({
          name,
          manifest: { metadata: { labels: { 'app.kubernetes.io/managed-by': claimOwner } } }
        }));
      }
    }
  };
  const service = new K8sWorkloadService(
    prisma as any,
    {
      ensureKubeConfig() {},
      kc: { makeApiClient: () => appsApi },
      createPVC: async () => undefined
    } as any,
    {} as any
  );
  return { state, service };
}

const update = (service: K8sWorkloadService, volumes: any[] = []) =>
  service.updateDeploymentVolumes({
    deploymentName: 'demo',
    namespace: 'project',
    volumes,
    deployStrategy: 'rollingUpdate'
  });

test('removing the last managed volume removes its mount and allows a healthy rolling replacement', async () => {
  const initial = deployment(['data']);
  initial.spec!.template.spec!.volumes = [managed, secret];
  initial.spec!.template.spec!.containers[0].volumeMounts!.splice(1, 1);
  const original = structuredClone(initial);
  const { state, service } = cluster(initial);
  assert.match(blueGreenBlocker(initial)!, /ReadWriteOnce/);
  await update(service);
  assert.deepEqual(state.deployment.spec!.template.spec!.volumes, [secret]);
  assert.deepEqual(state.deployment.spec!.template.spec!.containers[0].volumeMounts, [
    original.spec!.template.spec!.containers[0].volumeMounts![1]
  ]);
  assert.deepEqual(state.deployment.spec!.strategy, rollingUpdateStrategy());
  assert.equal(blueGreenBlocker(state.deployment), null);
  assert.deepEqual(original.spec!.template.spec!.volumes, [managed, secret]);
  const primary = structuredClone(state.deployment.spec!.template.spec!.containers[0]);
  primary.volumeMounts = original.spec!.template.spec!.containers[0].volumeMounts;
  assert.deepEqual(primary, original.spec!.template.spec!.containers[0]);
  assert.equal(state.deployment.spec!.template.metadata!.annotations!.unrelated, 'preserve');
  assert.equal(state.patches.length, 1);
});

test('partial updates remove old mounts, move paths and replace volume types without merging sources', async () => {
  const { state, service } = cluster();
  await update(service, [{ name: 'data', type: 'emptyDir', mountPath: '/new-data' }]);
  assert.deepEqual(state.deployment.spec!.template.spec!.volumes, [
    secret,
    { name: 'data', emptyDir: {} }
  ]);
  assert.deepEqual(state.deployment.spec!.template.spec!.containers[0].volumeMounts, [
    { name: 'credentials', mountPath: '/credentials', readOnly: true },
    { name: 'data', mountPath: '/new-data', readOnly: false }
  ]);
  assert.equal(
    await service.getDeploymentVolumeSignature('demo', 'project'),
    K8sWorkloadService.volumeSignature([{ name: 'data', type: 'emptyDir', mountPath: '/new-data' }])
  );
  await update(service);
  assert.deepEqual(state.deployment.spec!.template.spec!.volumes, [secret]);
  assert.equal(await service.getDeploymentVolumeSignature('demo', 'project'), '');
});

test('legacy primary mounts use verified Orchard claim ownership and preserve ambiguous storage', async () => {
  const { state, service } = cluster(deployment(null));
  await update(service);
  assert.deepEqual(state.claims, ['demo-data']);
  assert.deepEqual(state.deployment.spec!.template.spec!.volumes, [cache, secret]);
  assert.equal(
    state.deployment.spec!.template.spec!.containers[0].volumeMounts!.some(
      (mount) => mount.name === 'cache'
    ),
    true
  );
});

for (const ownership of ['someone-else', null]) {
  test(`unverified legacy claim (${ownership}) remains attached`, async () => {
    const { state, service } = cluster(deployment(null), ownership);
    await update(service);
    assert.ok(
      state.deployment.spec!.template.spec!.volumes!.some((volume) => volume.name === 'data')
    );
    assert.match(blueGreenBlocker(state.deployment)!, /ReadWriteOnce/);
    assert.equal(state.deployment.spec!.strategy!.type, 'Recreate');
  });
}

test('sidecar and init references retain the managed PVC without changing their fields', async () => {
  const initial = deployment();
  initial.spec!.template.spec!.containers.push({
    name: 'sidecar',
    image: 'side:v1',
    volumeMounts: [{ name: 'data', mountPath: '/side-data' }]
  });
  initial.spec!.template.spec!.initContainers = [
    { name: 'init', image: 'init:v1', volumeMounts: [{ name: 'cache', mountPath: '/init-cache' }] }
  ];
  const original = structuredClone(initial);
  const { state, service } = cluster(initial);
  await update(service);
  assert.deepEqual(state.deployment.spec!.template.spec!.volumes, [managed, cache, secret]);
  assert.deepEqual(
    state.deployment.spec!.template.spec!.containers[1],
    original.spec!.template.spec!.containers[1]
  );
  assert.deepEqual(
    state.deployment.spec!.template.spec!.initContainers,
    original.spec!.template.spec!.initContainers
  );
  assert.match(blueGreenBlocker(state.deployment)!, /ReadWriteOnce/);
  assert.equal(await service.getDeploymentVolumeSignature('demo', 'project'), '');
});

test('a requested volume cannot overwrite an unrelated source or occupy its mount path', async () => {
  const { state, service } = cluster();
  await assert.rejects(
    update(service, [{ name: 'credentials', type: 'emptyDir', mountPath: '/new' }]),
    /not managed by Orchard/
  );
  await assert.rejects(
    update(service, [{ name: 'new', type: 'emptyDir', mountPath: '/credentials' }]),
    /used by an unmanaged volume/
  );
  assert.equal(state.patches.length, 0);
});

test('resource version test refuses a stale patch without losing an unrelated concurrent edit', async () => {
  const { state, service } = cluster();
  await update(service);
  const patch = state.patches[0];
  const concurrent = structuredClone(state.deployment);
  concurrent.spec!.template.spec!.containers[0].image = 'demo:v2';
  assert.throws(() => patchObject(concurrent, patch.body, patch.contentType));
  assert.equal(concurrent.spec!.template.spec!.containers[0].image, 'demo:v2');
});

test('missing template annotations and volume lists are seeded safely', async () => {
  const initial = deployment();
  delete initial.spec!.template.metadata;
  delete initial.spec!.template.spec!.volumes;
  delete initial.spec!.template.spec!.containers[0].volumeMounts;
  const { state, service } = cluster(initial);
  await update(service, [{ name: 'cache', type: 'emptyDir', mountPath: '/cache' }]);
  assert.equal(
    state.deployment.spec!.template.metadata!.annotations![MANAGED_VOLUMES_ANNOTATION],
    '["cache"]'
  );
});

test('explicit legacy desired storage is tracked only when the entire existing mount matches', async () => {
  const initial = deployment(null);
  initial.spec!.template.spec!.volumes = [cache];
  initial.spec!.template.spec!.containers[0].volumeMounts = [
    { name: 'cache', mountPath: '/cache' }
  ];
  const { state, service } = cluster(initial);
  await update(service, [{ name: 'cache', type: 'emptyDir', mountPath: '/cache' }]);
  assert.equal(
    state.deployment.spec!.template.metadata!.annotations![MANAGED_VOLUMES_ANNOTATION],
    '["cache"]'
  );
  await update(service);
  assert.deepEqual(state.deployment.spec!.template.spec!.volumes, []);
});

test('an unrecorded mount with subPath or propagation cannot be adopted and stripped', async () => {
  const initial = deployment(null);
  initial.spec!.template.spec!.volumes = [cache];
  initial.spec!.template.spec!.containers[0].volumeMounts = [
    { name: 'cache', mountPath: '/cache', subPath: 'private', mountPropagation: 'HostToContainer' }
  ];
  const { state, service } = cluster(initial);
  await assert.rejects(
    update(service, [{ name: 'cache', type: 'emptyDir', mountPath: '/cache' }]),
    /not managed by Orchard/
  );
  assert.equal(state.patches.length, 0);
  assert.deepEqual(state.deployment, initial);
});

test('the drift check reads the mirror and never the apiserver', async () => {
  const rows = new Map<string, any>([['Deployment', { manifest: deployment(null) }]]);
  const service = new K8sWorkloadService(
    {
      k8sObject: {
        findFirst: async ({ where }: any) => rows.get(where.kind) ?? null,
        findMany: async () => [
          {
            name: 'demo-data',
            manifest: { metadata: { labels: { 'app.kubernetes.io/managed-by': 'orchard' } } }
          }
        ]
      }
    } as any,
    {
      ensureKubeConfig() {},
      kc: {
        makeApiClient: () => {
          throw new Error('apiserver called');
        }
      }
    } as any,
    {} as any
  );
  assert.equal(
    await service.getDeploymentVolumeSignature('demo', 'project'),
    K8sWorkloadService.volumeSignature([
      { name: 'data', type: 'pvc', mountPath: '/data', pvcName: 'demo-data' }
    ])
  );
  rows.clear();
  assert.equal(await service.getDeploymentVolumeSignature('demo', 'project'), null);
});
