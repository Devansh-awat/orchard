import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

process.env.JWT_SECRET = 'protection-auth-test-secret';
process.env.FRONTEND_URL = 'https://orchard.test';

// oxlint-disable-next-line import/first
import { ProtectionService } from '../src/auth/protection.service';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

// Everything a user's private app is worth sits behind checkProtection. These
// are the invariants that must not regress: a request without proof of identity
// never reaches the upstream, and proof issued for one site is worthless on
// another.

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const ING = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';
const HOST = 'private.example.test';

// No REDIS_URL under test, so the service takes its per-pod fallback path and
// these exercise the same counters a single-replica instance would use.
function offlineThrottle() {
  return {
    available: false,
    retryAfter: async () => null,
    hit: async () => false,
    clear: async () => false
  };
}

function buildService(row: Record<string, unknown> | null) {
  const svc = Object.create(ProtectionService.prototype) as any;
  svc.jwtSecret = SECRET;
  svc.frontendUrl = 'https://orchard.test';
  svc.ingressCache = new Map();
  svc.negativeCache = new Map();
  svc.basicAuthFailures = new Map();
  svc.throttle = offlineThrottle();
  svc.crypto = new SecretCryptoService();
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
    ...over
  };
}

async function sign(
  type: string,
  ingressId: string,
  opts: { exp?: string; secret?: Uint8Array } = {}
) {
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
  const d = await svc.checkProtection(
    HOST,
    '/secret',
    cookie(await sign('protection', ING)),
    undefined
  );
  assert.equal(d.allow, true);
});

test('a cookie minted for a DIFFERENT ingress is rejected', async () => {
  // Otherwise one protected site becomes a skeleton key for every other one.
  const svc = buildService(protectedRow());
  const d = await svc.checkProtection(
    HOST,
    '/secret',
    cookie(await sign('protection', OTHER)),
    undefined
  );
  assert.equal(d.allow, false);
});

test('a cookie signed with a different secret is rejected', async () => {
  const svc = buildService(protectedRow());
  const forged = await sign('protection', ING, {
    secret: new TextEncoder().encode('not-the-secret')
  });
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
  const d = await svc.checkProtection(
    HOST,
    '/secret',
    cookie(await sign('protection_exchange', ING)),
    undefined
  );
  assert.equal(d.allow, false);
});

test('garbage in the cookie is rejected, not thrown', async () => {
  const svc = buildService(protectedRow());
  for (const junk of ['', 'not-a-jwt', 'a.b.c', '...']) {
    const d = await svc.checkProtection(HOST, '/secret', cookie(junk), undefined);
    assert.equal(d.allow, false, `cookie ${JSON.stringify(junk)} must not allow`);
  }
});

test('redirects preserve the request path and query string', async () => {
  const svc = buildService(
    protectedRow({
      protectionMode: 'none',
      redirectTarget: 'https://example.com',
      redirectStatus: 307
    })
  );
  const headers: Record<string, string> = {};
  let status = 0;
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    status(value: number) {
      status = value;
      return this;
    },
    send() {
      return this;
    }
  };

  const handled = await svc.handleProxyRequest(
    {
      hostname: HOST,
      headers: {},
      originalUrl: '/docs/getting-started?source=www'
    } as any,
    res as any
  );

  assert.equal(handled, true);
  assert.equal(status, 307);
  assert.equal(headers.location, 'https://example.com/docs/getting-started?source=www');
});

test('a valid exchange token sets a cookie and redirects, it does not allow the request', async () => {
  const svc = buildService(protectedRow());
  const token = await sign('protection_exchange', ING);
  const d = await svc.checkProtection(
    HOST,
    `/secret?__orchard_token=${encodeURIComponent(token)}`,
    undefined,
    undefined
  );
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
  const d = await svc.checkProtection(
    HOST,
    `/x?__orchard_token=${encodeURIComponent(token)}`,
    undefined,
    undefined
  );
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
      `bypass ${JSON.stringify(wrong)} must not allow`
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
  const svc = buildService(
    protectedRow({ protectionMode: 'password', protectionPasswordHash: '$2b$10$x' })
  );
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
    // oxlint-disable-next-line no-script-url
    'javascript:alert(1)',
    '//evil.test'
  ]) {
    await assert.rejects(
      () => svc.validateReturnTo(ING, evil),
      `returnTo ${evil} must be rejected`
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
  (svc as any).proxyToUpstream = async () => {
    proxied = true;
  };
  const res: any = { status: () => res, send: () => res, setHeader: () => {} };
  const handled = await svc.handleProxyRequest(
    { hostname: 'nope.test', headers: {}, url: '/' } as any,
    res
  );
  assert.equal(handled, false);
  assert.equal(proxied, false);
});

