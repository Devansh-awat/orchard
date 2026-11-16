import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as http from 'http';
import { SignJWT } from 'jose';
import {
  authenticateUpgrade,
  originAllowed,
  parseCookies,
  platformOrigins,
  rejectUpgrade
} from '../src/auth/upgrade-auth';
import { hashApiToken } from '../src/auth/api-tokens.service';

const SECRET = 'upgrade-auth-test-secret';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_USER_ID = '99999999-2222-4333-8444-555555555555';
const SESSION_ID = 'sess-1';
const ORG_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const API_TOKEN = 'orch_' + 'a'.repeat(64);
const ALLOWED = new Set(['https://orchard.example']);

type UserRow = { id: string; email: string | null; externalAuthId?: string | null };
type TokenRow = {
  id: string;
  scopes: unknown;
  restrictedProjectIds: unknown;
  scopeOrganizationId: string | null;
  expiresAt: Date | null;
  user: { id: string; email: string | null; disabledAt?: Date | null };
};

function harness(
  opts: {
    users?: UserRow[];
    validSessions?: string[];
    sessionCheck?: (id: string) => Promise<boolean>;
    tokens?: Record<string, TokenRow>;
    requiredScope?: string;
    failLastUsed?: boolean;
  } = {}
) {
  const users = opts.users ?? [{ id: USER_ID, email: 'ada@example.com', externalAuthId: 'ext-1' }];
  const validSessions = new Set(opts.validSessions ?? [SESSION_ID]);
  const calls = {
    sessions: [] as string[],
    userQueries: [] as any[],
    tokenLookups: [] as string[],
    tokenUpdates: [] as any[]
  };
  const prisma = {
    user: {
      findFirst: async (args: any) => {
        calls.userQueries.push(args);
        const clauses: Array<Record<string, string>> = args.where.OR;
        return (
          users.find((u) =>
            clauses.some((c) =>
              Object.entries(c).every(([k, v]) => (u as Record<string, unknown>)[k] === v)
            )
          ) ?? null
        );
      }
    },
    apiToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        calls.tokenLookups.push(where.tokenHash);
        return opts.tokens?.[where.tokenHash] ?? null;
      },
      update: (args: any) => {
        calls.tokenUpdates.push(args);
        return opts.failLastUsed ? Promise.reject(new Error('db down')) : Promise.resolve({});
      }
    }
  };
  const sessions = {
    validateSession: async (id: string) => {
      calls.sessions.push(id);
      if (opts.sessionCheck) return opts.sessionCheck(id);
      return validSessions.has(id);
    }
  };
  const deps = {
    prisma: prisma as any,
    sessions: sessions as any,
    jwtSecret: SECRET,
    requiredScope: opts.requiredScope ?? 'exec'
  };
  return { deps, calls };
}

function req(headers: http.IncomingHttpHeaders, url = '/ws'): http.IncomingMessage {
  return { headers, url } as http.IncomingMessage;
}

