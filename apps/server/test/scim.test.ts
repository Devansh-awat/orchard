import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import express from 'express';
import SCIMMY from 'scimmy';
import { parseScimQuery } from '../src/scim/scim-query';
import { ScimService } from '../src/scim/scim.service';
import { OrgIdentityService } from '../src/sso/org-identity.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ctx = { organizationId: ORG };

// SCIMMY branches on `"key" in params`, so a query object carrying
// explicitly-undefined keys is rejected as malformed. These guard the shape
// parseScimQuery hands over.

test('a bare list query constructs without a filter error', () => {
  const resource = new SCIMMY.Resources.User(parseScimQuery({}));
  assert.equal(resource.filter, undefined);
  assert.equal(resource.attributes, undefined);
});

test('a filter alone is accepted, without attributes tagging along', () => {
  const resource = new SCIMMY.Resources.User(parseScimQuery({ filter: 'userName eq "a@b.co"' }));
  assert.ok(resource.filter);
  assert.equal(resource.attributes, undefined);
});

test('passing undefined-valued keys is what SCIMMY rejects', () => {
  assert.throws(
    () => new SCIMMY.Resources.User({ filter: undefined, attributes: undefined } as any),
    (err: any) => err.name === 'SCIMError' && err.status === 400
  );
});

test('pagination params are coerced to integers and bad ones are rejected', () => {
  assert.deepEqual(parseScimQuery({ startIndex: '1', count: '20' }), { startIndex: 1, count: 20 });
  assert.throws(
    () => parseScimQuery({ count: 'lots' }),
    (err: any) => err.name === 'SCIMError' && err.status === 400
  );
});

// RFC 7644 puts SCIM bodies on application/scim+json, which Express's json
// parser ignores unless it's in the type list, matching main.ts.
test('scim+json request bodies are parsed', async () => {
  const app = express();
  app.use(express.json({ type: ['application/json', 'application/scim+json'] }));
  app.post('/Users', (req, res) => res.json({ userName: req.body?.userName ?? null }));

  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/scim+json' },
      body: JSON.stringify({ userName: 'hopper@example.com' })
    });
    assert.deepEqual(await res.json(), { userName: 'hopper@example.com' });
  } finally {
    server.close();
  }
});

// Enough of the Prisma surface for the SCIM handlers to run against memory.
function makeDb() {
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
      const [row] = rows.splice(i, 1);
      return row;
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
  return { db, members, tombstones, users };
}

function makeService(verified: Array<[string, string]> = []) {
  const { db, members, tombstones, users } = makeDb();
  const revoked: Array<[string, string]> = [];
  const membershipCache = {
    revoked: (o: string, u: string) => {
      revoked.push([o, u]);
    }
  };
  const audit = { log: async () => {} };
  const sent: string[] = [];
  const email = {
    sendOrganizationAddedEmail: async ({ recipientEmail }: any) => {
      sent.push(recipientEmail);
      return true;
    }
  };
  const rateLimit = { checkRateLimit: async () => {}, checkInviteMail: async () => {} };
  const service = new ScimService(
    db as any,
    audit as any,
    email as any,
    rateLimit as any,
    membershipCache as any,
    undefined,
    undefined,
    {
      isVerifiedFor: async (organizationId: string, domain: string) =>
        verified.some(([o, d]) => o === organizationId && d === domain)
    } as any,
    new OrgIdentityService(db, audit as any)
  );
  service.onModuleInit();
  return { service, members, tombstones, users, sent, revoked };
}

const patchOp = (value: any) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', value }]
});

const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

test('provisioning, deactivating and reactivating keeps one stable resource id', async () => {
  const { service, members, tombstones } = makeService();

  const created: any = await service.createUser(
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'ada@example.com',
      externalId: 'idp-1'
    },
    ctx
  );
  assert.equal(created.active, true);
  assert.equal(created.userName, 'ada@example.com');
  assert.equal(created.externalId, 'idp-1');
  assert.equal(created.groups[0].value, 'role:member');
  assert.equal(members.length, 1);

  const id = created.id;

  // Deactivation is a state change, not a delete: the membership goes away so
  // access is revoked, but the resource stays readable under the same id.
  const deactivated: any = await service.patchUser(id, patchOp({ active: false }), ctx);
  assert.equal(deactivated.active, false);
  assert.equal(members.length, 0);
  assert.equal(tombstones.length, 1);

  const reread: any = await service.getUser(id, {}, ctx);
  assert.equal(reread.id, id);
  assert.equal(reread.active, false);
  assert.deepEqual(reread.groups, []);

  const listed: any = await service.listUsers({}, ctx);
  assert.equal(listed.Resources.length, 1);
  assert.equal(listed.Resources[0].active, false);

  const reactivated: any = await service.patchUser(id, patchOp({ active: true }), ctx);
  assert.equal(reactivated.id, id, 'reactivation must not mint a new resource id');
  assert.equal(reactivated.active, true);
  assert.equal(members.length, 1);
  assert.equal(tombstones.length, 0);
});

