import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { SsoLoginService } from '../src/sso/sso-login.service';
import { IdentityMappingService } from '../src/sso/identity-mapping.service';
import { OrgIdentityService } from '../src/sso/org-identity.service';
import { collection, type Row } from './support/memory-db';

const ORG = 'org-evil';
const OTHER_ORG = 'org-other';
const PROVIDER = 'idp-evil';

function world(opts: { verifiedDomains?: string[]; settings?: Row } = {}) {
  const tables: Record<string, Row[]> = {
    user: [],
    organizationMember: [],
    idpGroupRule: [],
    idpProjectRule: [],
    projectMember: [],
    idpAutoCreateRule: [],
    federatedIdentity: [],
    scimGroupMember: [],
    scimGroup: [],
    identityProvider: [],
    organization: [
      { id: ORG, slug: 'evil', name: 'Evil' },
      { id: OTHER_ORG, slug: 'other', name: 'Other' }
    ],
    accountLink: [],
    sessionOrgGrant: [],
    session: []
  };
  const provider: Row = {
    id: PROVIDER,
    organizationId: ORG,
    name: 'Evil IdP',
    protocol: 'oidc',
    groupClaim: 'groups',
    allowedDomains: [],
    requireVerifiedEmail: false,
    jitProvisioning: true,
    defaultRole: 'member',
    createdBy: null
  };
  tables.identityProvider.push(provider);
  const audits: Row[] = [];
  const hydrateIdentity = (row: Row | undefined) =>
    row ? { ...row, user: tables.user.find((u) => u.id === row.userId) } : null;
  const prisma: any = {
    user: collection(tables, 'user', () => ({
      id: randomUUID(),
      isSuperAdmin: false,
      emailVerified: false,
      setupCompleted: false,
      emailScope: 'account',
      homeOrganizationId: null,
      disabledAt: null
    })),
    organizationMember: collection(tables, 'organizationMember', () => ({
      id: randomUUID(),
      managedByProviderId: null,
      status: 'active'
    })),
    idpGroupRule: collection(tables, 'idpGroupRule', () => ({ id: randomUUID() })),
    idpProjectRule: collection(tables, 'idpProjectRule', () => ({ id: randomUUID() })),
    projectMember: collection(tables, 'projectMember', () => ({ id: randomUUID() })),
    idpAutoCreateRule: collection(tables, 'idpAutoCreateRule'),
    federatedIdentity: collection(
      tables,
      'federatedIdentity',
      () => ({ id: randomUUID() }),
      hydrateIdentity
    ),
    scimGroupMember: collection(tables, 'scimGroupMember'),
    scimGroup: collection(tables, 'scimGroup'),
    identityProvider: collection(tables, 'identityProvider'),
    organization: collection(tables, 'organization'),
    accountLink: collection(tables, 'accountLink', () => ({ id: randomUUID() })),
    sessionOrgGrant: collection(tables, 'sessionOrgGrant'),
    orgSsoSettings: { findUnique: async () => opts.settings ?? null },
    apiToken: { deleteMany: async () => ({ count: 0 }) }
  };
  prisma.$transaction = async (arg: any) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg);
  const audit = {
    log: async (e: Row) => {
      audits.push(e);
    }
  };
  const sessions = {
    revokeSignInSessions: async () => 0,
    createSession: async (p: Row) => {
      const id = randomUUID();
      tables.session.push({ id, ...p });
      return id;
    },
    validateSession: async (id: string) => id.startsWith('live-')
  };
  const mapping = new IdentityMappingService(
    prisma,
    audit as any,
    sessions as any,
    { revoked: () => {}, invalidateInternalUserId: () => {} } as any,
    { detachMember: async () => {} } as any
  );
  const minted: Row[] = [];
  const login = Object.create(SsoLoginService.prototype) as any;
  login.logger = { warn() {}, log() {} };
  login.frontendUrl = 'https://orchard.test';
  login.prisma = prisma;
  login.audit = audit;
  login.mapping = mapping;
  login.identities = new OrgIdentityService(prisma, audit as any);
  login.domains = {
    isVerifiedFor: async (org: string, domain: string) =>
      org === ORG && (opts.verifiedDomains ?? []).includes(domain)
  };
  login.sessionsService = sessions;
  login.oauthService = {
    generateSessionTokenForUser: async (...args: any[]) => {
      minted.push({ userId: args[0], orgScope: args[5] });
      return `token-for-${args[0]}`;
    }
  };

  const signIn = (
    profile: Partial<Row> & { email: string; subject: string },
    linked?: { userId: string; sessionId: string }
  ) =>
    login.completeLogin(
      provider,
      { name: 'Someone', emailVerified: true, claims: null, ...profile },
      undefined,
      linked?.userId,
      linked?.sessionId
    );

  const account = (over: Row = {}) => {
    const row = {
      id: randomUUID(),
      email: 'ceo@bigcorp.example',
      username: 'ceo',
      emailScope: 'account',
      homeOrganizationId: null,
      emailVerified: true,
      isSuperAdmin: false,
      setupCompleted: true,
      disabledAt: null,
      ...over
    };
    tables.user.push(row);
    return row;
  };
  const member = (userId: string, organizationId = ORG, role = 'member', status = 'active') =>
    tables.organizationMember.push({ id: randomUUID(), organizationId, userId, role, status });
  const bind = (userId: string, subject: string) =>
    tables.federatedIdentity.push({ id: randomUUID(), providerId: PROVIDER, subject, userId });
  const identities = () => tables.user.filter((u) => u.homeOrganizationId === ORG);

  return { tables, provider, audits, minted, signIn, account, member, bind, identities };
}

