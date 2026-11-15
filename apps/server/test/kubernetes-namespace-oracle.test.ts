import test from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { AuthorizationService } from '../src/auth/authorization.service';
import { KubernetesController } from '../src/kubernetes/kubernetes.controller';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const CALLER = '99999999-2222-4333-8444-555555555555';

function build() {
  const prisma: any = {
    project: {
      findFirst: async ({ where }: any) =>
        where.namespace === 'victim-shop-a1b2c3' ? { id: PROJECT_ID, organizationId: 'org' } : null,
      findUnique: async ({ where }: any) =>
        where.id === PROJECT_ID ? { id: PROJECT_ID, organizationId: 'org' } : null
    },
    environment: { findUnique: async () => null },
    user: { findUnique: async () => ({ id: CALLER, isSuperAdmin: false }) },
    organizationMember: { findUnique: async () => null, findFirst: async () => null },
    projectMember: { findUnique: async () => null, findFirst: async () => null }
  };
  const authz = new AuthorizationService(prisma, {} as any);
  return new KubernetesController({} as any, {} as any, {} as any, {} as any, authz, prisma);
}

async function failure(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error: any) {
    return error;
  }
  assert.fail('expected rejection');
}

test('existing-but-hidden and missing namespaces yield an identical 404', async () => {
  const controller = build();
  const req = { user: { sub: CALLER } };
  const hidden = await failure(() => controller.listPods('victim-shop-a1b2c3', req));
  const missing = await failure(() => controller.listPods('victim-shop-ffffff', req));
  assert.ok(hidden instanceof NotFoundException);
  assert.ok(missing instanceof NotFoundException);
  assert.deepEqual(hidden.getResponse(), missing.getResponse());
  const text = JSON.stringify([hidden.getResponse(), missing.getResponse()]);
  assert.ok(!text.includes(PROJECT_ID));
  assert.ok(!text.includes('victim-shop'));
});

test('edit-mode routes are uniform too', async () => {
  const controller = build();
  const req = { user: { sub: CALLER } };
  const hidden = await failure(() => controller.deletePod('p', req, 'victim-shop-a1b2c3'));
  const missing = await failure(() => controller.deletePod('p', req, 'victim-shop-ffffff'));
  assert.deepEqual(hidden.getResponse(), missing.getResponse());
});

test('requireProjectView never echoes the project id', async () => {
  const controller = build();
  const authz: any = (controller as any).authz;
  const error = await failure(() => authz.requireProjectView(PROJECT_ID, CALLER));
  assert.ok(!String(error.message).includes(PROJECT_ID));
});
