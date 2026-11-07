import test from 'node:test';
import assert from 'node:assert/strict';
import {
  namespaceRegistryMeta,
  registryImagePolicy,
  registryImagePolicyBinding,
  registryPolicyBlockers,
  registryPolicyMode,
  repoFromImage
} from '../src/kubernetes/registry-image-policy';

test('the policy enforces unless nothing can be refused safely or it is told otherwise', () => {
  assert.equal(registryPolicyMode(undefined), 'auto');
  assert.equal(registryPolicyMode(''), 'auto');
  assert.equal(registryPolicyMode('nonsense'), 'enforce');
  assert.equal(registryPolicyMode('ENFORCE'), 'enforce');
  assert.equal(registryPolicyMode('warn'), 'warn');
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
  assert.equal(
    hosts,
    "['registry.example', 'registry.example:443', 'registry.example:80', 'registry.example.', 'registry.example.:443', 'registry.example.:80']"
  );
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

test('automatic mode only enforces when no existing image would be refused', () => {
  const meta = namespaceRegistryMeta([
    { namespace: 'acme-web', environments: [], repos: [] },
    { namespace: 'acme-api', environments: [], repos: [] }
  ]);
  const hosts = ['registry.example'];
  const clean = registryPolicyBlockers(
    [
      {
        namespace: 'acme-web',
        images: ['registry.example/orchard/acme-web-app:v1', 'redis:8-alpine']
      },
      {
        namespace: 'acme-api',
        images: ['docker.io/library/postgres:17', 'registry.example/orchard/acme-api-x']
      }
    ],
    meta,
    hosts,
    'orchard'
  );
  assert.deepEqual(clean, []);
  const legacy = registryPolicyBlockers(
    [{ namespace: 'acme-web', images: ['registry.example/orchard/old-name:v1'] }],
    meta,
    hosts,
    'orchard'
  );
  assert.equal(legacy.length, 1);
  const other = registryPolicyBlockers(
    [
      {
        namespace: 'acme-web',
        images: ['registry.example./orchard/acme-web-x@sha256:' + 'a'.repeat(64)]
      }
    ],
    meta,
    hosts,
    'orchard'
  );
  assert.equal(other.length, 0);
  const crossed = registryPolicyBlockers(
    [{ namespace: 'acme-web', images: ['registry.example./orchard/zzz-x'] }],
    meta,
    hosts,
    'orchard'
  );
  assert.equal(crossed.length, 1);
  const pinned = registryPolicyBlockers([], meta, hosts, 'orchard', [
    'registry.example/orchard/pg:17'
  ]);
  assert.equal(pinned.length, 1);
  assert.deepEqual(
    registryPolicyBlockers([], meta, hosts, 'orchard', ['ghcr.io/cloudnative-pg/postgresql:17']),
    []
  );
});

test('the admission rule treats loopback spellings and public images the right way', () => {
  const policy = registryImagePolicy(['registry.example'], 'orchard') as any;
  const rule = policy.spec.validations[0].expression as string;
  assert.match(rule, /localhost/);
  assert.match(rule, /ffff/);
  assert.match(rule, /\{0,3\}/);
});
