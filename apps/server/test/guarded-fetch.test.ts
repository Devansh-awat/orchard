import { test, mock } from 'node:test';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  guardedFetch,
  guardedLookup,
  ResponseTooLargeError,
  setGuardedFetchTransport
} from '../src/notifications/webhook-guard';
import { IDP_MAX_BODY_BYTES, SsoService } from '../src/sso/sso.service';

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

async function withServer(
  handler: Parameters<typeof createServer>[1],
  run: (url: string) => Promise<void>
) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}/`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('maxBodyBytes lets a body under the cap through untouched', async () => {
  await withServer(
    (_req, res) => res.end('x'.repeat(100)),
    async (url) => {
      const res = await guardedFetch(url, { allowPrivate: true, maxBodyBytes: 1000 });
      assert.equal((await res.text()).length, 100);
    }
  );
});

test('maxBodyBytes refuses a declared content-length over the cap before reading', async () => {
  await withServer(
    (_req, res) => res.end('x'.repeat(2000)),
    async (url) => {
      await assert.rejects(
        guardedFetch(url, { allowPrivate: true, maxBodyBytes: 1000 }),
        ResponseTooLargeError
      );
    }
  );
});

test('maxBodyBytes aborts a chunked body that never declares a length and keeps going', async () => {
  let socketClosed = false;
  await withServer(
    (req, res) => {
      req.socket.on('close', () => {
        socketClosed = true;
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => res.write('x'.repeat(512)), 1);
      res.on('close', () => clearInterval(timer));
    },
    async (url) => {
      const res = await guardedFetch(url, { allowPrivate: true, maxBodyBytes: 4096 });
      assert.equal(res.headers.get('content-length'), null);
      await assert.rejects(res.text(), ResponseTooLargeError);
      for (let i = 0; i < 50 && !socketClosed; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(socketClosed, 'the connection is torn down instead of draining the endless body');
    }
  );
});

test('every identity provider fetch is capped at IDP_MAX_BODY_BYTES', async () => {
  const previous = process.env.SSO_ALLOW_INTERNAL_IDP;
  process.env.SSO_ALLOW_INTERNAL_IDP = 'true';
  const sso = Object.create(SsoService.prototype) as SsoService;
  try {
    await withServer(
      (req, res) => {
        const big = req.url?.startsWith('/big');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          big ? JSON.stringify({ keys: [], pad: 'x'.repeat(IDP_MAX_BODY_BYTES) }) : '{"keys":[]}'
        );
      },
      async (url) => {
        const ok = await sso.fetchIdp(url, {}, null);
        assert.deepEqual(await ok.json(), { keys: [] });
        const big = await sso.fetchIdp(`${url}big`, {}, null);
        await assert.rejects(big.json(), ResponseTooLargeError);
      }
    );
  } finally {
    if (previous === undefined) delete process.env.SSO_ALLOW_INTERNAL_IDP;
    else process.env.SSO_ALLOW_INTERNAL_IDP = previous;
  }
});

test('a rebound name is refused at connect time even when global fetch has been wrapped', async () => {
  const server = createServer((_req, res) => res.end('leak'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const original = globalThis.fetch;
  let wrappedCalls = 0;
  globalThis.fetch = ((input: any, init: any) => {
    wrappedCalls++;
    return original(input, init);
  }) as typeof fetch;
  const saveTime = mock.method(dnsPromises, 'lookup', async () => [
    { address: '93.184.216.34', family: 4 }
  ]);
  const connectTime = mock.method(dns, 'lookup', (_host: string, _opts: any, cb: any) =>
    cb(null, [{ address: '127.0.0.1', family: 4 }])
  );
  try {
    await assert.rejects(guardedFetch(`http://rebind.example.com:${port}/`), (e: any) =>
      /EBLOCKED|non-public/.test(String(e?.cause?.code ?? e?.cause?.message ?? e))
    );
    assert.equal(wrappedCalls, 0);
  } finally {
    globalThis.fetch = original;
    saveTime.mock.restore();
    connectTime.mock.restore();
    server.close();
  }
});

test('the transport seam replaces the network for tests without touching the url checks', async () => {
  const seen: string[] = [];
  setGuardedFetchTransport(async (url) => {
    seen.push(url.href);
    return new Response('stubbed');
  });
  try {
    const res = await guardedFetch('https://93.184.216.34/x');
    assert.equal(await res.text(), 'stubbed');
    assert.deepEqual(seen, ['https://93.184.216.34/x']);
    await assert.rejects(guardedFetch('http://127.0.0.1:8080/'), /public/);
    assert.equal(seen.length, 1);
  } finally {
    setGuardedFetchTransport(null);
  }
});
