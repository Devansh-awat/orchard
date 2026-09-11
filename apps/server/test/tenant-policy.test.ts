import test from 'node:test';
import assert from 'node:assert/strict';
import { tenantIngressNamespaces } from '../src/kubernetes/k8s-namespace.service';

function withEnv(value: string | undefined, fn: () => void) {
  const previous = process.env.TENANT_INGRESS_NAMESPACES;
  if (value === undefined) delete process.env.TENANT_INGRESS_NAMESPACES;
  else process.env.TENANT_INGRESS_NAMESPACES = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TENANT_INGRESS_NAMESPACES;
    else process.env.TENANT_INGRESS_NAMESPACES = previous;
  }
}

test('unset keeps the namespaces this project has always used', () => {
  withEnv(undefined, () => {
    assert.deepEqual(tenantIngressNamespaces(), ['network', 'orchard']);
  });
});

test('an empty value is treated as unset rather than as no namespaces', () => {
  withEnv('', () => {
    assert.deepEqual(tenantIngressNamespaces(), ['network', 'orchard']);
  });
  withEnv('  ', () => {
    assert.deepEqual(tenantIngressNamespaces(), ['network', 'orchard']);
  });
});

test('a k3s cluster can name Traefik instead', () => {
  withEnv('traefik,orchard', () => {
    assert.deepEqual(tenantIngressNamespaces(), ['traefik', 'orchard']);
  });
});

test('whitespace and trailing commas are tolerated', () => {
  withEnv(' traefik , orchard , ', () => {
    assert.deepEqual(tenantIngressNamespaces(), ['traefik', 'orchard']);
  });
});

test('a single namespace works', () => {
  withEnv('traefik', () => {
    assert.deepEqual(tenantIngressNamespaces(), ['traefik']);
  });
});
