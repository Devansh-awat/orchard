import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import {
  canonicalRegistryHost,
  imageRepoFilters,
  isLoopbackHost,
  parseImageRef,
  sameRegistryHost
} from '../src/projects/image-ref';
import {
  assertImageOwnedByProject,
  platformImageRepo,
  splitRegistryCleanup
} from '../src/projects/image-ownership';

test('image references split into host, repository, tag and digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(parseImageRef('registry.example/orchard/acme-web:v1'), {
    host: 'registry.example',
    repository: 'orchard/acme-web',
    tag: 'v1',
    digest: null
  });
  assert.deepEqual(parseImageRef('registry.example:5000/orchard/acme-web'), {
    host: 'registry.example:5000',
    repository: 'orchard/acme-web',
    tag: null,
    digest: null
  });
  assert.deepEqual(parseImageRef(`registry.example/orchard/acme-web@${digest}`), {
    host: 'registry.example',
    repository: 'orchard/acme-web',
    tag: null,
    digest
  });
  assert.deepEqual(parseImageRef(`Registry.Example/orchard/acme-web:v1@${digest}`), {
    host: 'registry.example',
    repository: 'orchard/acme-web',
    tag: 'v1',
    digest
  });
  assert.deepEqual(parseImageRef('redis:8-alpine'), {
    host: null,
    repository: 'redis',
    tag: '8-alpine',
    digest: null
  });
  assert.equal(parseImageRef('user@registry.example/orchard/x:v1'), null);
  assert.equal(parseImageRef('registry.example/orchard/../x:v1'), null);
  assert.equal(parseImageRef('registry.example/Orchard/x'), null);
  assert.equal(parseImageRef('registry.example\\orchard/x'), null);
});

test('registry hosts compare by canonical form', () => {
  for (const spelling of [
    'registry.example',
    'REGISTRY.example',
    'registry.example.',
    'registry.example:443',
    'registry.example:0443',
    'registry.example:80'
  ]) {
    assert.ok(sameRegistryHost(spelling, 'registry.example'), spelling);
  }
  assert.ok(!sameRegistryHost('registry.example:5000', 'registry.example'));
  assert.ok(!sameRegistryHost('registry.example.evil', 'registry.example'));
  assert.equal(canonicalRegistryHost('user@registry.example'), null);
});

test('loopback spellings are all recognised', () => {
  for (const host of [
    'localhost',
    'LOCALHOST.',
    'localhost:5000',
    '127.0.0.1',
    '127.1',
    '2130706433',
    '0x7f.1',
    '0177.0.0.1',
    '127.0.0.1.',
    '0.0.0.0',
    '[::1]:5000',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    'sub.localhost'
  ]) {
    assert.ok(isLoopbackHost(host), host);
  }
  for (const host of ['registry.example', '8.8.8.8', '[2001:db8::1]', '128.0.0.1']) {
    assert.ok(!isLoopbackHost(host), host);
  }
});

const mine = { id: 'p1', namespace: 'acme-a' };
const prismaWith = (taken: (where: any) => boolean = () => false) =>
  ({
    project: { findMany: async () => [] },
    environment: { findMany: async () => [] },
    deployment: {
      findFirst: async (args: any) => (taken(args.where) ? { id: 'other' } : null)
    }
  }) as any;

test('tag-less and digest references hit the same ownership checks as tagged ones', async () => {
  process.env.DOCKER_REGISTRY_PULL = 'registry.example';
  const digest = `sha256:${'b'.repeat(64)}`;
  for (const image of [
    'registry.example/orchard/other-web',
    `registry.example/orchard/other-web@${digest}`,
    'registry.example/orchard/other-web:v1'
  ]) {
    await assert.rejects(
      () => assertImageOwnedByProject(prismaWith(), image, mine),
      ForbiddenException,
      image
    );
  }
  for (const image of [
    'registry.example/orchard/acme-a-web',
    `registry.example/orchard/acme-a-web@${digest}`
  ]) {
    await assertImageOwnedByProject(prismaWith(), image, mine);
    assert.equal(platformImageRepo(image), 'acme-a-web');
  }
  await assert.rejects(
    () =>
      assertImageOwnedByProject(
        prismaWith((where) => where.OR.some((c: any) => c.image.endsWith === '/acme-a-web')),
        'registry.example/orchard/acme-a-web',
        mine
      ),
    ForbiddenException
  );
});

test('repo claims look for tag-less and digest images in other projects', () => {
  assert.deepEqual(imageRepoFilters('acme-a-web'), [
    { contains: '/acme-a-web:' },
    { contains: '/acme-a-web@' },
    { endsWith: '/acme-a-web' }
  ]);
});

test('alternate host spellings of the platform registry are held to the platform rules', async () => {
  process.env.DOCKER_REGISTRY_PULL = 'registry.example';
  for (const image of [
    'registry.example./orchard/other-web:v1',
    'REGISTRY.EXAMPLE/orchard/other-web:v1',
    'registry.example:443/orchard/other-web:v1',
    '127.1:5000/orchard/other-web:v1',
    '2130706433:5000/orchard/other-web:v1',
    '[::ffff:127.0.0.1]:5000/orchard/other-web:v1',
    'localhost./orchard/other-web:v1',
    'user@registry.example/orchard/acme-a-web:v1'
  ]) {
    await assert.rejects(
      () => assertImageOwnedByProject(prismaWith(), image, mine),
      ForbiddenException,
      image
    );
  }
});

test('public registry images keep working', async () => {
  process.env.DOCKER_REGISTRY_PULL = 'registry.example';
  for (const image of [
    'redis:8-alpine',
    'docker.io/library/redis:7',
    'ghcr.io/example/app',
    'quay.io/example/app@sha256:' + 'c'.repeat(64)
  ]) {
    await assertImageOwnedByProject(prismaWith(), image, mine);
  }
});

test('registry cleanup sees digest references and refuses repos outside the owner prefix', async () => {
  const seen: any[] = [];
  const prisma = {
    deployment: {
      findFirst: async (args: any) => {
        seen.push(args.where);
        return null;
      }
    }
  } as any;
  const digest = `sha256:${'d'.repeat(64)}`;
  const result = await splitRegistryCleanup(
    prisma,
    'dep',
    [
      `r.example/orchard/acme-a-web@${digest}`,
      'r.example/orchard/acme-a-api',
      'r.example/orchard/victim-web:v1'
    ],
    'acme-a'
  );
  assert.deepEqual(result.repositories, [
    `r.example/orchard/acme-a-web@${digest}`,
    'r.example/orchard/acme-a-api'
  ]);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].OR.some((c: any) => c.image?.contains === '/acme-a-web@'));
  assert.ok(
    seen[0].OR.some((c: any) => c.imageHistory?.some?.OR.some((i: any) => i.image.endsWith))
  );
});
