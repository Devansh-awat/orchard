import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DeploymentsService, SUPER_BUILDS_UNAVAILABLE } from '../src/projects/deployments.service';
import { AuthorizationService } from '../src/auth/authorization.service';
import { requestAuthStorage } from '../src/auth/request-context';

function harness(opts: { canEdit: boolean; superAdmin?: boolean }) {
  const deployment = {
    id: 'dep',
    name: 'web',
    namespace: 'ns',
    projectId: 'project',
    buildType: 'dockerfile',
    buildWithDepot: false,
    persistentBuildCache: false,
    builderOverride: null as string | null,
    startCommand: null,
    project: { id: 'project', organizationId: 'org', organization: {} }
  };
  const service = Object.create(DeploymentsService.prototype) as any;
  service.usersService = { findOrCreateByClerkId: async () => ({ id: 'user', email: 'u@x' }) };
  service.prisma = {
    deployment: {
      findUnique: async () => deployment,
      update: async ({ data }: any) => Object.assign(deployment, data)
    }
  };
  service.authz = Object.assign(
    new AuthorizationService(
      { user: { findUnique: async () => ({ isSuperAdmin: !!opts.superAdmin }) } } as any,
      {} as any
    ),
    {
      requireProjectEdit: async () => {
        if (!opts.canEdit) throw new ForbiddenException('Your role does not allow you to update');
      }
    }
  );
  service.audit = { log: () => {} };
  service.getDeployment = async () => deployment;
  return { service, deployment };
}

test('a project member can pick the builder', async () => {
  const { service, deployment } = harness({ canEdit: true });
  await service.updateDeploymentBuildConfig('dep', { builderOverride: 'kubernetes' }, 'clerk');
  assert.equal(deployment.builderOverride, 'kubernetes');
  await service.updateDeploymentBuildConfig('dep', { builderOverride: null }, 'clerk');
  assert.equal(deployment.builderOverride, null);
});

test('a viewer cannot pick the builder', async () => {
  const { service, deployment } = harness({ canEdit: false });
  await assert.rejects(
    service.updateDeploymentBuildConfig('dep', { builderOverride: 'kubernetes' }, 'clerk'),
    ForbiddenException
  );
  assert.equal(deployment.builderOverride, null);
});

test('super builds and persistent cache stay superadmin-only', async () => {
  const { service } = harness({ canEdit: true });
  await assert.rejects(
    service.updateDeploymentBuildConfig('dep', { buildWithDepot: true }, 'clerk'),
    ForbiddenException
  );
  await assert.rejects(
    service.updateDeploymentBuildConfig('dep', { persistentBuildCache: true }, 'clerk'),
    ForbiddenException
  );
});

test('a superadmin sets super builds only from an unrestricted principal', async () => {
  const { service, deployment } = harness({ canEdit: true, superAdmin: true });
  for (const ctx of [
    { apiTokenId: 't', tokenScopes: ['read', 'deploy', 'exec'], tokenProjectIds: ['project'] },
    { apiTokenId: 't', tokenScopes: ['read', 'deploy'] },
    { mcpGateway: true, tokenScopes: ['exec'] },
    { browserSession: true, sessionOrgId: 'org' }
  ]) {
    await assert.rejects(
      requestAuthStorage.run(ctx, () =>
        service.updateDeploymentBuildConfig('dep', { buildWithDepot: true }, 'clerk')
      ),
      ForbiddenException,
      JSON.stringify(ctx)
    );
  }
  assert.equal(deployment.buildWithDepot, false);
  process.env.DEPOT_TOKEN = 'depot';
  try {
    await requestAuthStorage.run({ browserSession: true }, () =>
      service.updateDeploymentBuildConfig('dep', { buildWithDepot: true }, 'clerk')
    );
  } finally {
    delete process.env.DEPOT_TOKEN;
  }
  assert.equal(deployment.buildWithDepot, true);
});

test('super builds are refused when the instance has no depot token', async () => {
  const { service, deployment } = harness({ canEdit: true, superAdmin: true });
  delete process.env.DEPOT_TOKEN;
  await assert.rejects(
    requestAuthStorage.run({ browserSession: true }, () =>
      service.updateDeploymentBuildConfig('dep', { buildWithDepot: true }, 'clerk')
    ),
    (error) => error instanceof BadRequestException && error.message === SUPER_BUILDS_UNAVAILABLE
  );
  assert.equal(deployment.buildWithDepot, false);
});
