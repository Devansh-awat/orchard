import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OAuthController } from '../src/auth/oauth.controller';
import { SuperAdminGuard } from '../src/auth/superadmin.guard';
import {
  clearSessionCookie,
  clearSsoStartCookie,
  isSessionCookieSecure,
  readSessionCookie,
  sessionCookieName,
  setGitOauthStateCookie,
  setGithubOauthStateCookie,
  setSessionCookie,
  setSsoStartCookie,
  ssoStartCookie
} from '../src/auth/cookies';

const FRONTEND = 'https://app.orchard.test';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const ENV_KEYS = [
  'NODE_ENV',
  'SESSION_COOKIE_SECURE',
  'COOKIE_DOMAIN',
  'FRONTEND_URL',
  'SIGNUP_MODE',
  'JWT_SECRET'
];

async function withEnv(vars: Record<string, string | undefined>, fn: () => unknown) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const merged = { FRONTEND_URL: FRONTEND, ...vars };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function response() {
  const out = {
    cookies: [] as { name: string; value: string; opts: any }[],
    cleared: [] as { name: string; opts: any }[],
    redirects: [] as string[],
    status: 0
  };
  const res: any = {
    cookie: (name: string, value: string, opts: any) => out.cookies.push({ name, value, opts }),
    clearCookie: (name: string, opts: any) => out.cleared.push({ name, opts }),
    redirect: (url: string) => {
      out.redirects.push(url);
      return res;
    },
    status: (code: number) => {
      out.status = code;
      return res;
    },
    send: () => res
  };
  return { res, out };
}

async function setCookieHeader(write: (res: express.Response) => void): Promise<string[]> {
  const app = express();
  app.get('/', (_req, res) => {
    write(res);
    res.end();
  });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    return res.headers.getSetCookie();
  } finally {
    server.close();
  }
}

test('in production the session cookie goes out HttpOnly, Secure, SameSite=Lax under COOKIE_DOMAIN', async () => {
  await withEnv(
    { NODE_ENV: 'production', SESSION_COOKIE_SECURE: undefined, COOKIE_DOMAIN: '.orchard.test' },
    async () => {
      const [header] = await setCookieHeader((res) => setSessionCookie(res, 'jwt'));
      const parts = header.split('; ');
      assert.equal(parts[0], 'session_token=jwt');
      for (const flag of [
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
        'Path=/',
        'Domain=.orchard.test',
        `Max-Age=${WEEK_MS / 1000}`
      ]) {
        assert.ok(parts.includes(flag), `${flag} missing from ${header}`);
      }
    }
  );
});

test('without COOKIE_DOMAIN the session cookie is host-only', async () => {
  await withEnv({ NODE_ENV: 'production', COOKIE_DOMAIN: undefined }, async () => {
    const [header] = await setCookieHeader((res) => setSessionCookie(res, 'jwt'));
    assert.equal(/domain=/i.test(header), false, header);
    assert.equal(header.split('; ')[0], '__Host-session_token=jwt');
    const { res, out } = response();
    setSessionCookie(res, 'jwt');
    assert.equal(out.cookies[0].opts.domain, undefined);
  });
});

test('SESSION_COOKIE_SECURE overrides the environment either way, and anything else defers to NODE_ENV', async () => {
  const cases: [string | undefined, string | undefined, boolean][] = [
    ['true', 'development', true],
    ['TRUE', 'development', true],
    ['false', 'production', false],
    ['False', 'production', false],
    ['yes', 'production', true],
    ['1', 'development', false],
    [undefined, 'production', true],
    [undefined, 'development', false],
    [undefined, undefined, false]
  ];
  for (const [override, nodeEnv, secure] of cases) {
    await withEnv({ SESSION_COOKIE_SECURE: override, NODE_ENV: nodeEnv }, () => {
      assert.equal(isSessionCookieSecure(), secure, `${override}/${nodeEnv}`);
      const { res, out } = response();
      setSessionCookie(res, 't');
      assert.equal(out.cookies[0].opts.secure, secure, `${override}/${nodeEnv}`);
    });
  }
});

