import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageBuilderService } from '../src/docker/image-builder.service';

function harness(t: import('node:test').TestContext, missing = false) {
  const calls: string[] = [];
  const core = {
    readNamespacedServiceAccount: async () => ({ body: {} }),
    createNamespacedServiceAccount: async () => {
      calls.push('createServiceAccount');
    }
  };
  const gone = { statusCode: 404 };
  const rbac = {
    deleteNamespacedRole: async (name: string) => {
      calls.push(`deleteRole:${name}`);
      if (missing) throw gone;
    },
    deleteNamespacedRoleBinding: async (name: string) => {
      calls.push(`deleteRoleBinding:${name}`);
      if (missing) throw gone;
    },
    createNamespacedRole: async () => {
      calls.push('createRole');
    },
    replaceNamespacedRole: async () => {
      calls.push('replaceRole');
    },
    createNamespacedRoleBinding: async () => {
      calls.push('createRoleBinding');
    }
  };
  t.mock.method(ImageBuilderService.prototype as any, 'initKubeConfig', () => {});
  const service = new ImageBuilderService({} as any, {} as any, undefined as any);
  Object.assign(service, {
    kc: {
      makeApiClient: (api: { name: string }) => (api.name === 'CoreV1Api' ? core : rbac)
    }
  });
  return { service, calls };
}

test('the image-builder service account is never given a role with secrets access', async (t) => {
  const { service, calls } = harness(t);
  await service.ensureServiceAccount();
  assert.deepEqual(calls.sort(), [
    'deleteRole:image-builder-role',
    'deleteRoleBinding:image-builder-rolebinding'
  ]);
});

test('a cluster that never had the legacy role boots quietly', async (t) => {
  const { service, calls } = harness(t, true);
  await service.ensureServiceAccount();
  assert.ok(!calls.some((c) => c.startsWith('create') || c.startsWith('replace')));
});
