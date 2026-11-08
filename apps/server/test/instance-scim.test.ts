import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { InstanceScimService, hashInstanceScimToken } from '../src/scim/instance-scim.service';
import { UsersService } from '../src/users/users.service';
import { collection, type Row } from './support/memory-db';

function world() {
  const tables: Record<string, Row[]> = {
    user: [],
    instanceScimToken: [],
    session: [],
    apiToken: []
  };
  const now = () => new Date();
  const prisma: any = {
    user: collection(tables, 'user', () => ({
      id: randomUUID(),
      emailScope: 'account',
      homeOrganizationId: null,
      firstName: null,
      lastName: null,
      disabledAt: null,
      scimExternalId: null,
      isSuperAdmin: false,
      createdAt: now(),
      updatedAt: now()
    })),
    instanceScimToken: collection(tables, 'instanceScimToken', () => ({ id: randomUUID() })),
    session: collection(tables, 'session'),
    apiToken: collection(tables, 'apiToken')
  };
  const findMany = prisma.user.findMany;
  prisma.user.findMany = async (args: any) => {
    const rows = await findMany(args);
    return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length));
  };
  const users = Object.create(UsersService.prototype) as any;
  users.prisma = prisma;
  users.invalidateUserCache = () => {};
  const audits: Row[] = [];
  const scim = new InstanceScimService(
    prisma,
    {
      log: async (e: Row) => {
        audits.push(e);
      }
    } as any,
    users
  );
  return { tables, scim, audits };
}

test('instance SCIM creates an account, and refuses a second one for the same address', async () => {
  const w = world();
  const created: any = await w.scim.create({
    userName: 'Ada@Corp.example',
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    externalId: 'okta-1'
  });
  assert.equal(created.userName, 'ada@corp.example');
  assert.equal(created.active, true);
  assert.equal(w.tables.user[0].emailScope, 'account');
  assert.equal(w.tables.user[0].homeOrganizationId, null);
  await assert.rejects(
    () => w.scim.create({ userName: 'ada@corp.example' }),
    (e: any) => e.getStatus() === 409
  );
});

test('instance SCIM lists and filters accounts only, never org identities', async () => {
  const w = world();
  await w.scim.create({ userName: 'ada@corp.example' });
  w.tables.user.push({
    id: 'ident',
    email: 'ada@corp.example',
    emailScope: 'org-1',
    homeOrganizationId: 'org-1',
    username: 'ada-org',
    createdAt: new Date(),
    updatedAt: new Date()
  });
  const all: any = await w.scim.list({});
  assert.equal(all.totalResults, 1);
  const hit: any = await w.scim.list({ filter: 'userName eq "ada@corp.example"' });
  assert.equal(hit.Resources.length, 1);
  assert.notEqual(hit.Resources[0].id, 'ident');
  await assert.rejects(
    () => w.scim.get('ident'),
    (e: any) => e.getStatus() === 404
  );
  await assert.rejects(
    () => w.scim.list({ filter: 'active pr' }),
    (e: any) => e.getStatus() === 400
  );
});

test('deprovisioning turns the account off and kills its sessions and tokens; delete does the same', async () => {
  const w = world();
  const created: any = await w.scim.create({ userName: 'bob@corp.example' });
  w.tables.session.push({ id: 's1', userId: created.id, revokedAt: null });
  w.tables.apiToken.push({ id: 't1', userId: created.id });

  const off: any = await w.scim.patch(created.id, {
    Operations: [{ op: 'replace', value: { active: false } }]
  });
  assert.equal(off.active, false);
  assert.ok(w.tables.user[0].disabledAt);
  assert.ok(w.tables.session[0].revokedAt);
  assert.equal(w.tables.apiToken.length, 0);

  const on: any = await w.scim.patch(created.id, {
    Operations: [{ op: 'replace', path: 'active', value: true }]
  });
  assert.equal(on.active, true);

  await w.scim.remove(created.id);
  assert.ok(w.tables.user[0].disabledAt, 'delete turns the account off, it never removes it');
  assert.equal(w.tables.user.length, 1);
});

test('instance SCIM cannot turn off the last superadmin', async () => {
  const w = world();
  const created: any = await w.scim.create({ userName: 'root@corp.example' });
  w.tables.user[0].isSuperAdmin = true;
  await assert.rejects(
    () => w.scim.remove(created.id),
    (e: any) => e.getStatus() === 400
  );
});

test('only an unexpired instance token is accepted, and org SCIM tokens never are', async () => {
  const w = world();
  const { token } = await w.scim.createToken('root', 'okta');
  assert.match(token, /^iscim_/);
  assert.equal(await w.scim.resolveToken(token), true);
  assert.equal(await w.scim.resolveToken(`scim_${token.slice(6)}`), false);
  assert.equal(await w.scim.resolveToken(''), false);
  w.tables.instanceScimToken[0].expiresAt = new Date(Date.now() - 1000);
  assert.equal(await w.scim.resolveToken(token), false);
  assert.equal(w.tables.instanceScimToken[0].tokenHash, hashInstanceScimToken(token));
});
