import assert from 'node:assert/strict';
import test from 'node:test';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import {
  ROLLOUT_MIN_READY_SECONDS,
  rollingUpdateStrategy
} from '../src/kubernetes/rollout-strategy';

test('rolling updates keep every existing replica available while the replacement starts', () => {
  assert.deepEqual(rollingUpdateStrategy(), {
    type: 'RollingUpdate',
    rollingUpdate: { maxSurge: '25%', maxUnavailable: 0 }
  });
});

test('an image and its readiness probes land in one pod-template patch', async () => {
  let applied: Record<string, unknown> | undefined;
  const api = {
    readNamespacedDeployment: async () => ({
      body: {
        spec: {
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxSurge: 0, maxUnavailable: 1 }
          },
          template: { spec: {} }
        }
      }
    }),
    patchNamespacedDeployment: async (
      _name: string,
      _namespace: string,
      patch: Record<string, unknown>
    ) => {
      applied = patch;
    }
  };
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.kubernetes = {
    kc: { makeApiClient: () => api },
    ensureKubeConfig: () => undefined
  };
  service.prisma = { project: { findFirst: async () => null } };

  await service.updateDeploymentImage('web', 'project', 'example/web:v2', {
    enabled: true,
    type: 'http',
    path: '/up',
    port: 3000,
    livenessEnabled: true,
    readinessEnabled: true,
    startupEnabled: true,
    interval: 10,
    timeout: 2,
    retries: 3,
    startupFailureThreshold: 9
  });

  const container = (applied as any).spec.template.spec.containers[0];
  assert.deepEqual((applied as any).spec.strategy, rollingUpdateStrategy());
  assert.equal((applied as any).spec.minReadySeconds, ROLLOUT_MIN_READY_SECONDS);
  assert.equal(container.image, 'example/web:v2');
  assert.deepEqual(container.readinessProbe.httpGet, { path: '/up', port: 3000 });
  assert.equal(container.readinessProbe.exec, null);
  assert.equal(container.readinessProbe.tcpSocket, null);
  assert.equal(container.readinessProbe.grpc, null);
  assert.equal(container.livenessProbe.periodSeconds, 10);
  assert.equal(container.readinessProbe.periodSeconds, 5);
  assert.equal(container.readinessProbe.failureThreshold, 6);
  assert.equal(container.startupProbe.periodSeconds, 5);
  assert.equal(container.startupProbe.failureThreshold, 18);
});

test('an exec probe patch removes every incompatible probe handler', async () => {
  let applied: Record<string, unknown> | undefined;
  const api = {
    readNamespacedDeployment: async () => ({ body: { spec: { template: { spec: {} } } } }),
    patchNamespacedDeployment: async (
      _name: string,
      _namespace: string,
      patch: Record<string, unknown>
    ) => {
      applied = patch;
    }
  };
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.kubernetes = {
    kc: { makeApiClient: () => api },
    ensureKubeConfig: () => undefined
  };
  service.prisma = { project: { findFirst: async () => null } };

  await service.updateDeploymentImage('web', 'project', 'example/web:v2', {
    enabled: true,
    type: 'exec',
    command: 'node health.js',
    execCommand: ['node', 'health.js'],
    livenessEnabled: true,
    readinessEnabled: true,
    startupEnabled: true,
    interval: 30,
    timeout: 5,
    retries: 3,
    startupFailureThreshold: 13
  });

  const container = (applied as any).spec.template.spec.containers[0];
  assert.deepEqual(container.livenessProbe.exec, { command: ['node', 'health.js'] });
  assert.equal(container.livenessProbe.httpGet, null);
  assert.equal(container.livenessProbe.tcpSocket, null);
  assert.equal(container.livenessProbe.grpc, null);
});

test('an image update preserves an intentional recreate strategy', async () => {
  let applied: Record<string, unknown> | undefined;
  const api = {
    readNamespacedDeployment: async () => ({
      body: { spec: { strategy: { type: 'Recreate' }, template: { spec: {} } } }
    }),
    patchNamespacedDeployment: async (
      _name: string,
      _namespace: string,
      patch: Record<string, unknown>
    ) => {
      applied = patch;
    }
  };
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.kubernetes = {
    kc: { makeApiClient: () => api },
    ensureKubeConfig: () => undefined
  };
  service.prisma = { project: { findFirst: async () => null } };

  await service.updateDeploymentImage('web', 'project', 'example/web:v2');

  assert.equal((applied as any).spec.strategy, undefined);
});
