import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException
} from '@nestjs/common';
import { ScimAuthGuard, SCIM_ORG_KEY } from '../src/scim/scim-auth.guard';
import { ScimTokensService, hashScimToken } from '../src/scim/scim-tokens.service';
import { ScimTokensController } from '../src/scim/scim-tokens.controller';
import { InstanceScimGuard } from '../src/scim/instance-scim.controller';
import { InstanceScimService } from '../src/scim/instance-scim.service';
import { ScimService } from '../src/scim/scim.service';
import { OrgIdentityService } from '../src/sso/org-identity.service';
import { AuthorizationService } from '../src/auth/authorization.service';
import { requestAuthStorage, type RequestAuthContext } from '../src/auth/request-context';
import { IS_PUBLIC_KEY } from '../src/auth/decorators';

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';

type TokenRow = {
  id: string;
  organizationId: string;
  name: string;
  tokenHash: string;
  createdBy: string;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
};

function tokenWorld() {
  const tokens: TokenRow[] = [];
  const lookups: string[] = [];
  const audits: any[] = [];
  const members = [
    { organizationId: ORG_A, userId: 'owner-a', role: 'owner', status: 'active' },
    { organizationId: ORG_A, userId: 'admin-a', role: 'admin', status: 'active' },
    { organizationId: ORG_A, userId: 'member-a', role: 'member', status: 'active' },
    { organizationId: ORG_B, userId: 'owner-b', role: 'owner', status: 'active' },
    { organizationId: ORG_A, userId: 'gone-a', role: 'owner', status: 'disabled' }
  ];
  let seq = 0;
  const prisma: any = {
    scimToken: {
      create: async ({ data }: any) => {
        const row: TokenRow = {
          id: `st-${++seq}`,
          createdAt: new Date(),
          lastUsedAt: null,
          ...data
        };
        tokens.push(row);
        return row;
      },
      findMany: async ({ where, select }: any) =>
        tokens
          .filter((t) => t.organizationId === where.organizationId)
          .map((t) =>
            Object.fromEntries(
              Object.keys(select).map((k) => [k, (t as Record<string, unknown>)[k]])
            )
          ),
      findFirst: async ({ where }: any) =>
        tokens.find((t) => t.id === where.id && t.organizationId === where.organizationId) ?? null,
      findUnique: async ({ where }: any) => {
        lookups.push(where.tokenHash);
        return tokens.find((t) => t.tokenHash === where.tokenHash) ?? null;
      },
      delete: async ({ where }: any) => {
        const i = tokens.findIndex((t) => t.id === where.id);
        return tokens.splice(i, 1)[0];
      },
      update: async ({ where, data }: any) =>
        Object.assign(
          tokens.find((t) => t.id === where.id)!,
          data
        )
    },
    instanceScimToken: { findUnique: async () => null },
    organizationMember: {
      findUnique: async ({ where }: any) =>
        members.find(
          (m) =>
            m.organizationId === where.organizationId_userId.organizationId &&
            m.userId === where.organizationId_userId.userId
        ) ?? null
    },
    organization: { findUnique: async ({ where }: any) => ({ id: where.id }) },
    orgSsoSettings: { findFirst: async () => null },
    user: { findUnique: async () => ({ isSuperAdmin: false }) }
  };
  const audit = { log: async (e: any) => audits.push(e) };
  const service = new ScimTokensService(prisma, audit as any);
  const authz = new AuthorizationService(prisma, {} as any);
  const controller = new ScimTokensController(service, authz);
  return { service, controller, tokens, lookups, audits, prisma };
}

function http(headers: Record<string, string | undefined>) {
  const req: any = { headers };
  const resHeaders: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => {
      resHeaders[k] = v;
    }
  };
  const context: any = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res })
  };
  return { req, resHeaders, context };
}

async function refused401(guard: { canActivate(c: any): Promise<boolean> }, c: any) {
  await assert.rejects(
    guard.canActivate(c),
    (err: unknown) => err instanceof HttpException && err.getStatus() === 401
  );
}

const asReq = (userId: string) => ({ auth: { userId } }) as any;

test('a SCIM token is returned once in plaintext and stored only as its hash', async () => {
  const w = tokenWorld();
  const created = await w.service.create(ORG_A, 'owner-a', 'okta');
  assert.match(created.token, /^scim_[0-9a-f]{64}$/);
  assert.equal(w.tokens[0].tokenHash, hashScimToken(created.token));
  assert.equal(
    JSON.stringify(w.tokens).includes(created.token),
    false,
    'the plaintext must never be persisted'
  );
  const listed = await w.service.list(ORG_A);
  assert.equal(JSON.stringify(listed).includes('scim_'), false);
  assert.equal(JSON.stringify(listed).includes(w.tokens[0].tokenHash), false);
});

