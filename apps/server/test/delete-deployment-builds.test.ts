import assert from 'node:assert/strict';
import test from 'node:test';
import { DeploymentsService } from '../src/projects/deployments.service';

function harness(buildStatus: string) {
  const cancelled: string[] = [];
  const service = Object.create(DeploymentsService.prototype) as any;
  service.usersService = { findOrCreateByClerkId: async () => ({ id: 'user' }) };
  service.authz = { requireProjectEdit: async () => ({}) };
  service.prisma = {
    deployment: {
      findUnique: async () => ({
        id: 'd1',
        name: 'web',
        namespace: 'ns',
        buildStatus,
        composeStackId: 'stack',
        projectId: 'p1',
        project: { id: 'p1', organizationId: 'org', organization: {} }
      }),
      delete: async () => ({})
    },
    ingress: { findMany: async () => [] },
    service: { findMany: async () => [] },
    deploymentVolume: { findMany: async () => [] },
    imageHistory: { findMany: async () => [] }
  };
  service.dockerService = {
    cancelBuildJobsByDeploymentId: async (id: string) => {
      cancelled.push(id);
    }
  };
  service.teardownDeploymentResources = async () => undefined;
  service.notifications = { purgeScope: async () => undefined };
  service.audit = { log: async () => undefined };
  return { service, cancelled };
}

test('a deleted app takes its build jobs with it, finished or not', async () => {
  for (const status of ['building', 'pending', 'failed', 'succeeded']) {
    const { service, cancelled } = harness(status);
    await service.deleteDeployment('d1', 'clerk', undefined, { fromComposeStack: true });
    assert.deepEqual(cancelled, ['d1'], status);
  }
});

test('an image deployment has no build jobs to look for', async () => {
  const { service, cancelled } = harness('none');
  await service.deleteDeployment('d1', 'clerk', undefined, { fromComposeStack: true });
  assert.deepEqual(cancelled, []);
});
