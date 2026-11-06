import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SignJWT } from 'jose';

process.env.JWT_SECRET = 'protection-binding-test-secret';
process.env.FRONTEND_URL = 'https://orchard.test';

// oxlint-disable-next-line import/first
import { ProtectionService } from '../src/auth/protection.service';
// oxlint-disable-next-line import/first
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

const ING = 'aaaaaaaa-0000-0000-0000-000000000001';
const HOST = 'private.example.test';
const HASH_A = '$2b$10$originalhashoriginalhashoriginalhashoriginalhashorigin';
const HASH_B = '$2b$10$rotatedhashrotatedhashrotatedhashrotatedhashrotatedhas';

function build(initial: Record<string, unknown>, access: { canView: boolean } | null) {
  const state = { row: initial, access, accessCalls: 0 };
  const svc = Object.create(ProtectionService.prototype) as any;
  svc.jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET);
  svc.frontendUrl = 'https://orchard.test';
  svc.ingressCache = new Map();
  svc.negativeCache = new Map();
  svc.basicAuthFailures = new Map();
  svc.userAccessCache = new Map();
  svc.throttle = {
    available: false,
    retryAfter: async () => null,
    hit: async () => false,
    clear: async () => false
  };
  svc.crypto = new SecretCryptoService();
  svc.prisma = {
    ingress: {
      findMany: async () => [state.row],
      findUnique: async () => state.row
    }
  };
  svc.authz = {
    resolveProjectAccess: async () => {
      state.accessCalls += 1;
      return state.access;
    }
  };
  return { svc: svc as ProtectionService, state };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: ING,
    projectId: 'p1',
    namespace: 'ns',
    protectionMode: 'password',
    protectionPasswordHash: HASH_A,
    protectionBypassSecret: null,
    protectionBypassPaths: [],
    host: HOST,
    project: { organizationId: 'o1', name: 'Proj' },
    service: { name: 'app', port: 3000 },
    ...over
  };
}

const orchardRow = () => row({ protectionMode: 'orchard', protectionPasswordHash: null });
const withCookie = (jwt: string) => `_orchard_protection=${jwt}`;

async function exchangeToCookie(svc: ProtectionService, subject: string) {
  const token = await svc.generateExchangeToken(ING, subject);
  const decision = await svc.checkProtection(
    HOST,
    `/x?__orchard_token=${encodeURIComponent(token)}`,
    undefined,
    undefined
  );
  assert.equal(decision.status, 302);
  const set = decision.headers?.['set-cookie'];
  assert.ok(set, 'exchange must set a cookie');
  return /^_orchard_protection=([^;]+)/.exec(set)![1];
}

test('a password cookie stops working after the password is rotated', async () => {
  const { svc, state } = build(row(), null);
  const jwt = await exchangeToCookie(svc, 'password');
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, true);

  state.row = row({ protectionPasswordHash: HASH_B });
  (svc as any).ingressCache.clear();
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, false);
});

test('a cookie stops working when the protection mode changes', async () => {
  const { svc, state } = build(row(), { canView: true });
  const jwt = await exchangeToCookie(svc, 'password');
  state.row = row({ protectionMode: 'orchard' });
  (svc as any).ingressCache.clear();
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, false);
});

test('a password-subject cookie never opens an orchard-mode host', async () => {
  const { svc } = build(orchardRow(), { canView: true });
  const jwt = await svc.generateProtectionCookie(
    { id: ING, protectionMode: 'orchard', protectionPasswordHash: null },
    'password'
  );
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, false);
});

test('a cookie without a generation claim is rejected', async () => {
  const { svc } = build(row(), null);
  const legacy = await new SignJWT({ type: 'protection', ingressId: ING })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('password')
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(legacy), undefined)).allow, false);
});

test('an exchange token minted before a rotation cannot mint a cookie after it', async () => {
  const { svc, state } = build(row(), null);
  const token = await svc.generateExchangeToken(ING, 'password');
  state.row = row({ protectionPasswordHash: HASH_B });
  (svc as any).ingressCache.clear();
  const decision = await svc.checkProtection(
    HOST,
    `/x?__orchard_token=${encodeURIComponent(token)}`,
    undefined,
    undefined
  );
  assert.equal(decision.headers?.['set-cookie'], undefined);
});

test('a user cookie stops working once the user loses project access', async () => {
  const { svc, state } = build(orchardRow(), { canView: true });
  const jwt = await exchangeToCookie(svc, 'user-1');
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, true);

  state.access = null;
  (svc as any).userAccessCache.clear();
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, false);
});

test('membership checks are cached so a request does not cost a lookup', async () => {
  const { svc, state } = build(orchardRow(), { canView: true });
  const jwt = await exchangeToCookie(svc, 'user-1');
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, true);
  }
  assert.equal(state.accessCalls, 1);
});

test('a failing membership lookup denies', async () => {
  const { svc } = build(orchardRow(), { canView: true });
  const jwt = await exchangeToCookie(svc, 'user-1');
  (svc as any).userAccessCache.clear();
  (svc as any).authz.resolveProjectAccess = async () => {
    throw new Error('db down');
  };
  assert.equal((await svc.checkProtection(HOST, '/', withCookie(jwt), undefined)).allow, false);
});

function upgradeRequest(cookie: string) {
  const socket = Object.assign(new EventEmitter(), {
    written: '',
    write(chunk: string) {
      this.written += chunk;
      return true;
    },
    destroy() {},
    pipe() {}
  });
  const req: any = {
    method: 'GET',
    url: '/ws',
    headers: { host: HOST, cookie },
    rawHeaders: ['Host', HOST],
    socket: { remoteAddress: '203.0.113.9' }
  };
  return { req, socket };
}

test('websocket upgrades honour password rotation and revoked access', async () => {
  const pw = build(row(), null);
  const pwJwt = await exchangeToCookie(pw.svc, 'password');
  pw.state.row = row({ protectionPasswordHash: HASH_B });
  (pw.svc as any).ingressCache.clear();
  const a = upgradeRequest(withCookie(pwJwt));
  await pw.svc.handleUpgrade(a.req, a.socket as any, Buffer.alloc(0));
  assert.match(a.socket.written, /401 Unauthorized/);

  const user = build(orchardRow(), { canView: false });
  const jwt = await user.svc.generateProtectionCookie(
    { id: ING, protectionMode: 'orchard', protectionPasswordHash: null },
    'user-1'
  );
  const b = upgradeRequest(withCookie(jwt));
  await user.svc.handleUpgrade(b.req, b.socket as any, Buffer.alloc(0));
  assert.match(b.socket.written, /401 Unauthorized/);
});
