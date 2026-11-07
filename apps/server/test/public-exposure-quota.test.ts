import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import { KubernetesService } from '../src/kubernetes/kubernetes.service';
import {
  assertOrgCanExposeNodePort,
  assertOrgCanExposePublicPort,
  assertWithinPublicPortLimit,
  maxPublicPortsPerOrg,
  nodePortExposureEnabled
} from '../src/projects/public-exposure-quota';

const prismaWith = (external: number, published: number, databases: number) =>
  ({
    service: { count: async () => external },
    servicePort: { count: async () => published },
    database: { count: async () => databases }
  }) as any;

test('the per-org public port limit defaults to 20 and honours the override', () => {
  assert.equal(maxPublicPortsPerOrg({} as any), 20);
  assert.equal(maxPublicPortsPerOrg({ MAX_PUBLIC_PORTS_PER_ORG: '5' } as any), 5);
  assert.equal(maxPublicPortsPerOrg({ MAX_PUBLIC_PORTS_PER_ORG: 'x' } as any), 20);
  assert.throws(() => assertWithinPublicPortLimit(5, 5), BadRequestException);
  assert.doesNotThrow(() => assertWithinPublicPortLimit(4, 5));
  assert.doesNotThrow(() => assertWithinPublicPortLimit(1000, 0));
});

test('exposures of every kind count toward the same limit', async () => {
  await assert.doesNotReject(assertOrgCanExposePublicPort(prismaWith(5, 5, 9), 'org'));
  await assert.rejects(
    assertOrgCanExposePublicPort(prismaWith(10, 5, 5), 'org'),
    BadRequestException
  );
});

test('NodePort exposure can be switched off', async () => {
  assert.equal(nodePortExposureEnabled({} as any), true);
  assert.equal(nodePortExposureEnabled({ TENANT_NODEPORT_EXPOSURE: 'false' } as any), false);
  const saved = process.env.TENANT_NODEPORT_EXPOSURE;
  process.env.TENANT_NODEPORT_EXPOSURE = 'false';
  try {
    await assert.rejects(assertOrgCanExposeNodePort(prismaWith(0, 0, 0), 'org'), /disabled/);
  } finally {
    if (saved === undefined) delete process.env.TENANT_NODEPORT_EXPOSURE;
    else process.env.TENANT_NODEPORT_EXPOSURE = saved;
  }
  await assert.doesNotReject(assertOrgCanExposeNodePort(prismaWith(0, 0, 0), 'org'));
});

test('createDeployment ignores a tenant-chosen nodePort and non-TCP/UDP protocols', async () => {
  const calls: { method: string; args: any[] }[] = [];
  const kc = {
    makeApiClient() {
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async (...args: any[]) => {
              calls.push({ method, args });
              if (method === 'readNamespacedService') {
                return { body: { spec: { ports: [] }, status: {} } };
              }
              if (method.startsWith('read')) {
                const e: any = new Error('nf');
                e.response = { statusCode: 404 };
                throw e;
              }
              return { body: { items: [], status: {}, spec: {}, metadata: {} } };
            };
          }
        }
      );
    },
    getCurrentCluster() {
      return { server: 'https://x' };
    }
  } as any;
  const kube: any = new (KubernetesService as any)({});
  kube.kc = kc;
  const svc = new (K8sWorkloadService as any)({}, kube, {}, {});
  await svc.createDeployment({
    namespace: 'ns',
    name: 'x',
    image: 'alpine',
    replicas: 1,
    ports: [{ name: 'p', containerPort: 80, servicePort: 80, protocol: 'sctp', nodePort: 31337 }],
    serviceType: 'NodePort'
  });
  const service = calls.find((c) => c.method === 'createNamespacedService')!.args[1];
  assert.equal(service.spec.type, 'NodePort');
  assert.equal(service.spec.ports[0].nodePort, undefined);
  assert.equal(service.spec.ports[0].protocol, 'TCP');
});
