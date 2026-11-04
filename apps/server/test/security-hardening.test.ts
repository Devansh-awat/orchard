import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { IngressService } from '../src/projects/ingress.service';
import { isValidPodName } from '../src/kubernetes/pod-name';
import { deniedToOrgScopedSession } from '../src/auth/superadmin.guard';
import { assertImageOwnedByProject } from '../src/projects/image-ownership';
import { stripOperationSecrets } from '../src/projects/strip-operation-secrets.interceptor';

test('pod names cannot carry a path', () => {
  assert.equal(isValidPodName('web-7d4b9c-x2x'), true);
  for (const name of ['../../orchard/pods/db-1', 'a/b', '..', '', 'A', '%2e%2e', undefined]) {
    assert.equal(isValidPodName(name), false, String(name));
  }
});

test('org-scoped sessions cannot reach account credentials', () => {
  for (const [method, path] of [
    ['POST', '/apiv1/auth/mcp-token'],
    ['POST', '/apiv1/auth/tokens'],
    ['POST', '/apiv1/auth/password/set'],
    ['POST', '/apiv1/auth/passkey/register/options'],
    ['POST', '/apiv1/auth/sessions/revoke-all'],
    ['POST', '/apiv1/ssh-identities']
  ]) {
    assert.equal(deniedToOrgScopedSession(method, path), true, path);
  }
  assert.equal(deniedToOrgScopedSession('GET', '/apiv1/auth/me'), false);
  assert.equal(deniedToOrgScopedSession('POST', '/apiv1/auth/logout'), false);
  assert.equal(deniedToOrgScopedSession('GET', '/apiv1/projects'), false);
});

function ownership(others: string[] = []) {
  return {
    project: { findMany: async () => others.map((namespace) => ({ namespace })) },
    environment: { findMany: async () => [] }
  } as any;
}

test('platform images belong to the project whose namespace built them', async () => {
  process.env.DOCKER_REGISTRY_PULL = 'registry.example';
  const mine = { id: 'p1', namespace: 'acme-a' };
  await assertImageOwnedByProject(ownership(), 'registry.example/orchard/acme-a-web:v1', mine);
  await assertImageOwnedByProject(ownership(), 'docker.io/library/redis:7', mine);
  for (const image of [
    'registry.example/orchard/other-web:v1',
    'registry.example:443/orchard/other-web:v1'
  ]) {
    await assert.rejects(
      () => assertImageOwnedByProject(ownership(), image, mine),
      ForbiddenException
    );
  }
  await assert.rejects(
    () =>
      assertImageOwnedByProject(
        ownership(['acme-a-b']),
        'registry.example/orchard/acme-a-b-web:v1',
        mine
      ),
    ForbiddenException
  );
});

test('operation records never carry the stored database password', () => {
  const at = new Date();
  const out = stripOperationSecrets({
    operations: [{ id: 'op', createdAt: at, source: { dbUser: 'app', dbPassword: 'enc:v1:x' } }]
  }) as any;
  assert.deepEqual(out.operations[0].source, { dbUser: 'app' });
  assert.equal(out.operations[0].createdAt, at);
});

function ingressService(existingHost: string) {
  const checked: string[] = [];
  const service = Object.create(IngressService.prototype) as any;
  service.usersService = { findOrCreateByClerkId: async () => ({ id: 'u1' }) };
  service.authz = { requireProjectEdit: async () => {} };
  service.access = {
    assertHostnameAvailable: async (host: string) => {
      checked.push(host);
      throw new ForbiddenException('taken');
    }
  };
  const project = { id: 'p1', deployments: [] };
  service.prisma = {
    ingress: { findFirst: async () => ({ host: existingHost, project }) },
    project: { findUnique: async () => project }
  };
  return { service, checked };
}

test('moving an ingress to a new host checks that the host is free', async () => {
  const { service, checked } = ingressService('mine.example');
  await assert.rejects(
    () => service.updateProjectIngress('p1', 'i1', { host: 'victim.example' }, 'clerk'),
    ForbiddenException
  );
  assert.deepEqual(checked, ['victim.example']);
});

test('keeping the same host does not recheck it', async () => {
  const { service, checked } = ingressService('mine.example');
  await assert.rejects(
    () => service.updateProjectIngress('p1', 'i1', { host: 'mine.example' }, 'clerk'),
    /At least one route/
  );
  assert.deepEqual(checked, []);
});

test('creating a project ingress reaches its own validation', async () => {
  const { service } = ingressService('mine.example');
  await assert.rejects(
    () => service.createProjectIngress('p1', { host: 'new.example' }, 'clerk'),
    /At least one route/
  );
});
