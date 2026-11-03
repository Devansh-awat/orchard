import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.BUILD_PLATFORM = 'linux/arm64';
process.env.DOCKER_REGISTRY_PULL = 'zot.example.com';
process.env.DOCKER_REGISTRY_PUSH = 'zot.orchard.svc.cluster.local:5000';
process.env.REGISTRY_PROJECT = 'orchard';

let platform: typeof import('../src/docker/build-platform');

before(async () => {
  platform = await import('../src/docker/build-platform');
});

const built = 'zot.example.com/orchard/acme-web:20261013';

test('BUILD_PLATFORM accepts the platform, the bare arch, and uname spellings', () => {
  assert.equal(platform.parseBuildArch(undefined), 'amd64');
  assert.equal(platform.parseBuildArch(''), 'amd64');
  assert.equal(platform.parseBuildArch('linux/amd64'), 'amd64');
  assert.equal(platform.parseBuildArch('x86_64'), 'amd64');
  assert.equal(platform.parseBuildArch('linux/arm64'), 'arm64');
  assert.equal(platform.parseBuildArch(' AARCH64 '), 'arm64');
});

test('an unbuildable BUILD_PLATFORM fails at boot instead of building the wrong thing', () => {
  assert.throws(() => platform.parseBuildArch('linux/riscv64'), /BUILD_PLATFORM/);
  assert.throws(() => platform.parseBuildArch('windows/amd64'), /BUILD_PLATFORM/);
});

test('the configured platform drives the build target and the builder node', () => {
  assert.equal(platform.BUILD_ARCH, 'arm64');
  assert.equal(platform.BUILD_PLATFORM, 'linux/arm64');
  assert.deepEqual(platform.buildArchNodeSelector(), { 'kubernetes.io/arch': 'arm64' });
});

test('only images Orchard pushed to its own registry project count as built here', () => {
  assert.equal(platform.isPlatformBuiltImage(built), true);
  assert.equal(
    platform.isPlatformBuiltImage('zot.orchard.svc.cluster.local:5000/orchard/acme-web:1'),
    true
  );
  assert.equal(platform.isPlatformBuiltImage('zot.example.com/other/acme-web:1'), false);
  assert.equal(platform.isPlatformBuiltImage('ghcr.io/orchard/acme-web:1'), false);
  assert.equal(platform.isPlatformBuiltImage('nginx:latest'), false);
  assert.equal(platform.isPlatformBuiltImage('zot.example.com/orchard'), false);
});

test('a build with no registry configured fails and names what is missing', () => {
  assert.throws(
    () => platform.assertBuildRegistryConfigured({}),
    /DOCKER_REGISTRY_PUSH and DOCKER_REGISTRY_PULL are not set/
  );
  assert.throws(
    () =>
      platform.assertBuildRegistryConfigured({
        DOCKER_REGISTRY_PUSH: 'zot:5000',
        DOCKER_REGISTRY_PULL: ' '
      }),
    /DOCKER_REGISTRY_PULL is not set/
  );
  assert.doesNotThrow(() =>
    platform.assertBuildRegistryConfigured({
      DOCKER_REGISTRY_PUSH: 'zot:5000',
      DOCKER_REGISTRY_PULL: 'zot.example.com'
    })
  );
});

test('third-party images keep whatever placement they had', () => {
  const affinity = {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [{ matchExpressions: [{ key: 'pool', operator: 'In', values: ['a'] }] }]
      }
    }
  };
  assert.equal(platform.pinToBuildArch(affinity, 'nginx:latest'), affinity);
  assert.equal(platform.pinToBuildArch(undefined, 'nginx:latest'), undefined);
});

test('a built image with no placement gets a lone arch requirement', () => {
  assert.deepEqual(platform.pinToBuildArch(undefined, built), {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          { matchExpressions: [{ key: 'kubernetes.io/arch', operator: 'In', values: ['arm64'] }] }
        ]
      }
    }
  });
});

test('the arch requirement is ANDed into every OR term and replaces a conflicting one', () => {
  const pinned = platform.pinToBuildArch(
    {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                { key: 'pool', operator: 'In', values: ['a'] },
                { key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] }
              ]
            },
            { matchExpressions: [{ key: 'pool', operator: 'In', values: ['b'] }] }
          ]
        },
        preferredDuringSchedulingIgnoredDuringExecution: [
          { weight: 100, preference: { matchExpressions: [{ key: 'ssd', operator: 'Exists' }] } }
        ]
      },
      podAntiAffinity: {}
    },
    built
  );
  const arch = { key: 'kubernetes.io/arch', operator: 'In', values: ['arm64'] };
  assert.deepEqual(
    pinned?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms,
    [
      { matchExpressions: [{ key: 'pool', operator: 'In', values: ['a'] }, arch] },
      { matchExpressions: [{ key: 'pool', operator: 'In', values: ['b'] }, arch] }
    ]
  );
  assert.equal(pinned?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution?.length, 1);
  assert.deepEqual(pinned?.podAntiAffinity, {});
});