test('A1/A2: forging an existing account email (verified or not) only creates an org identity', async () => {
  for (const emailVerified of [true, undefined, 'yes']) {
    const w = world();
    const ceo = w.account();
    w.member(ceo.id, OTHER_ORG, 'owner');
    await w.signIn({ email: ceo.email, subject: 'forged', emailVerified });

    assert.notEqual(w.minted[0].userId, ceo.id, 'never a session for the real account');
    assert.equal(w.minted[0].orgScope, ORG, 'the session is confined to the org');
    assert.ok(!w.tables.federatedIdentity.some((f) => f.userId === ceo.id));
    assert.equal(
      w.tables.organizationMember.filter((m) => m.userId === ceo.id).length,
      1,
      'the real account gains no membership'
    );
    const identity = w.identities()[0];
    assert.equal(identity.emailScope, ORG);
    assert.equal(identity.email, ceo.email);
    assert.match(identity.username, /-evil$/, 'A9: org identities never get a bare username');
  }
});

test('A1: an account that is a member of the org is still not signed in by the IdP alone', async () => {
  const w = world();
  const ceo = w.account();
  w.member(ceo.id, ORG, 'admin');
  await w.signIn({ email: ceo.email, subject: 'forged' });
  assert.notEqual(w.minted[0].userId, ceo.id);
  assert.ok(!w.tables.federatedIdentity.some((f) => f.userId === ceo.id));
});

test('A1: an account bound before, outside a verified domain, needs its own session', async () => {
  const w = world();
  const ceo = w.account();
  w.member(ceo.id, ORG);
  w.bind(ceo.id, 'real-subject');
  await assert.rejects(
    () => w.signIn({ email: ceo.email, subject: 'real-subject' }),
    (e: any) => e.getResponse().message === 'sso_sign_in_first'
  );
  assert.equal(w.minted.length, 0);
});

test('the person passing the org IdP from their own session gets a grant, not a new session', async () => {
  const w = world();
  const ceo = w.account();
  w.member(ceo.id, ORG);
  const result = await w.signIn(
    { email: 'whatever@idp.example', subject: 'their-subject' },
    { userId: ceo.id, sessionId: 'live-ceo-session' }
  );
  assert.equal(result.token, undefined, 'the browser keeps its own session cookie');
  assert.equal(w.minted.length, 0);
  assert.equal(w.tables.sessionOrgGrant.length, 1);
  assert.equal(w.tables.sessionOrgGrant[0].sessionId, 'live-ceo-session');
  assert.equal(w.tables.sessionOrgGrant[0].organizationId, ORG);
  assert.ok(w.tables.sessionOrgGrant[0].expiresAt > new Date());
  assert.equal(w.tables.federatedIdentity[0].userId, ceo.id, 'the subject binds to the account');

  const again = await w.signIn(
    { email: 'whatever@idp.example', subject: 'their-subject' },
    { userId: ceo.id, sessionId: 'live-ceo-session' }
  );
  assert.equal(again.token, undefined);
  await assert.rejects(
    () => w.signIn({ email: 'whatever@idp.example', subject: 'their-subject' }),
    (e: any) => e.getResponse().message === 'sso_sign_in_first',
    'without the session, the bound subject alone is not enough'
  );
});

test('a revoked account session cannot be granted entry', async () => {
  const w = world();
  const ceo = w.account();
  w.member(ceo.id, ORG);
  await assert.rejects(
    () =>
      w.signIn(
        { email: 'x@idp.example', subject: 's' },
        { userId: ceo.id, sessionId: 'revoked-session' }
      ),
    /SSO authentication failed/
  );
  assert.equal(w.tables.sessionOrgGrant.length, 0);
});

test('a non-member signing in from their account gets an org identity linked to it', async () => {
  const w = world();
  const me = w.account({ email: 'me@personal.example' });
  const result = await w.signIn(
    { email: 'me@work.example', subject: 'work-subject' },
    { userId: me.id, sessionId: 'live-me' }
  );
  const identity = w.identities()[0];
  assert.equal(result.userId, identity.id);
  assert.equal(w.tables.accountLink.length, 1);
  assert.equal(w.tables.accountLink[0].accountUserId, me.id);
  assert.equal(w.tables.accountLink[0].identityUserId, identity.id);
  assert.equal(w.minted[0].orgScope, ORG);
  assert.ok(!w.tables.organizationMember.some((m) => m.userId === me.id));
});

