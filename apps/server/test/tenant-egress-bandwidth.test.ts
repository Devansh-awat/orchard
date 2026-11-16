import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import { JobsOrchestratorService } from '../src/jobs/jobs-orchestrator.service';
import {
  EGRESS_BANDWIDTH_ANNOTATION,
  tenantEgressBandwidth,
  tenantPodAnnotations
} from '../src/kubernetes/trusted-images';

const withBandwidth = async (value: string | undefined, fn: () => Promise<void> | void) => {
  const prev = process.env.TENANT_EGRESS_BANDWIDTH;
  if (value === undefined) delete process.env.TENANT_EGRESS_BANDWIDTH;
  else process.env.TENANT_EGRESS_BANDWIDTH = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.TENANT_EGRESS_BANDWIDTH;
    else process.env.TENANT_EGRESS_BANDWIDTH = prev;
  }
};

test('the setting is off unless it holds a valid bandwidth quantity', () => {
  assert.equal(tenantEgressBandwidth({}), undefined);
  assert.equal(tenantEgressBandwidth({ TENANT_EGRESS_BANDWIDTH: '' }), undefined);
  assert.equal(tenantEgressBandwidth({ TENANT_EGRESS_BANDWIDTH: 'fast' }), undefined);
  assert.equal(tenantEgressBandwidth({ TENANT_EGRESS_BANDWIDTH: '0' }), undefined);
  assert.equal(tenantEgressBandwidth({ TENANT_EGRESS_BANDWIDTH: '-5M' }), undefined);
  assert.equal(tenantEgressBandwidth({ TENANT_EGRESS_BANDWIDTH: ' 50M ' }), '50M');
  assert.equal(tenantEgressBandwidth({ TENANT_EGRESS_BANDWIDTH: '1G' }), '1G');
  assert.deepEqual(tenantPodAnnotations({ TENANT_EGRESS_BANDWIDTH: '10M' }), {
    [EGRESS_BANDWIDTH_ANNOTATION]: '10M'
  });
  assert.equal(tenantPodAnnotations({}), undefined);
});

function workload() {
  let created: any;
  let patched: any;
  const api = {
    createNamespacedDeployment: async (_ns: string, b: any) => {
      created = b;
    },
    createNamespacedService: async () => ({ body: {} }),
    readNamespacedService: async () => ({ body: { spec: { ports: [] } } }),
    readNamespacedDeployment: async () => ({ body: { spec: { template: { spec: {} } } } }),
    patchNamespacedDeployment: async (_n: string, _ns: string, patch: any) => {
      patched = patch;
    }
  };
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.kubernetes = { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined };
  service.prisma = { project: { findFirst: async () => null } };
  return { service, created: () => created, patched: () => patched };
}

test('app pods carry the egress bandwidth annotation when the setting is on', async () => {
  await withBandwidth('25M', async () => {
    const w = workload();
    await w.service.createDeployment({
      namespace: 'project',
      name: 'web',
      image: 'registry.example.com/org/app:1',
      ports: [{ name: 'http', containerPort: 8080, servicePort: 80, protocol: 'TCP' }]
    });
    assert.equal(
      w.created().spec.template.metadata.annotations[EGRESS_BANDWIDTH_ANNOTATION],
      '25M'
    );
    await w.service.updateDeploymentImage('web', 'project', 'registry.example.com/org/app:2');
    assert.equal(
      w.patched().spec.template.metadata.annotations[EGRESS_BANDWIDTH_ANNOTATION],
      '25M'
    );
  });
});

test('app pods are untouched when the setting is off', async () => {
  await withBandwidth(undefined, async () => {
    const w = workload();
    await w.service.createDeployment({
      namespace: 'project',
      name: 'web',
      image: 'registry.example.com/org/app:1',
      ports: [{ name: 'http', containerPort: 8080, servicePort: 80, protocol: 'TCP' }]
    });
    assert.equal(
      w.created().spec.template.metadata.annotations?.[EGRESS_BANDWIDTH_ANNOTATION],
      undefined
    );
    assert.equal(JSON.stringify(w.created()).includes('egress-bandwidth'), false);
    await w.service.updateDeploymentImage('web', 'project', 'registry.example.com/org/app:2');
    assert.equal(w.patched().spec.template.metadata, undefined);
  });
});

test('job step pods carry the egress bandwidth annotation when the setting is on', async () => {
  const build = () =>
    (Object.create(JobsOrchestratorService.prototype) as any).buildStepJobManifest(
      { jobId: 'job-1', projectId: 'p', organizationId: 'o', namespace: 'ns' },
      {
        stepOrder: 1,
        name: 'run',
        type: 'app',
        image: 'registry.example.com/org/app:1',
        shell: 'true',
        envVars: [],
        retries: 0,
        timeoutSeconds: 60
      },
      { name: 'ojr-1', envSecret: 'env' }
    );
  await withBandwidth('5M', () => {
    assert.equal(build().spec.template.metadata.annotations[EGRESS_BANDWIDTH_ANNOTATION], '5M');
  });
  await withBandwidth(undefined, () => {
    assert.equal(build().spec.template.metadata.annotations, undefined);
  });
});
