import assert from 'node:assert/strict';
import test from 'node:test';
import { composeBuildPaths, stackWithBuildState } from '../src/compose-stacks/compose-build';

const paths = (composePath: string, build: { context?: string; dockerfile?: string }) =>
  composeBuildPaths('web', composePath, build);

test('a context resolves against the compose file, wherever that lives', () => {
  assert.deepEqual(paths('nginx-golang/compose.yaml', { context: 'backend' }), {
    dockerfilePath: 'nginx-golang/backend/Dockerfile',
    buildFromRoot: false
  });
  assert.deepEqual(paths('docker-compose.yml', { context: './backend/' }), {
    dockerfilePath: 'backend/Dockerfile',
    buildFromRoot: false
  });
  assert.deepEqual(paths('a/b/compose.yml', { context: '.' }), {
    dockerfilePath: 'a/b/Dockerfile',
    buildFromRoot: false
  });
});

test('a context at the repo root keeps building from the root', () => {
  for (const context of [undefined, '.', './']) {
    assert.deepEqual(paths('docker-compose.yml', { context }), {
      dockerfilePath: 'Dockerfile',
      buildFromRoot: true
    });
  }
  assert.deepEqual(paths('docker-compose.yml', { dockerfile: 'docker/Dockerfile.prod' }), {
    dockerfilePath: 'docker/Dockerfile.prod',
    buildFromRoot: true
  });
  assert.deepEqual(paths('deploy/compose.yml', { context: '..', dockerfile: 'app/Dockerfile' }), {
    dockerfilePath: 'app/Dockerfile',
    buildFromRoot: true
  });
});

test('a dockerfile name is taken relative to the context', () => {
  assert.deepEqual(paths('compose.yml', { context: 'api', dockerfile: 'Dockerfile.dev' }), {
    dockerfilePath: 'api/Dockerfile.dev',
    buildFromRoot: false
  });
});

test('a build this repo cannot express is refused up front', () => {
  assert.throws(
    () => paths('compose.yml', { context: 'api', dockerfile: '../Dockerfile' }),
    /move the Dockerfile/
  );
  assert.throws(() => paths('compose.yml', { context: '../other' }), /outside the repository/);
  assert.throws(() => paths('compose.yml', { context: '/srv/app' }), /outside the repository/);
  assert.throws(
    () => paths('compose.yml', { context: 'https://example.test/r.git' }),
    /folder in this repository/
  );
});

function stack(status: string, ...children: (string | null)[]) {
  return {
    status,
    buildStatus: 'building',
    lastError: null as string | null,
    deployments: children.map((buildStatus, i) => ({
      name: `app-s${i}`,
      composeServiceName: `s${i}`,
      buildStatus
    }))
  };
}

test('a failed build fails the stack and names the service', () => {
  const result = stackWithBuildState(stack('active', 'failed', 'succeeded'));
  assert.equal(result.status, 'failed');
  assert.equal(result.buildStatus, 'failed');
  assert.match(result.lastError!, /s0/);
});

test('a stack stops building once its builds finish', () => {
  const result = stackWithBuildState(stack('active', 'succeeded', 'none'));
  assert.equal(result.status, 'active');
  assert.equal(result.buildStatus, 'succeeded');
  assert.equal(result.lastError, null);
});

test('a build in progress keeps the stack building, and a retry clears the failure', () => {
  const retried = stackWithBuildState(stack('active', 'building', 'succeeded'));
  assert.equal(retried.status, 'active');
  assert.equal(retried.buildStatus, 'building');
});

test('a stack with only images has no build state', () => {
  assert.equal(stackWithBuildState(stack('active', 'none')).buildStatus, 'none');
});

test('a stack in the middle of something keeps saying so', () => {
  const result = stackWithBuildState(stack('deleting', 'failed'));
  assert.equal(result.status, 'deleting');
  assert.equal(result.lastError, null);
});