test('clearing the session cookie uses the same attributes it was set with, so browsers drop it', async () => {
  for (const env of [
    { NODE_ENV: 'production', COOKIE_DOMAIN: '.orchard.test' },
    { NODE_ENV: 'production', COOKIE_DOMAIN: undefined },
    { NODE_ENV: 'development', COOKIE_DOMAIN: undefined }
  ]) {
    await withEnv(env, () => {
      const { res, out } = response();
      setSessionCookie(res, 't');
      clearSessionCookie(res);
      const { maxAge, ...setOpts } = out.cookies[0].opts;
      assert.equal(maxAge, WEEK_MS);
      assert.equal(out.cleared[0].name, out.cookies[0].name);
      assert.deepEqual(out.cleared[0].opts, setOpts);
    });
  }
});

test('a secure host-only instance names the session cookie __Host- and reads nothing else', async () => {
  const cases: [Record<string, string | undefined>, string][] = [
    [{ NODE_ENV: 'production', COOKIE_DOMAIN: undefined }, '__Host-session_token'],
    [{ NODE_ENV: 'production', COOKIE_DOMAIN: '.orchard.test' }, 'session_token'],
    [{ NODE_ENV: 'development', COOKIE_DOMAIN: undefined }, 'session_token'],
    [{ NODE_ENV: 'development', SESSION_COOKIE_SECURE: 'true' }, '__Host-session_token']
  ];
  for (const [env, name] of cases) {
    await withEnv({ SESSION_COOKIE_SECURE: undefined, ...env }, () => {
      assert.equal(sessionCookieName(), name, JSON.stringify(env));
      const other = name === 'session_token' ? '__Host-session_token' : 'session_token';
      assert.equal(readSessionCookie({ [name]: 'mine' }), 'mine');
      assert.equal(readSessionCookie({ [other]: 'tossed' }), undefined);
      assert.equal(readSessionCookie({ [other]: 'tossed', [name]: 'mine' }), 'mine');
      assert.equal(readSessionCookie(undefined), undefined);
    });
  }
});

test('logging out of a __Host- instance also drops a leftover legacy cookie', async () => {
  await withEnv({ NODE_ENV: 'production', COOKIE_DOMAIN: undefined }, () => {
    const { res, out } = response();
    clearSessionCookie(res);
    assert.deepEqual(
      out.cleared.map((c) => c.name),
      ['__Host-session_token', 'session_token']
    );
  });
});

test('OAuth state cookies are HttpOnly, short-lived, scoped to their callback path and never shared across subdomains', async () => {
  await withEnv({ NODE_ENV: 'production', COOKIE_DOMAIN: '.orchard.test' }, () => {
    const { res, out } = response();
    setGithubOauthStateCookie(res, 's1');
    setGitOauthStateCookie(res, 's2');
    assert.deepEqual(
      out.cookies.map((c) => [c.name, c.opts]),
      [
        [
          'github_oauth_state',
          {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: TEN_MIN_MS,
            path: '/apiv1/github'
          }
        ],
        [
          'git_oauth_state',
          {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: TEN_MIN_MS,
            path: '/apiv1/git/oauth'
          }
        ]
      ]
    );
  });
});

test('the SSO start cookie is HttpOnly and host-only, and only drops SameSite to None when it is Secure', async () => {
  for (const [nodeEnv, secure, sameSite] of [
    ['production', true, 'none'],
    ['development', false, 'lax']
  ] as const) {
    await withEnv({ NODE_ENV: nodeEnv, COOKIE_DOMAIN: '.orchard.test' }, () => {
      const { res, out } = response();
      setSsoStartCookie(res, 'start');
      clearSsoStartCookie(res);
      assert.deepEqual(out.cookies[0], {
        name: 'sso_start',
        value: 'start',
        opts: { httpOnly: true, secure, sameSite, path: '/', maxAge: TEN_MIN_MS }
      });
      assert.deepEqual(out.cleared[0], {
        name: 'sso_start',
        opts: { httpOnly: true, secure, sameSite, path: '/' }
      });
    });
  }
  assert.equal(ssoStartCookie({ cookies: { sso_start: 'x' } }), 'x');
  assert.equal(ssoStartCookie({}), undefined);
});

type Identity = { id: string; email: string; name: string; emailVerified?: boolean };

