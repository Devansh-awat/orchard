import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RegistryCredentialsService } from '../src/projects/registry-credentials.service';
import { OrganizationRegistryCredentialsController } from '../src/organizations/organization-registry-credentials.controller';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import { PullAuthError, registryAuth } from '../src/docker/registry-pull-auth';

function fixture() {
  const prior = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.SECRETS_ENCRYPTION_KEY = 'organization-registry-test-encryption-key';
  const crypto = new SecretCryptoService();
  if (prior === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = prior;
  const orgRows = [
    {
      id: 'o1',
      organizationId: 'org-a',
      registry: 'dhi.io',
      username: 'org',
      password: crypto.encrypt('org-token')
    },
    {
      id: 'o2',
      organizationId: 'org-b',
      registry: 'ghcr.io',
      username: 'other-org',
      password: crypto.encrypt('other-token')
    }
  ];
  const projectRows: any[] = [];
  const secretWrites: any[] = [];
  const patches: any[] = [];
  const audits: any[] = [];
  const prisma = {
    project: {
      findUnique: async ({ where }: any) => ({
        organizationId: where.id === 'p-b' ? 'org-b' : 'org-a'
      }),
      findMany: async ({ where }: any) =>
        where.organizationId === 'org-a' ? [{ id: 'p-a' }] : [{ id: 'p-b' }]
    },
    deployment: {
      findUnique: async ({ where }: any) =>
        where.id === 'missing' ? null : { projectId: where.id === 'd-b' ? 'p-b' : 'p-a' },
      findMany: async () => [{ id: 'd-a', name: 'app', namespace: 'ns-a', image: 'dhi.io/node:24' }]
    },
    environment: { findMany: async () => [{ namespace: 'ns-a' }] },
    registryCredential: {
      findMany: async ({ where }: any) => projectRows.filter((r) => r.projectId === where.projectId)
    },
    organizationRegistryCredential: {
      findMany: async ({ where, select }: any) =>
        orgRows
          .filter((r) => r.organizationId === where.organizationId)
          .map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => select[key]))),
      findFirst: async ({ where }: any) =>
        orgRows.find((r) => r.id === where.id && r.organizationId === where.organizationId) ?? null,
      delete: async ({ where }: any) => {
        orgRows.splice(
          orgRows.findIndex((r) => r.id === where.id),
          1
        );
      },
      upsert: async ({ create, update, where, select }: any) => {
        const existing = orgRows.find(
          (r) =>
            r.organizationId === where.organizationId_registry.organizationId &&
            r.registry === where.organizationId_registry.registry
        );
        const row = existing ? Object.assign(existing, update) : { id: 'new', ...create };
        if (!existing) orgRows.push(row);
        return Object.fromEntries(Object.entries(row).filter(([key]) => select[key]));
      }
    }
  };
  const k8s = {
    upsertDockerConfigSecret: async (...args: any[]) => {
      secretWrites.push(args);
    },
    readDeploymentPullSecrets: async () => ['unrelated-secret'],
    updateDeploymentPullSecrets: async (...args: any[]) => {
      patches.push(args);
    }
  };
  const service = new RegistryCredentialsService(prisma as any, k8s as any, crypto, {
    log: async (event: any) => {
      audits.push(event);
    }
  } as any);
  return { service, prisma, orgRows, projectRows, secretWrites, patches, audits, crypto };
}

test('organization credentials are inherited by builds and image pulls without crossing tenants', async () => {
  const { service, secretWrites } = fixture();
  assert.deepEqual(await service.buildAuths('d-a', {}), {
    'dhi.io': registryAuth('org', 'org-token')
  });
  assert.deepEqual(await service.buildAuths('d-b', {}), {
    'ghcr.io': registryAuth('other-org', 'other-token')
  });
  assert.deepEqual(await service.buildAuths(undefined, {}), {});
  await assert.rejects(service.buildAuths('missing', {}), /Deployment not found/);
  assert.deepEqual(await service.pullSecretsFor('p-a', 'dhi.io/node:24'), [
    { name: 'orchard-registry-creds' }
  ]);
  assert.deepEqual(await service.pullSecretsFor('p-b', 'dhi.io/node:24'), []);
  await service.syncNamespace('p-a', 'new-environment');
  assert.equal(secretWrites[0][2]['dhi.io'].password, 'org-token');
});

test('project logins override organization defaults and complete env logins override both', async () => {
  const { service, projectRows, crypto } = fixture();
  projectRows.push({
    projectId: 'p-a',
    registry: 'dhi.io',
    username: 'project',
    password: crypto.encrypt('project-token')
  });
  assert.equal((await service.buildAuths('d-a', {}))['dhi.io'].username, 'project');
  assert.equal(
    (await service.buildAuths('d-a', { DHI_USERNAME: 'app', DHI_TOKEN: 'app-token' }))['dhi.io']
      .username,
    'app'
  );
  const config = JSON.stringify({ auths: { 'dhi.io': registryAuth('config', 'config-token') } });
  assert.equal(
    (await service.buildAuths('d-a', { DOCKER_AUTH_CONFIG: config }))['dhi.io'].username,
    'config'
  );
  await assert.rejects(service.buildAuths('d-a', { DHI_USERNAME: 'partial' }), PullAuthError);
  await assert.rejects(service.buildAuths('d-a', { DHI_TOKEN: 'partial' }), PullAuthError);
  projectRows.length = 0;
  assert.equal((await service.buildAuths('d-a', {}))['dhi.io'].username, 'org');
});

