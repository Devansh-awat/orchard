import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { TemplateEngineService } from '../src/templates/template-engine.service';
import { TemplatesService, registryUrl } from '../src/templates/templates.service';

const ghost = `apiVersion: leaf/v1
kind: Template
metadata:
  name: ghost
  displayName: Ghost Blog
  version: '1.2.0'
  category: cms
  tags: ['blog']
resources:
  - name: app
    type: deployment
    config:
      image: ghost:5
`;

const tampered = ghost.replace('ghost:5', 'ghost:6');

function sha(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function fakeRegistry(files: Record<string, string>) {
  const server = createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (body === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', req.url?.endsWith('.json') ? 'application/json' : 'text/plain');
    res.end(body);
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function fakePrisma(rows: Record<string, { source: string; yaml: string }>) {
  const writes: Array<{ name: string; source: string; version: string }> = [];
  const prisma = {
    template: {
      findUnique: async ({ where }: { where: { name: string } }) => rows[where.name] ?? null,
      upsert: async ({ where, update }: { where: { name: string }; update: any }) => {
        rows[where.name] = { source: update.source, yaml: update.yaml };
        writes.push({ name: where.name, source: update.source, version: update.version });
        return rows[where.name];
      }
    }
  };
  return { prisma, writes };
}

function service(prisma: unknown) {
  return new TemplatesService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    new TemplateEngineService(),
    {} as any,
    {} as any,
    { canCoordinate: true } as any
  );
}

test('registryUrl defaults to the public registry, trims a trailing slash and turns off when blank', () => {
  delete process.env.TEMPLATE_REGISTRY_URL;
  assert.equal(registryUrl(), 'https://assets.orchard.my/registry');
  process.env.TEMPLATE_REGISTRY_URL = 'https://registry.example.com/';
  assert.equal(registryUrl(), 'https://registry.example.com');
  process.env.TEMPLATE_REGISTRY_URL = '   ';
  assert.equal(registryUrl(), null);
});

test('imports catalogue entries whose checksum matches, and leaves custom names alone', async () => {
  const registry = await fakeRegistry({
    '/templates/index.json': JSON.stringify({
      templates: [
        {
          name: 'ghost',
          version: '1.2.0',
          yaml: 'templates/ghost/1.2.0/template.yaml',
          sha256: sha(ghost)
        },
        {
          name: 'redis',
          version: '1.0.0',
          yaml: 'templates/redis/1.0.0/template.yaml',
          sha256: sha(ghost)
        }
      ]
    }),
    '/templates/ghost/1.2.0/template.yaml': ghost,
    '/templates/redis/1.0.0/template.yaml': ghost.replace('name: ghost', 'name: redis')
  });
  process.env.TEMPLATE_REGISTRY_URL = registry.url;
  const { prisma, writes } = fakePrisma({ redis: { source: 'custom', yaml: 'x' } });
  try {
    const result = await service(prisma).syncRegistry();
    assert.deepEqual(result, { synced: 1, skipped: 1 });
    assert.deepEqual(writes, [{ name: 'ghost', source: 'registry', version: '1.2.0' }]);
  } finally {
    registry.close();
  }
});

test('a checksum mismatch is never imported', async () => {
  const registry = await fakeRegistry({
    '/templates/index.json': JSON.stringify({
      templates: [
        {
          name: 'ghost',
          version: '1.2.0',
          yaml: 'templates/ghost/1.2.0/template.yaml',
          sha256: sha(ghost)
        }
      ]
    }),
    '/templates/ghost/1.2.0/template.yaml': tampered
  });
  process.env.TEMPLATE_REGISTRY_URL = registry.url;
  const { prisma, writes } = fakePrisma({});
  try {
    const result = await service(prisma).syncRegistry();
    assert.deepEqual(result, { synced: 0, skipped: 1 });
    assert.equal(writes.length, 0);
  } finally {
    registry.close();
  }
});

test('an unchanged registry template is not rewritten, and a built-in one is taken over', async () => {
  const registry = await fakeRegistry({
    '/templates/index.json': JSON.stringify({
      templates: [
        {
          name: 'ghost',
          version: '1.2.0',
          yaml: 'templates/ghost/1.2.0/template.yaml',
          sha256: sha(ghost)
        }
      ]
    }),
    '/templates/ghost/1.2.0/template.yaml': ghost
  });
  process.env.TEMPLATE_REGISTRY_URL = registry.url;
  try {
    const unchanged = fakePrisma({ ghost: { source: 'registry', yaml: ghost } });
    assert.deepEqual(await service(unchanged.prisma).syncRegistry(), { synced: 0, skipped: 0 });
    assert.equal(unchanged.writes.length, 0);

    const builtIn = fakePrisma({ ghost: { source: 'built-in', yaml: 'older' } });
    assert.deepEqual(await service(builtIn.prisma).syncRegistry(), { synced: 1, skipped: 0 });
    assert.equal(builtIn.writes[0].source, 'registry');
  } finally {
    registry.close();
  }
});

test('an unreachable registry is a warning, not a crash', async () => {
  process.env.TEMPLATE_REGISTRY_URL = 'http://127.0.0.1:1';
  const { prisma, writes } = fakePrisma({});
  assert.deepEqual(await service(prisma).syncRegistry(), { synced: 0, skipped: 0 });
  assert.equal(writes.length, 0);
});
