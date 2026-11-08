import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { IdentityMappingService } from '../src/sso/identity-mapping.service';
import { OidcStateStore } from '../src/sso/oidc-state.store';
import { SsoLoginService } from '../src/sso/sso-login.service';
import { collection as memoryCollection, type Row } from './support/memory-db';

const ISSUER = 'https://idp.test';
const REDIRECT = 'https://orchard.test/apiv1/sso/prov/callback';
const CLIENT_ID = 'orchard-client';
const ORG = 'org-a';
const PROVIDER_ID = 'prov';

interface Scenario {
  signWith?: 'good' | 'other';
  issuer?: string;
  audience?: string;
  nonce?: string | null;
  groups?: unknown;
  extra?: Record<string, unknown>;
  email?: string;
  sub?: string;
  emailVerified?: boolean;
  expired?: boolean;
}

const keys: { good?: any; other?: any; goodJwk?: any } = {};
let server: Server;
let base = '';
let scenario: Scenario = {};
const codes = new Map<string, { nonce: string; challenge: string }>();

before(async () => {
  keys.good = await generateKeyPair('RS256');
  keys.other = await generateKeyPair('RS256');
  keys.goodJwk = { ...(await exportJWK(keys.good.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic']
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [keys.goodJwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const grant = codes.get(form.get('code') ?? '');
      if (!grant) return json(400, { error: 'invalid_grant' });
      codes.delete(form.get('code')!);
      const expected = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (expected !== grant.challenge) return json(400, { error: 'invalid_grant' });

      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        sub: scenario.sub ?? 'subject-1',
        email: scenario.email ?? 'ada@corp.example',
        email_verified: scenario.emailVerified ?? true,
        name: 'Ada Lovelace',
        ...(scenario.groups === undefined ? {} : { groups: scenario.groups }),
        ...scenario.extra
      };
      if (scenario.nonce !== null) claims.nonce = scenario.nonce ?? grant.nonce;
      const signer = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(scenario.issuer ?? ISSUER)
        .setAudience(scenario.audience ?? CLIENT_ID)
        .setIssuedAt(scenario.expired ? now - 7200 : now)
        .setExpirationTime(scenario.expired ? now - 3600 : now + 300);
      const idToken = await signer.sign(
        (scenario.signWith === 'other' ? keys.other : keys.good).privateKey
      );
      return json(200, {
        access_token: 'access',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken
      });
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function makeWorld() {
  const tables: Record<string, Row[]> = {
    user: [],
    organizationMember: [],
    idpGroupRule: [],
    idpAutoCreateRule: [],
    federatedIdentity: [],
    scimGroupMember: [],
    scimGroup: [],
    identityProvider: []
  };
  const audits: Row[] = [];
  const sessionWipes: Row[] = [];
  const detached: string[] = [];
  const created: string[] = [];

  const provider: Row = {
    id: PROVIDER_ID,
    organizationId: ORG,
    name: 'Corp',
    protocol: 'oidc',
    issuerUrl: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    scopes: 'openid email profile',
    groupClaim: 'groups',
    allowedDomains: ['corp.example'],
    requireVerifiedEmail: true,
    jitProvisioning: true,
    defaultRole: 'member',
    createdBy: 'someone',
    enabled: true
  };
  tables.identityProvider.push(provider);

  const hydrateIdentity = (row: Row | undefined) =>
    row ? { ...row, user: tables.user.find((u) => u.id === row.userId) } : null;
  const col = (name: string, defaults?: () => Row, hydrate?: any) =>
    memoryCollection(tables, name, defaults, hydrate);
  const prisma: any = {
    user: col('user', () => ({
      id: randomUUID(),
      isSuperAdmin: false,
      emailVerified: false,
      setupCompleted: false
    })),
    organizationMember: col('organizationMember', () => ({
      id: randomUUID(),
      managedByProviderId: null
    })),
    idpGroupRule: col('idpGroupRule', () => ({ id: randomUUID() })),
    idpAutoCreateRule: col('idpAutoCreateRule'),
    federatedIdentity: col('federatedIdentity', () => ({ id: randomUUID() }), hydrateIdentity),
    scimGroupMember: col('scimGroupMember'),
    scimGroup: col('scimGroup'),
    identityProvider: col('identityProvider'),
    organizationInvitation: { findFirst: async () => null },
    orgSsoSettings: { findUnique: async () => ({ enabled: true, platformEnabled: true }) },
    apiToken: { deleteMany: async () => ({ count: 0 }) }
  };
  prisma.$transaction = async (arg: any) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg);

  const audit = { log: async (e: Row) => void audits.push(e) };
  const sessions = {
    revokeSignInSessions: async (p: Row) => {
      sessionWipes.push(p);
      return 0;
    },
    createSession: async () => 'session-1'
  };
  const mapping = new IdentityMappingService(
    prisma,
    audit as any,
    sessions as any,
    { revoked: () => {}, invalidateInternalUserId: () => {} } as any,
    {
      detachMember: async (member: Row) => {
        detached.push(member.userId);
        const i = tables.organizationMember.findIndex((m) => m.id === member.id);
        tables.organizationMember.splice(i, 1);
      }
    } as any
  );

  const login = Object.create(SsoLoginService.prototype) as any;
  login.logger = { warn() {}, log() {} };
  login.frontendUrl = 'https://orchard.test';
  login.prisma = prisma;
  login.audit = audit;
  login.mapping = mapping;
  login.stateStore = new OidcStateStore();
  login.crypto = { decryptOrNull: (v: string | null) => v };
  login.domains = { isVerifiedFor: async () => true };
  login.authz = {};
  login.sessionsService = sessions;
  login.oauthService = { generateSessionTokenForUser: async () => 'session-token' };
  login.sso = {
    callbackUrl: () => REDIRECT,
    fetchIdp: (url: string | URL, init?: RequestInit) => {
      const target = new URL(typeof url === 'string' ? url : url.href);
      assert.equal(target.origin, ISSUER, 'the client may only talk to the pinned issuer');
      return fetch(`${base}${target.pathname}${target.search}`, init);
    }
  };
  login.createUser = async (email: string, name: string) => {
    created.push(email);
    const user = await prisma.user.create({
      data: { id: randomUUID(), email, username: email.split('@')[0], firstName: name }
    });
    return user;
  };

  return { tables, prisma, audits, sessionWipes, detached, created, provider, login };
}

type World = ReturnType<typeof makeWorld>;

async function signIn(w: World, overrides: Scenario = {}) {
  scenario = overrides;
  const authorizationUrl: string = await w.login.startOidc(w.provider);
  const authorize = new URL(authorizationUrl);
  assert.equal(authorize.origin, ISSUER);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const state = authorize.searchParams.get('state')!;
  const code = randomUUID();
  codes.set(code, {
    nonce: authorize.searchParams.get('nonce')!,
    challenge: authorize.searchParams.get('code_challenge')!
  });
  const callback = new URL(`${REDIRECT}?code=${code}&state=${state}`);
  return { callback, state };
}

async function complete(w: World, overrides: Scenario = {}) {
  const { callback, state } = await signIn(w, overrides);
  return w.login.handleOidcCallback(PROVIDER_ID, callback, state);
}

function rule(w: World, value: string, role: string) {
  w.tables.idpGroupRule.push({
    id: randomUUID(),
    providerId: PROVIDER_ID,
    organizationId: ORG,
    value,
    role
  });
}

async function rejected(promise: Promise<unknown>, pattern?: RegExp) {
  try {
    await promise;
  } catch (err: any) {
    assert.ok(!(err instanceof TypeError), `harness error, not a rejection: ${err?.stack}`);
    if (pattern) assert.match(String(err?.message), pattern);
    return err;
  }
  assert.fail('expected the sign-in to be rejected');
}

const memberOf = (w: World) => w.tables.organizationMember.find((m) => m.organizationId === ORG);

test('a validated ID token provisions a new member with the mapped role', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  rule(w, 'everyone', 'member');

  const result = await complete(w, { groups: ['everyone', 'orchard-admins'] });
  assert.equal(result.token, 'session-token');

  const user = w.tables.user.find((u) => u.email === 'ada@corp.example')!;
  assert.ok(user);
  assert.equal(memberOf(w)?.userId, user.id);
  assert.equal(memberOf(w)?.role, 'admin');
  assert.equal(memberOf(w)?.managedByProviderId, PROVIDER_ID);
  assert.equal(w.tables.federatedIdentity[0].subject, 'subject-1');
  assert.ok(w.audits.some((a) => a.action === 'sso.member.role_synced'));
});

test('groups are read from a dotted claim path in the ID token', async () => {
  const w = makeWorld();
  w.provider.groupClaim = 'realm_access.roles';
  rule(w, 'staff', 'member');
  await complete(w, { extra: { realm_access: { roles: ['staff'] } } });
  assert.equal(memberOf(w)?.role, 'member');
});

test('a user in no mapped group is denied before an account exists', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');

  await assert.rejects(
    () => complete(w, { groups: ['sales'] }),
    (err: any) => err.message === 'sso_not_mapped'
  );
  assert.deepEqual(w.created, []);
  assert.equal(w.tables.organizationMember.length, 0);
  assert.ok(
    w.audits.some(
      (a) => a.action === 'sso.login.denied' && a.metadata.reason === 'no_matching_rule'
    )
  );
});

test('a token with no groups claim at all is denied when rules exist', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await assert.rejects(
    () => complete(w),
    (err: any) => err.message === 'sso_not_mapped'
  );
});

test('an overage marker means unknown groups and never grants', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await assert.rejects(
    () => complete(w, { extra: { _claim_names: { groups: 'src1' } } }),
    (err: any) => err.message === 'sso_not_mapped'
  );
  assert.ok(w.audits.some((a) => a.metadata?.reason === 'groups_overage'));
  assert.deepEqual(w.created, []);
});

