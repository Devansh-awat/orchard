import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDockerfileEnvVars as parse } from '../src/github/dockerfile-env';
import { builderContainerEnv, buildSafeEnv } from '../src/env/reserved-env';

/**
 * Repo detection offers a Dockerfile's ENV lines as the deployment's env vars,
 * and the new-deployment page applies the whole set. A standard bun preamble
 * meant Orchard generated `PATH=/usr/local/bun/bin:$PATH` for the user, stored
 * the literal (Kubernetes expands `$(VAR)`, never `$VAR`), then copied it into
 * the builder container — where it replaced the builder image's own PATH and
 * left BuildKit unable to find `mkdir`, let alone `buildkitd`. It exited 127
 * with no output, and the failure surfaced as the pusher's containerd 429.
 */

const BUN_PREAMBLE = `FROM oven/bun:1 AS base
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:$PATH
ENV RAILS_ENV=production
`;

test('a Dockerfile PATH built on $PATH is not offered as a deployment env var', () => {
  const keys = parse(BUN_PREAMBLE).map((e) => e.key);
  assert.ok(!keys.includes('PATH'));
  assert.deepEqual(keys, ['BUN_INSTALL', 'RAILS_ENV']);
});

test('a runtime-owned name is skipped even with a fully literal value', () => {
  const keys = parse('FROM alpine\nENV PATH=/usr/bin:/bin\nENV HOME=/root\nENV APP=x\n').map(
    (e) => e.key
  );
  assert.deepEqual(keys, ['APP']);
});

test('any build-time expansion is skipped, not just PATH', () => {
  const keys = parse('FROM alpine\nENV GEM_PATH=$GEM_HOME/vendor\nENV PORT=3000\n').map(
    (e) => e.key
  );
  assert.deepEqual(keys, ['PORT']);
});

test('the space-separated ENV form is filtered too', () => {
  const keys = parse('FROM alpine\nENV PATH /opt/bin:$PATH\nENV NODE_ENV production\n').map(
    (e) => e.key
  );
  assert.deepEqual(keys, ['NODE_ENV']);
});

test('ordinary values still come through with quotes stripped', () => {
  assert.deepEqual(parse('FROM alpine\nENV RAILS_ENV="production" PORT=3000\n'), [
    { key: 'RAILS_ENV', value: 'production' },
    { key: 'PORT', value: '3000' }
  ]);
});

test('a deployment that already stores PATH cannot reach the builder container', () => {
  const env = builderContainerEnv({
    PATH: '/usr/local/bun/bin:$PATH',
    DOCKER_CONFIG: '/tmp/evil',
    BUILDKITD_FLAGS: '--debug',
    DATABASE_URL: 'postgres://app'
  });
  assert.deepEqual(env, [{ name: 'DATABASE_URL', value: 'postgres://app' }]);
});

test('AWS credentials are a normal build input and are never withheld', () => {
  const stored = { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'shh' };
  assert.deepEqual(buildSafeEnv(stored), stored);
  assert.deepEqual(builderContainerEnv(stored), [
    { name: 'AWS_ACCESS_KEY_ID', value: 'AKIA' },
    { name: 'AWS_SECRET_ACCESS_KEY', value: 'shh' }
  ]);
});

test('the same set is withheld from the build, so ARG PATH never shadows the base image', () => {
  assert.deepEqual(
    buildSafeEnv({ PATH: '/usr/local/bun/bin:$PATH', HOME: '/x', DATABASE_URL: 'postgres://app' }),
    { DATABASE_URL: 'postgres://app' }
  );
});

test('the container env and the build-arg set agree, so no Railpack secret dangles', () => {
  const stored = { PATH: '/bad', DOCKER_CONFIG: '/tmp/evil', PORT: '3000', AWS_ACCESS_KEY_ID: 'k' };
  const forBuild = buildSafeEnv(stored);
  const inContainer = builderContainerEnv(forBuild).map((e) => e.name);
  assert.deepEqual(Object.keys(forBuild), inContainer);
});