test('a protected host is never proxied upstream without a decision', async () => {
  const svc = buildService(protectedRow());
  let proxied = false;
  (svc as any).proxyToUpstream = async () => {
    proxied = true;
  };
  const sent: any = {};
  const res: any = {
    status(s: number) {
      sent.status = s;
      return res;
    },
    send() {
      return res;
    },
    setHeader(k: string, v: string) {
      (sent.headers ??= {})[k] = v;
    }
  };
  const handled = await svc.handleProxyRequest(
    { hostname: HOST, headers: {}, url: '/secret', originalUrl: '/secret' } as any,
    res
  );
  assert.equal(handled, true);
  assert.equal(proxied, false, 'an unauthenticated request must never reach the upstream');
  assert.equal(sent.status, 302);
});

test('a protected host with a valid cookie is proxied upstream', async () => {
  const svc = buildService(protectedRow());
  let target: string | null = null;
  (svc as any).proxyToUpstream = async (
    _r: unknown,
    _s: unknown,
    hostname: string,
    port: number
  ) => {
    target = `${hostname}:${port}`;
  };
  const res: any = { status: () => res, send: () => res, setHeader: () => {} };
  const handled = await svc.handleProxyRequest(
    {
      hostname: HOST,
      headers: { cookie: cookie(await sign('protection', ING)) },
      url: '/secret',
      originalUrl: '/secret'
    } as any,
    res
  );
  assert.equal(handled, true);
  assert.equal(target, 'app.ns.svc.cluster.local:3000');
});

test('an unresolvable host is denied, not allowed', async () => {
  // Was fail-open. handleProxyRequest resolves the ingress itself and then
  // calls this, so an allow here proxied to an upstream with nothing checked.
  const svc = buildService(null);
  const d = await svc.checkProtection('unknown.example.test', '/', undefined, undefined);
  assert.equal(d.allow, false);
  assert.equal(d.status, 404);
});

test('a second lookup returning nothing cannot slip past the wall', async () => {
  // handleProxyRequest resolves the ingress and checkProtection resolves it
  // again. In practice the 5s ingressCache serves the second lookup, so the
  // two agree. This pins the behaviour when it does not: a cold or disabled
  // cache, or any future caller reaching checkProtection on its own.
  const svc = buildService(protectedRow());
  let calls = 0;
  (svc as any).prisma = {
    ingress: {
      findFirst: async () => {
        calls += 1;
        return calls === 1 ? protectedRow() : null;
      }
    }
  };
  // A cache that forgets immediately, so both lookups reach the database.
  (svc as any).ingressCache = { get: () => undefined, set: () => {} };
  (svc as any).negativeCache = { get: () => undefined, set: () => {} };

  let proxied = false;
  (svc as any).proxyToUpstream = async () => {
    proxied = true;
  };
  const sent: any = {};
  const res: any = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    send() {
      return res;
    },
    setHeader() {}
  };

  const handled = await svc.handleProxyRequest(
    { hostname: HOST, headers: {}, url: '/secret', originalUrl: '/secret' } as any,
    res
  );
  assert.equal(calls, 2, 'both lookups should have hit the database');
  assert.equal(handled, true);
  assert.equal(proxied, false, 'a request must never reach the upstream unauthenticated');
  assert.equal(sent.status, 404);
});

// Basic auth is the mode that has to work on a cluster with no Cilium, so it
// is enforced here rather than by an Envoy filter. Everything below is what
// stops that fallback from being weaker than the thing it replaces.

const BCRYPT_SECRET = 'hunter2';
// bcrypt hash of 'hunter2', cost 10.
const BCRYPT_HASH = '$2b$10$2/j12Oe/E9WQ3i5zqw32Y.aIW.HTm6KToczjiz4G3E6qVBflXFza6';

function basicRow(over: Record<string, unknown> = {}) {
  return protectedRow({
    protectionMode: 'basic',
    protectionUsername: 'alice',
    protectionPasswordHash: BCRYPT_HASH,
    ...over
  });
}

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

test('basic auth challenges an anonymous request instead of redirecting', async () => {
  const svc = buildService(basicRow());
  const decision = await svc.checkProtection(HOST, '/secret', undefined, undefined, undefined);
  assert.equal(decision.allow, false);
  assert.equal(decision.status, 401, 'must be a challenge, not a 302 to the control plane');
  assert.match(String(decision.headers?.['www-authenticate']), /^Basic realm=/);
  assert.equal(
    decision.headers?.location,
    undefined,
    'basic auth must not bounce to the login page'
  );
});

