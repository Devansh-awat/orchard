import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNamespaceScope } from '../src/projects/namespace-scope';

const PROJECT = { id: 'proj-1', organizationId: 'org-1' };

/** Two namespaces: the project's own, and one owned by a second environment. */
function prismaStub() {
  return {
    project: {
      findFirst: async ({ where }: any) =>
        where.namespace === 'ysws-crescent' ? PROJECT : null
    },
    environment: {
      findUnique: async ({ where }: any) => {
        if (where.namespace === 'ysws-crescent') {
          return {
            id: 'env-prod',
            projectId: PROJECT.id,
            project: { organizationId: PROJECT.organizationId }
          };
        }
        if (where.namespace === 'ysws-crescent-staging') {
          return {
            id: 'env-staging',
            projectId: PROJECT.id,
            project: { organizationId: PROJECT.organizationId }
          };
        }
        return null;
      }
    }
  } as any;
}

test('the project namespace resolves to the project and its environment', async () => {
  const scope = await resolveNamespaceScope(prismaStub(), 'ysws-crescent');
  assert.deepEqual(scope, {
    projectId: 'proj-1',
    organizationId: 'org-1',
    environmentId: 'env-prod'
  });
});

test('a secondary environment namespace resolves to the owning project', async () => {
  const scope = await resolveNamespaceScope(prismaStub(), 'ysws-crescent-staging');
  assert.deepEqual(scope, {
    projectId: 'proj-1',
    organizationId: 'org-1',
    environmentId: 'env-staging'
  });
});

test('an unknown namespace resolves to nothing', async () => {
  assert.equal(await resolveNamespaceScope(prismaStub(), 'ysws-nothing'), null);
  assert.equal(await resolveNamespaceScope(prismaStub(), ''), null);
  assert.equal(await resolveNamespaceScope(prismaStub(), undefined), null);
});

test('an environment namespace from another project never overrides the project', async () => {
  const prisma = {
    project: { findFirst: async () => PROJECT },
    environment: {
      findUnique: async () => ({
        id: 'env-other',
        projectId: 'proj-2',
        project: { organizationId: 'org-2' }
      })
    }
  } as any;
  const scope = await resolveNamespaceScope(prisma, 'ysws-crescent');
  assert.deepEqual(scope, {
    projectId: 'proj-1',
    organizationId: 'org-1',
    environmentId: null
  });
});
