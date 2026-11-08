import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IdentityMappingService } from '../src/sso/identity-mapping.service';
import { ScimService } from '../src/scim/scim.service';
import { ScimGroupsService } from '../src/scim/scim-groups.service';

type Row = Record<string, any>;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ctxA = { organizationId: ORG_A };
const ctxB = { organizationId: ORG_B };
const PROVIDER_A = '33333333-3333-4333-8333-333333333333';
const PROVIDER_B = '44444444-4444-4444-8444-444444444444';

function makeWorld() {
  const tables: Record<string, Row[]> = {
    user: [],
    organizationMember: [],
    scimDeprovisionedMember: [],
    scimGroup: [],
    scimGroupMember: [],
    idpGroupRule: [],
    identityProvider: [
      { id: PROVIDER_A, organizationId: ORG_A, name: 'A idp', groupClaim: 'groups' },
      { id: PROVIDER_B, organizationId: ORG_B, name: 'B idp', groupClaim: 'groups' }
    ]
  };
  const audits: Row[] = [];
  const tokenWipes: Row[] = [];
  const sessionWipes: Row[] = [];
  const cacheRevoked: Array<[string, string]> = [];
  const detached: string[] = [];

  const matchValue = (actual: any, expected: any): boolean => {
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('in' in expected) return expected.in.includes(actual);
      if ('not' in expected) return actual !== expected.not;
    }
    return actual === expected;
  };
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'organizationId_userId') {
        return row.organizationId === (v as any).organizationId && row.userId === (v as any).userId;
      }
      return matchValue(row[k], v);
    });

  const hydrate = (row: Row | undefined) =>
    row ? { ...row, user: tables.user.find((u) => u.id === row.userId) } : null;

  const collection = (name: string, defaults: () => Row = () => ({})) => {
    const rows = tables[name];
    return {
      findFirst: async ({ where }: any = {}) => hydrate(rows.find((r) => matches(r, where))),
      findUnique: async ({ where }: any) => hydrate(rows.find((r) => matches(r, where))),
      findMany: async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).map(hydrate),
      count: async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).length,
      create: async ({ data }: any) => {
        const row = { ...defaults(), ...data };
        rows.push(row);
        return hydrate(row);
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => matches(r, where))!;
        Object.assign(row, data);
        return hydrate(row);
      },
      upsert: async ({ where, create, update }: any) => {
        const row = rows.find((r) => matches(r, where));
        if (row) {
          Object.assign(row, update);
          return hydrate(row);
        }
        const created = { ...defaults(), ...create };
        rows.push(created);
        return hydrate(created);
      },
      delete: async ({ where }: any) => {
        const i = rows.findIndex((r) => matches(r, where));
        return rows.splice(i, 1)[0];
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (matches(rows[i], where)) {
            rows.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      }
    };
  };

  const prisma: any = {
    user: collection('user', () => ({ id: randomUUID(), isSuperAdmin: false })),
    organization: { findUnique: async () => ({ name: 'Acme', createdAt: new Date() }) },
    organizationMember: collection('organizationMember', () => ({
      id: randomUUID(),
      role: 'member',
      addedAt: new Date(),
      scimManaged: false,
      managedByProviderId: null
    })),
    scimDeprovisionedMember: collection('scimDeprovisionedMember', () => ({
      id: randomUUID(),
      role: 'member',
      deactivatedAt: new Date()
    })),
    scimGroup: collection('scimGroup', () => ({
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      externalId: null
    })),
    scimGroupMember: collection('scimGroupMember'),
    idpGroupRule: collection('idpGroupRule'),
    identityProvider: collection('identityProvider'),
    apiToken: {
      deleteMany: async ({ where }: any) => {
        tokenWipes.push(where);
      }
    }
  };
  prisma.$transaction = async (fn: any) => fn(prisma);

  const audit = {
    log: async (e: Row) => {
      audits.push(e);
    }
  };
  const membershipCache = {
    revoked: (o: string, u: string) => {
      cacheRevoked.push([o, u]);
    },
    invalidateInternalUserId: () => {}
  };
  const sessions = {
    revokeSignInSessions: async (p: Row) => {
      sessionWipes.push(p);
      return 0;
    }
  };
  const orgs = {
    detachMember: async (member: Row) => {
      detached.push(member.userId);
      const i = tables.organizationMember.findIndex((m) => m.id === member.id);
      tables.organizationMember.splice(i, 1);
    }
  };

  const mapping = new IdentityMappingService(
    prisma,
    audit as any,
    sessions as any,
    membershipCache as any,
    orgs as any
  );
  const groups = new ScimGroupsService(prisma, audit as any, mapping);
  const scim = new ScimService(
    prisma,
    audit as any,
    { sendOrganizationAddedEmail: async () => true } as any,
    { checkRateLimit: async () => {}, checkInviteMail: async () => {} } as any,
    membershipCache as any,
    groups,
    mapping
  );
  scim.onModuleInit();

  return {
    tables,
    prisma,
    scim,
    mapping,
    audits,
    tokenWipes,
    sessionWipes,
    cacheRevoked,
    detached
  };
}

