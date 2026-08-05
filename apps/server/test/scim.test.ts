import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import express from 'express';
import SCIMMY from 'scimmy';
import { parseScimQuery } from '../src/scim/scim-query';
import { ScimService } from '../src/scim/scim.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ctx = { organizationId: ORG };

// ---- SCIMMY query-param handling ------------------------------------------
//
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
    (err: any) => err.name === 'SCIMError' && err.status === 400,
  );
});

test('pagination params are coerced to integers and bad ones are rejected', () => {
  assert.deepEqual(parseScimQuery({ startIndex: '1', count: '20' }), { startIndex: 1, count: 20 });
  assert.throws(
    () => parseScimQuery({ count: 'lots' }),
    (err: any) => err.name === 'SCIMError' && err.status === 400,
  );
});

// ---- Request body parsing --------------------------------------------------

// RFC 7644 puts SCIM bodies on application/scim+json, which Express's json
// parser ignores unless it's in the type list — matching main.ts.
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
      body: JSON.stringify({ userName: 'hopper@example.com' }),
    });
    assert.deepEqual(await res.json(), { userName: 'hopper@example.com' });
  } finally {
    server.close();
  }
});

// ---- User lifecycle --------------------------------------------------------

// Enough of the Prisma surface for the SCIM handlers to run against memory.
function makeDb() {
  const users: any[] = [];
  const members: any[] = [];
  const tombstones: any[] = [];

  const hydrate = (row: any) => (row ? { ...row, user: users.find((u) => u.id === row.userId) } : row);
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
    },
  });

  const db: any = {
    user: {
      ...collection(users, () => ({ id: randomUUID(), firstName: null, lastName: null })),
      findUnique: async ({ where }: any) =>
        users.find((u) => (where.email ? u.email === where.email : u.id === where.id)
          || (where.username && u.username === where.username)) ?? null,
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
        scimManaged: false,
      })),
      count: async ({ where }: any) => members.filter((m) => matches(m, where)).length,
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
      displayName: null,
    })),
  };
  db.$transaction = async (fn: any) => fn(db);
  return { db, members, tombstones, users };
}

function makeService() {
  const { db, members, tombstones, users } = makeDb();
  const audit = { log: async () => {} };
  const service = new ScimService(db as any, audit as any);
  service.onModuleInit();
  return { service, members, tombstones, users };
}

const patchOp = (value: any) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', value }],
});

const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

test('provisioning, deactivating and reactivating keeps one stable resource id', async () => {
  const { service, members, tombstones } = makeService();

  const created: any = await service.createUser(
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'ada@example.com', externalId: 'idp-1' },
    ctx,
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
    ctx,
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
    ctx,
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
    (err: any) => err.name === 'SCIMError' && err.status === 409 && err.scimType === 'uniqueness',
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
    (err: any) => err.name === 'SCIMError' && err.status === 404,
  );
});

// ---- Role provisioning -----------------------------------------------------

test('a user can be provisioned straight in as an admin via roles', async () => {
  const { service, members } = makeService();
  const created: any = await service.createUser(
    { userName: 'ada@example.com', roles: [{ value: 'admin', primary: true }] },
    ctx,
  );
  assert.equal(created.roles[0].value, 'admin');
  assert.equal(created.userType, 'admin');
  assert.equal(created.groups[0].value, 'role:admin');
  assert.equal(members[0].role, 'admin');
});

test('userType is accepted as the role when roles is absent', async () => {
  const { service, members } = makeService();
  await service.createUser({ userName: 'grace@example.com', userType: 'owner' }, ctx);
  assert.equal(members[0].role, 'owner');
});

test('an unknown role is rejected rather than silently downgraded', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.createUser({ userName: 'x@example.com', userType: 'superuser' }, ctx),
    (err: any) => err.name === 'SCIMError' && err.status === 400 && err.scimType === 'invalidValue',
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
    ctx,
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
    { op: 'replace', value: { userType: 'admin' } },
  ]) {
    const { service, members } = makeService();
    const created: any = await service.createUser({ userName: 'linus@example.com' }, ctx);
    const promoted: any = await service.patchUser(
      created.id,
      { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [operation] },
      ctx,
    );
    assert.equal(members[0].role, 'admin', `role not applied for ${JSON.stringify(operation)}`);
    assert.equal(promoted.roles[0].value, 'admin');
    assert.equal(promoted.userType, 'admin');
  }
});

test('a write that omits roles leaves the role alone', async () => {
  const { service, members } = makeService();
  const created: any = await service.createUser({ userName: 'edsger@example.com', userType: 'admin' }, ctx);

  await service.replaceUser(created.id, { userName: 'edsger@example.com' }, ctx);
  assert.equal(members[0].role, 'admin', 'an omitted role must not demote to member');
});

test('the last owner cannot be demoted, deactivated or deleted', async () => {
  const { service } = makeService();
  const owner: any = await service.createUser({ userName: 'boss@example.com', userType: 'owner' }, ctx);

  const lastOwner = (err: any) => err.name === 'SCIMError' && err.status === 400;
  await assert.rejects(() => service.patchUser(owner.id, patchOp({ userType: 'member' }), ctx), lastOwner);
  await assert.rejects(() => service.patchUser(owner.id, patchOp({ active: false }), ctx), lastOwner);
  await assert.rejects(() => service.deleteUser(owner.id, ctx), lastOwner);

  // With a second owner in place the guard lifts.
  await service.createUser({ userName: 'cofounder@example.com', userType: 'owner' }, ctx);
  const demoted: any = await service.patchUser(owner.id, patchOp({ userType: 'member' }), ctx);
  assert.equal(demoted.roles[0].value, 'member');
});