function oauthWorld(
  opts: {
    identity?: Identity;
    users?: any[];
    member?: boolean;
    invitation?: boolean;
    ssoEnforcedFor?: string[];
    instanceSso?: boolean;
    exchangeFails?: boolean;
    enabled?: boolean;
    pkce?: boolean;
  } = {}
) {
  const identity = opts.identity ?? {
    id: 'hc-1',
    email: 'ada@example.com',
    name: 'Ada L',
    emailVerified: true
  };
  const users = opts.users ?? [];
  const calls = {
    exchanged: [] as string[],
    verifiers: [] as (string | undefined)[],
    sessions: [] as any[],
    revoked: [] as [string, string][],
    linked: [] as Identity[]
  };
  const oauthService: any = {
    oauthEnabled: opts.enabled ?? true,
    usesPkce: async () => opts.pkce ?? false,
    getAuthorizationUrl: async (state: string, challenge?: string) =>
      `https://auth.idp.test/authorize?state=${state}` +
      (challenge ? `&code_challenge=${challenge}&code_challenge_method=S256` : ''),
    exchangeCodeForToken: async (code: string, verifier?: string) => {
      calls.exchanged.push(code);
      calls.verifiers.push(verifier);
      if (opts.exchangeFails) throw new Error('bad code');
      return 'access-token';
    },
    getUserInfo: async () => identity,
    generateSessionToken: async (_u: Identity, sessionId: string) => `jwt-for-${sessionId}`,
    verifySessionSignature: async (token: string) => {
      if (token !== 'valid-session') throw new Error('bad signature');
      return { sub: 'user-1', sessionId: 'sess-9', externalAuthId: undefined };
    }
  };
  const sessionsService: any = {
    createSession: async (data: any) => {
      calls.sessions.push(data);
      return 'sess-1';
    },
    revokeSession: async (userId: string, sessionId: string) => {
      calls.revoked.push([userId, sessionId]);
    }
  };
  const usersService: any = {
    findOrCreateByExternalAuthId: async (i: Identity) => {
      calls.linked.push(i);
      return users.find((u) => u.externalAuthId === i.id || u.email === i.email) ?? { id: 'new' };
    }
  };
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) =>
        users.find((u) =>
          where.externalAuthId
            ? u.externalAuthId === where.externalAuthId
            : u.email === where.emailScope_email?.email
        ) ?? null
    },
    organizationMember: { findFirst: async () => (opts.member ? { id: 'm' } : null) },
    organizationInvitation: { findFirst: async () => (opts.invitation ? { id: 'i' } : null) }
  };
  const authz: any = {
    assertSsoNotEnforced: async (user: { id: string }) => {
      if (opts.ssoEnforcedFor?.includes(user.id)) throw new Error('sso enforced');
    },
    assertSsoNotEnforcedForEmail: async () => {
      if (opts.instanceSso) throw new Error('instance sso');
    }
  };
  const controller = new OAuthController(
    oauthService,
    sessionsService,
    {} as any,
    usersService,
    prisma,
    authz
  );
  return { controller, calls };
}

const cbReq = (cookies: Record<string, string> = {}) =>
  ({ cookies, headers: { 'user-agent': 'test' }, socket: { remoteAddress: '203.0.113.9' } }) as any;

const STATE = 'a'.repeat(64);
const STATE_CLEARED = [
  { name: 'oauth_state', opts: { path: '/apiv1/auth' } },
  { name: 'oauth_pkce', opts: { path: '/apiv1/auth' } }
];

function noSession(out: ReturnType<typeof response>['out']) {
  assert.equal(
    out.cookies.some((c) => c.name === 'session_token'),
    false,
    'no session cookie may be set'
  );
}

test('starting the platform OAuth login binds a fresh random state to an HttpOnly cookie', async () => {
  await withEnv({ NODE_ENV: 'production' }, async () => {
    const { controller } = oauthWorld();
    const first = response();
    await controller.login(first.res);
    const second = response();
    await controller.login(second.res);
    const [cookie] = first.out.cookies;
    assert.equal(cookie.name, 'oauth_state');
    assert.match(cookie.value, /^[0-9a-f]{64}$/);
    assert.deepEqual(cookie.opts, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: TEN_MIN_MS,
      path: '/apiv1/auth'
    });
    assert.equal(
      new URL(first.out.redirects[0]).searchParams.get('state'),
      cookie.value,
      'the state sent to the IdP is the one bound to this browser'
    );
    assert.notEqual(second.out.cookies[0].value, cookie.value);
    assert.equal(first.out.cookies.length, 1, 'no PKCE cookie when the IdP does not do PKCE');
    assert.equal(new URL(first.out.redirects[0]).searchParams.get('code_challenge'), null);
  });
});

