import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tenantSecretsBinding,
  tenantSecretsRole,
  TENANT_SECRETS_ROLE
} from '../src/kubernetes/tenant-rbac';

test('with the chart-provided ClusterRole the binding points at it, so no Role has to be minted', () => {
  const binding = tenantSecretsBinding('tenant-a', 'orchard', 'orchard-tenant-secrets');
  assert.equal(binding.roleRef.kind, 'ClusterRole');
  assert.equal(binding.roleRef.name, 'orchard-tenant-secrets');
  assert.equal(binding.metadata?.namespace, 'tenant-a');
  assert.deepEqual(binding.subjects, [
    { kind: 'ServiceAccount', name: 'orchard-server', namespace: 'orchard' }
  ]);
});

test('without the ClusterRole the old per-namespace Role shape is kept for existing installs', () => {
  const binding = tenantSecretsBinding('tenant-a', 'orchard', undefined);
  assert.equal(binding.roleRef.kind, 'Role');
  assert.equal(binding.roleRef.name, TENANT_SECRETS_ROLE);
  const role = tenantSecretsRole('tenant-a');
  assert.equal(role.metadata?.name, TENANT_SECRETS_ROLE);
  assert.deepEqual(role.rules?.[0].resources, ['secrets', 'configmaps']);
});

test('the binding grants nothing beyond secrets and configmaps', () => {
  const role = tenantSecretsRole('tenant-a');
  for (const rule of role.rules ?? []) {
    assert.deepEqual(rule.apiGroups, ['']);
    assert.ok(rule.resources?.every((r) => r === 'secrets' || r === 'configmaps'));
  }
});
