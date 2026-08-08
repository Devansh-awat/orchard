import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

process.env.JWT_SECRET = 'protection-auth-test-secret';
process.env.FRONTEND_URL = 'https://orchard.test';

// eslint-disable-next-line import-x/first
import { ProtectionService } from '../src/auth/protection.service';

// Everything a user's private app is worth sits behind checkProtection. These
// are the invariants that must not regress: a request without proof of identity
// never reaches the upstream, and proof issued for one site is worthless on
// another.

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const ING = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';
const HOST = 'private.example.test';

function buildService(row: Record<string, unknown> | null) {
  const svc = Object.create(ProtectionService.prototype) as any;
  svc.jwtSecret = SECRET;
  svc.frontendUrl = 'https://orchard.test';
  svc.ingressCache = new Map();
  svc.negativeCache = new Map();
  svc.prisma = { ingress: { findFirst: async () => row, findUnique: async () => row } };
  svc.authz = { resolveProjectAccess: async () => ({ canView: true }) };
  return svc as ProtectionService;
}

function protectedRow(over: Record<string, unknown> = {}) {
  return {
    id: ING,
    projectId: 'p1',
    namespace: 'ns',
    protectionMode: 'orchard',
    protectionPasswordHash: null,
    protectionBypassSecret: null,
    host: HOST,
    project: { organizationId: 'o1', name: 'Proj' },
    service: { name: 'app', port: 3000 },
    ...over,
  };
}