test('with OAuth turned off, login redirects home with an error and binds nothing', async () => {
  await withEnv({}, async () => {
    const { controller } = oauthWorld({ enabled: false });
    const { res, out } = response();
    await controller.login(res);
    assert.deepEqual(out.redirects, [`${FRONTEND}?error=oauth_disabled`]);
    assert.deepEqual(out.cookies, []);
  });
});

test('a callback whose state does not match the browser cookie is refused before the code is exchanged', async () => {
  await withEnv({}, async () => {
    const cases: [string | undefined, Record<string, string>][] = [
      [STATE, {}],
      [undefined, { oauth_state: STATE }],
      ['', { oauth_state: '' }],
      [STATE, { oauth_state: 'b'.repeat(64) }],
      [STATE, { oauth_state: STATE.slice(1) }],
      [STATE.slice(1), { oauth_state: STATE }],
      [STATE.toUpperCase(), { oauth_state: STATE }]
    ];
    for (const [state, cookies] of cases) {
      const { controller, calls } = oauthWorld();
      const { res, out } = response();
      await controller.callback('code', undefined as any, state as any, cbReq(cookies), res);
      assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback?error=invalid_state`]);
      assert.deepEqual(out.cleared, STATE_CLEARED);
      assert.deepEqual(calls.exchanged, []);
      assert.deepEqual(calls.sessions, []);
      noSession(out);
    }
  });
});

test('a matching state signs the user in and always lands on the platform frontend', async () => {
  await withEnv({ SIGNUP_MODE: 'open' }, async () => {
    const { controller, calls } = oauthWorld();
    const { res, out } = response();
    const req = cbReq({ oauth_state: STATE });
    req.query = { returnTo: 'https://evil.example', redirect_uri: 'https://evil.example' };
    await controller.callback('code-1', undefined as any, STATE, req, res);
    assert.deepEqual(calls.exchanged, ['code-1']);
    assert.equal(calls.sessions[0].authMethod, 'oauth');
    assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback`]);
    const session = out.cookies.find((c) => c.name === 'session_token');
    assert.equal(session?.value, 'jwt-for-sess-1');
    assert.equal(session?.opts.httpOnly, true);
    assert.deepEqual(out.cleared, STATE_CLEARED);
  });
});

test('the state cookie is single-use: it is cleared on success and on refusal', async () => {
  await withEnv({ SIGNUP_MODE: 'open' }, async () => {
    for (const cookieState of [STATE, 'c'.repeat(64)]) {
      const { controller } = oauthWorld();
      const { res, out } = response();
      await controller.callback(
        'c',
        undefined as any,
        STATE,
        cbReq({ oauth_state: cookieState }),
        res
      );
      assert.equal(out.cleared.filter((c) => c.name === 'oauth_state').length, 1);
    }
  });
});

test('an IdP error is passed home URL-encoded and cannot steer the redirect off the frontend', async () => {
  await withEnv({}, async () => {
    const { controller, calls } = oauthWorld();
    for (const error of [
      'access_denied',
      'x&next=https://evil.example',
      '@evil.example',
      '#/../../evil',
      '\r\nLocation: https://evil.example'
    ]) {
      const { res, out } = response();
      await controller.callback(undefined as any, error, undefined as any, cbReq(), res);
      const url = new URL(out.redirects[0]);
      assert.equal(url.origin, FRONTEND, error);
      assert.equal(url.searchParams.get('error'), error);
      assert.deepEqual([...url.searchParams.keys()], ['error']);
      noSession(out);
    }
    assert.deepEqual(calls.exchanged, []);
  });
});

test('an IdP error with FRONTEND_URL unset lands on the default frontend, not a relative "undefined" path', async () => {
  await withEnv({ FRONTEND_URL: undefined }, async () => {
    const { controller } = oauthWorld();
    const { res, out } = response();
    await controller.callback(undefined as any, 'access_denied', undefined as any, cbReq(), res);
    assert.equal(new URL(out.redirects[0]).origin, 'http://localhost:3000');
  });
});

