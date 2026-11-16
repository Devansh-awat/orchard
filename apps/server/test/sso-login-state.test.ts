import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SignJWT, decodeJwt } from 'jose';
import { SsoController } from '../src/sso/sso.controller';
import { SsoLoginService } from '../src/sso/sso-login.service';
import { OidcStateStore } from '../src/sso/oidc-state.store';
import { IS_PUBLIC_KEY } from '../src/auth/decorators';

const FRONTEND = 'https://app.orchard.test';
process.env.FRONTEND_URL = FRONTEND;

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ORG_OFF = 'cccccccc-0000-4000-8000-000000000003';
const ORG_KILLED = 'dddddddd-0000-4000-8000-000000000004';
const SECRET = new TextEncoder().encode('sso-login-state-test-secret');

const oauth2 = (
  id: string,
  organizationId: string | null,
  extra: Record<string, unknown> = {}
) => ({
  id,
  organizationId,
  protocol: 'oauth2',
  enabled: true,
  clientId: `${id}-client`,
  clientSecret: null,
  scopes: 'email',
  authorizationUrl: `https://idp.${id}.test/authorize`,
  tokenUrl: `https://idp.${id}.test/token`,
  callbackPath: null,
  createdAt: new Date(),
  ...extra
});

function world() {
  const providers = [
    oauth2('prov-a', ORG_A),
    oauth2('prov-b', ORG_B),
    oauth2('prov-off', ORG_OFF),
    oauth2('prov-killed', ORG_KILLED),
    oauth2('prov-disabled', ORG_A, { enabled: false }),
    oauth2('oidc-a', ORG_A, { protocol: 'oidc' }),
    oauth2('oidc-b', ORG_B, { protocol: 'oidc' }),
    oauth2('saml-a', ORG_A, { protocol: 'saml' }),
    oauth2('saml-off', ORG_OFF, { protocol: 'saml' }),
    oauth2('saml-killed', ORG_KILLED, { protocol: 'saml' })
  ];
  const settings: Record<string, { enabled: boolean; platformEnabled: boolean }> = {
    [ORG_A]: { enabled: true, platformEnabled: true },
    [ORG_B]: { enabled: true, platformEnabled: true },
    [ORG_OFF]: { enabled: false, platformEnabled: true },
    [ORG_KILLED]: { enabled: true, platformEnabled: false }
  };
  const exchanges: string[] = [];
  const consumed: string[] = [];
  const samlTakes: string[] = [];
  const prisma: any = {
    identityProvider: {
      findUnique: async ({ where }: any) => providers.find((p) => p.id === where.id) ?? null,
      findFirst: async ({ where }: any) =>
        providers.find(
          (p) =>
            p.organizationId === where.organizationId &&
            p.protocol === where.protocol &&
            p.enabled === where.enabled
        ) ?? null
    },
    orgSsoSettings: {
      findUnique: async ({ where }: any) => settings[where.organizationId] ?? null
    }
  };
  const sso: any = {
    callbackUrl: (p: { id: string }) => `https://api.orchard.test/apiv1/sso/callback/${p.id}`,
    fetchIdp: async (url: string) => {
      exchanges.push(url);
      throw new Error('idp unreachable in tests');
    }
  };
  const store = new OidcStateStore();
  const realConsume = store.consume.bind(store);
  store.consume = async (state: string) => {
    consumed.push(state);
    return realConsume(state);
  };
  const oauthService: any = {
    getJwtSecret: () => SECRET,
    verifySessionToken: async () => {
      throw new Error('no session');
    }
  };
  const login = new SsoLoginService(
    prisma,
    sso,
    { decryptOrNull: () => null } as any,
    store,
    {
      take: async (key: string) => {
        samlTakes.push(key);
        return null;
      }
    } as any,
    oauthService,
    { validateSession: async () => false } as any,
    {} as any,
    { log: async () => {} } as any,
    {} as any,
    {} as any,
    {} as any
  );
  const controller = new SsoController(sso, login);
  return { controller, login, store, exchanges, consumed, samlTakes };
}

function response() {
  const out = {
    cookies: [] as { name: string; value: string; opts: any }[],
    cleared: [] as { name: string; opts: any }[],
    redirects: [] as string[]
  };
  const res: any = {
    cookie: (name: string, value: string, opts: any) => out.cookies.push({ name, value, opts }),
    clearCookie: (name: string, opts: any) => out.cleared.push({ name, opts }),
    redirect: (url: string) => {
      out.redirects.push(url);
      return res;
    }
  };
  return { res, out };
}

function callbackReq(query: Record<string, string>, cookies: Record<string, string> = {}) {
  return {
    query,
    cookies,
    protocol: 'https',
    originalUrl: `/apiv1/sso/callback?${new URLSearchParams(query)}`,
    get: () => 'api.orchard.test'
  } as any;
}

