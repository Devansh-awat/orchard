import test from 'node:test';
import assert from 'node:assert/strict';
import {
  namespaceRegistryMeta,
  registryImagePolicy,
  registryImagePolicyBinding,
  registryPolicyMode,
  repoFromImage
} from '../src/kubernetes/registry-image-policy';

test('the policy stays in report-only mode unless told otherwise', () => {
  assert.equal(registryPolicyMode(undefined), 'warn');
  assert.equal(registryPolicyMode('nonsense'), 'warn');
  assert.equal(registryPolicyMode('ENFORCE'), 'enforce');
  assert.equal(registryPolicyMode('off'), 'off');
  assert.deepEqual((registryImagePolicyBinding('warn') as any).spec.validationActions, [
    'Warn',
    'Audit'
  ]);
  assert.deepEqual((registryImagePolicyBinding('enforce') as any).spec.validationActions, ['Deny']);
});

test('the policy only applies to namespaces carrying a registry prefix', () => {
  const policy = registryImagePolicy(['registry.example'], 'orchard') as any;
  assert.deepEqual(policy.spec.matchConstraints.namespaceSelector.matchExpressions, [
    { key: 'orchard.my/registry-prefix', operator: 'Exists' }
  ]);
  const hosts = policy.spec.variables.find((v: any) => v.name === 'hosts').expression;
  assert.equal(hosts, "['registry.example', 'registry.example:443']");
});

test('environments share their project prefix', () => {
  const meta = namespaceRegistryMeta([
    { namespace: 'acme-web', environments: ['acme-web', 'acme-web-staging'], repos: [] }
  ]);
  assert.equal(meta.get('acme-web')?.prefix, 'acme-web');
  assert.equal(meta.get('acme-web-staging')?.prefix, 'acme-web');
  assert.equal(meta.get('acme-web')?.foreign, null);
});

test('a project whose name extends another stays off limits to the shorter one', () => {
  const meta = namespaceRegistryMeta([
    { namespace: 'ysws-clubs', environments: [], repos: ['ysws-clubs-web'] },
    { namespace: 'ysws-clubs-infra', environments: [], repos: ['ysws-clubs-infra-api'] }
  ]);
  assert.equal(meta.get('ysws-clubs')?.foreign, 'ysws-clubs-infra');
  assert.equal(meta.get('ysws-clubs')?.own, null);
  assert.equal(meta.get('ysws-clubs-infra')?.foreign, null);
});

test('an app that really belongs to the shorter project keeps its image', () => {
  const meta = namespaceRegistryMeta([
    { namespace: 'ysws-clubs', environments: [], repos: ['ysws-clubs-infra-tool'] },
    { namespace: 'ysws-clubs-infra', environments: [], repos: [] }
  ]);
  assert.equal(meta.get('ysws-clubs')?.own, 'ysws-clubs-infra-tool');
});

test('repo names come out of every image shape', () => {
  assert.equal(repoFromImage('r.example/orchard/acme-web:v1'), 'acme-web');
  assert.equal(repoFromImage('r.example:5000/orchard/acme-web@sha256:abc'), 'acme-web');
  assert.equal(repoFromImage('nginx'), 'nginx');
});