test('a callback with no code is a 400 and exchanges nothing', async () => {
  await withEnv({}, async () => {
    const { controller, calls } = oauthWorld();
    const { res } = response();
    await assert.rejects(
      controller.callback(
        undefined as any,
        undefined as any,
        STATE,
        cbReq({ oauth_state: STATE }),
        res
      ),
      (err: unknown) => err instanceof HttpException && err.getStatus() === 400
    );
    assert.deepEqual(calls.exchanged, []);
  });
});

test('an identity whose email belongs to an account linked elsewhere is refused without saying so', async () => {
  await withEnv({ SIGNUP_MODE: 'open' }, async () => {
    const { controller, calls } = oauthWorld({
      users: [{ id: 'victim', email: 'ada@example.com', externalAuthId: 'hc-other' }]
    });
    const { res, out } = response();
    await controller.callback('c', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
    assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback?error=oauth_failed`]);
    assert.deepEqual(calls.linked, []);
    assert.deepEqual(calls.sessions, []);
    noSession(out);
  });
});

test('a member of an SSO-enforcing organization cannot sign in through platform OAuth', async () => {
  await withEnv({ SIGNUP_MODE: 'open' }, async () => {
    const { controller, calls } = oauthWorld({
      users: [{ id: 'u1', email: 'ada@example.com', externalAuthId: 'hc-1' }],
      ssoEnforcedFor: ['u1']
    });
    const { res, out } = response();
    await controller.callback('c', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
    assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback?error=sso_required`]);
    assert.deepEqual(calls.sessions, []);
    noSession(out);
  });
});

test('an unlinked account found by email is still held to its SSO enforcement before any link', async () => {
  await withEnv({ SIGNUP_MODE: 'open' }, async () => {
    const { controller, calls } = oauthWorld({
      users: [{ id: 'otp-user', email: 'ada@example.com', externalAuthId: null }],
      ssoEnforcedFor: ['otp-user']
    });
    const { res, out } = response();
    await controller.callback('c', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
    assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback?error=sso_required`]);
    assert.deepEqual(calls.linked, []);
    noSession(out);
  });
});

test('a new identity on an instance that requires SSO is refused', async () => {
  await withEnv({ SIGNUP_MODE: 'open' }, async () => {
    const { controller, calls } = oauthWorld({ instanceSso: true });
    const { res, out } = response();
    await controller.callback('c', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
    assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback?error=sso_required`]);
    assert.deepEqual(calls.linked, []);
    noSession(out);
  });
});