async function sign(type: string, ingressId: string, opts: { exp?: string; secret?: Uint8Array } = {}) {
  return new SignJWT({ type, ingressId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '7d')
    .sign(opts.secret ?? SECRET);
}

const cookie = (jwt: string) => `_orchard_protection=${jwt}`;

test('no credentials never reaches the app', async () => {
  const svc = buildService(protectedRow());
  const d = await svc.checkProtection(HOST, '/secret', undefined, undefined);
  assert.equal(d.allow, false);
  assert.equal(d.status, 302);
  assert.match(d.headers!.location, /^https:\/\/orchard\.test\/auth\/protect\?/);
});

test('a valid cookie for this ingress is allowed', async () => {
  const svc = buildService(protectedRow());
  const d = await svc.checkProtection(HOST, '/secret', cookie(await sign('protection', ING)), undefined);
  assert.equal(d.allow, true);
});

test('a cookie minted for a DIFFERENT ingress is rejected', async () => {
  // Otherwise one protected site becomes a skeleton key for every other one.
  const svc = buildService(protectedRow());
  const d = await svc.checkProtection(HOST, '/secret', cookie(await sign('protection', OTHER)), undefined);
  assert.equal(d.allow, false);
});

test('a cookie signed with a different secret is rejected', async () => {
  const svc = buildService(protectedRow());
  const forged = await sign('protection', ING, { secret: new TextEncoder().encode('not-the-secret') });
  const d = await svc.checkProtection(HOST, '/secret', cookie(forged), undefined);
  assert.equal(d.allow, false);
});

test('an expired cookie is rejected', async () => {
  const svc = buildService(protectedRow());
  const expired = await sign('protection', ING, { exp: '-1s' });
  const d = await svc.checkProtection(HOST, '/secret', cookie(expired), undefined);
  assert.equal(d.allow, false);
});

test('a short-lived exchange token cannot be replayed as a session cookie', async () => {
  // The exchange token is handed out in a URL and lives 5 minutes; the session
  // cookie lives 7 days. Confusing the two would upgrade a link into a session.
  const svc = buildService(protectedRow());
  const d = await svc.checkProtection(HOST, '/secret', cookie(await sign('protection_exchange', ING)), undefined);
  assert.equal(d.allow, false);
});

test('garbage in the cookie is rejected, not thrown', async () => {
  const svc = buildService(protectedRow());
  for (const junk of ['', 'not-a-jwt', 'a.b.c', '...']) {
    const d = await svc.checkProtection(HOST, '/secret', cookie(junk), undefined);
    assert.equal(d.allow, false, `cookie ${JSON.stringify(junk)} must not allow`);
  }
});

test('a valid exchange token sets a cookie and redirects, it does not allow the request', async () => {
  const svc = buildService(protectedRow());
  const token = await sign('protection_exchange', ING);
  const d = await svc.checkProtection(HOST, `/secret?__orchard_token=${encodeURIComponent(token)}`, undefined, undefined);
  assert.equal(d.allow, false);
  assert.equal(d.status, 302);
  assert.match(d.headers!['set-cookie'], /^_orchard_protection=/);
  assert.match(d.headers!['set-cookie'], /HttpOnly/);
  assert.match(d.headers!['set-cookie'], /Secure/);
  assert.match(d.headers!['set-cookie'], /SameSite=Lax/);
  assert.equal(d.headers!.location, `https://${HOST}/secret`);
});

test('an exchange token for another ingress issues no cookie', async () => {
  const svc = buildService(protectedRow());
  const token = await sign('protection_exchange', OTHER);
  const d = await svc.checkProtection(HOST, `/x?__orchard_token=${encodeURIComponent(token)}`, undefined, undefined);
  assert.equal(d.allow, false);
  assert.equal(d.headers?.['set-cookie'], undefined);
});

test('the bypass secret allows only on an exact match', async () => {
  const svc = buildService(protectedRow({ protectionBypassSecret: 'super-secret-value' }));
  assert.equal((await svc.checkProtection(HOST, '/', undefined, 'super-secret-value')).allow, true);
  for (const wrong of ['super-secret-valuE', 'super-secret-valu', 'super-secret-value ', 'x']) {
    assert.equal(
      (await svc.checkProtection(HOST, '/', undefined, wrong)).allow,
      false,
      `bypass ${JSON.stringify(wrong)} must not allow`,
    );
  }
});

test('a bypass header cannot open an ingress that has no bypass secret', async () => {
  const svc = buildService(protectedRow({ protectionBypassSecret: null }));
  for (const header of ['', 'anything', 'null', 'undefined']) {
    assert.equal((await svc.checkProtection(HOST, '/', undefined, header)).allow, false);
  }
});

test('password mode sends the user to the password form', async () => {
  const svc = buildService(protectedRow({ protectionMode: 'password', protectionPasswordHash: '$2b$10$x' }));
  const d = await svc.checkProtection(HOST, '/', undefined, undefined);
  assert.equal(d.allow, false);
  assert.match(d.headers!.location, /mode=password/);
});

test('verifyPassword refuses when the ingress is not password mode or has no hash', async () => {
  const bcrypt = await import('bcrypt');
  const hash = await bcrypt.hash('hunter2', 4);

  const ok = buildService({ protectionMode: 'password', protectionPasswordHash: hash });
  assert.equal(await ok.verifyPassword(ING, 'hunter2'), true);
  assert.equal(await ok.verifyPassword(ING, 'wrong'), false);

  const wrongMode = buildService({ protectionMode: 'orchard', protectionPasswordHash: hash });
  assert.equal(await wrongMode.verifyPassword(ING, 'hunter2'), false);

  const noHash = buildService({ protectionMode: 'password', protectionPasswordHash: null });
  assert.equal(await noHash.verifyPassword(ING, 'hunter2'), false);

  const missing = buildService(null);
  assert.equal(await missing.verifyPassword(ING, 'hunter2'), false);
});

test('returnTo may not leave the ingress host', async () => {
  const svc = buildService({ host: HOST });
  await svc.validateReturnTo(ING, `https://${HOST}/deep/link?a=1`);
  for (const evil of [
    'https://evil.test/',
    `https://${HOST}.evil.test/`,
    `https://evil.test/?x=${HOST}`,
    // eslint-disable-next-line no-script-url
    'javascript:alert(1)',
    '//evil.test',
  ]) {
    await assert.rejects(
      () => svc.validateReturnTo(ING, evil),
      `returnTo ${evil} must be rejected`,
    );
  }
});

test('checkUserAccess follows project access and denies when the ingress is gone', async () => {
  const allowed = buildService({ projectId: 'p1', project: { organizationId: 'o1' } });
  assert.equal(await allowed.checkUserAccess(ING, 'u1'), true);

  const denied = buildService({ projectId: 'p1', project: { organizationId: 'o1' } });
  (denied as any).authz = { resolveProjectAccess: async () => ({ canView: false }) };
  assert.equal(await denied.checkUserAccess(ING, 'u1'), false);

  const noAccess = buildService({ projectId: 'p1', project: { organizationId: 'o1' } });
  (noAccess as any).authz = { resolveProjectAccess: async () => null };
  assert.equal(await noAccess.checkUserAccess(ING, 'u1'), false);

  const gone = buildService(null);
  assert.equal(await gone.checkUserAccess(ING, 'u1'), false);
});

test('getIngressInfo never reveals an unprotected ingress', async () => {
  const svc = buildService({ host: HOST, protectionMode: 'none', project: { name: 'Proj' } });
  assert.equal(await svc.getIngressInfo(ING), null);
});

test('handleProxyRequest does not serve the upstream for an unknown host', async () => {
  // resolveIngressFromHost returning null must mean "not ours", never "let it
  // through". checkProtection's own null branch is fail-open, so the guard here
  // is what keeps an unknown host from reaching an app.
  const svc = buildService(null);
  let proxied = false;
  (svc as any).proxyToUpstream = async () => { proxied = true; };
  const res: any = { status: () => res, send: () => res, setHeader: () => {} };
  const handled = await svc.handleProxyRequest({ hostname: 'nope.test', headers: {}, url: '/' } as any, res);
  assert.equal(handled, false);
  assert.equal(proxied, false);
});

test('a protected host is never proxied upstream without a decision', async () => {
  const svc = buildService(protectedRow());
  let proxied = false;
  (svc as any).proxyToUpstream = async () => { proxied = true; };
  const sent: any = {};
  const res: any = {
    status(s: number) { sent.status = s; return res; },
    send() { return res; },
    setHeader(k: string, v: string) { (sent.headers ??= {})[k] = v; },
  };
  const handled = await svc.handleProxyRequest(
    { hostname: HOST, headers: {}, url: '/secret', originalUrl: '/secret' } as any,
    res,
  );
  assert.equal(handled, true);
  assert.equal(proxied, false, 'an unauthenticated request must never reach the upstream');
  assert.equal(sent.status, 302);
});

test('a protected host with a valid cookie is proxied upstream', async () => {
  const svc = buildService(protectedRow());
  let target: string | null = null;
  (svc as any).proxyToUpstream = async (_r: unknown, _s: unknown, hostname: string, port: number) => {
    target = `${hostname}:${port}`;
  };
  const res: any = { status: () => res, send: () => res, setHeader: () => {} };
  const handled = await svc.handleProxyRequest(
    {
      hostname: HOST,
      headers: { cookie: cookie(await sign('protection', ING)) },
      url: '/secret',
      originalUrl: '/secret',
    } as any,
    res,
  );
  assert.equal(handled, true);
  assert.equal(target, 'app.ns.svc.cluster.local:3000');
});

test('TRIPWIRE: checkProtection fails OPEN for an unknown host', async () => {
  // Documenting this deliberately rather than asserting it is fine.
  //
  // checkProtection returns allow for a host it cannot resolve. Today nothing
  // reaches it that way: handleProxyRequest bails before calling it, and the
  // only other caller is GET /apiv1/auth/protect/check, which nothing uses —
  // no ingress carries an auth-url annotation and no infra references it.
  //
  // If that endpoint is ever wired up as an auth subrequest, an unresolvable
  // host becomes a bypass. Change this test the day you change that.
  const svc = buildService(null);
  const d = await svc.checkProtection('unknown.example.test', '/', undefined, undefined);
  assert.equal(d.allow, true, 'if this now denies, the fail-open was fixed — update the comment above');
});
