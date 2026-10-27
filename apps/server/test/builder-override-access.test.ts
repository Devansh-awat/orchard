import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { DeploymentsService } from '../src/projects/deployments.service';

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
  service.authz = {
    requireProjectEdit: async () => {
      if (!opts.canEdit) throw new ForbiddenException('Your role does not allow you to update');
    },
    isSuperAdmin: async () => !!opts.superAdmin
  };
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
