import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dockerConfigJson,
  hasRegistryAuths,
  isPullAuthEnvKey,
  mergeRegistryAuths,
  parseDockerAuthConfig,
  pullAuthsFromEnv,
  PullAuthError,
  registryAuth
} from '../src/docker/registry-pull-auth';
import { buildSafeEnv, builderContainerEnv } from '../src/env/reserved-env';

test('DHI_USERNAME and DHI_TOKEN become a dhi.io docker auth entry', () => {
  const auths = pullAuthsFromEnv({
    DHI_USERNAME: 'moby',
    DHI_TOKEN: 'dckr_pat_abc',
    DATABASE_URL: 'postgres://app'
  });
  assert.deepEqual(auths, { 'dhi.io': registryAuth('moby', 'dckr_pat_abc') });
});

test('either DHI field alone is an error', () => {
  assert.throws(() => pullAuthsFromEnv({ DHI_USERNAME: 'moby' }), PullAuthError);
  assert.throws(() => pullAuthsFromEnv({ DHI_TOKEN: 'dckr_pat_abc' }), PullAuthError);
});

test('DOCKER_AUTH_CONFIG accepts a full docker config or a bare auths map', () => {
  const wrapped = pullAuthsFromEnv({
    DOCKER_AUTH_CONFIG: JSON.stringify({
      auths: { 'dhi.io': { username: 'moby', password: 'pat' } }
    })
  });
  const bare = parseDockerAuthConfig(
    JSON.stringify({
      'ghcr.io': { username: 'octo', password: 'ghs_x' }
    })
  );
  assert.equal(wrapped['dhi.io'].username, 'moby');
  assert.equal(bare['ghcr.io'].password, 'ghs_x');
  assert.equal(wrapped['dhi.io'].auth, Buffer.from('moby:pat').toString('base64'));
});

test('DOCKER_AUTH_CONFIG can decode an auth field without username/password', () => {
  const auths = parseDockerAuthConfig(
    JSON.stringify({
      auths: { 'dhi.io': { auth: Buffer.from('moby:pat').toString('base64') } }
    })
  );
  assert.equal(auths['dhi.io'].username, 'moby');
  assert.equal(auths['dhi.io'].password, 'pat');
});

test('invalid DOCKER_AUTH_CONFIG fails closed', () => {
  assert.throws(() => pullAuthsFromEnv({ DOCKER_AUTH_CONFIG: '{' }), PullAuthError);
  assert.throws(() => pullAuthsFromEnv({ DOCKER_AUTH_CONFIG: '[]' }), PullAuthError);
  assert.throws(
    () => pullAuthsFromEnv({ DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { 'dhi.io': {} } }) }),
    PullAuthError
  );
});

test('later auths win when merging the same host', () => {
  const merged = mergeRegistryAuths(
    { 'dhi.io': registryAuth('ops', 'ops-pat') },
    pullAuthsFromEnv({ DHI_USERNAME: 'app', DHI_TOKEN: 'app-pat' })
  );
  assert.equal(merged['dhi.io'].username, 'app');
  assert.equal(merged['dhi.io'].password, 'app-pat');
});

test('empty env is a no-op', () => {
  assert.deepEqual(pullAuthsFromEnv({ DATABASE_URL: 'postgres://app' }), {});
  assert.equal(hasRegistryAuths({}), false);
});

test('dockerconfigjson keeps username, password, and auth', () => {
  const auths = pullAuthsFromEnv({ DHI_USERNAME: 'moby', DHI_TOKEN: 'pat' });
  assert.deepEqual(dockerConfigJson(auths), { auths });
});

test('pull-auth keys never become build args or builder container env', () => {
  const stored = {
    DHI_USERNAME: 'moby',
    DHI_TOKEN: 'dckr_pat_abc',
    DOCKER_AUTH_CONFIG: '{"auths":{}}',
    DATABASE_URL: 'postgres://app'
  };
  const forBuild = buildSafeEnv(stored);
  assert.deepEqual(forBuild, { DATABASE_URL: 'postgres://app' });
  assert.deepEqual(
    builderContainerEnv(stored).map((e) => e.name),
    ['DATABASE_URL']
  );
  for (const key of ['DHI_USERNAME', 'DHI_TOKEN', 'DOCKER_AUTH_CONFIG']) {
    assert.equal(isPullAuthEnvKey(key), true);
  }
});
