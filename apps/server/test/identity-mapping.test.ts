import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { IdentityMappingService, cleanSubject } from '../src/sso/identity-mapping.service';
import { SsoLoginService } from '../src/sso/sso-login.service';

type Row = Record<string, any>;

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

class Fake {
  rules: Row[] = [];

  members: Row[] = [];

  identities: Row[] = [];

  providers: Row[] = [];

  orgs = new Set(['orgA', 'orgB']);

  tokensDeleted: Row[] = [];

  audits: Row[] = [];

  revoked: Row[] = [];

  cacheRevoked: Array<[string, string]> = [];

  detached: string[] = [];

  prisma: any = {
    idpGroupRule: {
      findMany: async ({ where }: any) =>
        this.rules.filter((r) => !where?.providerId || r.providerId === where.providerId),
      findFirst: async ({ where }: any) =>
        this.rules.find(
          (r) =>
            where.organizationId.in.includes(r.organizationId) &&
            r.providerId !== where.providerId.not
        ) ?? null,
      deleteMany: async ({ where }: any) => {
        this.rules = this.rules.filter((r) => !where.id.in.includes(r.id));
      },
      update: async ({ where, data }: any) => {
        Object.assign(
          this.rules.find((r) => r.id === where.id)!,
          data
        );
      },
      createMany: async ({ data }: any) => {
        for (const d of data) this.rules.push({ id: id('rule'), ...d });
      }
    },
    identityProvider: {
      findFirst: async ({ where }: any) =>
        this.providers.find(
          (p) => p.id === where.id && p.organizationId === where.organizationId
        ) ?? null,
      update: async ({ where, data }: any) => {
        Object.assign(
          this.providers.find((p) => p.id === where.id)!,
          data
        );
      }
    },
    organization: {
      findMany: async ({ where }: any) =>
        where.id.in.filter((o: string) => this.orgs.has(o)).map((o: string) => ({ id: o }))
    },
    organizationMember: {
      findMany: async ({ where }: any) =>
        this.members.filter(
          (m) =>
            (!where.userId || m.userId === where.userId) &&
            (!where.managedByProviderId || m.managedByProviderId === where.managedByProviderId)
        ),
      findUnique: async ({ where }: any) => {
        const row = this.members.find(
          (m) =>
            m.organizationId === where.organizationId_userId.organizationId &&
            m.userId === where.organizationId_userId.userId
        );
        return row ? { ...row } : null;
      },
      create: async ({ data }: any) => {
        this.members.push({ id: id('m'), ...data });
      },
      update: async ({ where, data }: any) => {
        Object.assign(
          this.members.find((m) => m.id === where.id)!,
          data
        );
      }
    },
    apiToken: {
      deleteMany: async ({ where }: any) => {
        this.tokensDeleted.push(where);
      }
    },
    federatedIdentity: {
      findUnique: async ({ where }: any) => {
        if (where.providerId_subject) {
          const w = where.providerId_subject;
          const row = this.identities.find(
            (i) => i.providerId === w.providerId && i.subject === w.subject
          );
          return row
            ? { ...row, user: { id: row.userId, email: `${row.userId}@x.example` } }
            : null;
        }
        const w = where.providerId_userId;
        return (
          this.identities.find((i) => i.providerId === w.providerId && i.userId === w.userId) ??
          null
        );
      },
      create: async ({ data }: any) => {
        this.identities.push({ id: id('fi'), ...data });
      },
      update: async ({ where, data }: any) => {
        Object.assign(
          this.identities.find((i) => i.id === where.id)!,
          data
        );
      }
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops)
  };

  service = new IdentityMappingService(
    this.prisma,
    {
      log: async (e: Row) => {
        this.audits.push(e);
      }
    } as any,
    {
      revokeSignInSessions: async (p: Row) => {
        this.revoked.push(p);
        return 1;
      }
    } as any,
    {
      revoked: (o: string, u: string) => {
        this.cacheRevoked.push([o, u]);
      },
      invalidateInternalUserId: () => {}
    } as any,
    {
      detachMember: async (m: Row) => {
        this.detached.push(m.userId);
        this.members = this.members.filter((x) => x.id !== m.id);
      }
    } as any
  );