// ---- Account isolation -----------------------------------------------------
//
// The SCIM resource is a membership, so everything the IdP writes belongs to
// this org. One org's IdP must never edit the shared account another org reads.

test('an update never writes to the shared user account', async () => {
  const { service, users } = makeService();
  const created: any = await service.createUser(
    { userName: 'grace@example.com', name: { givenName: 'Grace', familyName: 'Hopper' } },
    ctx,
  );
  const account = { ...users[0] };

  await service.replaceUser(
    created.id,
    {
      userName: 'grace.hopper@newcorp.com',
      name: { givenName: 'Rear Admiral', familyName: 'Hopper' },
      displayName: 'Amazing Grace',
    },
    ctx,
  );

  assert.deepEqual(users[0], account, 'the users row must be untouched by a SCIM update');
});

test('the per-org profile is what SCIM reads back', async () => {
  const { service } = makeService();
  const created: any = await service.createUser(
    { userName: 'katherine@example.com', name: { givenName: 'Katherine' } },
    ctx,
  );

  const renamed: any = await service.replaceUser(
    created.id,
    { userName: 'kj@nasa.gov', name: { givenName: 'K', familyName: 'Johnson' }, displayName: 'KJ' },
    ctx,
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
      [ENTERPRISE]: { department: 'Analytical Engines' },
    },
    ctx,
  );
  assert.equal(created.name.familyName, 'Lovelace');

  const replaced: any = await service.replaceUser(created.id, { userName: 'ada@example.com' }, ctx);
  assert.equal(replaced.name.givenName, undefined);
  assert.equal(replaced.name.familyName, undefined);
  assert.equal(replaced.externalId, undefined);
  assert.equal(replaced[ENTERPRISE], undefined);
  // displayName has no empty state to replace it with, so it re-derives down
  // the fallback chain: name -> orchard handle -> userName.
  assert.equal(replaced.displayName, 'ada');
});

test('an existing account joining a second org is linked, not rewritten', async () => {
  const { service, users } = makeService();
  await service.createUser(
    { userName: 'shared@example.com', name: { givenName: 'Real', familyName: 'Name' } },
    ctx,
  );
  const account = { ...users[0] };

  // Same person, different org, IdP calls them something else entirely.
  const otherOrg = { organizationId: '22222222-2222-4222-8222-222222222222' };
  const linked: any = await service.createUser(
    { userName: 'shared@example.com', name: { givenName: 'Contractor' } },
    otherOrg,
  );

  assert.equal(users.length, 1, 'the same account must be reused');
  assert.deepEqual(users[0], account, 'the second org must not rewrite the account');
  assert.equal(linked.name.givenName, 'Contractor', "but it does get its own view");
});

test('a brand-new account is seeded from the provisioning payload', async () => {
  const { service, users } = makeService();
  await service.createUser(
    { userName: 'newbie@example.com', name: { givenName: 'New', familyName: 'Bie' } },
    ctx,
  );
  assert.equal(users[0].firstName, 'New');
  assert.equal(users[0].lastName, 'Bie');
});

test('a membership added in-app reads through to the account', async () => {
  const { service, users, members } = makeService();
  users.push({ id: 'u-1', email: 'inapp@example.com', firstName: 'In', lastName: 'App' });
  members.push({
    id: 'm-1', organizationId: ORG, userId: 'u-1', role: 'admin', addedAt: new Date(),
    scimManaged: false, scimExternalId: null, scimUserName: null,
    scimGivenName: null, scimFamilyName: null, scimDisplayName: null, scimEnterprise: null,
  });

  const read: any = await service.getUser('m-1', {}, ctx);
  assert.equal(read.userName, 'inapp@example.com');
  assert.equal(read.name.givenName, 'In');
  assert.equal(read.roles[0].value, 'admin');
});

// ---- Enterprise extension --------------------------------------------------

test('enterprise extension attributes round-trip', async () => {
  const { service } = makeService();
  const created: any = await service.createUser(
    {
      userName: 'katherine@example.com',
      [ENTERPRISE]: { department: 'Flight Research', employeeNumber: '1953' },
    },
    ctx,
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
    'ResourceTypes must advertise the enterprise extension',
  );
});

test('a filtered list finds the user by userName', async () => {
  const { service } = makeService();
  await service.createUser({ userName: 'katherine@example.com' }, ctx);
  await service.createUser({ userName: 'dorothy@example.com' }, ctx);

  const found: any = await service.listUsers(
    parseScimQuery({ filter: 'userName eq "dorothy@example.com"' }),
    ctx,
  );
  assert.equal(found.Resources.length, 1);
  assert.equal(found.Resources[0].userName, 'dorothy@example.com');
});

// ---- Routing ---------------------------------------------------------------

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
      { provide: ScimTokensService, useValue: {} },
    ],
  })
  class TestScimModule {}

  const app = await NestFactory.create(TestScimModule, { logger: false });
  app.setGlobalPrefix('apiv1');
  await app.init();

  try {
    const router = (app.getHttpAdapter().getInstance() as any)._router;
    const paths: string[] = router.stack.filter((l: any) => l.route).map((l: any) => l.route.path);

    const catchAll = paths.indexOf('/apiv1/scim/v2/*');
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
      '/apiv1/scim/v2/Schemas/:id',
    ]) {
      const at = paths.indexOf(route);
      assert.ok(at >= 0, `${route} must be registered`);
      assert.ok(at < catchAll, `${route} must be registered before the catch-all`);
    }
  } finally {
    await app.close();
  }
});