test('a SCIM token resolves to the organization it was minted for and nothing else', async () => {
  const w = tokenWorld();
  const a = await w.service.create(ORG_A, 'owner-a', 'okta');
  const b = await w.service.create(ORG_B, 'owner-b', 'entra');
  const guard = new ScimAuthGuard(w.service);
  for (const [token, org] of [
    [a.token, ORG_A],
    [b.token, ORG_B]
  ]) {
    const { req, context } = http({
      authorization: `Bearer ${token}`,
      'x-organization-id': org === ORG_A ? ORG_B : ORG_A
    });
    req.params = { organizationId: org === ORG_A ? ORG_B : ORG_A };
    req.query = { organizationId: org === ORG_A ? ORG_B : ORG_A };
    assert.equal(await guard.canActivate(context), true);
    assert.equal(req[SCIM_ORG_KEY], org);
  }
});

test('a missing, malformed or unknown SCIM bearer is a 401 with a SCIM challenge', async () => {
  const w = tokenWorld();
  const { token } = await w.service.create(ORG_A, 'owner-a', 'okta');
  const guard = new ScimAuthGuard(w.service);
  for (const authorization of [
    undefined,
    '',
    token,
    `bearer ${token}`,
    `Basic ${token}`,
    `Token ${token}`,
    'Bearer ',
    'Bearer scim_' + '0'.repeat(64),
    `Bearer ${token}x`,
    `Bearer ${token.toUpperCase()}`
  ]) {
    const { req, resHeaders, context } = http({ authorization });
    await refused401(guard, context);
    assert.equal(resHeaders['WWW-Authenticate'], 'Bearer realm="SCIM"', String(authorization));
    assert.equal(req[SCIM_ORG_KEY], undefined);
  }
});

test('a bearer without the SCIM prefix never reaches the token table', async () => {
  const w = tokenWorld();
  const guard = new ScimAuthGuard(w.service);
  for (const bearer of ['orch_' + 'a'.repeat(64), 'iscim_' + 'a'.repeat(64), 'eyJ.x.y', 'x']) {
    await refused401(guard, http({ authorization: `Bearer ${bearer}` }).context);
  }
  assert.deepEqual(w.lookups, []);
});

test('an expired SCIM token is refused', async () => {
  const w = tokenWorld();
  const { token } = await w.service.create(ORG_A, 'owner-a', 'okta');
  w.tokens[0].expiresAt = new Date(Date.now() - 1);
  const guard = new ScimAuthGuard(w.service);
  await refused401(guard, http({ authorization: `Bearer ${token}` }).context);
});

test('a revoked SCIM token stops working at once', async () => {
  const w = tokenWorld();
  const { id, token } = await w.service.create(ORG_A, 'owner-a', 'okta');
  const guard = new ScimAuthGuard(w.service);
  assert.equal(await guard.canActivate(http({ authorization: `Bearer ${token}` }).context), true);
  await w.controller.revoke(ORG_A, id, asReq('owner-a'));
  await refused401(guard, http({ authorization: `Bearer ${token}` }).context);
});

test('an organization SCIM token cannot drive the instance-wide SCIM directory', async () => {
  const w = tokenWorld();
  const { token } = await w.service.create(ORG_A, 'owner-a', 'okta');
  const guard = new InstanceScimGuard(new InstanceScimService(w.prisma, {} as any));
  await refused401(guard, http({ authorization: `Bearer ${token}` }).context);
});

test('SCIM token lifetimes are capped at a year and must lie in the future', async () => {
  const w = tokenWorld();
  const year = 365 * 24 * 60 * 60 * 1000;
  const forever = await w.service.create(ORG_A, 'owner-a', 'a', new Date(Date.now() + 10 * year));
  assert.ok(forever.expiresAt!.getTime() <= Date.now() + year);
  const unset = await w.service.create(ORG_A, 'owner-a', 'b');
  assert.ok(unset.expiresAt!.getTime() <= Date.now() + year);
  await assert.rejects(
    w.service.create(ORG_A, 'owner-a', 'c', new Date(Date.now() - 1000)),
    BadRequestException
  );
  await assert.rejects(
    w.service.create(ORG_A, 'owner-a', 'd', new Date('not a date')),
    BadRequestException
  );
  await assert.rejects(w.service.create(ORG_A, 'owner-a', '   '), BadRequestException);
});