test('organization save encrypts tokens, returns metadata and synchronizes existing projects', async () => {
  const { service, orgRows, crypto, audits, patches } = fixture();
  (service as any).verify = async () => {};
  const result = await service.upsert(
    'org-a',
    { registry: 'dhi.io', username: 'replacement', password: 'replacement-token' },
    'admin',
    true
  );
  assert.equal(result.username, 'replacement');
  assert.equal('password' in result, false);
  assert.ok(crypto.isEncrypted(orgRows[0].password));
  assert.equal(crypto.decrypt(orgRows[0].password), 'replacement-token');
  assert.equal(JSON.stringify(await service.listOrganization('org-a')).includes('password'), false);
  assert.equal(JSON.stringify(audits).includes('replacement-token'), false);
  assert.equal(audits[0].action, 'org.registry_credential.set');
  assert.deepEqual(patches[0][2], [
    { name: 'unrelated-secret' },
    { name: 'orchard-registry-creds' }
  ]);
});

test('removal is organization scoped and preserves project overrides', async () => {
  const { service, orgRows, projectRows, crypto, secretWrites } = fixture();
  await assert.rejects(service.removeOrganization('org-b', 'o1', 'admin'), /not found/);
  assert.equal(orgRows.length, 2);
  projectRows.push({
    projectId: 'p-a',
    registry: 'dhi.io',
    username: 'project',
    password: crypto.encrypt('project-token')
  });
  await service.removeOrganization('org-a', 'o1', 'admin');
  assert.equal(secretWrites[0][2]['dhi.io'].username, 'project');
  assert.equal(orgRows.length, 1);
});

test('removing the last organization login clears inherited namespace credentials', async () => {
  const { service, secretWrites } = fixture();
  await service.removeOrganization('org-a', 'o1', 'admin');
  assert.equal(secretWrites[0][2], null);
  assert.deepEqual(await service.pullSecretsFor('p-a', 'dhi.io/node:24'), []);
});

test('all organization credential routes require organization admin authorization first', async () => {
  const calls: string[] = [];
  const credentials = {
    listOrganization: () => calls.push('list'),
    upsert: () => calls.push('upsert'),
    removeOrganization: () => calls.push('remove')
  };
  const users = { findOrCreateByClerkId: async () => ({ id: 'user' }) };
  const authz = {
    requireOrgAdmin: async (orgId: string, userId: string) => {
      assert.equal(orgId, 'org-a');
      assert.equal(userId, 'user');
      throw new Error('Forbidden');
    }
  };
  const controller = new OrganizationRegistryCredentialsController(
    credentials as any,
    users as any,
    authz as any
  );
  const req = { user: { sub: 'external-user' } };
  await assert.rejects(controller.list('org-a', req), /Forbidden/);
  await assert.rejects(controller.upsert('org-a', {} as any, req), /Forbidden/);
  await assert.rejects(controller.remove('org-a', 'credential', req), /Forbidden/);
  assert.deepEqual(calls, []);
});

test('Docker Hub aliases in env config override all inherited Docker Hub auth entries', async () => {
  const { service, orgRows, crypto } = fixture();
  orgRows.push({
    id: 'hub',
    organizationId: 'org-a',
    registry: 'docker.io',
    username: 'org-hub',
    password: crypto.encrypt('org-hub-token')
  });
  const auths = await service.buildAuths('d-a', {
    DOCKER_AUTH_CONFIG: JSON.stringify({
      auths: { 'registry-1.docker.io': registryAuth('app-hub', 'app-hub-token') }
    })
  });
  assert.equal(auths['docker.io'].username, 'app-hub');
  assert.equal(auths['https://index.docker.io/v1/'].username, 'app-hub');
  assert.equal(auths['dhi.io'].username, 'org');
});

test('invalid input and unencrypted instances cannot persist organization logins', async () => {
  const { service, orgRows, crypto } = fixture();
  for (const input of [
    null,
    { registry: 12 },
    { registry: 'dhi.io', username: {}, password: 'token' },
    { registry: 'dhi.io', username: 'user', password: {} }
  ]) {
    await assert.rejects(service.upsert('org-a', input as any, 'admin', true));
  }
  Object.defineProperty(crypto, 'enabled', { get: () => false });
  await assert.rejects(
    service.upsert(
      'org-a',
      { registry: 'dhi.io', username: 'user', password: 'token' },
      'admin',
      true
    ),
    /SECRETS_ENCRYPTION_KEY/
  );
  assert.equal(orgRows[0].username, 'org');
});
