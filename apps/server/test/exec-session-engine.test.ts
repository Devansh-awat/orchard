import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { PassThrough } from 'stream';
import WebSocket from 'ws';

process.env.JWT_SECRET = 'exec-engine-test-secret';
delete process.env.REDIS_URL;
delete process.env.POD_IP;

import { ExecSessionEngine, type ExecRouteHooks } from '../src/kubernetes/exec-session-engine';
import { sessions, sessionsByUser, type ExtensionExecTarget } from '../src/kubernetes/exec-sessions';
import type { PtyHandle } from '../src/kubernetes/pty';

const SANDBOX = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';

function echoPty(opened: string[], resized: Array<[number, number]>): PtyHandle {
  const stdin = new PassThrough();
  const output = new PassThrough();
  let resolveExit!: (v: { ok: boolean; message: string | null }) => void;
  const exited = new Promise<{ ok: boolean; message: string | null }>((r) => (resolveExit = r));
  stdin.on('data', (chunk: Buffer) => output.write(chunk));
  opened.push('open');
  return {
    stdin,
    output,
    resize: (cols, rows) => resized.push([cols, rows]),
    pause: () => output.pause(),
    resume: () => output.resume(),
    close: () => resolveExit({ ok: true, message: null }),
    exited
  };
}

interface Frame {
  json?: any;
  bytes?: string;
}

function connect(
  url: string
): Promise<{ ws: WebSocket; frames: Frame[]; next: () => Promise<Frame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: Frame[] = [];
    const waiters: Array<(f: Frame) => void> = [];
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const frame: Frame = isBinary
        ? { bytes: data.toString('utf8') }
        : { json: JSON.parse(data.toString()) };
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    ws.on('open', () =>
      resolve({
        ws,
        frames,
        next: () =>
          frames.length
            ? Promise.resolve(frames.shift()!)
            : new Promise<Frame>((r) => waiters.push(r))
      })
    );
    ws.on('error', reject);
  });
}

async function setup() {
  const server = http.createServer();
  const opened: string[] = [];
  const resized: Array<[number, number]> = [];
  const commands: string[] = [];
  const engine = new ExecSessionEngine(server, {
    prisma: {} as any,
    sessions: {} as any,
    jwtSecret: new TextEncoder().encode('exec-engine-test-secret')
  });
  const hooks: ExecRouteHooks = {
    route: /^\/apiv1\/sandboxes\/([0-9a-f-]{36})\/terminal$/,
    authenticate: async () => ({
      userId: 'user-1',
      actorEmail: null,
      browserSessionId: undefined,
      sessionOrgScope: undefined,
      tokenAuthCtx: null,
      isProxyHop: false
    }),
    async resolveTarget(match, url) {
      const index = url.searchParams.get('n') || '0';
      const target: ExtensionExecTarget = {
        kind: 'sandbox',
        key: `sandbox:${match[1]}/-/${index}/rw`,
        sandboxId: match[1],
        index
      };
      return { target, recheckAuth: async () => true, logAudit: () => {} };
    },
    async open(_target, sessionId) {
      commands.push(sessionId);
      return echoPty(opened, resized);
    },
    proxyPath: () => ({ path: '/', params: {} }),
    audit: { open: 'open', reattach: 'reattach', denied: 'denied' }
  };
  engine.register(hooks);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `ws://127.0.0.1:${port}/apiv1/sandboxes/${SANDBOX}/terminal`;
  return { server, base, opened, resized, commands };
}

test('the sandbox route speaks protocol v2 and resumes with a snapshot', async () => {
  const { server, base, opened, resized } = await setup();
  try {
    const first = await connect(`${base}?proto=2&cols=100&rows=30`);
    const attached = (await first.next()).json;
    assert.equal(attached.type, 'attached');
    assert.equal(attached.proto, 2);
    assert.equal(attached.resumed, false);
    assert.equal(attached.reason, 'new');
    assert.deepEqual([attached.cols, attached.rows], [100, 30]);
    first.ws.send(Buffer.from('marker-123'), { binary: true });
    const echoed = await first.next();
    assert.equal(echoed.bytes, 'marker-123');
    first.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(resized.at(-1), [90, 20]);
    first.ws.close();
    await new Promise((r) => setTimeout(r, 50));

    const second = await connect(
      `${base}?proto=2&cols=90&rows=20&session=${encodeURIComponent(attached.handle)}`
    );
    const resumed = (await second.next()).json;
    assert.equal(resumed.type, 'attached');
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.reason, 'resumed');
    assert.equal(resumed.handle, attached.handle);
    assert.match(resumed.snapshot, /marker-123/);
    assert.equal(opened.length, 1);
    second.ws.close();
  } finally {
    for (const s of [...sessions.values()]) s.upstream?.close();
    sessions.clear();
    sessionsByUser.clear();
    server.close();
  }
});

test('a handle presented for a different terminal index gets a fresh shell, not the old one', async () => {
  const { server, base, opened } = await setup();
  try {
    const first = await connect(`${base}?proto=2&n=0`);
    const attached = (await first.next()).json;
    first.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const other = await connect(
      `${base}?proto=2&n=1&session=${encodeURIComponent(attached.handle)}`
    );
    const denied = (await other.next()).json;
    assert.equal(denied.reason, 'denied');
    assert.notEqual(denied.handle, attached.handle);
    assert.equal(opened.length, 2);
    other.ws.close();
  } finally {
    for (const s of [...sessions.values()]) s.upstream?.close();
    sessions.clear();
    sessionsByUser.clear();
    server.close();
  }
});

test('the engine leaves upgrades on preview hosts to the preview proxy', async () => {
  const server = http.createServer();
  const resolved: string[] = [];
  const engine = new ExecSessionEngine(server, {
    prisma: {} as any,
    sessions: {} as any,
    jwtSecret: new TextEncoder().encode('exec-engine-test-secret'),
    skipUpgrade: (req) => String(req.headers.host).endsWith('.preview.test')
  });
  engine.register({
    route: /^\/apiv1\/sandboxes\/([0-9a-f-]{36})\/terminal$/,
    authenticate: async () => {
      resolved.push('auth');
      return { reject: 401, message: 'Unauthorized' };
    },
    async resolveTarget() {
      resolved.push('target');
      return { reject: 404, message: 'Not Found' };
    },
    open: async () => {
      throw new Error('unreachable');
    },
    proxyPath: () => ({ path: '/', params: {} }),
    audit: { open: 'open', reattach: 'reattach', denied: 'denied' }
  });
  const previewHandled: string[] = [];
  server.on('upgrade', (req, socket) => {
    if (!String(req.headers.host).endsWith('.preview.test')) return;
    previewHandled.push(String(req.url));
    socket.end('HTTP/1.1 418 Preview\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const upgrade = (host: string) =>
    new Promise<number>((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: `/apiv1/sandboxes/${SANDBOX}/terminal`,
        headers: {
          host,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
        }
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(-1));
      req.end();
    });
  try {
    assert.equal(await upgrade('3000-3f2d7e6a.preview.test'), 418);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(resolved, [], 'the terminal engine never touched the preview request');
    assert.equal(previewHandled.length, 1);
    await upgrade('orchard.test');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(resolved.includes('auth'), 'normal hosts still reach the engine');
  } finally {
    server.close();
  }
});