async function provision(world: ReturnType<typeof makeWorld>, ctx: typeof ctxA, email: string) {
  const created: any = await world.scim.createUser({ userName: email }, ctx);
  return created.id as string;
}

function rule(providerId: string, organizationId: string, value: string, role: string) {
  return { id: randomUUID(), providerId, organizationId, value, role };
}

const group = (displayName: string, members: string[] = []) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
  displayName,
  members: members.map((value) => ({ value }))
});

const patchOps = (...Operations: any[]) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations
});

function roleOf(world: ReturnType<typeof makeWorld>, orgId: string, memberId: string) {
  return world.tables.organizationMember.find(
    (m) => m.id === memberId && m.organizationId === orgId
  )?.role;
}

test('creating a group applies the same rules as a login', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  const ada = await provision(w, ctxA, 'ada@example.com');

  const created: any = await w.scim.createGroup(group('Platform', [ada]), ctxA);
  assert.equal(created.displayName, 'Platform');
  assert.equal(created.members[0].value, ada);
  assert.equal(roleOf(w, ORG_A, ada), 'admin');
  const row = w.tables.organizationMember.find((m) => m.id === ada)!;
  assert.equal(row.managedByProviderId, PROVIDER_A);
  assert.ok(w.audits.some((a) => a.action === 'sso.member.role_synced'));
  assert.ok(w.audits.some((a) => a.action === 'scim.group.created'));
});

test('removing a member through PATCH withdraws what the group granted', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  const bob = await provision(w, ctxA, 'bob@example.com');
  const created: any = await w.scim.createGroup(group('Platform', [ada, bob]), ctxA);

  await w.scim.patchGroup(
    created.id,
    patchOps({ op: 'remove', path: `members[value eq "${ada}"]` }),
    ctxA
  );

  assert.equal(roleOf(w, ORG_A, ada), undefined, 'no remaining rule match removes the member');
  assert.equal(roleOf(w, ORG_A, bob), 'admin');
  assert.equal(w.sessionWipes.length >= 1, true);
  assert.ok(w.tokenWipes.some((t) => t.scopeOrganizationId === ORG_A));
  assert.ok(w.cacheRevoked.some(([o]) => o === ORG_A));
  assert.ok(w.audits.some((a) => a.action === 'sso.member.removed'));
});

test('adding a member through PATCH grants the mapped role', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Guests', 'guest'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  const created: any = await w.scim.createGroup(group('Guests'), ctxA);
  assert.equal(roleOf(w, ORG_A, ada), 'member');

  await w.scim.patchGroup(
    created.id,
    patchOps({ op: 'add', path: 'members', value: [{ value: ada }] }),
    ctxA
  );
  assert.equal(roleOf(w, ORG_A, ada), 'guest');
});