  orgProvider(extra: Row = {}) {
    const p = {
      id: 'pA',
      organizationId: 'orgA',
      protocol: 'oidc',
      name: 'Okta',
      groupClaim: 'groups',
      ...extra
    };
    this.providers.push(p);
    return p as any;
  }

  instanceProvider(extra: Row = {}) {
    const p = {
      id: 'pI',
      organizationId: null,
      protocol: 'saml',
      name: 'Corp',
      groupClaim: 'groups',
      ...extra
    };
    this.providers.push(p);
    return p as any;
  }

  rule(providerId: string, organizationId: string, value: string, role: string) {
    this.rules.push({ id: id('rule'), providerId, organizationId, value, role });
  }

  member(organizationId: string, userId: string, role: string, managedByProviderId: string | null) {
    this.members.push({ id: id('m'), organizationId, userId, role, managedByProviderId });
  }

  roleOf(organizationId: string, userId: string) {
    return this.members.find((m) => m.organizationId === organizationId && m.userId === userId)
      ?.role;
  }
}

const u1 = { id: 'u1', email: 'u1@corp.example' };
const owner = { userId: 'actor', email: 'actor@corp.example' };

async function login(f: Fake, provider: any, groups: unknown, user = u1) {
  const ctx = await f.service.prepare(provider, { groups });
  if (ctx.hasRules && !ctx.allowed) {
    await f.service.deny(provider, ctx, { email: user.email, userId: user.id });
  }
  await f.service.apply(provider, user, ctx);
  return ctx;
}

test('an org without rules behaves exactly as before: allowed, nothing touched', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.member('orgA', 'u1', 'admin', null);
  const ctx = await login(f, p, ['anything']);
  assert.equal(ctx.hasRules, false);
  assert.equal(ctx.allowed, true);
  assert.equal(f.roleOf('orgA', 'u1'), 'admin');
  assert.equal(f.audits.length, 0);
});

test('roles re-sync on every login and a downgrade revokes sessions and tokens', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  f.rule('pA', 'orgA', 'leads', 'admin');
  f.member('orgA', 'u1', 'admin', null);

  await login(f, p, ['eng']);
  assert.equal(f.roleOf('orgA', 'u1'), 'member');
  assert.equal(f.revoked.length, 1);
  assert.deepEqual(f.revoked[0].userIds, ['u1']);
  assert.deepEqual(f.revoked[0].authMethods, ['sso']);
  assert.deepEqual(f.tokensDeleted[0], { userId: 'u1', scopeOrganizationId: 'orgA' });
  assert.deepEqual(f.cacheRevoked, [['orgA', 'u1']]);
  const synced = f.audits.find((a) => a.action === 'sso.member.role_synced')!;
  assert.equal(synced.metadata.from, 'admin');
  assert.equal(synced.metadata.to, 'member');
  assert.equal(synced.organizationId, 'orgA');
  assert.equal(synced.metadata.provider_id, 'pA');
  assert.equal(synced.metadata.rule_ids.length, 1);

  await login(f, p, ['eng', 'leads']);
  assert.equal(f.roleOf('orgA', 'u1'), 'admin');
  assert.equal(f.revoked.length, 1);
});

test('a user matching no rule is denied once rules exist, and nothing is created', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  const ctx = await f.service.prepare(p, { groups: ['sales'] });
  assert.equal(ctx.allowed, false);
  await assert.rejects(
    () => f.service.deny(p, ctx, { email: u1.email }),
    (e: any) => e instanceof UnauthorizedException && e.message === 'sso_not_mapped'
  );
  assert.equal(f.members.length, 0);
  const denied = f.audits.find((a) => a.action === 'sso.login.denied')!;
  assert.equal(denied.metadata.reason, 'no_matching_rule');
  assert.equal(denied.targetId, 'pA');
});