test('basic auth accepts the right credentials', async () => {
  const svc = buildService(basicRow());
  const decision = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    basicHeader('alice', BCRYPT_SECRET)
  );
  assert.equal(decision.allow, true);
});

test('basic auth rejects a wrong password, a wrong username, and junk', async () => {
  const svc = buildService(basicRow());
  for (const header of [
    basicHeader('alice', 'wrong'),
    basicHeader('mallory', BCRYPT_SECRET),
    'Basic not-base64-at-all!!',
    'Bearer sometoken',
    basicHeader('alice', '')
  ]) {
    const decision = await svc.checkProtection(HOST, '/secret', undefined, undefined, header);
    assert.equal(decision.allow, false, `should have rejected: ${header}`);
    assert.equal(decision.status, 401);
  }
});

test('a password with a colon in it still works', async () => {
  // Only the first colon separates the pair, so the password may contain more.
  const hash = '$2b$10$DbTeC24OQkP3Ysp0LFTApOQ4piHinEiPwR5Bc4TbZYbNxa7OgTQBi';
  const svc = buildService(basicRow({ protectionPasswordHash: hash }));
  const decision = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    basicHeader('alice', 'a:b:c')
  );
  assert.equal(decision.allow, true);
});

test('a basic-auth row that lost its credentials fails closed', async () => {
  for (const broken of [{ protectionUsername: null }, { protectionPasswordHash: null }]) {
    const svc = buildService(basicRow(broken));
    const decision = await svc.checkProtection(
      HOST,
      '/secret',
      undefined,
      undefined,
      basicHeader('alice', BCRYPT_SECRET)
    );
    assert.equal(decision.allow, false, `should fail closed for ${JSON.stringify(broken)}`);
    assert.equal(decision.status, 401);
  }
});

test('a protection cookie does not open a basic-auth host', async () => {
  // The cookie is issued by the Orchard login flow. Basic auth never mints one,
  // so accepting it here would let a cookie from another mode leak across.
  const svc = buildService(basicRow());
  const cookie = await new SignJWT({ type: 'protection', ingressId: ING })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
  const decision = await svc.checkProtection(
    HOST,
    '/secret',
    `_orchard_protection=${cookie}`,
    undefined,
    undefined
  );
  assert.equal(decision.allow, false);
  assert.equal(decision.status, 401);
});

test('bypass paths and the bypass secret still work under basic auth', async () => {
  const svc = buildService(
    basicRow({
      protectionBypassPaths: ['/webhooks'],
      protectionBypassSecret: 'sekrit'
    })
  );
  const viaPath = await svc.checkProtection(
    HOST,
    '/webhooks/github',
    undefined,
    undefined,
    undefined
  );
  assert.equal(viaPath.allow, true);
  const viaSecret = await svc.checkProtection(HOST, '/secret', undefined, 'sekrit', undefined);
  assert.equal(viaSecret.allow, true);
});

test('handleProxyRequest forwards the Authorization header to the check', async () => {
  const svc = buildService(basicRow());
  let proxied = false;
  (svc as any).proxyToUpstream = async () => {
    proxied = true;
  };
  const res: any = {
    status() {
      return res;
    },
    send() {
      return res;
    },
    setHeader() {}
  };

  await svc.handleProxyRequest(
    {
      hostname: HOST,
      headers: { authorization: basicHeader('alice', BCRYPT_SECRET) },
      url: '/secret',
      originalUrl: '/secret'
    } as any,
    res
  );
  assert.equal(
    proxied,
    true,
    'correct credentials on the real request path must reach the upstream'
  );
});

test('basic auth stops answering after repeated wrong credentials', async () => {
  const svc = buildService(basicRow());
  const wrong = basicHeader('alice', 'wrong');

  for (let i = 0; i < 10; i++) {
    const d = await svc.checkProtection(
      HOST,
      '/secret',
      undefined,
      undefined,
      wrong,
      '203.0.113.9'
    );
    assert.equal(d.status, 401, `attempt ${i + 1} should still be a plain challenge`);
  }

  const blocked = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    wrong,
    '203.0.113.9'
  );
  assert.equal(blocked.allow, false);
  assert.equal(blocked.status, 429, 'the eleventh guess must be throttled, not answered');
  assert.ok(Number(blocked.headers?.['retry-after']) > 0);
});