test('PUT replaces membership and deleting the group withdraws the grant', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  const bob = await provision(w, ctxA, 'bob@example.com');
  const created: any = await w.scim.createGroup(group('Platform', [ada]), ctxA);

  await w.scim.replaceGroup(created.id, group('Platform', [bob]), ctxA);
  assert.equal(roleOf(w, ORG_A, ada), undefined);
  assert.equal(roleOf(w, ORG_A, bob), 'admin');

  await w.scim.deleteGroup(created.id, ctxA);
  assert.equal(roleOf(w, ORG_A, bob), undefined);
  assert.equal(w.tables.scimGroup.length, 0);
  assert.equal(w.tables.scimGroupMember.length, 0);
});

test('a group that matches no rule changes nothing', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  await w.scim.createGroup(group('Lunch club', [ada]), ctxA);
  assert.equal(roleOf(w, ORG_A, ada), 'member');
  assert.equal(w.tables.organizationMember[0].managedByProviderId, null);
});

test('an owner is never changed, granted or removed by a SCIM group', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'member'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  w.tables.organizationMember.find((m) => m.id === ada)!.role = 'owner';

  const created: any = await w.scim.createGroup(group('Platform', [ada]), ctxA);
  assert.equal(roleOf(w, ORG_A, ada), 'owner');
  await w.scim.deleteGroup(created.id, ctxA);
  assert.equal(roleOf(w, ORG_A, ada), 'owner');
});

test('rules cannot name owner, so no group can ever resolve to it', async () => {
  const w = makeWorld();
  const provider = w.tables.identityProvider[0];
  await assert.rejects(
    () =>
      w.mapping.replaceRules(
        { ...provider, protocol: 'saml' } as any,
        { rules: [{ value: 'Platform', role: 'owner' }] },
        { userId: 'u' }
      ),
    /never owner/
  );
});

test('a deactivated user in a group is not given access back', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  const bob = await provision(w, ctxA, 'bob@example.com');
  await w.scim.patchUser(ada, patchOps({ op: 'replace', value: { active: false } }), ctxA);
  assert.equal(w.tables.scimDeprovisionedMember.length, 1);

  const created: any = await w.scim.createGroup(group('Platform', [ada, bob]), ctxA);
  assert.equal(created.members.length, 2, 'the directory still lists the deactivated user');
  assert.equal(roleOf(w, ORG_A, ada), undefined, 'a group never recreates a membership');
  assert.equal(roleOf(w, ORG_A, bob), 'admin');
});

test('deactivating and deleting a user revokes sessions and org tokens', async () => {
  const w = makeWorld();
  const ada = await provision(w, ctxA, 'ada@example.com');
  const bob = await provision(w, ctxA, 'bob@example.com');

  await w.scim.patchUser(ada, patchOps({ op: 'replace', value: { active: false } }), ctxA);
  assert.equal(w.sessionWipes.length, 1);
  assert.deepEqual(
    w.tokenWipes.map((t) => t.scopeOrganizationId),
    [ORG_A]
  );

  await w.scim.deleteUser(bob, ctxA);
  assert.equal(w.sessionWipes.length, 2);
  assert.equal(w.tokenWipes.length, 2);
});

test('deleting a user drops their group links', async () => {
  const w = makeWorld();
  const ada = await provision(w, ctxA, 'ada@example.com');
  await w.scim.createGroup(group('Platform', [ada]), ctxA);
  await w.scim.deleteUser(ada, ctxA);
  assert.equal(w.tables.scimGroupMember.length, 0);
});

test('the built-in role groups stay read-only', async () => {
  const w = makeWorld();
  await assert.rejects(
    () => w.scim.replaceGroup('role:admin', group('Admin'), ctxA),
    (err: any) => err.status === 400 && err.scimType === 'mutability'
  );
  await assert.rejects(
    () => w.scim.deleteGroup('role:admin', ctxA),
    (err: any) => err.status === 400 && err.scimType === 'mutability'
  );
  const listed: any = await w.scim.listGroups({}, ctxA);
  assert.ok(listed.Resources.some((g: any) => g.id === 'role:admin'));
});