test('outside open signup a stranger without an invitation gets no account and no session', async () => {
  for (const [mode, reason] of [
    ['invite_only', 'private_beta'],
    ['closed', 'signups_disabled']
  ]) {
    await withEnv({ SIGNUP_MODE: mode }, async () => {
      const { controller, calls } = oauthWorld();
      const { res, out } = response();
      await controller.callback('c', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
      assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback?error=${reason}`], mode);
      assert.deepEqual(calls.linked, []);
      noSession(out);
    });
  }
});

test('a closed instance lets existing members in but not invitees', async () => {
  await withEnv({ SIGNUP_MODE: 'closed' }, async () => {
    const invited = oauthWorld({ invitation: true });
    const a = response();
    await invited.controller.callback(
      'c',
      undefined as any,
      STATE,
      cbReq({ oauth_state: STATE }),
      a.res
    );
    noSession(a.out);
    const member = oauthWorld({
      users: [{ id: 'u1', email: 'ada@example.com', externalAuthId: 'hc-1' }],
      member: true
    });
    const b = response();
    await member.controller.callback(
      'c',
      undefined as any,
      STATE,
      cbReq({ oauth_state: STATE }),
      b.res
    );
    assert.ok(b.out.cookies.some((c) => c.name === 'session_token'));
  });
});

test('a failed code exchange signs nobody in', async () => {
  await withEnv({ SIGNUP_MODE: 'open' }, async () => {
    const { controller, calls } = oauthWorld({ exchangeFails: true });
    const { res, out } = response();
    const original = console.error;
    console.error = () => {};
    try {
      await controller.callback('c', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
    } finally {
      console.error = original;
    }
    assert.equal(new URL(out.redirects[0]).origin, FRONTEND);
    assert.deepEqual(calls.sessions, []);
    noSession(out);
  });
});

test('logout revokes the presented session and clears the cookie with its set attributes', async () => {
  await withEnv({ NODE_ENV: 'production', COOKIE_DOMAIN: '.orchard.test' }, async () => {
    const { controller, calls } = oauthWorld();
    const { res, out } = response();
    await controller.logout({ cookies: { session_token: 'valid-session' } } as any, res);
    assert.deepEqual(calls.revoked, [['user-1', 'sess-9']]);
    assert.equal(out.status, 204);
    assert.deepEqual(out.cleared, [
      {
        name: 'session_token',
        opts: {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          domain: '.orchard.test'
        }
      }
    ]);
  });
});

test('logout with a forged or missing session revokes nothing but still clears the cookie', async () => {
  await withEnv({}, async () => {
    for (const cookies of [{ session_token: 'forged' }, {}]) {
      const { controller, calls } = oauthWorld();
      const { res, out } = response();
      await controller.logout({ cookies } as any, res);
      assert.deepEqual(calls.revoked, []);
      assert.equal(out.cleared[0].name, 'session_token');
      assert.equal(out.status, 204);
    }
  });
});

test('the profile routes on the public auth controller still demand a credential', async () => {
  await withEnv({ JWT_SECRET: 'x'.repeat(40) }, async () => {
    const guard = new SuperAdminGuard({} as any, {} as any, new Reflector());
    const context = (handler: string) =>
      ({
        getHandler: () => (OAuthController.prototype as any)[handler],
        getClass: () => OAuthController,
        switchToHttp: () => ({
          getRequest: () => ({ headers: {}, cookies: {}, method: 'GET', path: '/apiv1/auth/me' })
        })
      }) as any;
    for (const handler of ['me', 'updateMe', 'markUpdateSeen', 'uploadAvatar', 'deleteAvatar']) {
      await assert.rejects(guard.canActivate(context(handler)), UnauthorizedException, handler);
    }
    for (const handler of ['login', 'callback']) {
      assert.equal(await guard.canActivate(context(handler)), true, handler);
    }
  });
});

test('the platform OAuth login sends a PKCE challenge and proves the verifier at the code exchange', async () => {
  await withEnv({ NODE_ENV: 'production', SIGNUP_MODE: 'open' }, async () => {
    const { controller, calls } = oauthWorld({ pkce: true });
    const login = response();
    await controller.login(login.res);
    const verifier = login.out.cookies.find((c) => c.name === 'oauth_pkce');
    assert.ok(verifier, 'the verifier is bound to this browser');
    assert.match(verifier.value, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(verifier.opts, login.out.cookies[0].opts);
    const url = new URL(login.out.redirects[0]);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      url.searchParams.get('code_challenge'),
      createHash('sha256').update(verifier.value).digest('base64url')
    );
    const state = login.out.cookies[0].value;

    const { res, out } = response();
    await controller.callback(
      'code-1',
      undefined as any,
      state,
      cbReq({ oauth_state: state, oauth_pkce: verifier.value }),
      res
    );
    assert.deepEqual(calls.verifiers, [verifier.value]);
    assert.deepEqual(out.cleared, STATE_CLEARED);
    assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback`]);
  });
});

test('a platform OIDC identity whose userinfo omits email_verified does not adopt an existing account by email', async () => {
  await withEnv({ SIGNUP_MODE: 'invite' }, async () => {
    const { controller, calls } = oauthWorld({
      identity: { id: 'idp-9', email: 'ada@example.com', name: 'Ada', emailVerified: false },
      users: [{ id: 'u-ada', email: 'ada@example.com', externalAuthId: null, isSuperAdmin: false }],
      invitation: true
    });
    const { res, out } = response();
    await controller.callback('code', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
    assert.deepEqual(out.redirects, [`${FRONTEND}/oauth/callback?error=oauth_failed`]);
    assert.deepEqual(calls.linked, []);
    assert.deepEqual(calls.sessions, []);
    noSession(out);
  });
});

test('an unverified email does not count as an invitation outside open signup', async () => {
  await withEnv({ SIGNUP_MODE: 'invite' }, async () => {
    const { controller, calls } = oauthWorld({
      identity: { id: 'idp-9', email: 'invited@example.com', name: 'X', emailVerified: false },
      invitation: true
    });
    const { res, out } = response();
    await controller.callback('code', undefined as any, STATE, cbReq({ oauth_state: STATE }), res);
    assert.equal(out.redirects[0].startsWith(`${FRONTEND}/oauth/callback?error=`), true);
    assert.deepEqual(calls.sessions, []);
    noSession(out);
  });
});
