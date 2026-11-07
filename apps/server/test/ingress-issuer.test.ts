import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';
import { KubernetesService } from '../src/kubernetes/kubernetes.service';
import { CERT_CLUSTER_ISSUER } from '../src/projects/projects.utils';
import {
  isSanctionedIssuerValue,
  tenantIngressAnnotations
} from '../src/kubernetes/ingress-annotations';

function fakeKc(calls: { method: string; args: any[] }[]) {
  return {
    makeApiClient() {
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async (...args: any[]) => {
              calls.push({ method, args });
              if (method.startsWith('read')) {
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

const hostile = {
  'cert-manager.io/cluster-issuer': 'internal-ca',
  'cert-manager.io/issuer': 'whatever',
  'cert-manager.io/issuer-kind': 'ClusterIssuer',
  'acme.cert-manager.io/http01-edit-in-place': 'false',
  'orchard.my/basic-auth': 'true',
  'orchard.my/protection': 'none',
  'ingress.cilium.io/force-https': 'disabled'
};

test('tenant annotations never carry cert-manager or orchard.my keys', () => {
  assert.deepEqual(tenantIngressAnnotations(hostile), {
    'ingress.cilium.io/force-https': 'disabled'
  });
  assert.deepEqual(tenantIngressAnnotations(null), {});
});

test('only the server-configured issuer value is sanctioned', () => {
  assert.equal(
    isSanctionedIssuerValue('cert-manager.io/cluster-issuer', 'internal-ca', 'le'),
    false
  );
  assert.equal(isSanctionedIssuerValue('cert-manager.io/cluster-issuer', 'le', 'le'), true);
  assert.equal(isSanctionedIssuerValue('cert-manager.io/issuer', 'le', 'le'), false);
  assert.equal(isSanctionedIssuerValue('ingress.cilium.io/force-https', 'x', 'le'), true);
});

test('createIngress drops a tenant-chosen issuer but keeps the platform one', async () => {
  const calls: { method: string; args: any[] }[] = [];
  const kube: any = new (KubernetesService as any)({});
  kube.kc = fakeKc(calls);
  const net = new (K8sNetworkService as any)({}, kube, { onAcquired() {} });
  const base = {
    namespace: 'ns',
    name: 'i',
    host: 'a.example.com',
    path: '/',
    pathType: 'Prefix',
    serviceName: 'svc',
    servicePort: 80,
    tlsSecretName: 'leaf-cert-x',
    tlsHosts: ['a.example.com'],
    ingressClassName: 'haproxy'
  };
  await net.createIngress({ ...base, annotations: hostile });
  let body = calls.find((c) => c.method === 'createNamespacedIngress')!.args[1];
  assert.equal(body.metadata.annotations['cert-manager.io/cluster-issuer'], undefined);
  assert.equal(body.metadata.annotations['cert-manager.io/issuer'], undefined);

  calls.length = 0;
  await net.createIngress({
    ...base,
    annotations: { 'cert-manager.io/cluster-issuer': CERT_CLUSTER_ISSUER }
  });
  body = calls.find((c) => c.method === 'createNamespacedIngress')!.args[1];
  assert.equal(body.metadata.annotations['cert-manager.io/cluster-issuer'], CERT_CLUSTER_ISSUER);
});
