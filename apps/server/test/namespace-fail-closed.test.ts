import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { K8sNamespaceService } from '../src/kubernetes/k8s-namespace.service';

function namespaceService(policy: () => Promise<void>) {
  const calls: string[] = [];
  const core = {
    createNamespace: async () => {
      calls.push('create');
    },
    deleteNamespace: async (name: string) => {
      calls.push(`delete:${name}`);
    }
  };
  const kubernetes: any = {
    kc: { makeApiClient: () => core },
    ensureKubeConfig: () => {},
    isCiliumAvailable: async () => false,
    clusterExceptCidrs: async () => []
  };
  const service: any = new K8sNamespaceService({} as any, kubernetes, {
    canCoordinate: false
  } as any);
  service.policyRetryDelaysMs = [0, 0];
  service.createNetworkPolicy = async () => {
    calls.push('policy');
    await policy();
  };
  service.bootstrapTenantSecretsRbac = async () => {
    calls.push('rbac');
  };
  return { service: service as K8sNamespaceService, calls };
}

test('a namespace whose default-deny cannot be applied is removed and the call fails', async () => {
  const { service, calls } = namespaceService(async () => {
    throw new Error('apiserver unavailable');
  });
  await assert.rejects(() => service.createNamespace('acme-web'), ServiceUnavailableException);
  assert.deepEqual(calls, ['create', 'policy', 'policy', 'policy', 'delete:acme-web']);
});

test('a failed removal still fails the call', async () => {
  const { service, calls } = namespaceService(async () => {
    throw new Error('apiserver unavailable');
  });
  (service as any).kubernetes.kc.makeApiClient = () => ({
    createNamespace: async () => {},
    deleteNamespace: async () => {
      calls.push('delete-failed');
      throw new Error('gone');
    }
  });
  await assert.rejects(() => service.createNamespace('acme-web'), ServiceUnavailableException);
  assert.ok(calls.includes('delete-failed'));
  assert.ok(!calls.includes('rbac'));
});

test('a transient policy failure is retried and the namespace is kept', async () => {
  let attempts = 0;
  const { service, calls } = namespaceService(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('flaky');
  });
  const result = await service.createNamespace('acme-web');
  assert.equal(result.created, true);
  assert.deepEqual(calls, ['create', 'policy', 'policy', 'policy', 'rbac']);
});

test('the policy is applied before the service reports the namespace as created', async () => {
  const { service, calls } = namespaceService(async () => {});
  await service.createNamespace('acme-web');
  assert.ok(calls.indexOf('policy') > calls.indexOf('create'));
  assert.ok(calls.indexOf('policy') < calls.indexOf('rbac'));
});