test('deactivating twice is a no-op rather than an error', async () => {
  const { service } = makeService();
  const created: any = await service.createUser({ userName: 'grace@example.com' }, ctx);

  await service.patchUser(created.id, patchOp({ active: false }), ctx);
  const again: any = await service.replaceUser(
    created.id,
    { userName: 'grace@example.com', active: false },
    ctx
  );
  assert.equal(again.active, false);
  assert.equal(again.id, created.id);
});

test('an attribute write on a deactivated user does not restore access', async () => {
  const { service, members } = makeService();
  const created: any = await service.createUser({ userName: 'alan@example.com' }, ctx);
  await service.patchUser(created.id, patchOp({ active: false }), ctx);

  const updated: any = await service.replaceUser(
    created.id,
    { userName: 'alan@example.com', name: { givenName: 'Alan' } },
    ctx
  );
  assert.equal(updated.active, false, 'a PUT without active must not reactivate');
  assert.equal(updated.name.givenName, 'Alan');
  assert.equal(members.length, 0);
});

test('creating an already-provisioned user is a 409 uniqueness conflict', async () => {
  const { service } = makeService();
  await service.createUser({ userName: 'linus@example.com' }, ctx);

  await assert.rejects(
    () => service.createUser({ userName: 'linus@example.com' }, ctx),
    (err: any) => err.name === 'SCIMError' && err.status === 409 && err.scimType === 'uniqueness'
  );
});

test('re-creating a deactivated user revives the original resource id', async () => {
  const { service } = makeService();
  const created: any = await service.createUser({ userName: 'edsger@example.com' }, ctx);
  await service.patchUser(created.id, patchOp({ active: false }), ctx);

  const revived: any = await service.createUser({ userName: 'edsger@example.com' }, ctx);
  assert.equal(revived.id, created.id);
  assert.equal(revived.active, true);
});

test('DELETE clears the membership and the tombstone for good', async () => {
  const { service, members, tombstones } = makeService();
  const created: any = await service.createUser({ userName: 'barbara@example.com' }, ctx);
  await service.patchUser(created.id, patchOp({ active: false }), ctx);

  await service.deleteUser(created.id, ctx);
  assert.equal(members.length, 0);
  assert.equal(tombstones.length, 0);

  await assert.rejects(
    () => service.getUser(created.id, {}, ctx),
    (err: any) => err.name === 'SCIMError' && err.status === 404
  );
});

test('a user can be provisioned straight in as an admin via roles', async () => {
  const { service, members } = makeService();
  const created: any = await service.createUser(
    { userName: 'ada@example.com', roles: [{ value: 'admin', primary: true }] },
    ctx
  );
  assert.equal(created.roles[0].value, 'admin');
  assert.equal(created.userType, 'admin');
  assert.equal(created.groups[0].value, 'role:admin');
  assert.equal(members[0].role, 'admin');
});

test('userType is accepted as the role when roles is absent', async () => {
  const { service, members } = makeService();
  await service.createUser({ userName: 'grace@example.com', userType: 'admin' }, ctx);
  assert.equal(members[0].role, 'admin');
});

test('an identity provider cannot provision an owner', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.createUser({ userName: 'boss@example.com', userType: 'owner' }, ctx),
    (err: any) => err.name === 'SCIMError' && err.status === 400 && err.scimType === 'invalidValue'
  );
});

test('a provisioned account is not verified until its owner signs in', async () => {
  const { service, users } = makeService();
  await service.createUser({ userName: 'new@example.com' }, ctx);
  assert.ok(!users[0].emailVerified);
  assert.equal(users[0].homeOrganizationId, ORG, 'SCIM provisions an org identity');
});

test('an unknown role is rejected rather than silently downgraded', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.createUser({ userName: 'x@example.com', userType: 'superuser' }, ctx),
    (err: any) => err.name === 'SCIMError' && err.status === 400 && err.scimType === 'invalidValue'
  );
});

test('no role supplied means member', async () => {
  const { service, members } = makeService();
  await service.createUser({ userName: 'plain@example.com' }, ctx);
  assert.equal(members[0].role, 'member');
});