test('the next login re-syncs: a demotion applies and removal revokes access', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  rule(w, 'everyone', 'member');

  await complete(w, { groups: ['orchard-admins'] });
  assert.equal(memberOf(w)?.role, 'admin');

  await complete(w, { groups: ['everyone'] });
  assert.equal(memberOf(w)?.role, 'member');
  assert.ok(w.sessionWipes.length >= 1, 'a downgrade revokes the SSO sessions');

  await assert.rejects(
    () => complete(w, { groups: ['unrelated'] }),
    (err: any) => err.message === 'sso_not_mapped'
  );
  assert.equal(memberOf(w), undefined, 'losing every mapped group removes the membership');
  assert.equal(w.detached.length, 1);
  assert.ok(w.audits.some((a) => a.action === 'sso.member.removed'));
});

test('an owner keeps their role whatever the token says', async () => {
  const w = makeWorld();
  rule(w, 'everyone', 'member');
  const owner = await w.prisma.user.create({
    data: { id: 'boss', email: 'ada@corp.example', username: 'ada', emailVerified: true }
  });
  w.provider.createdBy = owner.id;
  w.tables.organizationMember.push({
    id: 'm1',
    organizationId: ORG,
    userId: owner.id,
    role: 'owner',
    managedByProviderId: null
  });

  await complete(w, { groups: ['everyone'] });
  assert.equal(memberOf(w)?.role, 'owner');
});