test('the basic auth throttle does not answer the right password either', async () => {
  // Otherwise an attacker learns when they have hit it, which is the one bit
  // the throttle exists to withhold.
  const svc = buildService(basicRow());
  const wrong = basicHeader('alice', 'wrong');
  for (let i = 0; i < 10; i++) {
    await svc.checkProtection(HOST, '/secret', undefined, undefined, wrong, '203.0.113.9');
  }

  const d = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    basicHeader('alice', BCRYPT_SECRET),
    '203.0.113.9'
  );
  assert.equal(d.status, 429);
  assert.equal(d.allow, false);
});

test('one throttled address does not lock out another', async () => {
  const svc = buildService(basicRow());
  const wrong = basicHeader('alice', 'wrong');
  for (let i = 0; i < 12; i++) {
    await svc.checkProtection(HOST, '/secret', undefined, undefined, wrong, '203.0.113.9');
  }

  const other = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    basicHeader('alice', BCRYPT_SECRET),
    '198.51.100.4'
  );
  assert.equal(other.allow, true, 'a different client must be unaffected');
});

test('anonymous challenges are never counted against the throttle', async () => {
  // Every first visit arrives without an Authorization header. If those burned
  // attempts, an ordinary browser would throttle itself off the site.
  const svc = buildService(basicRow());
  for (let i = 0; i < 50; i++) {
    const d = await svc.checkProtection(
      HOST,
      '/secret',
      undefined,
      undefined,
      undefined,
      '203.0.113.9'
    );
    assert.equal(d.status, 401);
  }

  const d = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    basicHeader('alice', BCRYPT_SECRET),
    '203.0.113.9'
  );
  assert.equal(d.allow, true);
});

test('a success clears the failures that came before it', async () => {
  const svc = buildService(basicRow());
  const wrong = basicHeader('alice', 'wrong');
  for (let i = 0; i < 9; i++) {
    await svc.checkProtection(HOST, '/secret', undefined, undefined, wrong, '203.0.113.9');
  }

  const ok = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    basicHeader('alice', BCRYPT_SECRET),
    '203.0.113.9'
  );
  assert.equal(ok.allow, true);

  const after = await svc.checkProtection(
    HOST,
    '/secret',
    undefined,
    undefined,
    wrong,
    '203.0.113.9'
  );
  assert.equal(after.status, 401, 'the counter should have been reset by the success');
});

test('the throttle map does not grow without bound', async () => {
  const svc = buildService(basicRow());
  const wrong = basicHeader('alice', 'wrong');
  const failures = (svc as any).basicAuthFailures as Map<string, unknown>;

  for (let i = 0; i < 10_050; i++) {
    (svc as any).recordBasicAuthFailure(`${ING}:10.0.${Math.floor(i / 256)}.${i % 256}`);
  }
  assert.ok(failures.size <= 10_000, `map grew to ${failures.size}`);

  const d = await svc.checkProtection(HOST, '/secret', undefined, undefined, wrong, '203.0.113.9');
  assert.equal(d.status, 401, 'pruning must not break the normal path');
});

test('sign-in goes back to where the domain is really served', async () => {
  const redirectFor = async (row: Record<string, unknown>) => {
    const svc = buildService(protectedRow(row));
    const d = await svc.checkProtection(HOST, '/secret', undefined, undefined);
    return new URL(d.headers!.location).searchParams.get('returnTo');
  };
  assert.equal(await redirectFor({ tlsSecretName: 'tls' }), `https://${HOST}/secret`);
  assert.equal(
    await redirectFor({ tlsSecretName: null, entrypoints: ['web'] }),
    `http://${HOST}/secret`
  );
  process.env.PUBLIC_HTTPS_PORT = '8443';
  try {
    assert.equal(await redirectFor({ tlsSecretName: 'tls' }), `https://${HOST}:8443/secret`);
  } finally {
    delete process.env.PUBLIC_HTTPS_PORT;
  }
});

test('the protection cookie is only marked Secure on an https domain', async () => {
  const cookieFor = async (row: Record<string, unknown>) => {
    const svc = buildService(protectedRow(row));
    const token = await sign('protection_exchange', 'i1');
    const d = await svc.checkProtection(HOST, `/a?__orchard_token=${token}`, undefined, undefined);
    return d.headers!['set-cookie'];
  };
  assert.match(await cookieFor({ id: 'i1', tlsSecretName: 'tls' }), /; Secure;/);
  assert.doesNotMatch(
    await cookieFor({ id: 'i1', tlsSecretName: null, entrypoints: ['web'] }),
    /Secure/
  );
});
