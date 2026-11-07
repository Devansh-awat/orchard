import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import { KubernetesService } from '../src/kubernetes/kubernetes.service';

type Call = { method: string; args: any[] };

function fakeKc(calls: Call[]) {
  return {
    makeApiClient() {
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async (...args: any[]) => {
              calls.push({ method, args });
              if (/^read/.test(method)) {
                const e: any = new Error('nf');
                e.response = { statusCode: 404 };
                throw e;
              }
              return { body: { items: [], status: {}, spec: {}, metadata: {} } };
            };
          }
        }
      );
    },
    getCurrentCluster() {
      return { server: 'https://x' };
    }
  } as any;
}

async function proxyObjects(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const calls: Call[] = [];
    const kube: any = new (KubernetesService as any)({});
    kube.kc = fakeKc(calls);
    const svc = new (K8sWorkloadService as any)({}, kube, {}, {});
    await svc.addTailscaleSidecar('ns', 'app', 'tskey-auth-X', 'host', [
      { port: 80, targetPort: 8080, protocol: 'TCP' }
    ]);
    const deployment = calls.find((c) => c.method === 'createNamespacedDeployment')!.args[1];
    const netpol = calls.find((c) => c.method === 'createNamespacedNetworkPolicy')!.args[1];
    return { pod: deployment.spec.template.spec, netpol };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the tailscale proxy pod runs sandboxed with every capability dropped', async () => {
  const { pod } = await proxyObjects({
    TENANT_RUNTIME_CLASS: 'gvisor',
    TAILSCALE_IMAGE: undefined
  });
  assert.equal(pod.runtimeClassName, 'gvisor');
  const sc = pod.containers[0].securityContext;
  assert.deepEqual(sc.capabilities, { drop: ['ALL'] });
  assert.equal(sc.allowPrivilegeEscalation, false);
  assert.equal(sc.runAsNonRoot, true);
  assert.equal(sc.seccompProfile.type, 'RuntimeDefault');
});

test('the tailscale image is configurable', async () => {
  const { pod } = await proxyObjects({
    TENANT_RUNTIME_CLASS: undefined,
    TAILSCALE_IMAGE: 'ghcr.io/tailscale/tailscale@sha256:abc'
  });
  assert.equal(pod.containers[0].image, 'ghcr.io/tailscale/tailscale@sha256:abc');
  assert.equal(pod.runtimeClassName, undefined);
});

test('the tailscale egress rule excludes link-local and CGNAT space', async () => {
  const { netpol } = await proxyObjects({ TENANT_RUNTIME_CLASS: undefined });
  const blocks = netpol.spec.egress
    .flatMap((r: any) => r.to ?? [])
    .filter((p: any) => p.ipBlock?.cidr === '0.0.0.0/0');
  assert.equal(blocks.length, 1);
  for (const cidr of ['169.254.0.0/16', '100.64.0.0/10', '10.0.0.0/8']) {
    assert.ok(blocks[0].ipBlock.except.includes(cidr), cidr);
  }
});
