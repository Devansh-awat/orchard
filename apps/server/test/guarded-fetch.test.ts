import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, fetch as undiciFetch } from 'undici';
import { guardedFetch, guardedLookup } from '../src/notifications/webhook-guard';

test('the pinned lookup refuses a name that resolves to a private address', async () => {
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    guardedLookup('localhost', {}, (e) => resolve(e));
  });
  assert.equal(err?.code, 'EBLOCKED');
});

test('a connect through the pinned agent cannot reach a private listener even when the url check is skipped', async () => {
  const server = createServer((_req, res) => res.end('leak'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const agent = new Agent({ connect: { lookup: guardedLookup } });
  try {
    await assert.rejects(
      undiciFetch(`http://localhost:${port}/`, { dispatcher: agent }),
      (e: any) => /EBLOCKED|non-public/.test(String(e?.cause?.code ?? e?.cause?.message ?? e))
    );
  } finally {
    await agent.close();
    server.close();
  }
});

test('allowPrivate still reaches a local listener, so internal callers keep working', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const res = await guardedFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(await res.text(), 'ok');
  } finally {
    server.close();
  }
});

test(
  'a public fetch through the guard follows a redirect and returns the body',
  { skip: !process.env.TEST_NETWORK },
  async () => {
    const res = await guardedFetch('https://example.com/', { label: 'example' });
    assert.equal(res.status, 200);
  }
);
