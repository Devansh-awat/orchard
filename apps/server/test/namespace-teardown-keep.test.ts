import test from 'node:test';
import assert from 'node:assert/strict';
import { NamespaceTeardownService } from '../src/projects/namespace-teardown.service';

function harness() {
  const purged: string[] = [];
  const registry: string[][] = [];
  const prisma = {
    deployment: {
      findMany: async () => [
        {
          id: 'd1',
          name: 'web',
          buildStatus: 'succeeded',
          buildContextKey: null,
          imageHistory: [{ image: 'registry/acme/web:v1' }]
        }
      ]
    },
    database: {
      findMany: async () => [
        {
          id: 'db1',
          name: 'main',
          namespace: 'acme',
          clusterName: 'pg-main',
          r2ProxyAccessKey: null
        }
      ]
    },
    job: { findMany: async () => [] }
  };
  const service = new NamespaceTeardownService(
    prisma as any,
    { deleteRepositoriesFromRegistry: async (images: string[]) => registry.push(images) } as any,
    { deleteBuildContext: async () => {} } as any,
    { purgeScope: async () => {} } as any,
    { removeBinding: async () => {} } as any,
    { cleanupNamespace: async () => {} } as any,
    { log: async () => {} } as any,
    {
      get: () => ({
        purgeBackupObjects: async (db: { name: string }) => purged.push(db.name)
      })
    } as any
  );
  return { service, purged, registry };
}

const scope = {
  projectId: 'p1',
  organizationId: 'o1',
  namespace: 'acme',
  reason: 'project.deleted' as const,
  actor: {}
};

test('a namespace removed in the cluster keeps backups and images', async () => {
  const { service, purged, registry } = harness();
  const summary = await service.teardown({ ...scope, keepData: true });
  assert.deepEqual(purged, []);
  assert.deepEqual(registry, []);
  assert.equal(summary.backupPrefixes, 0);
});

test('a project deleted in orchard still purges backups and images', async () => {
  const { service, purged, registry } = harness();
  await service.teardown({ ...scope, actor: { userId: 'u1' } });
  assert.deepEqual(purged, ['main']);
  assert.equal(registry.length, 1);
});