test('a verified domain lets the org sign in its own legacy accounts, confined, but never owners', async () => {
  const w = world({ verifiedDomains: ['bigcorp.example'] });
  const emp = w.account({ email: 'emp@bigcorp.example' });
  w.member(emp.id, ORG);
  w.bind(emp.id, 'emp-subject');
  await w.signIn({ email: emp.email, subject: 'emp-subject' });
  assert.deepEqual(w.minted[0], { userId: emp.id, orgScope: ORG });

  const boss = w.account({ email: 'boss@bigcorp.example' });
  w.member(boss.id, ORG, 'owner');
  w.bind(boss.id, 'boss-subject');
  await assert.rejects(
    () => w.signIn({ email: boss.email, subject: 'boss-subject' }),
    (e: any) => e.getResponse().message === 'sso_sign_in_first'
  );
});

test('superadmins are never reached through an org IdP, bound or from their session', async () => {
  const w = world({ verifiedDomains: ['bigcorp.example'] });
  const root = w.account({ email: 'root@bigcorp.example', isSuperAdmin: true });
  w.member(root.id, ORG);
  w.bind(root.id, 'root-subject');
  await assert.rejects(() => w.signIn({ email: root.email, subject: 'root-subject' }));
  const root2 = w.account({ email: 'root2@bigcorp.example', isSuperAdmin: true });
  w.member(root2.id, ORG);
  await assert.rejects(() =>
    w.signIn({ email: 'x@y.example', subject: 'new' }, { userId: root2.id, sessionId: 'live-r' })
  );
});

test("A16: an identity bound to one org's provider is refused if presented elsewhere", async () => {
  const w = world();
  w.tables.user.push({
    id: 'foreign',
    email: 'f@x.example',
    emailScope: OTHER_ORG,
    homeOrganizationId: OTHER_ORG,
    username: 'f-other',
    setupCompleted: true,
    disabledAt: null
  });
  w.bind('foreign', 'foreign-subject');
  await assert.rejects(() => w.signIn({ email: 'f@x.example', subject: 'foreign-subject' }));
});

test('A17: a recycled email with a new subject never inherits the old identity', async () => {
  const w = world();
  await w.signIn({ email: 'jane@corp.example', subject: 'jane-1' });
  await assert.rejects(
    () => w.signIn({ email: 'jane@corp.example', subject: 'jane-2' }),
    /SSO authentication failed/
  );
  assert.equal(w.identities().length, 1);
  assert.ok(w.audits.some((a) => a.metadata?.reason === 'subject_mismatch'));
});

test('a disabled identity or membership is told so and gets no session', async () => {
  const w = world();
  await w.signIn({ email: 'gone@corp.example', subject: 'gone' });
  w.tables.organizationMember.find((m) => m.organizationId === ORG)!.status = 'disabled';
  await assert.rejects(
    () => w.signIn({ email: 'gone@corp.example', subject: 'gone' }),
    /sso_access_disabled/
  );
  assert.equal(w.minted.length, 1);
});

test('SCIM-only orgs refuse JIT but sign in identities SCIM already provisioned', async () => {
  const w = world({ settings: { scimOnlySignIn: true, maxSessionHours: 8 } });
  await assert.rejects(() => w.signIn({ email: 'walkin@corp.example', subject: 'w' }));
  assert.equal(w.identities().length, 0);

  w.tables.user.push({
    id: 'scim-1',
    email: 'pre@corp.example',
    emailScope: ORG,
    homeOrganizationId: ORG,
    username: 'pre-evil',
    setupCompleted: true,
    disabledAt: null
  });
  w.member('scim-1');
  await w.signIn({ email: 'pre@corp.example', subject: 'pre' });
  assert.equal(w.minted[0].userId, 'scim-1');
  const session = w.tables.session.at(-1)!;
  assert.equal(session.ttlMs, 8 * 60 * 60_000, 'F1: org identity sessions use the org lifetime');
});

test('A8: JIT stops at the per-org identity cap', async () => {
  const previous = process.env.ORG_IDENTITY_CAP;
  process.env.ORG_IDENTITY_CAP = '2';
  try {
    const w = world();
    await w.signIn({ email: 'a@corp.example', subject: 'a' });
    await w.signIn({ email: 'b@corp.example', subject: 'b' });
    await assert.rejects(
      () => w.signIn({ email: 'c@corp.example', subject: 'c' }),
      /sso_member_limit/
    );
    assert.equal(w.identities().length, 2);
  } finally {
    if (previous === undefined) delete process.env.ORG_IDENTITY_CAP;
    else process.env.ORG_IDENTITY_CAP = previous;
  }
});

test('A3: JIT never creates an owner even when the provider default says so', async () => {
  const w = world();
  w.provider.defaultRole = 'owner';
  await w.signIn({ email: 'x@corp.example', subject: 'x' });
  assert.equal(w.tables.organizationMember.at(-1)!.role, 'member');
});