test('a denied user who was granted by rules loses the membership and sessions', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  f.member('orgA', 'u1', 'member', 'pA');
  await assert.rejects(() => login(f, p, ['sales']), UnauthorizedException);
  assert.equal(f.roleOf('orgA', 'u1'), undefined);
  assert.deepEqual(f.detached, ['u1']);
  assert.equal(f.revoked.length, 1);
  assert.ok(f.audits.some((a) => a.action === 'sso.member.removed'));
});

test('a denied user whose membership was not rule-granted keeps it', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  f.member('orgA', 'u1', 'member', null);
  await assert.rejects(() => login(f, p, ['sales']), UnauthorizedException);
  assert.equal(f.roleOf('orgA', 'u1'), 'member');
  assert.equal(f.detached.length, 0);
});

test('owners are never changed or removed by rules', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'guest');
  f.member('orgA', 'u1', 'owner', 'pA');
  const ctx = await f.service.prepare(p, { groups: ['eng'] });
  await f.service.apply(p, u1, ctx);
  assert.equal(f.roleOf('orgA', 'u1'), 'owner');
  const none = await f.service.prepare(p, { groups: [] });
  await f.service.apply(p, u1, none);
  assert.equal(f.roleOf('orgA', 'u1'), 'owner');
  assert.equal(f.revoked.length, 0);
});

test('overage and oversized claims deny without removing anyone', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  f.member('orgA', 'u1', 'member', 'pA');
  for (const claims of [
    { hasgroups: true },
    { groups: Array.from({ length: 501 }, (_, i) => `g${i}`) }
  ]) {
    const ctx = await f.service.prepare(p, claims);
    assert.equal(ctx.allowed, false);
    await assert.rejects(() => f.service.deny(p, ctx, { email: u1.email, userId: 'u1' }));
  }
  assert.equal(f.roleOf('orgA', 'u1'), 'member');
  assert.equal(f.detached.length, 0);
  assert.ok(f.audits.every((a) => a.metadata.reason.startsWith('groups_')));
});

test('a protocol that cannot carry groups is denied when rules exist', async () => {
  const f = new Fake();
  const p = f.orgProvider({ protocol: 'oauth2' });
  f.rule('pA', 'orgA', 'eng', 'member');
  const ctx = await f.service.prepare(p, null);
  assert.equal(ctx.allowed, false);
});

test('an org provider only ever maps into its own org, even with a stray rule row', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgB', 'eng', 'admin');
  f.member('orgB', 'u1', 'member', 'pA');
  const ctx = await f.service.prepare(p, { groups: ['eng'] });
  assert.equal(ctx.hasRules, true);
  assert.equal(ctx.allowed, false);
  await f.service.apply(p, u1, ctx);
  assert.equal(f.roleOf('orgB', 'u1'), 'member');
});

test('the same group name in a claim from another org provider grants nothing here', async () => {
  const f = new Fake();
  const evil = f.orgProvider({ id: 'pEvil', organizationId: 'orgB' });
  f.rule('pEvil', 'orgB', 'admins', 'admin');
  const ctx = await f.service.prepare(evil, { groups: ['admins'] });
  assert.deepEqual([...ctx.decisions.keys()], ['orgB']);
  await f.service.apply(evil, u1, ctx);
  assert.equal(f.roleOf('orgA', 'u1'), undefined);
  assert.equal(f.roleOf('orgB', 'u1'), 'admin');
});

test('instance rules provision memberships in their target orgs and drop only managed ones', async () => {
  const f = new Fake();
  const p = f.instanceProvider();
  f.rule('pI', 'orgA', 'eng', 'member');
  f.rule('pI', 'orgB', 'eng', 'admin');
  f.member('orgB', 'u1', 'guest', null);

  await login(f, p, ['eng']);
  assert.equal(f.roleOf('orgA', 'u1'), 'member');
  assert.equal(f.roleOf('orgB', 'u1'), 'admin');
  assert.equal(f.members.find((m) => m.organizationId === 'orgA')!.managedByProviderId, 'pI');
  assert.ok(
    f.audits.some((a) => a.action === 'sso.member.provisioned' && a.organizationId === 'orgA')
  );

  f.member('orgB', 'u1', 'owner', 'pI');
  f.members = f.members.filter((m) => !(m.organizationId === 'orgB' && m.role === 'admin'));
  f.rules = f.rules.filter((r) => r.organizationId !== 'orgB');
  await assert.rejects(() => login(f, p, ['sales']), UnauthorizedException);
  assert.equal(f.roleOf('orgA', 'u1'), undefined);
  assert.equal(f.roleOf('orgB', 'u1'), 'owner');
});