test('a role change on an existing user is applied', async () => {
  const { service, members } = makeService();
  const created: any = await service.createUser({ userName: 'linus@example.com' }, ctx);

  const promoted: any = await service.patchUser(
    created.id,
    patchOp({ roles: [{ value: 'admin', primary: true }] }),
    ctx
  );
  assert.equal(promoted.roles[0].value, 'admin');
  assert.equal(members[0].role, 'admin');
});

// A pathless replace on a multi-valued attribute appends rather than replaces,
// so the merged `roles` still leads with the old value. Both shapes must land
// on the same role.
test('a role change lands whether the patch is pathed or not', async () => {
  for (const operation of [
    { op: 'replace', value: { roles: [{ value: 'admin', primary: true }] } },
    { op: 'replace', path: 'roles', value: [{ value: 'admin', primary: true }] },
    { op: 'replace', value: { userType: 'admin' } }
  ]) {
    const { service, members } = makeService();
    const created: any = await service.createUser({ userName: 'linus@example.com' }, ctx);
    const promoted: any = await service.patchUser(
      created.id,
      { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [operation] },
      ctx
    );
    assert.equal(members[0].role, 'admin', `role not applied for ${JSON.stringify(operation)}`);
    assert.equal(promoted.roles[0].value, 'admin');
    assert.equal(promoted.userType, 'admin');
  }
});

test('a write that omits roles leaves the role alone', async () => {
  const { service, members } = makeService();
  const created: any = await service.createUser(
    { userName: 'edsger@example.com', userType: 'admin' },
    ctx
  );

  await service.replaceUser(created.id, { userName: 'edsger@example.com' }, ctx);
  assert.equal(members[0].role, 'admin', 'an omitted role must not demote to member');
});

test('the last owner cannot be demoted, deactivated or deleted', async () => {
  const { service, members } = makeService();
  const owner: any = await service.createUser(
    { userName: 'boss@example.com', userType: 'admin' },
    ctx
  );
  members[0].role = 'owner';

  const lastOwner = (err: any) => err.name === 'SCIMError' && err.status === 400;
  await assert.rejects(
    () => service.patchUser(owner.id, patchOp({ userType: 'member' }), ctx),
    lastOwner
  );
  await assert.rejects(
    () => service.patchUser(owner.id, patchOp({ active: false }), ctx),
    lastOwner
  );
  await assert.rejects(() => service.deleteUser(owner.id, ctx), lastOwner);

  // With a second owner in place the guard lifts.
  await service.createUser({ userName: 'cofounder@example.com', userType: 'admin' }, ctx);
  members[1].role = 'owner';
  const demoted: any = await service.patchUser(owner.id, patchOp({ userType: 'member' }), ctx);
  assert.equal(demoted.roles[0].value, 'member');
});

// The SCIM resource is a membership, so everything the IdP writes belongs to
// this org. One org's IdP must never edit the shared account another org reads.

test('an update never writes to the shared user account', async () => {
  const { service, users } = makeService();
  const created: any = await service.createUser(
    { userName: 'grace@example.com', name: { givenName: 'Grace', familyName: 'Hopper' } },
    ctx
  );
  const account = { ...users[0] };

  await service.replaceUser(
    created.id,
    {
      userName: 'grace.hopper@newcorp.com',
      name: { givenName: 'Rear Admiral', familyName: 'Hopper' },
      displayName: 'Amazing Grace'
    },
    ctx
  );

  assert.deepEqual(users[0], account, 'the users row must be untouched by a SCIM update');
});

test('the per-org profile is what SCIM reads back', async () => {
  const { service } = makeService();
  const created: any = await service.createUser(
    { userName: 'katherine@example.com', name: { givenName: 'Katherine' } },
    ctx
  );

  const renamed: any = await service.replaceUser(
    created.id,
    { userName: 'kj@nasa.gov', name: { givenName: 'K', familyName: 'Johnson' }, displayName: 'KJ' },
    ctx
  );
  assert.equal(renamed.userName, 'kj@nasa.gov');
  assert.equal(renamed.name.givenName, 'K');
  assert.equal(renamed.name.familyName, 'Johnson');
  assert.equal(renamed.displayName, 'KJ');
  assert.equal(renamed.emails[0].value, 'kj@nasa.gov');

  const reread: any = await service.getUser(created.id, {}, ctx);
  assert.equal(reread.userName, 'kj@nasa.gov');
  assert.equal(reread.displayName, 'KJ');
});