async function sessionJwt(
  claims: Record<string, unknown> = {},
  opts: { secret?: string; exp?: number | string; nbf?: number | string; sub?: string | null } = {}
) {
  const jwt = new SignJWT({ sessionId: SESSION_ID, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt();
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? USER_ID);
  jwt.setExpirationTime(opts.exp ?? '1h');
  if (opts.nbf !== undefined) jwt.setNotBefore(opts.nbf);
  return jwt.sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

function tokenRow(overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    id: 'tok-1',
    scopes: ['read', 'exec'],
    restrictedProjectIds: [],
    scopeOrganizationId: null,
    expiresAt: null,
    user: { id: USER_ID, email: 'ada@example.com' },
    ...overrides
  };
}

function withToken(row: TokenRow, extra: Parameters<typeof harness>[0] = {}) {
  return harness({ tokens: { [hashApiToken(API_TOKEN)]: row }, ...extra });
}

test('an upgrade from the platform origin is allowed for a cookie session', () => {
  assert.equal(originAllowed('https://orchard.example', ALLOWED, 'cookie'), true);
});

test('a cross-origin upgrade with a session cookie is refused', () => {
  assert.equal(originAllowed('https://evil.example', ALLOWED, 'cookie'), false);
});

test('look-alike hosts that only share a prefix or suffix with the platform are refused', () => {
  for (const origin of [
    'https://evil-orchard.example',
    'https://orchard.example.evil.com',
    'https://sub.orchard.example',
    'https://orchard.examplee',
    'https://orchard.example.',
    'https://xn--orchard-example.com'
  ]) {
    for (const via of ['cookie', 'bearer', 'api-token', null] as const) {
      assert.equal(originAllowed(origin, ALLOWED, via), false, `${origin} via ${via}`);
    }
  }
});

test('a different scheme or port on the platform host is refused', () => {
  for (const origin of [
    'http://orchard.example',
    'wss://orchard.example',
    'https://orchard.example:8443',
    'https://orchard.example:80'
  ]) {
    assert.equal(originAllowed(origin, ALLOWED, 'cookie'), false, origin);
  }
});

test('the platform origin matches however the browser spells it', () => {
  for (const origin of [
    'https://orchard.example:443',
    'https://ORCHARD.example',
    'https://orchard.example/'
  ]) {
    assert.equal(originAllowed(origin, ALLOWED, 'cookie'), true, origin);
  }
});

test('userinfo in the origin cannot smuggle the platform host past the check', () => {
  assert.equal(originAllowed('https://orchard.example@evil.com', ALLOWED, 'cookie'), false);
  assert.equal(originAllowed('https://orchard.example:x@evil.com', ALLOWED, 'bearer'), false);
});

test('an opaque, malformed or wildcard origin is refused', () => {
  for (const origin of ['null', 'orchard.example', '*', 'https://', 'not a url', 'file:///etc']) {
    for (const via of ['cookie', 'bearer', 'api-token', null] as const) {
      assert.equal(originAllowed(origin, ALLOWED, via), false, `${origin} via ${via}`);
    }
  }
});

test('more than one origin header is refused even when one of them is the platform', () => {
  assert.equal(
    originAllowed(['https://orchard.example', 'https://evil.example'], ALLOWED, 'cookie'),
    false
  );
  assert.equal(originAllowed(['https://orchard.example'], ALLOWED, 'bearer'), false);
});

test('a cookie session without an origin is refused', () => {
  assert.equal(originAllowed(undefined, ALLOWED, 'cookie'), false);
  assert.equal(originAllowed('', ALLOWED, 'cookie'), false);
});

test('an unauthenticated upgrade without an origin is refused', () => {
  assert.equal(originAllowed(undefined, ALLOWED, null), false);
  assert.equal(originAllowed('', ALLOWED, null), false);
});

test('a header-borne credential without an origin is allowed for non-browser clients', () => {
  assert.equal(originAllowed(undefined, ALLOWED, 'bearer'), true);
  assert.equal(originAllowed(undefined, ALLOWED, 'api-token'), true);
});

test('a header-borne credential still cannot come from a foreign origin', () => {
  assert.equal(originAllowed('https://evil.example', ALLOWED, 'bearer'), false);
  assert.equal(originAllowed('https://evil.example', ALLOWED, 'api-token'), false);
});

test('an empty allow-list admits no origin', () => {
  assert.equal(originAllowed('https://orchard.example', new Set(), 'cookie'), false);
});

test('platform origins come from FRONTEND_URL and PLATFORM_ORIGINS reduced to bare origins', () => {
  const saved = { f: process.env.FRONTEND_URL, p: process.env.PLATFORM_ORIGINS };
  try {
    process.env.FRONTEND_URL = 'https://orchard.example/app/';
    process.env.PLATFORM_ORIGINS =
      ' https://admin.example:8443/x , not a url,,*, http://other.test ';
    assert.deepEqual(
      [...platformOrigins()].sort(),
      ['http://other.test', 'https://admin.example:8443', 'https://orchard.example'].sort()
    );
  } finally {
    if (saved.f === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = saved.f;
    if (saved.p === undefined) delete process.env.PLATFORM_ORIGINS;
    else process.env.PLATFORM_ORIGINS = saved.p;
  }
});

test('without configuration only the local dev frontend is a platform origin', () => {
  const saved = { f: process.env.FRONTEND_URL, p: process.env.PLATFORM_ORIGINS };
  try {
    delete process.env.FRONTEND_URL;
    delete process.env.PLATFORM_ORIGINS;
    assert.deepEqual([...platformOrigins()], ['http://localhost:5173']);
  } finally {
    if (saved.f !== undefined) process.env.FRONTEND_URL = saved.f;
    if (saved.p !== undefined) process.env.PLATFORM_ORIGINS = saved.p;
  }
});

test('a valid session cookie authenticates the upgrade as a cookie identity', async () => {
  const { deps, calls } = harness();
  const token = await sessionJwt({ orgScope: ORG_ID, externalAuthId: 'ext-1' });
  const identity = await authenticateUpgrade(
    req({ cookie: `theme=dark; session_token=${token}`, origin: 'https://orchard.example' }),
    deps
  );
  assert.deepEqual(identity, {
    userId: USER_ID,
    email: 'ada@example.com',
    sessionId: SESSION_ID,
    orgScope: ORG_ID,
    via: 'cookie'
  });
  assert.deepEqual(calls.sessions, [SESSION_ID]);
});

test('a session JWT in the Authorization header authenticates as a bearer identity', async () => {
  const { deps } = harness();
  const token = await sessionJwt();
  const identity = await authenticateUpgrade(req({ authorization: `Bearer ${token}` }), deps);
  assert.equal(identity?.via, 'bearer');
  assert.equal(identity?.userId, USER_ID);
  assert.equal(identity?.orgScope, null);
});

test('a cookie and a bearer together are judged as a cookie, so cookie origin rules apply', async () => {
  const { deps } = harness();
  const token = await sessionJwt();
  const identity = await authenticateUpgrade(
    req({ cookie: `session_token=${token}`, authorization: `Bearer ${token}` }),
    deps
  );
  assert.equal(identity?.via, 'cookie');
});

test('a bad session cookie is not rescued by a valid bearer', async () => {
  const { deps } = harness();
  const good = await sessionJwt();
  const bad = await sessionJwt({}, { secret: 'attacker-secret' });
  assert.equal(
    await authenticateUpgrade(
      req({ cookie: `session_token=${bad}`, authorization: `Bearer ${good}` }),
      deps
    ),
    null
  );
});

test('an expired session token is refused before the session store is asked', async () => {
  const { deps, calls } = harness();
  const token = await sessionJwt({}, { exp: Math.floor(Date.now() / 1000) - 60 });
  assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
  assert.deepEqual(calls.sessions, []);
});

test('a session token that is not valid yet is refused', async () => {
  const { deps } = harness();
  const token = await sessionJwt({}, { nbf: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
});

test('a session token signed with another secret is refused', async () => {
  const { deps, calls } = harness();
  const token = await sessionJwt({}, { secret: 'attacker-secret' });
  assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
  assert.deepEqual(calls.sessions, []);
  assert.deepEqual(calls.userQueries, []);
});

test('a session token with a tampered payload is refused', async () => {
  const { deps } = harness({
    users: [
      { id: USER_ID, email: 'ada@example.com' },
      { id: OTHER_USER_ID, email: 'admin@example.com' }
    ]
  });
  const [header, , signature] = (await sessionJwt()).split('.');
  const forged = Buffer.from(
    JSON.stringify({ sub: OTHER_USER_ID, sessionId: SESSION_ID, exp: 9999999999 })
  ).toString('base64url');
  assert.equal(
    await authenticateUpgrade(
      req({ cookie: `session_token=${header}.${forged}.${signature}` }),
      deps
    ),
    null
  );
});

test('an unsigned alg none token is refused', async () => {
  const { deps } = harness();
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: USER_ID, sessionId: SESSION_ID })}.`;
  assert.equal(await authenticateUpgrade(req({ authorization: `Bearer ${token}` }), deps), null);
});

test('a revoked session is refused even with a correctly signed token', async () => {
  const { deps, calls } = harness({ validSessions: [] });
  const token = await sessionJwt();
  assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
  assert.deepEqual(calls.sessions, [SESSION_ID]);
  assert.deepEqual(calls.userQueries, []);
});

test('a session store failure refuses the upgrade', async () => {
  const { deps } = harness({
    sessionCheck: async () => {
      throw new Error('db down');
    }
  });
  const token = await sessionJwt();
  assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
});

test('mcp and other typed tokens never open an upgrade', async () => {
  const { deps, calls } = harness();
  for (const type of ['mcp', 'mcp_refresh', 'exec-proxy', 'sandbox']) {
    const token = await sessionJwt({ type });
    assert.equal(await authenticateUpgrade(req({ authorization: `Bearer ${token}` }), deps), null);
  }
  assert.deepEqual(calls.sessions, []);
});

test('a signed token without a session binding is refused', async () => {
  const { deps, calls } = harness();
  for (const sessionId of [undefined, '', 42]) {
    const token = await sessionJwt({ sessionId });
    assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
  }
  assert.deepEqual(calls.sessions, []);
});

test('a valid session for a user who no longer exists is refused', async () => {
  const { deps } = harness({ users: [] });
  const token = await sessionJwt();
  assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
});

test('a session token naming no subject resolves to nobody', async () => {
  const { deps, calls } = harness();
  const token = await sessionJwt({}, { sub: null });
  assert.equal(await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps), null);
  assert.deepEqual(calls.userQueries[0].where.OR, []);
});

test('a non-string orgScope claim is dropped rather than trusted', async () => {
  const { deps } = harness();
  const token = await sessionJwt({ orgScope: { id: ORG_ID } });
  const identity = await authenticateUpgrade(req({ cookie: `session_token=${token}` }), deps);
  assert.equal(identity?.orgScope, null);
});

test('an upgrade with no credential is refused without touching the database', async () => {
  const { deps, calls } = harness();
  assert.equal(await authenticateUpgrade(req({}), deps), null);
  assert.equal(await authenticateUpgrade(req({ cookie: 'session_token=' }), deps), null);
  assert.deepEqual(calls, { sessions: [], userQueries: [], tokenLookups: [], tokenUpdates: [] });
});

test('a token in the query string is ignored', async () => {
  const { deps } = withToken(tokenRow());
  const jwt = await sessionJwt();
  assert.equal(
    await authenticateUpgrade(req({}, `/ws?token=${jwt}&session_token=${jwt}`), deps),
    null
  );
  assert.equal(await authenticateUpgrade(req({}, `/ws?access_token=${API_TOKEN}`), deps), null);
});

test('a token in the websocket subprotocol header is ignored', async () => {
  const { deps } = withToken(tokenRow());
  const jwt = await sessionJwt();
  assert.equal(
    await authenticateUpgrade(req({ 'sec-websocket-protocol': `bearer, ${jwt}` }), deps),
    null
  );
  assert.equal(await authenticateUpgrade(req({ 'sec-websocket-protocol': API_TOKEN }), deps), null);
});

test('only the exact "Bearer " scheme is read from the Authorization header', async () => {
  const { deps } = withToken(tokenRow());
  const jwt = await sessionJwt();
  for (const authorization of [
    `bearer ${jwt}`,
    `Basic ${jwt}`,
    `Token ${API_TOKEN}`,
    API_TOKEN,
    `Bearer${API_TOKEN}`
  ]) {
    assert.equal(await authenticateUpgrade(req({ authorization }), deps), null, authorization);
  }
});

test('a session cookie under a look-alike name is ignored', async () => {
  const { deps } = harness();
  const jwt = await sessionJwt();
  for (const cookie of [
    `session_token_x=${jwt}`,
    `xsession_token=${jwt}`,
    `Session_Token=${jwt}`,
    `__Host-session_token=${jwt}`
  ]) {
    assert.equal(await authenticateUpgrade(req({ cookie }), deps), null, cookie);
  }
});

test('a valid API token with the required scope authenticates as an api-token identity', async () => {
  const { deps, calls } = withToken(tokenRow({ scopeOrganizationId: ORG_ID }));
  const identity = await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps);
  assert.deepEqual(identity, {
    userId: USER_ID,
    email: 'ada@example.com',
    sessionId: null,
    orgScope: ORG_ID,
    via: 'api-token'
  });
  assert.deepEqual(calls.tokenLookups, [hashApiToken(API_TOKEN)]);
  assert.notEqual(calls.tokenLookups[0], API_TOKEN);
  assert.equal(calls.tokenUpdates[0].where.id, 'tok-1');
});

test('an org-scoped API token reports its own organization, never an unscoped identity', async () => {
  const { deps } = withToken(tokenRow({ scopeOrganizationId: ORG_ID }));
  const identity = await authenticateUpgrade(
    req({ authorization: `Bearer ${API_TOKEN}`, 'x-organization-id': 'some-other-org' }),
    deps
  );
  assert.equal(identity?.orgScope, ORG_ID);
});

test('an API token without the required scope is refused', async () => {
  for (const scopes of [[], ['read'], ['read', 'deploy'], ['EXEC'], ['exec:read'], [' exec']]) {
    const { deps } = withToken(tokenRow({ scopes }));
    assert.equal(
      await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps),
      null,
      JSON.stringify(scopes)
    );
  }
});

test('a scopes column that is not a list grants nothing', async () => {
  for (const scopes of ['exec', 'read,exec', { exec: true }, null]) {
    const { deps } = withToken(tokenRow({ scopes }));
    assert.equal(
      await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps),
      null,
      JSON.stringify(scopes)
    );
  }
});

test('the required scope is whatever the caller asks for', async () => {
  const { deps } = withToken(tokenRow({ scopes: ['exec'] }), { requiredScope: 'deploy' });
  assert.equal(
    await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps),
    null
  );
});

test('an expired API token is refused', async () => {
  const { deps, calls } = withToken(tokenRow({ expiresAt: new Date(Date.now() - 1000) }));
  assert.equal(
    await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps),
    null
  );
  assert.deepEqual(calls.tokenUpdates, []);
});

test('an API token that has not expired yet is accepted', async () => {
  const { deps } = withToken(tokenRow({ expiresAt: new Date(Date.now() + 60_000) }));
  const identity = await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps);
  assert.equal(identity?.via, 'api-token');
});

test('a revoked API token is refused', async () => {
  const { deps } = harness({ tokens: {} });
  assert.equal(
    await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps),
    null
  );
});

test('a project-restricted API token can never open an upgrade', async () => {
  const { deps, calls } = withToken(
    tokenRow({ restrictedProjectIds: ['cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee'] })
  );
  assert.equal(
    await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps),
    null
  );
  assert.deepEqual(calls.tokenUpdates, []);
});

test('a bearer that is neither a JWT nor an API token never reaches the token table', async () => {
  const { deps, calls } = withToken(tokenRow());
  for (const bearer of ['garbage', 'eyJhbGciOiJIUzI1NiJ9.x.y', 'ORCH_' + 'a'.repeat(64)]) {
    assert.equal(await authenticateUpgrade(req({ authorization: `Bearer ${bearer}` }), deps), null);
  }
  assert.deepEqual(calls.tokenLookups, []);
});

test('a failed lastUsedAt write does not break an accepted upgrade', async () => {
  const { deps } = withToken(tokenRow(), { failLastUsed: true });
  const identity = await authenticateUpgrade(req({ authorization: `Bearer ${API_TOKEN}` }), deps);
  assert.equal(identity?.via, 'api-token');
  await new Promise((r) => setImmediate(r));
});

test.todo(
  'an API token whose owner is turned off is refused, as the HTTP guard does with user.disabledAt'
);

test('the first session_token cookie wins over a later duplicate', () => {
  assert.equal(parseCookies('session_token=first; session_token=second').session_token, 'first');
});

test('cookie parsing ignores pairs without a name and keeps values containing =', () => {
  assert.deepEqual(parseCookies('=orphan; flag; a=b=c;  spaced = v '), { a: 'b=c', spaced: 'v' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('a __proto__ or constructor cookie cannot pollute the parsed cookie object', () => {
  const cookies = parseCookies('__proto__=x; constructor=y; toString=z; session_token=t');
  assert.equal(Object.getPrototypeOf(cookies), Object.prototype);
  assert.equal(Object.hasOwn(cookies, '__proto__'), false);
  assert.equal(Object.hasOwn(cookies, 'constructor'), false);
  assert.equal(typeof cookies.toString, 'function');
  assert.equal(cookies.session_token, 't');
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test('a refused upgrade writes the status line and always destroys the socket', () => {
  const written: string[] = [];
  let destroyed = 0;
  rejectUpgrade(
    {
      write: (d: string) => written.push(d),
      destroy: () => {
        destroyed += 1;
      }
    },
    403,
    'Forbidden'
  );
  assert.deepEqual(written, [
    'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
  ]);
  assert.equal(destroyed, 1);

  let destroyedAfterThrow = 0;
  rejectUpgrade(
    {
      write: () => {
        throw new Error('socket closed');
      },
      destroy: () => {
        destroyedAfterThrow += 1;
      }
    },
    401,
    'Unauthorized'
  );
  assert.equal(destroyedAfterThrow, 1);
});
