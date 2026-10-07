import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY_PULL_SECRET_NAME,
  bearerTokenUrl,
  imageRegistryHost,
  normalizeRegistryHost,
  parseBearerChallenge,
  pullSecretsForImage,
  registryAuthsFor
} from '../src/projects/registry-credentials';

test('registry hosts normalise scheme, path, case and docker hub aliases', () => {
  assert.equal(normalizeRegistryHost('https://ghcr.io/'), 'ghcr.io');
  assert.equal(normalizeRegistryHost('GHCR.io/hackclub'), 'ghcr.io');
  assert.equal(normalizeRegistryHost('index.docker.io'), 'docker.io');
  assert.equal(normalizeRegistryHost('https://index.docker.io/v1/'), 'docker.io');
  assert.equal(normalizeRegistryHost('registry.example.com:5000'), 'registry.example.com:5000');
  assert.equal(normalizeRegistryHost('not a host'), null);
  assert.equal(normalizeRegistryHost('ghcr'), null);
  assert.equal(normalizeRegistryHost(''), null);
});

test('image references resolve to the registry that serves them', () => {
  assert.equal(imageRegistryHost('nginx'), 'docker.io');
  assert.equal(imageRegistryHost('hackclub/private:1.2'), 'docker.io');
  assert.equal(imageRegistryHost('docker.io/hackclub/private'), 'docker.io');
  assert.equal(imageRegistryHost('ghcr.io/hackclub/orchard:main'), 'ghcr.io');
  assert.equal(
    imageRegistryHost('registry.example.com:5000/team/app@sha256:abc'),
    'registry.example.com:5000'
  );
  assert.equal(imageRegistryHost('localhost:5000/app'), 'localhost:5000');
});

test('a pull secret is only attached when the project holds a matching credential', () => {
  const registries = ['ghcr.io'];
  assert.deepEqual(pullSecretsForImage('ghcr.io/hackclub/app', registries), [
    { name: REGISTRY_PULL_SECRET_NAME }
  ]);
  assert.deepEqual(pullSecretsForImage('nginx', registries), []);
  assert.deepEqual(pullSecretsForImage('ghcr.io/hackclub/app', []), []);
});

test('docker hub credentials are written under both keys the kubelet looks up', () => {
  const auths = registryAuthsFor([
    { registry: 'docker.io', username: 'me', password: 'pw' },
    { registry: 'ghcr.io', username: 'gh', password: 'ghp_x' }
  ]);
  assert.deepEqual(Object.keys(auths).sort(), [
    'docker.io',
    'ghcr.io',
    'https://index.docker.io/v1/'
  ]);
  assert.equal(auths['ghcr.io'].auth, Buffer.from('gh:ghp_x').toString('base64'));
  assert.equal(auths['docker.io'].username, 'me');
});

test('bearer challenges yield the token realm and service', () => {
  assert.deepEqual(
    parseBearerChallenge(
      'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"'
    ),
    { realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:x:pull' }
  );
  assert.equal(
    bearerTokenUrl({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:x:pull'
    }),
    'https://ghcr.io/token?service=ghcr.io&scope=repository%3Ax%3Apull'
  );
  assert.equal(
    bearerTokenUrl({ realm: 'https://quay.io/v2/auth', service: 'quay.io' }),
    'https://quay.io/v2/auth?service=quay.io'
  );
  assert.equal(parseBearerChallenge('Basic realm="harbor"'), null);
  assert.equal(parseBearerChallenge(null), null);
});