test('instance rules cannot grant owner even when stored', async () => {
  const f = new Fake();
  const p = f.instanceProvider();
  f.rule('pI', 'orgA', 'root', 'owner');
  const ctx = await f.service.prepare(p, { groups: ['root'] });
  assert.equal(ctx.allowed, false);
});

test('replaceRules refuses owner, bad scripts, duplicates and oversized sets', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  const put = (rules: any[]) => f.service.replaceRules(p, { rules }, owner);
  await assert.rejects(() => put([{ value: 'x', role: 'owner' }]), BadRequestException);
  await assert.rejects(() => put([{ value: 'x', role: 'superadmin' }]), BadRequestException);
  await assert.rejects(() => put([{ value: 'Аdmins', role: 'admin' }]), BadRequestException);
  await assert.rejects(() => put([{ value: '', role: 'admin' }]), BadRequestException);
  await assert.rejects(
    () =>
      put([
        { value: 'x', role: 'admin' },
        { value: ' x ', role: 'member' }
      ]),
    BadRequestException
  );
  await assert.rejects(
    () => put(Array.from({ length: 1001 }, (_, i) => ({ value: `g${i}`, role: 'member' }))),
    BadRequestException
  );
  await assert.rejects(
    () => f.service.replaceRules(p, { groupClaim: '__proto__', rules: [] }, owner),
    BadRequestException
  );
  assert.equal(f.rules.length, 0);
});

test('an org owner cannot target another org or an instance-style target', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  await assert.rejects(
    () =>
      f.service.replaceRules(
        p,
        { rules: [{ value: 'x', role: 'admin', organizationId: 'orgB' }] },
        owner
      ),
    BadRequestException
  );
  await f.service.replaceRules(
    p,
    { rules: [{ value: 'x', role: 'admin', organizationId: 'orgA' }] },
    owner
  );
  assert.equal(f.rules[0].organizationId, 'orgA');
});

test('instance rules need an existing target org', async () => {
  const f = new Fake();
  const p = f.instanceProvider();
  await assert.rejects(
    () => f.service.replaceRules(p, { rules: [{ value: 'x', role: 'member' }] }, owner),
    BadRequestException
  );
  await assert.rejects(
    () =>
      f.service.replaceRules(
        p,
        { rules: [{ value: 'x', role: 'member', organizationId: 'nope' }] },
        owner
      ),
    BadRequestException
  );
  await f.service.replaceRules(
    p,
    { rules: [{ value: 'x', role: 'member', organizationId: 'orgB' }] },
    owner
  );
  assert.equal(f.rules.length, 1);
});

test('two providers cannot both hold rules for the same org', async () => {
  const f = new Fake();
  const a = f.orgProvider();
  f.orgProvider({ id: 'pA2' });
  f.rule('pA2', 'orgA', 'x', 'member');
  await assert.rejects(
    () => f.service.replaceRules(a, { rules: [{ value: 'y', role: 'member' }] }, owner),
    ConflictException
  );
});

