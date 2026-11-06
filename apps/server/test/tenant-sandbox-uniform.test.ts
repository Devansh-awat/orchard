import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import { JobsOrchestratorService } from '../src/jobs/jobs-orchestrator.service';
import { buildGreenDeployment } from '../src/kubernetes/rollout-strategy';
import * as trustedImages from '../src/kubernetes/trusted-images';

const IMAGES = [
  'redis',
  'redis:8-alpine',
  'docker.io/library/redis:7',
  'bitnami/redis:latest',
  'bitnami/redis-cluster:7',
  'valkey/valkey:8-alpine',
  'ghcr.io/evil/redis:1',
  'evil/image:1'
];

const withRuntime = async (fn: () => Promise<void> | void) => {
  const prev = process.env.TENANT_RUNTIME_CLASS;
  const prevExtra = process.env.TRUSTED_IMAGES_EXTRA;
  process.env.TENANT_RUNTIME_CLASS = 'gvisor';
  process.env.TRUSTED_IMAGES_EXTRA = 'redis,redis:*,evil/image,evil/image:*';
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.TENANT_RUNTIME_CLASS;
    else process.env.TENANT_RUNTIME_CLASS = prev;
    if (prevExtra === undefined) delete process.env.TRUSTED_IMAGES_EXTRA;
    else process.env.TRUSTED_IMAGES_EXTRA = prevExtra;
  }
};

const assertHardened = (securityContext: any) => {
  assert.equal(securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(securityContext.capabilities.drop, ['ALL']);
  assert.equal(securityContext.seccompProfile.type, 'RuntimeDefault');
};

test('no image name is exempt from the sandbox runtime or the hardened context', () => {
  assert.equal('isTrustedImage' in trustedImages, false);
  assert.equal('trustedSecurityContext' in trustedImages, false);
  assert.equal('TRUSTED_IMAGES' in trustedImages, false);
});

test('createDeployment applies the runtimeClass and hardened context to every image', async () => {
  await withRuntime(async () => {
    for (const image of IMAGES) {
      let body: any;
      const api = {
        createNamespacedDeployment: async (_ns: string, b: any) => {
          body = b;
        },
        createNamespacedService: async () => ({ body: {} }),
        readNamespacedService: async () => ({ body: { spec: { ports: [] } } })
      };
      const service = Object.create(K8sWorkloadService.prototype) as any;
      service.kubernetes = { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined };
      await service.createDeployment({
        namespace: 'project',
        name: 'cache',
        image,
        ports: [{ name: 'redis', containerPort: 6379, servicePort: 6379, protocol: 'TCP' }]
      });
      const pod = body.spec.template.spec;
      assert.equal(pod.runtimeClassName, 'gvisor', image);
      assertHardened(pod.containers[0].securityContext);
    }
  });
});

test('changing the image later re-asserts the runtimeClass and hardened context', async () => {
  await withRuntime(async () => {
    for (const image of IMAGES) {
      let applied: any;
      const api = {
        readNamespacedDeployment: async () => ({ body: { spec: { template: { spec: {} } } } }),
        patchNamespacedDeployment: async (_n: string, _ns: string, patch: any) => {
          applied = patch;
        }
      };
      const service = Object.create(K8sWorkloadService.prototype) as any;
      service.kubernetes = { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined };
      service.prisma = { project: { findFirst: async () => null } };
      await service.updateDeploymentImage('web', 'project', image);
      const pod = applied.spec.template.spec;
      assert.equal(pod.runtimeClassName, 'gvisor', image);
      assertHardened(pod.containers[0].securityContext);
    }
  });
});

test('a blue/green candidate is sandboxed whatever its blue pod carried', async () => {
  await withRuntime(() => {
    const blue: any = {
      metadata: { name: 'cache' },
      spec: {
        selector: {},
        template: {
          spec: {
            containers: [{ name: 'cache', image: 'redis', securityContext: {} }]
          }
        }
      }
    };
    const green = buildGreenDeployment(blue, { image: 'redis:8' });
    assert.equal(green.spec!.template.spec!.runtimeClassName, 'gvisor');
    assertHardened(green.spec!.template.spec!.containers[0].securityContext);
  });
});

test('job app steps with a tenant shell get the runtimeClass and hardened context on any image', async () => {
  await withRuntime(() => {
    const orchestrator = Object.create(JobsOrchestratorService.prototype) as any;
    for (const image of IMAGES) {
      const job = orchestrator.buildStepJobManifest(
        { jobId: 'job-1', projectId: 'p', organizationId: 'o', namespace: 'ns' },
        {
          stepOrder: 1,
          name: 'run',
          type: 'app',
          image,
          shell: 'id; cat /proc/self/status',
          envVars: [],
          retries: 0,
          timeoutSeconds: 60
        },
        { name: 'ojr-1', envSecret: 'env' }
      );
      const pod = job.spec!.template.spec!;
      assert.equal(pod.runtimeClassName, 'gvisor', image);
      assertHardened(pod.containers[0].securityContext);
    }
  });
});