test('PUT clears the attributes it omits', async () => {
  const { service } = makeService();
  const created: any = await service.createUser(
    {
      userName: 'ada@example.com',
      externalId: 'idp-1',
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      displayName: 'Ada L',
      [ENTERPRISE]: { department: 'Analytical Engines' }
    },
    ctx
  );
  assert.equal(created.name.familyName, 'Lovelace');

  const replaced: any = await service.replaceUser(created.id, { userName: 'ada@example.com' }, ctx);
  assert.equal(replaced.name.givenName, undefined);
  assert.equal(replaced.name.familyName, undefined);
  assert.equal(replaced.externalId, undefined);
  assert.equal(replaced[ENTERPRISE], undefined);
  // displayName has no empty state to replace it with, so it re-derives down
  // the fallback chain: name -> orchard handle -> userName.
  assert.equal(replaced.displayName, 'ada-acme');
});

test('an existing account is never attached by an org SCIM, which gets its own identity instead', async () => {
  const { service, users, members } = makeService();
  users.push({
    id: 'victim',
    email: 'victim@example.com',
    username: 'victim',
    emailScope: 'account'
  });
  const before = JSON.stringify(users[0]);
  const evilOrg = { organizationId: '33333333-3333-4333-8333-333333333333' };
  const created: any = await service.createUser(
    { userName: 'victim@example.com', name: { givenName: 'Hostile' } },
    evilOrg
  );
  assert.equal(JSON.stringify(users[0]), before, 'the account is untouched');
  assert.ok(!members.some((m: any) => m.userId === 'victim'), 'and gains no membership');
  const identity = users.find((u: any) => u.homeOrganizationId === evilOrg.organizationId);
  assert.ok(identity);
  assert.equal(identity.emailScope, evilOrg.organizationId);
  assert.equal(created.name.givenName, 'Hostile');
});

test('the same address in two orgs is two separate org identities', async () => {
  const { service, users } = makeService();
  await service.createUser({ userName: 'shared@example.com' }, ctx);
  const otherOrg = { organizationId: '22222222-2222-4222-8222-222222222222' };
  await service.createUser({ userName: 'shared@example.com' }, otherOrg);
  assert.equal(users.length, 2);
  assert.deepEqual(
    users.map((u: any) => u.homeOrganizationId).sort(),
    [ORG, otherOrg.organizationId].sort()
  );
});

test('a brand-new account is seeded from the provisioning payload', async () => {
  const { service, users } = makeService();
  await service.createUser(
    { userName: 'newbie@example.com', name: { givenName: 'New', familyName: 'Bie' } },
    ctx
  );
  assert.equal(users[0].firstName, 'New');
  assert.equal(users[0].lastName, 'Bie');
});

test('a membership added in-app reads through to the account', async () => {
  const { service, users, members } = makeService();
  users.push({ id: 'u-1', email: 'inapp@example.com', firstName: 'In', lastName: 'App' });
  members.push({
    id: 'm-1',
    organizationId: ORG,
    userId: 'u-1',
    role: 'admin',
    addedAt: new Date(),
    scimManaged: false,
    scimExternalId: null,
    scimUserName: null,
    scimGivenName: null,
    scimFamilyName: null,
    scimDisplayName: null,
    scimEnterprise: null
  });

  const read: any = await service.getUser('m-1', {}, ctx);
  assert.equal(read.userName, 'inapp@example.com');
  assert.equal(read.name.givenName, 'In');
  assert.equal(read.roles[0].value, 'admin');
});

test('enterprise extension attributes round-trip', async () => {
  const { service } = makeService();
  const created: any = await service.createUser(
    {
      userName: 'katherine@example.com',
      [ENTERPRISE]: { department: 'Flight Research', employeeNumber: '1953' }
    },
    ctx
  );
  assert.equal(created[ENTERPRISE].department, 'Flight Research');

  const reread: any = await service.getUser(created.id, {}, ctx);
  assert.equal(reread[ENTERPRISE].department, 'Flight Research');
  assert.equal(reread[ENTERPRISE].employeeNumber, '1953');
});

test('the enterprise extension is declared on the User schema', async () => {
  const { service } = makeService();
  const resourceTypes: any = await service.resourceTypes('User');
  assert.ok(
    resourceTypes.schemaExtensions?.some((e: any) => e.schema === ENTERPRISE),
    'ResourceTypes must advertise the enterprise extension'
  );
});

test('a filtered list finds the user by userName', async () => {
  const { service } = makeService();
  await service.createUser({ userName: 'katherine@example.com' }, ctx);
  await service.createUser({ userName: 'dorothy@example.com' }, ctx);

  const found: any = await service.listUsers(
    parseScimQuery({ filter: 'userName eq "dorothy@example.com"' }),
    ctx
  );
  assert.equal(found.Resources.length, 1);
  assert.equal(found.Resources[0].userName, 'dorothy@example.com');
});

