import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
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
    ['POST', '/apiv1/ssh-identities'],
    ['GET', '/apiv1/github/repositories']
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