test('changing rules is audited, and lowering or removing revokes managed members', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'admin');
  f.rule('pA', 'orgA', 'ops', 'member');
  f.member('orgA', 'u1', 'admin', 'pA');
  f.member('orgA', 'u2', 'member', null);

  await f.service.replaceRules(
    p,
    {
      rules: [
        { value: 'eng', role: 'member' },
        { value: 'qa', role: 'guest' }
      ]
    },
    owner
  );
  assert.deepEqual(f.revoked[0].userIds, ['u1']);
  const audit = f.audits.find((a) => a.action === 'sso.rules.updated')!;
  assert.deepEqual(audit.metadata.added, ['guest:qa']);
  assert.deepEqual(audit.metadata.removed, ['member:ops']);
  assert.deepEqual(audit.metadata.changed, ['eng:admin>member']);
  assert.equal(audit.metadata.revoked_members, 1);
  assert.equal(audit.actorUserId, 'actor');
  assert.equal(audit.organizationId, 'orgA');
});

test('adding or raising rules does not revoke anyone', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  f.member('orgA', 'u1', 'member', 'pA');
  await f.service.replaceRules(
    p,
    {
      rules: [
        { value: 'eng', role: 'admin' },
        { value: 'qa', role: 'guest' }
      ]
    },
    owner
  );
  assert.equal(f.revoked.length, 0);
});

test('changing the group claim revokes managed members', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  f.member('orgA', 'u1', 'member', 'pA');
  const out = await f.service.replaceRules(
    p,
    { groupClaim: 'roles', rules: [{ value: 'eng', role: 'member' }] },
    owner
  );
  assert.equal(out.groupClaim, 'roles');
  assert.equal(f.revoked.length, 1);
});

test('rules need an OIDC or SAML provider', async () => {
  const f = new Fake();
  const p = f.orgProvider({ protocol: 'oauth2' });
  await assert.rejects(
    () => f.service.replaceRules(p, { rules: [{ value: 'x', role: 'member' }] }, owner),
    BadRequestException
  );
});

test('preview shows the decision without touching anything', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  f.rule('pA', 'orgA', 'eng', 'member');
  f.rule('pA', 'orgA', 'leads', 'admin');
  const out = await f.service.preview(p, ['eng', 'leads', 'Leads']);
  assert.equal(out.allowed, true);
  assert.deepEqual(out.matches, [
    { organizationId: 'orgA', role: 'admin', ruleIds: [f.rules[1].id] }
  ]);
  const none = await f.service.preview(p, ['sales']);
  assert.equal(none.allowed, false);
  await assert.rejects(
    () =>
      f.service.preview(
        p,
        Array.from({ length: 501 }, () => 'x')
      ),
    BadRequestException
  );
  assert.equal(f.audits.length, 0);
});

test('the IdP subject is stored on first login and later logins match it, not the email', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  assert.equal(await f.service.findBound(p, 'sub-1'), null);
  await f.service.bind(p, 'sub-1', u1);
  assert.equal(f.identities[0].subject, 'sub-1');
  assert.ok(f.audits.some((a) => a.action === 'sso.identity.bound'));
  const bound = await f.service.findBound(p, 'sub-1');
  assert.equal(bound?.id, 'u1');
  await f.service.bind(p, 'sub-1', u1);
  assert.equal(f.identities.length, 1);
});

test('a different subject for an already-bound account is refused', async () => {
  const f = new Fake();
  const p = f.orgProvider();
  await f.service.bind(p, 'sub-1', u1);
  await assert.rejects(() => f.service.bind(p, 'sub-2', u1), UnauthorizedException);
  assert.equal(f.audits.at(-1)!.metadata.reason, 'subject_mismatch');
});

test('subjects are not shared across providers', async () => {
  const f = new Fake();
  const a = f.orgProvider();
  const b = f.orgProvider({ id: 'pB', organizationId: 'orgB' });
  await f.service.bind(a, 'same', u1);
  assert.equal(await f.service.findBound(b, 'same'), null);
});

test('missing or oversized subjects are not bound', async () => {
  assert.equal(cleanSubject(undefined), null);
  assert.equal(cleanSubject(''), null);
  assert.equal(cleanSubject('x'.repeat(256)), null);
  assert.equal(cleanSubject('x'.repeat(255)), 'x'.repeat(255));
  const f = new Fake();
  await f.service.bind(f.orgProvider(), null, u1);
  assert.equal(f.identities.length, 0);
});