async function startOn(w: ReturnType<typeof world>, providerId: string, returnTo?: string) {
  const { res, out } = response();
  await w.controller.start(providerId, returnTo, { cookies: {} } as any, res);
  const startCookie = out.cookies.find((c) => c.name === 'sso_start');
  const url = new URL(out.redirects[0]);
  return { startCookie, url, state: url.searchParams.get('state') ?? '', out };
}

const failed = (out: { redirects: string[]; cookies: { name: string }[] }) => {
  assert.equal(out.redirects.length, 1);
  assert.ok(out.redirects[0].startsWith(`${FRONTEND}?error=`), out.redirects[0]);
  assert.equal(
    out.cookies.some((c) => c.name === 'session_token'),
    false,
    'a refused callback must never set a session'
  );
};

test('starting a sign-in redirects to that provider with a fresh state bound into the start cookie', async () => {
  const w = world();
  const a = await startOn(w, 'prov-a');
  assert.equal(a.url.origin, 'https://idp.prov-a.test');
  assert.match(a.state, /^[0-9a-f]{64}$/);
  assert.equal(
    a.url.searchParams.get('redirect_uri'),
    'https://api.orchard.test/apiv1/sso/callback/prov-a'
  );
  assert.ok(a.startCookie);
  assert.equal(a.startCookie!.opts.httpOnly, true);
  const claims = decodeJwt(a.startCookie!.value);
  assert.equal(claims.type, 'sso_start');
  assert.equal(claims.providerId, 'prov-a');
  assert.equal(claims.state, a.state);
  const again = await startOn(w, 'prov-a');
  assert.notEqual(again.state, a.state);
});

test('a disabled provider, or one whose organization or the platform turned SSO off, cannot start a sign-in', async () => {
  const w = world();
  for (const id of ['prov-disabled', 'prov-off', 'prov-killed', 'nope']) {
    const { out } = await startOn(w, id);
    assert.deepEqual(out.redirects, [`${FRONTEND}?error=sso_failed`], id);
    assert.deepEqual(out.cookies, [], id);
  }
});

test('a sign-in started at one organization provider is refused at another organization callback', async () => {
  const w = world();
  const a = await startOn(w, 'prov-a');
  const { res, out } = response();
  await w.controller.callback(
    'prov-b',
    callbackReq({ state: a.state, code: 'c' }, { sso_start: a.startCookie!.value }),
    res
  );
  failed(out);
  assert.deepEqual(w.exchanges, []);
  assert.deepEqual(w.consumed, []);
});

test('the matching callback reaches the code exchange once and its state cannot be replayed', async () => {
  const w = world();
  const a = await startOn(w, 'prov-a');
  const cookies = { sso_start: a.startCookie!.value };
  const first = response();
  await w.controller.callback(
    'prov-a',
    callbackReq({ state: a.state, code: 'c' }, cookies),
    first.res
  );
  failed(first.out);
  assert.deepEqual(w.exchanges, ['https://idp.prov-a.test/token']);
  const replay = response();
  await w.controller.callback(
    'prov-a',
    callbackReq({ state: a.state, code: 'c2' }, cookies),
    replay.res
  );
  failed(replay.out);
  assert.deepEqual(w.exchanges, ['https://idp.prov-a.test/token']);
});

test('a state from another browser login of the same provider does not match this browser', async () => {
  const w = world();
  const mine = await startOn(w, 'prov-a');
  const theirs = await startOn(w, 'prov-a');
  const { res, out } = response();
  await w.controller.callback(
    'prov-a',
    callbackReq({ state: theirs.state, code: 'c' }, { sso_start: mine.startCookie!.value }),
    res
  );
  failed(out);
  assert.deepEqual(w.exchanges, []);
  assert.deepEqual(w.consumed, [], 'a refused binding must not burn the other browser state');
});

test('a callback without a state or without the start cookie is refused before any exchange', async () => {
  const w = world();
  const a = await startOn(w, 'prov-a');
  for (const [query, cookies] of [
    [{ code: 'c' }, { sso_start: a.startCookie!.value }],
    [{ state: a.state, code: 'c' }, {}],
    [{ state: a.state, code: 'c' }, { sso_start: '' }]
  ] as const) {
    const { res, out } = response();
    await w.controller.callback('prov-a', callbackReq(query as any, cookies as any), res);
    failed(out);
  }
  assert.deepEqual(w.exchanges, []);
  assert.deepEqual(w.consumed, []);
});

test('a forged, expired or non-start token in the start cookie is refused', async () => {
  const w = world();
  const a = await startOn(w, 'prov-a');
  const sign = (claims: Record<string, unknown>, secret = SECRET, exp: string | number = '10m') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(secret);
  const base = { type: 'sso_start', providerId: 'prov-a', state: a.state };
  for (const token of [
    await sign(base, new TextEncoder().encode('attacker')),
    await sign(base, SECRET, Math.floor(Date.now() / 1000) - 60),
    await sign({ ...base, type: undefined, sub: 'u', sessionId: 's' }),
    await sign({ ...base, type: 'mcp' }),
    'garbage'
  ]) {
    const { res, out } = response();
    await w.controller.callback(
      'prov-a',
      callbackReq({ state: a.state, code: 'c' }, { sso_start: token }),
      res
    );
    failed(out);
  }
  assert.deepEqual(w.exchanges, []);
});

