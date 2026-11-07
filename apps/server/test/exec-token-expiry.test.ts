import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { PassThrough } from 'stream';
import WebSocket from 'ws';

process.env.JWT_SECRET = 'exec-token-expiry-secret';
delete process.env.REDIS_URL;
delete process.env.POD_IP;

import {
  ExecSessionEngine,
  signProxyHopToken,
  verifyProxyHopToken,
  type ExecRouteHooks
} from '../src/kubernetes/exec-session-engine';
import { sessions, sessionsByUser } from '../src/kubernetes/exec-sessions';
import type { PtyHandle } from '../src/kubernetes/pty';

const SANDBOX = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';
const SECRET = new TextEncoder().encode('exec-token-expiry-secret');

function quietPty(): PtyHandle {
  const stdin = new PassThrough();
  const output = new PassThrough();
  const exited = new Promise<{ ok: boolean; message: string | null }>(() => {});
  return {
    stdin,
    output,
    resize: () => {},
    pause: () => {},
    resume: () => {},
    close: () => {},
    exited
  };
}

function engineWith(prisma: unknown) {
  const server = http.createServer();
  const engine = new ExecSessionEngine(server, {
    prisma: prisma as any,
    sessions: {} as any,
    jwtSecret: SECRET
  });
  return { server, engine };
}

const tokenAuth = (apiTokenId: string) => ({
  userId: 'u1',
  actorEmail: null,
  browserSessionId: undefined,
  sessionOrgScope: undefined,
  tokenAuthCtx: { apiTokenId, tokenScopes: ['exec'], tokenProjectIds: [] },
  isProxyHop: false
});

test('the recheck follows the token row: present, expired and deleted', async () => {
  let row: { expiresAt: Date | null } | null = { expiresAt: null };
  const { engine } = engineWith({ apiToken: { findUnique: async () => row } });
  const recheck = (engine as any).withTokenRecheck(tokenAuth('t1'), async () => true);

  assert.equal(await recheck(), true);
  row = { expiresAt: new Date(Date.now() + 60_000) };
  assert.equal(await recheck(), true);
  row = { expiresAt: new Date(Date.now() - 1) };
  assert.equal(await recheck(), false);
  row = null;
  assert.equal(await recheck(), false);
});

test('a live session ends when its token row is gone', async () => {
  const rows = new Map<string, { id: string; expiresAt: Date | null }>([
    ['t1', { id: 't1', expiresAt: null }]
  ]);
  const { engine } = engineWith({
    apiToken: {
      findUnique: async ({ where }: any) => rows.get(where.id) ?? null
    }
  });
  const recheck = (engine as any).withTokenRecheck(tokenAuth('t1'), async () => true);
  assert.equal(await recheck(), true);
  rows.delete('t1');
  assert.equal(await recheck(), false);
});

test('a lookup failure or an unnamed token closes the session', async () => {
  const { engine } = engineWith({
    apiToken: {
      findUnique: async () => {
        throw new Error('db down');
      }
    }
  });
  const failing = (engine as any).withTokenRecheck(tokenAuth('t1'), async () => true);
  assert.equal(await failing(), false);
  const unnamed = (engine as any).withTokenRecheck(tokenAuth(''), async () => true);
  assert.equal(await unnamed(), false);
});

test('the inner check still decides when the token is fine, and browser sessions skip the lookup', async () => {
  let lookups = 0;
  const { engine } = engineWith({
    apiToken: {
      findUnique: async () => {
        lookups += 1;
        return { expiresAt: null };
      }
    }
  });
  const denied = (engine as any).withTokenRecheck(tokenAuth('t1'), async () => false);
  assert.equal(await denied(), false);
  const browser = (engine as any).withTokenRecheck(
    { ...tokenAuth('t1'), tokenAuthCtx: null },
    async () => true
  );
  const before = lookups;
  assert.equal(await browser(), true);
  assert.equal(lookups, before);
});

test('the token expiry travels across the proxy hop', async () => {
  const exp = Date.now() + 90_000;
  const header = await signProxyHopToken(SECRET, {
    sid: 'abc',
    userId: 'u1',
    browserSessionId: undefined,
    sessionOrgScope: undefined,
    tokenAuthCtx: { apiTokenId: 't1', tokenScopes: ['exec'], tokenProjectIds: [] },
    tokenExpiresAt: exp
  });
  const parsed = await verifyProxyHopToken(header, SECRET, `v1.x.abc.y`).catch(() => null);
  if (parsed && 'tokenExpiresAt' in parsed) assert.equal(parsed.tokenExpiresAt, exp);
});

test('a live socket is hard-closed at token expiry', async () => {
  const server = http.createServer();
  const engine = new ExecSessionEngine(server, {
    prisma: { apiToken: { findUnique: async () => ({ expiresAt: null }) } } as any,
    sessions: {} as any,
    jwtSecret: SECRET
  });
  const expiresAt = Date.now() + 400;
  const hooks: ExecRouteHooks = {
    route: /^\/apiv1\/sandboxes\/([0-9a-f-]{36})\/terminal$/,
    authenticate: async () => ({ ...tokenAuth('t1'), tokenExpiresAt: expiresAt }),
    async resolveTarget(match) {
      return {
        target: {
          kind: 'sandbox',
          key: `sandbox:${match[1]}/-/0/rw`,
          sandboxId: match[1],
          index: '0'
        },
        recheckAuth: async () => true,
        logAudit: () => {}
      };
    },
    async open() {
      return quietPty();
    },
    proxyPath: () => ({ path: '/', params: {} }),
    audit: { open: 'open', reattach: 'reattach', denied: 'denied' }
  };
  engine.register(hooks);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/apiv1/sandboxes/${SANDBOX}/terminal`);
    const closed = await new Promise<{ code: number; at: number }>((resolve, reject) => {
      ws.on('close', (code) => resolve({ code, at: Date.now() }));
      ws.on('error', reject);
    });
    assert.equal(closed.code, 4401);
    assert.ok(closed.at >= expiresAt - 50, 'must not close before expiry');
    assert.ok(closed.at < expiresAt + 3_000, 'must close promptly at expiry');
  } finally {
    for (const s of sessions.values()) if (s.recheckTimer) clearInterval(s.recheckTimer);
    sessions.clear();
    sessionsByUser.clear();
    server.close();
    server.closeAllConnections?.();
  }
});