test('only the organization owner can list, mint or revoke its SCIM tokens', async () => {
  const w = tokenWorld();
  const { id } = await w.service.create(ORG_A, 'owner-a', 'okta');
  for (const [userId, expected] of [
    ['admin-a', ForbiddenException],
    ['member-a', ForbiddenException],
    ['owner-b', NotFoundException],
    ['gone-a', NotFoundException],
    ['stranger', NotFoundException]
  ] as const) {
    await assert.rejects(w.controller.list(ORG_A, asReq(userId)), expected, userId);
    await assert.rejects(
      w.controller.create(ORG_A, asReq(userId), { name: 'x' }),
      expected,
      userId
    );
    await assert.rejects(w.controller.revoke(ORG_A, id, asReq(userId)), expected, userId);
  }
  assert.equal(w.tokens.length, 1);
  const listed = await w.controller.list(ORG_A, asReq('owner-a'));
  assert.equal(listed.tokens.length, 1);
});

test('an owner cannot list or revoke another organization SCIM token by id', async () => {
  const w = tokenWorld();
  const theirs = await w.service.create(ORG_B, 'owner-b', 'entra');
  await w.service.create(ORG_A, 'owner-a', 'okta');
  const listed = await w.controller.list(ORG_A, asReq('owner-a'));
  assert.deepEqual(
    listed.tokens.map((t: any) => t.id),
    w.tokens.filter((t) => t.organizationId === ORG_A).map((t) => t.id)
  );
  await assert.rejects(w.controller.revoke(ORG_A, theirs.id, asReq('owner-a')), NotFoundException);
  assert.ok(w.tokens.some((t) => t.id === theirs.id));
  await assert.rejects(w.controller.revoke(ORG_B, theirs.id, asReq('owner-a')), NotFoundException);
});

test('a project-scoped or other-org-confined credential cannot mint SCIM tokens', async () => {
  const w = tokenWorld();
  const run = (ctx: RequestAuthContext) =>
    requestAuthStorage.run(ctx, () =>
      w.controller.create(ORG_A, asReq('owner-a'), { name: 'sneaky' })
    );
  await assert.rejects(
    run({ apiTokenId: 't', tokenScopes: ['deploy'], tokenProjectIds: ['p1'] }),
    ForbiddenException
  );
  await assert.rejects(
    run({ apiTokenId: 't', tokenScopes: ['deploy'], sessionOrgId: ORG_B }),
    NotFoundException
  );
  assert.equal(w.tokens.length, 0);
});

test('the SCIM token routes are authenticated, not public', () => {
  assert.notEqual(Reflect.getMetadata(IS_PUBLIC_KEY, ScimTokensController), true);
  for (const name of ['list', 'create', 'revoke'] as const) {
    assert.notEqual(
      Reflect.getMetadata(IS_PUBLIC_KEY, ScimTokensController.prototype[name]),
      true,
      name
    );
  }
});

