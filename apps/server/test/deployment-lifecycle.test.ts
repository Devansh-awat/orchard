import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WorkloadMirrorConsumer } from '../src/mirror/consumers/workload-mirror.consumer';
import { DeploymentsService } from '../src/projects/deployments.service';

describe('deployment lifecycle', () => {
  test('reports a persistently stopped deployment as stopped', async () => {
    const service = Object.create(DeploymentsService.prototype) as DeploymentsService;
    const status = await service.computeDeploymentStatus({
      stopped: true,
      replicas: 3,
      name: 'web',
      namespace: 'project'
    });
    assert.equal(status, 'stopped');
  });

  test('does not adopt zero replicas from a stopped workload', async () => {
    let update: any;
    const consumer = Object.create(WorkloadMirrorConsumer.prototype) as any;
    consumer.prisma = {
      deployment: {
        findUnique: async () => ({
          replicas: 3,
          stopped: true,
          image: 'example/app:latest',
          cpuRequestMilli: null,
          memoryRequestBytes: null,
          deployStrategy: 'rollingUpdate',
          imagePullPolicy: null,
          buildStatus: 'succeeded'
        }),
        update: async (args: any) => {
          update = args;
        }
      },
      k8sApplyItem: { count: async () => 0 }
    };

    await consumer.adoptWorkloadSpec('deployment-id', {
      spec: { replicas: 0, template: { spec: { containers: [{ image: 'example/app:latest' }] } } }
    });

    assert.equal(update, undefined);
  });

  test('applies zero replicas while preserving the desired count', async () => {
    let applied: any;
    const service = Object.create(DeploymentsService.prototype) as any;
    service.prisma = {
      deployment: {
        findUnique: async () => ({
          name: 'web',
          namespace: 'project',
          replicas: 3,
          stopped: true
        })
      }
    };
    service.k8sWorkload = {
      getKubernetesDeployment: async () => ({ status: {} })
    };
    service.applyExecutor = {
      ssaApply: async (manifest: any) => {
        applied = manifest;
      }
    };

    await service.applyScaleToCluster('deployment-id');

    assert.equal(applied.spec.replicas, 0);
  });
});
