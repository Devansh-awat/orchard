import test from 'node:test';
import assert from 'node:assert/strict';
import { findVolumeConflict, volumeClaim, type VolumeHolder } from '../src/projects/volume-claims';
import { DeploymentsService } from '../src/projects/deployments.service';

function holder(deployment: string, pvcName: string | null): VolumeHolder {
  return { name: 'data', pvcName, deployment: { id: deployment, name: deployment } };
}

function guard(rows: VolumeHolder[]) {
  const service = Object.create(DeploymentsService.prototype);
  const queries: any[] = [];
  service.prisma = {
    deploymentVolume: {
      findMany: async (args: any) => {
        queries.push(args);
        return rows;
      }
    }
  };
  service.environments = { resolveEnvironment: async () => ({ namespace: 'ns-env' }) };
  return { service, queries };
}

test('a volume claims its pvc name and falls back to its own name', () => {
  assert.equal(volumeClaim({ name: 'data', pvcName: ' disk ' }), 'disk');
  assert.equal(volumeClaim({ name: 'data', pvcName: null }), 'data');
});

test('another app holding the disk is a conflict', () => {
  assert.deepEqual(findVolumeConflict(['data'], [holder('blog', 'data')]), {
    claim: 'data',
    holder: 'blog'
  });
});

test('an old row with no pvc name still holds the disk it mounts', () => {
  assert.equal(findVolumeConflict(['data'], [holder('blog', null)])?.holder, 'blog');
});

test('a free name and the excepted deployments are not conflicts', () => {
  assert.equal(findVolumeConflict(['other'], [holder('blog', 'data')]), null);
  assert.equal(findVolumeConflict(['data'], [holder('blog', 'data')], ['blog']), null);
});

test('creating an app on a claimed disk is refused and names the holder', async () => {
  const { service, queries } = guard([holder('blog', 'data')]);
  await assert.rejects(
    service.assertVolumesUnclaimed('ns', [{ name: 'data', type: 'pvc', pvcName: 'data' }]),
    /Volume "data" is already used by "blog"/
  );
  assert.equal(queries[0].where.deployment.namespace, 'ns');
});

test('temporary volumes never hit the check', async () => {
  const { service, queries } = guard([holder('blog', 'data')]);
  await service.assertVolumesUnclaimed('ns', [{ name: 'data', type: 'emptyDir' }]);
  assert.equal(queries.length, 0);
});

test('a compose preflight checks the namespace of the stack environment', async () => {
  const { service, queries } = guard([holder('blog', 'data')]);
  await assert.rejects(
    service.assertEnvironmentVolumesUnclaimed('project', 'env', [{ name: 'data', type: 'pvc' }]),
    /already used by "blog"/
  );
  assert.equal(queries[0].where.deployment.namespace, 'ns-env');
});

function teardownHarness(rows: VolumeHolder[]) {
  const { service } = guard(rows);
  const deleted: string[] = [];
  service.kubernetesService = {
    deletePVC: async (_ns: string, name: string) => {
      deleted.push(name);
    }
  };
  service.k8sNetwork = {
    unexposeAllDeploymentPortsPublic: async () => {},
    deletePublicDeploymentNetworkPolicy: async () => {}
  };
  service.tailscaleService = { cleanupDeployment: async () => {} };
  service.k8sWorkload = { deleteDeployment: async () => {} };
  const app = {
    id: 'a',
    name: 'a',
    namespace: 'ns',
    buildContextKey: null,
    tailscaleExposed: false
  };
  const related = {
    ingresses: [],
    services: [],
    volumes: [
      { type: 'pvc', pvcName: 'shared' },
      { type: 'pvc', pvcName: 'own' }
    ]
  };
  return { service, deleted, app, related };
}

test('deleting an app keeps a disk another app still mounts', async () => {
  const { service, deleted, app, related } = teardownHarness([
    holder('a', 'shared'),
    holder('b', 'shared'),
    holder('a', 'own')
  ]);
  await service.teardownDeploymentResources(app, related, true);
  assert.deepEqual(deleted, ['own']);
});

test('the last app on a disk deletes it', async () => {
  const { service, deleted, app, related } = teardownHarness([
    holder('a', 'shared'),
    holder('a', 'own')
  ]);
  await service.teardownDeploymentResources(app, related, true);
  assert.deepEqual(deleted, ['shared', 'own']);
});

test('deleting from the cluster with volumes kept never touches them', async () => {
  const { service, deleted, app, related } = teardownHarness([]);
  await service.teardownDeploymentResources(app, related, false);
  assert.deepEqual(deleted, []);
});