function directory() {
  const users: any[] = [];
  const members: any[] = [];
  const tombstones: any[] = [];
  const hydrate = (row: any) =>
    row ? { ...row, user: users.find((u) => u.id === row.userId) } : row;
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (k === 'organizationId_userId') {
        const key = v as any;
        return row.organizationId === key.organizationId && row.userId === key.userId;
      }
      return row[k] === v;
    });
  const collection = (rows: any[], defaults: () => any) => ({
    findFirst: async ({ where }: any) => hydrate(rows.find((r) => matches(r, where))) ?? null,
    findUnique: async ({ where }: any) => hydrate(rows.find((r) => matches(r, where))) ?? null,
    findMany: async ({ where }: any) => rows.filter((r) => matches(r, where)).map(hydrate),
    create: async ({ data }: any) => {
      const row = { ...defaults(), ...data };
      rows.push(row);
      return hydrate(row);
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where));
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
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
      return { count: 0 };
    }
  });
  const db: any = {
    organization: {
      findUnique: async () => ({ name: 'Acme', slug: 'acme' }),
      findUniqueOrThrow: async () => ({ name: 'Acme', slug: 'acme' })
    },
    user: {
      ...collection(users, () => ({
        id: randomUUID(),
        firstName: null,
        lastName: null,
        emailScope: 'account',
        homeOrganizationId: null
      })),
      count: async ({ where }: any) => users.filter((u) => matches(u, where)).length,
      findUnique: async ({ where }: any) =>
        users.find((u) => {
          if (where.emailScope_email) {
            return (
              u.email === where.emailScope_email.email &&
              (u.emailScope ?? 'account') === where.emailScope_email.emailScope
            );
          }
          if (where.email) return u.email === where.email;
          if (where.username) return u.username === where.username;
          return u.id === where.id;
        }) ?? null
    },
    organizationMember: {
      ...collection(members, () => ({
        id: randomUUID(),
        role: 'member',
        addedAt: new Date(),
        scimExternalId: null,
        scimEnterprise: null,
        scimUserName: null,
        scimGivenName: null,
        scimFamilyName: null,
        scimDisplayName: null,
        scimManaged: false
      })),
      count: async ({ where }: any) => members.filter((m) => matches(m, where)).length,
      findUniqueOrThrow: async ({ where }: any) => {
        const row = members.find((r) => matches(r, where));
        if (!row) throw new Error('member not found');
        return hydrate(row);
      }
    },
    scimDeprovisionedMember: collection(tombstones, () => ({
      id: randomUUID(),
      role: 'member',
      deactivatedAt: new Date(),
      externalId: null,
      enterprise: null,
      userName: null,
      givenName: null,
      familyName: null,
      displayName: null
    }))
  };
  db.$transaction = async (fn: any) => fn(db);
  const revoked: Array<[string, string]> = [];
  const audit = { log: async () => {} };
  const service = new ScimService(
    db,
    audit as any,
    { sendOrganizationAddedEmail: async () => true } as any,
    { checkRateLimit: async () => {}, checkInviteMail: async () => {} } as any,
    { revoked: (o: string, u: string) => revoked.push([o, u]) } as any,
    undefined,
    undefined,
    { isVerifiedFor: async () => false } as any,
    new OrgIdentityService(db, audit as any)
  );
  service.onModuleInit();
  return { service, members, tombstones, users, revoked };
}

const A = { organizationId: ORG_A };
const B = { organizationId: ORG_B };
const patchOp = (value: any) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', value }]
});
const notFound = (err: any) => err?.status === 404;

test('another organization SCIM client gets 404 for every operation on this organization user', async () => {
  const d = directory();
  const created: any = await d.service.createUser({ userName: 'ada@acme.test' }, A);
  const before = structuredClone(d.members);
  await assert.rejects(d.service.getUser(created.id, {}, B), notFound);
  await assert.rejects(
    d.service.replaceUser(created.id, { userName: 'ada@acme.test', active: false }, B),
    notFound
  );
  await assert.rejects(d.service.patchUser(created.id, patchOp({ active: false }), B), notFound);
  await assert.rejects(
    d.service.patchUser(created.id, patchOp({ roles: [{ value: 'admin' }] }), B),
    notFound
  );
  await assert.rejects(d.service.deleteUser(created.id, B), notFound);
  assert.deepEqual(d.members, before);
  assert.deepEqual(d.revoked, []);
});

test('another organization SCIM listing and role groups never show this organization users', async () => {
  const d = directory();
  await d.service.createUser({ userName: 'ada@acme.test' }, A);
  const listed: any = await d.service.listUsers({}, B);
  assert.equal(listed.totalResults, 0);
  const filtered: any = await d.service.listUsers({ filter: 'userName eq "ada@acme.test"' }, B);
  assert.equal(filtered.totalResults, 0);
  const groups: any = await d.service.listGroups({}, B);
  for (const g of groups.Resources) assert.deepEqual(g.members ?? [], [], g.id);
});

test('a deactivated user tombstone is invisible to another organization SCIM client', async () => {
  const d = directory();
  const created: any = await d.service.createUser({ userName: 'ada@acme.test' }, A);
  await d.service.patchUser(created.id, patchOp({ active: false }), A);
  assert.equal(d.tombstones.length, 1);
  await assert.rejects(d.service.getUser(created.id, {}, B), notFound);
  await assert.rejects(d.service.patchUser(created.id, patchOp({ active: true }), B), notFound);
  assert.equal(d.members.length, 0);
  assert.equal(d.tombstones.length, 1);
});

test('a person in two organizations is only changed in the organization whose token asked', async () => {
  const d = directory();
  const inA: any = await d.service.createUser({ userName: 'ada@acme.test' }, A);
  const inB: any = await d.service.createUser({ userName: 'ada@acme.test' }, B);
  await d.service.deleteUser(inB.id, B);
  assert.deepEqual(
    d.revoked.map(([o]) => o),
    [ORG_B]
  );
  const stillA: any = await d.service.getUser(inA.id, {}, A);
  assert.equal(stillA.active, true);
  assert.equal(d.members.filter((m) => m.organizationId === ORG_A).length, 1);
});