function instanceLogin(existing: any) {
  const f = new Fake();
  const login = Object.create(SsoLoginService.prototype) as any;
  login.mapping = f.service;
  login.audit = { log: async () => {} };
  login.authz = {
    assertSsoNotEnforced: async () => {},
    assertSsoNotEnforcedForEmail: async () => {}
  };
  login.prisma = {
    user: { findUnique: async () => existing },
    organizationMember: { findFirst: async () => null },
    organizationInvitation: { findFirst: async () => null }
  };
  login.createUser = async (email: string) => ({ id: 'new', email });
  return { f, login };
}

test('an instance login matching no rule is denied, but superadmins are exempt', async () => {
  const prev = process.env.SIGNUP_MODE;
  process.env.SIGNUP_MODE = 'open';
  try {
    const regular = instanceLogin({ id: 'u1', email: 'u1@corp.example', isSuperAdmin: false });
    regular.f.instanceProvider();
    regular.f.rule('pI', 'orgA', 'eng', 'member');
    const m1 = await regular.f.service.prepare(regular.f.providers[0], { groups: [] });
    await assert.rejects(
      () =>
        regular.login.resolveInstanceUser(
          { id: 'pI', jitProvisioning: true },
          'u1@corp.example',
          'U',
          null,
          m1,
          true
        ),
      (e: any) => e.message === 'sso_not_mapped'
    );

    const root = instanceLogin({ id: 'root', email: 'root@corp.example', isSuperAdmin: true });
    root.f.instanceProvider();
    root.f.rule('pI', 'orgA', 'eng', 'member');
    const m2 = await root.f.service.prepare(root.f.providers[0], { groups: [] });
    const user = await root.login.resolveInstanceUser(
      { id: 'pI', jitProvisioning: true },
      'root@corp.example',
      'R',
      null,
      m2,
      true
    );
    assert.equal(user.id, 'root');
  } finally {
    if (prev === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = prev;
  }
});

test('an instance IdP with an unverified email never lands on an existing account without consent', async () => {
  const prev = process.env.SIGNUP_MODE;
  process.env.SIGNUP_MODE = 'open';
  try {
    const victim = { id: 'victim', email: 'victim@corp.example', isSuperAdmin: true };
    const { f, login } = instanceLogin(victim);
    f.instanceProvider();
    const provider = { id: 'pI', jitProvisioning: true };
    await assert.rejects(
      () => login.resolveInstanceUser(provider, victim.email, 'V', null, undefined, false),
      (e: any) => e.message === 'sso_link_required'
    );
    await assert.rejects(
      () =>
        login.resolveInstanceUser(provider, victim.email, 'V', null, undefined, false, 'attacker'),
      (e: any) => e.message === 'sso_link_required'
    );
    const consented = await login.resolveInstanceUser(
      provider,
      victim.email,
      'V',
      null,
      undefined,
      false,
      'victim'
    );
    assert.equal(consented.id, 'victim');
    const alreadyBound = await login.resolveInstanceUser(
      provider,
      victim.email,
      'V',
      victim,
      undefined,
      false
    );
    assert.equal(alreadyBound.id, 'victim');
  } finally {
    if (prev === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = prev;
  }
});

test('an instance rule match counts as signup access when signups are closed', async () => {
  const prev = process.env.SIGNUP_MODE;
  process.env.SIGNUP_MODE = 'closed';
  try {
    const { f, login } = instanceLogin(null);
    f.instanceProvider();
    f.rule('pI', 'orgA', 'eng', 'member');
    const matched = await f.service.prepare(f.providers[0], { groups: ['eng'] });
    const user = await login.resolveInstanceUser(
      { id: 'pI', jitProvisioning: true },
      'n@corp.example',
      'N',
      null,
      matched
    );
    assert.equal(user.id, 'new');
    await assert.rejects(
      () =>
        login.resolveInstanceUser({ id: 'pI', jitProvisioning: true }, 'n@corp.example', 'N', null),
      UnauthorizedException
    );
  } finally {
    if (prev === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = prev;
  }
});