test('duplicate names, unknown members and bad names are rejected', async () => {
  const w = makeWorld();
  await w.scim.createGroup(group('Platform'), ctxA);
  await assert.rejects(
    () => w.scim.createGroup(group('Platform'), ctxA),
    (err: any) => err.status === 409 && err.scimType === 'uniqueness'
  );
  await assert.rejects(
    () => w.scim.createGroup(group('Other', [randomUUID()]), ctxA),
    (err: any) => err.status === 400 && err.scimType === 'invalidValue'
  );
  await assert.rejects(
    () => w.scim.createGroup({ ...group('x'), displayName: 'bad\u0000name' }, ctxA),
    (err: any) => err.status === 400
  );
});

test('another organization token cannot read, change or delete a group', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  const created: any = await w.scim.createGroup(group('Platform', [ada]), ctxA);

  await assert.rejects(
    () => w.scim.getGroup(created.id, {}, ctxB),
    (err: any) => err.status === 404
  );
  await assert.rejects(
    () => w.scim.replaceGroup(created.id, group('Platform', []), ctxB),
    (err: any) => err.status === 404
  );
  await assert.rejects(
    () =>
      w.scim.patchGroup(
        created.id,
        patchOps({ op: 'remove', path: `members[value eq "${ada}"]` }),
        ctxB
      ),
    (err: any) => err.status === 404
  );
  await assert.rejects(
    () => w.scim.deleteGroup(created.id, ctxB),
    (err: any) => err.status === 404
  );
  assert.equal(roleOf(w, ORG_A, ada), 'admin');
  assert.equal(w.tables.scimGroup.length, 1);
  const listed: any = await w.scim.listGroups({}, ctxB);
  assert.equal(
    listed.Resources.filter((g: any) => g.id === created.id).length,
    0,
    'groups of other organizations never list'
  );
});

test('another organization cannot enrol this organization members', async () => {
  const w = makeWorld();
  const ada = await provision(w, ctxA, 'ada@example.com');
  await assert.rejects(
    () => w.scim.createGroup(group('Platform', [ada]), ctxB),
    (err: any) => err.status === 400 && err.scimType === 'invalidValue'
  );
  assert.equal(w.tables.scimGroup.length, 0);
});

test('an evil organization group name cannot trigger another organization rules', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  const ada = await provision(w, ctxA, 'ada@example.com');
  const mallory = await provision(w, ctxB, 'mallory@example.com');

  await w.scim.createGroup(group('Platform', [mallory]), ctxB);
  assert.equal(roleOf(w, ORG_B, mallory), 'member');
  assert.equal(roleOf(w, ORG_A, ada), 'member');
  assert.equal(w.tables.organizationMember.filter((m) => m.role === 'admin').length, 0);
});

test('a member of two organizations is only touched in the token organization', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  w.tables.idpGroupRule.push(rule(PROVIDER_B, ORG_B, 'Platform', 'admin'));
  const inA = await provision(w, ctxA, 'ada@example.com');
  const inB = await provision(w, ctxB, 'ada@example.com');

  await w.scim.createGroup(group('Platform', [inB]), ctxB);
  assert.equal(roleOf(w, ORG_B, inB), 'admin');
  assert.equal(roleOf(w, ORG_A, inA), 'member');
});

test('login evaluation unions claim groups with the directory groups', async () => {
  const w = makeWorld();
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Platform', 'admin'));
  w.tables.idpGroupRule.push(rule(PROVIDER_A, ORG_A, 'Everyone', 'member'));
  const adaMemberId = await provision(w, ctxA, 'ada@example.com');
  const ada = w.tables.organizationMember.find((m) => m.id === adaMemberId)!.userId;
  await w.scim.createGroup(group('Platform', [adaMemberId]), ctxA);

  const provider = w.tables.identityProvider[0] as any;
  const viaDirectory = await w.mapping.prepare(provider, { groups: [] }, ada);
  assert.equal(viaDirectory.allowed, true);
  assert.equal(viaDirectory.decisions.get(ORG_A)?.role, 'admin');

  const viaClaims = await w.mapping.prepare(provider, { groups: ['Everyone'] }, ada);
  assert.equal(viaClaims.decisions.get(ORG_A)?.role, 'admin', 'highest role wins across sources');

  const stranger = await w.mapping.prepare(provider, { groups: [] }, randomUUID());
  assert.equal(stranger.allowed, false);
});