// The catch-all is only safe if Express registers it behind every real route,
// since it matches in registration order. This boots the real controller and
// reads back the router table. (Requests aren't driven here: tsx compiles with
// esbuild, which doesn't emit the decorator metadata Nest's DI needs.)
test('the SCIM catch-all registers behind every real endpoint', async () => {
  const { NestFactory } = await import('@nestjs/core');
  const { Module } = await import('@nestjs/common');
  const { ScimController } = await import('../src/scim/scim.controller');
  const { ScimTokensService } = await import('../src/scim/scim-tokens.service');

  @Module({
    controllers: [ScimController],
    providers: [
      { provide: ScimService, useValue: {} },
      { provide: ScimTokensService, useValue: {} }
    ]
  })
  class TestScimModule {}

  const app = await NestFactory.create(TestScimModule, { logger: false });
  app.setGlobalPrefix('apiv1');
  await app.init();

  try {
    const router = (app.getHttpAdapter().getInstance() as any).router;
    const paths: string[] = router.stack.filter((l: any) => l.route).map((l: any) => l.route.path);

    const catchAll = paths.indexOf('/apiv1/scim/v2/{*splat}');
    assert.ok(catchAll >= 0, 'the catch-all must be registered');
    assert.equal(catchAll, paths.length - 1, 'the catch-all must be registered last');
    assert.ok(paths.indexOf('/apiv1/scim/v2/Me') < catchAll);

    for (const route of [
      '/apiv1/scim/v2/Users',
      '/apiv1/scim/v2/Users/:id',
      '/apiv1/scim/v2/Users/.search',
      '/apiv1/scim/v2/Groups',
      '/apiv1/scim/v2/Groups/:id',
      '/apiv1/scim/v2/ServiceProviderConfig',
      '/apiv1/scim/v2/ResourceTypes',
      '/apiv1/scim/v2/ResourceTypes/:id',
      '/apiv1/scim/v2/Schemas',
      '/apiv1/scim/v2/Schemas/:id'
    ]) {
      const at = paths.indexOf(route);
      assert.ok(at >= 0, `${route} must be registered`);
      assert.ok(at < catchAll, `${route} must be registered before the catch-all`);
    }
  } finally {
    await app.close();
  }
});

test('SCIM never emails an address on a domain the org has not verified', async () => {
  const unverified = makeService();
  await unverified.service.createUser({ userName: 'pepito@gmail.example' }, ctx);
  assert.deepEqual(unverified.sent, []);

  const verified = makeService([[ORG, 'acme.example']]);
  await verified.service.createUser({ userName: 'new@acme.example' }, ctx);
  assert.deepEqual(verified.sent, ['new@acme.example']);
});

test('reactivating a stale owner tombstone never promotes a re-added member to owner', async () => {
  const { service, members, tombstones } = makeService();
  await service.createUser({ userName: 'first@example.com' }, ctx);
  const past: any = await service.createUser({ userName: 'past@example.com' }, ctx);
  members[0].role = 'owner';
  members[1].role = 'owner';

  await service.patchUser(past.id, patchOp({ active: false }), ctx);
  assert.equal(tombstones[0].role, 'owner');

  const pastUserId = tombstones[0].userId;
  members.push({
    id: randomUUID(),
    organizationId: ORG,
    userId: pastUserId,
    role: 'member',
    addedAt: new Date(),
    scimManaged: false
  });

  await service.patchUser(past.id, patchOp({ active: true }), ctx);
  const live = members.find((m) => m.userId === pastUserId);
  assert.equal(live.role, 'member');
  assert.equal(members.filter((m) => m.role === 'owner').length, 1);
});

test('reactivating an owner tombstone with no live membership restores at most admin', async () => {
  const { service, members } = makeService();
  await service.createUser({ userName: 'first@example.com' }, ctx);
  const past: any = await service.createUser({ userName: 'past@example.com' }, ctx);
  members[0].role = 'owner';
  members[1].role = 'owner';

  await service.patchUser(past.id, patchOp({ active: false }), ctx);
  await service.patchUser(past.id, patchOp({ active: true }), ctx);
  assert.equal(members.find((m) => m.id === past.id).role, 'admin');
});

test('SCIM deactivate and delete emit a membership revocation for the removed user', async () => {
  const { service, revoked, members } = makeService();
  const created: any = await service.createUser({ userName: 'rev@example.com' }, ctx);
  const userId = members[0].userId;
  await service.patchUser(created.id, patchOp({ active: false }), ctx);
  assert.deepEqual(revoked, [[ORG, userId]]);

  await service.deleteUser(created.id, ctx);
  assert.deepEqual(revoked, [
    [ORG, userId],
    [ORG, userId]
  ]);
});
