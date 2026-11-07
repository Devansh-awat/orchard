import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { DockerService } from '../src/docker/docker.service';
import { registryLoginHostError } from '../src/docker/registry-pull-auth';

function service(t: import('node:test').TestContext) {
  const docker = new DockerService({} as any, {} as any) as any;
  t.mock.method(docker, 'appendLog', async () => {});
  t.mock.method(docker, 'maybePruneDocker', async () => {});
  t.mock.method(docker, 'cloneRepository', async () => '/nonexistent-build-dir');
  return docker;
}

test('each local build gets its own docker config directory, removed afterwards', async (t) => {
  const docker = service(t);
  const seen: string[] = [];
  t.mock.method(docker, 'buildImage', async () => {
    const dir = docker.dockerConfigEnv().DOCKER_CONFIG as string;
    assert.ok(existsSync(dir));
    assert.equal(statSync(dir).mode & 0o077, 0);
    seen.push(dir);
  });
  t.mock.method(docker, 'pushImage', async () => {
    assert.equal(docker.dockerConfigEnv().DOCKER_CONFIG, seen[seen.length - 1]);
  });
  const build = () =>
    docker.buildWithLocalDocker({
      repoUrl: 'https://github.com/example/app',
      branch: 'main',
      dockerfilePath: 'Dockerfile',
      imageName: 'app'
    });
  await Promise.all([build(), build()]);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  for (const dir of seen) assert.equal(existsSync(dir), false);
  assert.deepEqual(docker.dockerConfigEnv(), {});
});

test('the config directory is removed when the build fails', async (t) => {
  const docker = service(t);
  let dir = '';
  t.mock.method(docker, 'buildImage', async () => {
    dir = docker.dockerConfigEnv().DOCKER_CONFIG;
    throw new Error('boom');
  });
  await assert.rejects(
    docker.buildWithLocalDocker({
      repoUrl: 'https://github.com/example/app',
      branch: 'main',
      dockerfilePath: 'Dockerfile',
      imageName: 'app'
    }),
    /boom/
  );
  assert.ok(dir);
  assert.equal(existsSync(dir), false);
});

test('registry login hosts must look like registries', () => {
  for (const host of [
    'ghcr.io',
    'registry.example:5000',
    'https://index.docker.io/v1/',
    'dhi.io'
  ]) {
    assert.equal(registryLoginHostError(host), null, host);
  }
  for (const host of [
    '--config=/etc',
    '-u',
    '',
    'user@evil.example',
    'localhost:5000',
    '127.1',
    '[::1]',
    'a b'
  ]) {
    assert.notEqual(registryLoginHostError(host), null, host);
  }
});