test('a token signed by another key is rejected and nothing is provisioned', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await rejected(
    complete(w, { signWith: 'other', groups: ['orchard-admins'] }),
    /SSO authentication failed/
  );
  assert.deepEqual(w.created, []);
  assert.equal(w.tables.organizationMember.length, 0);
  assert.equal(w.tables.federatedIdentity.length, 0);
});

test('a token from a different issuer is rejected', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await rejected(
    complete(w, { issuer: 'https://evil.test', groups: ['orchard-admins'] }),
    /unexpected JWT claim value/
  );
  assert.deepEqual(w.created, []);
});

test('a token minted for another client is rejected', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await rejected(
    complete(w, { audience: 'someone-else', groups: ['orchard-admins'] }),
    /unexpected JWT claim value/
  );
  assert.deepEqual(w.created, []);
});

test('a token with the wrong or missing nonce is rejected', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await rejected(
    complete(w, { nonce: 'replayed-nonce', groups: ['orchard-admins'] }),
    /unexpected JWT claim value/
  );
  await rejected(complete(w, { nonce: null, groups: ['orchard-admins'] }), /invalid response/);
  assert.deepEqual(w.created, []);
});

test('an expired token is rejected', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await rejected(complete(w, { expired: true, groups: ['orchard-admins'] }), /timestamp claim/);
  assert.deepEqual(w.created, []);
});

test('an unverified email is refused even with the right groups', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  await assert.rejects(
    () => complete(w, { emailVerified: false, groups: ['orchard-admins'] }),
    /email not verified/
  );
  assert.deepEqual(w.created, []);
});

test('SSO state is single use and bound to its provider', async () => {
  const w = makeWorld();
  rule(w, 'orchard-admins', 'admin');
  const { callback, state } = await signIn(w, { groups: ['orchard-admins'] });
  await w.login.handleOidcCallback(PROVIDER_ID, callback, state);
  await assert.rejects(
    () => w.login.handleOidcCallback(PROVIDER_ID, callback, state),
    /Invalid or expired SSO state/
  );

  const other = await signIn(w, { groups: ['orchard-admins'] });
  await assert.rejects(
    () => w.login.handleOidcCallback('another-provider', other.callback, other.state),
    /Provider mismatch/
  );
});