test('a state minted for one provider is burned when presented to another provider', async () => {
  const w = world();
  const a = await startOn(w, 'prov-a');
  await assert.rejects(
    w.login.handleOAuth2Callback('prov-b', 'c', a.state),
    (err: unknown) => err instanceof HttpException && err.getStatus() === 400
  );
  await assert.rejects(
    w.login.handleOAuth2Callback('prov-a', 'c', a.state),
    /Invalid or expired SSO state/
  );
  assert.deepEqual(w.exchanges, []);
});

test('the start token only verifies for the provider and state it was minted for', async () => {
  const w = world();
  const token = await w.login.issueStartToken(
    'prov-a',
    'https://idp.prov-a.test/authorize?state=s1'
  );
  assert.deepEqual(await w.login.readStartToken('prov-a', token, 's1'), {
    linkedUserId: undefined,
    linkedSessionId: undefined
  });
  await assert.rejects(
    w.login.readStartToken('prov-b', token, 's1'),
    /not started in this browser/
  );
  await assert.rejects(
    w.login.readStartToken('prov-a', token, 's2'),
    /not started in this browser/
  );
  await assert.rejects(w.login.readStartToken('prov-a', undefined, 's1'), /not started/);
});

test('a legacy organization callback refuses a start token from another organization', async () => {
  const w = world();
  const token = await w.login.issueStartToken(
    'oidc-a',
    'https://idp.oidc-a.test/authorize?state=s1'
  );
  const { res, out } = response();
  await w.controller.legacyOidcCallback(
    ORG_B,
    callbackReq({ state: 's1', code: 'c' }, { sso_start: token }),
    res
  );
  failed(out);
  assert.deepEqual(w.consumed, []);
});

test('a legacy SAML callback for an organization without SSO enabled fails closed', async () => {
  const w = world();
  const relay = 'a'.repeat(48);
  const enabled = response();
  await w.controller.legacySamlCallback(ORG_A, 'PHNhbWw+', relay, callbackReq({}, {}), enabled.res);
  failed(enabled.out);
  assert.deepEqual(w.samlTakes, [`relay:${relay}`]);
  for (const org of [ORG_OFF, ORG_KILLED, 'no-such-org']) {
    const { res, out } = response();
    await w.controller.legacySamlCallback(
      org,
      'PHNhbWw+',
      'a'.repeat(48),
      callbackReq({}, {}),
      res
    );
    failed(out);
  }
  assert.deepEqual(w.samlTakes, [`relay:${relay}`]);
});

test('a failed callback names only a known reason and never reflects raw error text', () => {
  const w = world();
  const fail = (err: unknown) => {
    const { res, out } = response();
    (w.controller as any).fail(res, err);
    return out.redirects[0];
  };
  assert.equal(fail(new Error('https://evil.example/phish')), `${FRONTEND}?error=sso_failed`);
  assert.equal(fail('not even an error'), `${FRONTEND}?error=sso_failed`);
  assert.equal(fail(new Error('sso_not_mapped')), `${FRONTEND}?error=sso_not_mapped`);
  const withSlug = new HttpException(
    { message: 'sso_access_disabled', orgSlug: '../../evil.example?x=' },
    HttpStatus.FORBIDDEN
  );
  const url = new URL(fail(withSlug));
  assert.equal(url.origin, FRONTEND);
  assert.equal(url.pathname, `/${encodeURIComponent('../../evil.example?x=')}/login`);
});

test('a finished sign-in sets the session, drops the start cookie and lands where the service decided', () => {
  const w = world();
  const { res, out } = response();
  (w.controller as any).finish(res, { token: 'jwt', userId: 'u', redirectTo: `${FRONTEND}/x` });
  assert.deepEqual(
    out.cookies.map((c) => c.name),
    ['session_token']
  );
  assert.deepEqual(
    out.cleared.map((c) => c.name),
    ['sso_start']
  );
  assert.deepEqual(out.redirects, [`${FRONTEND}/x`]);
});

test('the post-login return path can only point inside the platform frontend', () => {
  const w = world();
  const safe = (p: string | undefined) => (w.login as any).safeReturnTo(p) as string;
  assert.equal(safe('/projects/1?tab=logs'), `${FRONTEND}/projects/1?tab=logs`);
  for (const evil of [
    undefined,
    '',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/x\\@evil.example',
    '/x\r\nLocation: https://evil.example',
    '/\tevil',
    ' /x',
    '/' + 'a'.repeat(600)
  ]) {
    assert.equal(safe(evil), `${FRONTEND}/oauth/callback`, JSON.stringify(evil));
  }
  for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
    assert.equal((w.login as any).plainReturnTo(evil), undefined, evil);
  }
});

test('the login routes are public, as they must be reachable before sign-in', () => {
  assert.equal(Reflect.getMetadata(IS_PUBLIC_KEY, SsoController), true);
});
