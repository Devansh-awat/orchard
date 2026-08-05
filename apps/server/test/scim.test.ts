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
    organizationMember: collection(members, () => ({
      id: randomUUID(),
      role: 'member',
      addedAt: new Date(),
      scimExternalId: null,
      scimManaged: false,
    })),
    scimDeprovisionedMember: collection(tombstones, () => ({
      id: randomUUID(),
      role: 'member',
      deactivatedAt: new Date(),
      externalId: null,
    })),
  };
  db.$transaction = async (fn: any) => fn(db);
  return { db, members, tombstones };
}

function makeService() {
  const { db, members, tombstones } = makeDb();
  const audit = { log: async () => {} };
  const service = new ScimService(db as any, audit as any);
  service.onModuleInit();
  return { service, members, tombstones };
}

const patchOp = (value: any) => ({
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', value }],
});

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
