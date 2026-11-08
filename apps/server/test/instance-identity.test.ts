import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IdentityMappingService } from '../src/sso/identity-mapping.service';
import { InstanceIdentityService, slugFor } from '../src/sso/instance-identity.service';
import { InstanceSettingsService } from '../src/instance-settings/instance-settings.service';
import { collection as memoryCollection, type Row } from './support/memory-db';

const INSTANCE_IDP = '55555555-5555-4555-8555-555555555555';
const OTHER_IDP = '66666666-6666-4666-8666-666666666666';
const ORG_IDP = '77777777-7777-4777-8777-777777777777';
const HOME_ORG = '88888888-8888-4888-8888-888888888888';
const admin = { userId: 'root', email: 'root@example.com' };

function makeWorld() {
  const tables: Record<string, Row[]> = {
    user: [],
    organization: [],
    organizationMember: [],
    idpGroupRule: [],
    idpAutoCreateRule: [],
    federatedIdentity: [],
    scimGroupMember: [],
    scimGroup: [],
    instanceSetting: [],
    identityProvider: [
      {
        id: INSTANCE_IDP,
        organizationId: null,
        name: 'Company',
        protocol: 'oidc',
        groupClaim: 'groups'
      },
      {
        id: OTHER_IDP,
        organizationId: null,
        name: 'Other',
        protocol: 'oidc',
        groupClaim: 'groups'
      },
      {
        id: ORG_IDP,
        organizationId: HOME_ORG,
        name: 'Tenant',
        protocol: 'saml',
        groupClaim: 'groups'
      }
    ]
  };
  const audits: Row[] = [];
  const sessionWipes: Row[] = [];
  let failClaim = false;

  const col = (name: string, defaults?: () => Row) => memoryCollection(tables, name, defaults);
  const prisma: any = {
    user: col('user'),
    organization: col('organization', () => ({ id: randomUUID() })),
    organizationMember: col('organizationMember', () => ({
      id: randomUUID(),
      managedByProviderId: null
    })),
    idpGroupRule: col('idpGroupRule', () => ({ id: randomUUID() })),
    idpAutoCreateRule: col('idpAutoCreateRule', () => ({ id: randomUUID(), organizationId: null })),
    federatedIdentity: col('federatedIdentity', () => ({
      id: randomUUID(),
      grantedSuperadmin: false
    })),
    scimGroupMember: col('scimGroupMember'),
    scimGroup: col('scimGroup'),
    identityProvider: col('identityProvider'),
    instanceSetting: {
      findUnique: async ({ where }: any) =>
        tables.instanceSetting.find((r) => r.key === where.key) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const row = tables.instanceSetting.find((r) => r.key === where.key);
        if (row) Object.assign(row, update);
        else tables.instanceSetting.push({ ...create });
      },
      deleteMany: async ({ where }: any) => {
        const i = tables.instanceSetting.findIndex((r) => r.key === where.key);
        if (i >= 0) tables.instanceSetting.splice(i, 1);
      }
    }
  };
  const realUpdateMany = prisma.idpAutoCreateRule.updateMany;
  prisma.idpAutoCreateRule.updateMany = async (args: any) =>
    failClaim ? { count: 0 } : realUpdateMany(args);
  prisma.$transaction = async (arg: any) => {
    if (typeof arg === 'function') {
      const snapshot = Object.fromEntries(
        Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))])
      );
      try {
        return await arg(prisma);
      } catch (err) {
        for (const [k, v] of Object.entries(snapshot)) {
          tables[k].splice(0, tables[k].length, ...v);
        }
        throw err;
      }
    }
    return Promise.all(arg);
  };

  const audit = {
    log: async (e: Row) => {
      audits.push(e);
    }
  };
  const sessions = {
    revokeSignInSessions: async (p: Row) => {
      sessionWipes.push(p);
      return 0;
    }
  };
  const membershipCache = { revoked: () => {}, invalidateInternalUserId: () => {} };
  const settings = new InstanceSettingsService(prisma);
  const identity = new InstanceIdentityService(prisma, audit as any, settings, sessions as any);
  const mapping = new IdentityMappingService(
    prisma,
    audit as any,
    sessions as any,
    membershipCache as any,
    { detachMember: async () => {} } as any,
    identity
  );

  const addUser = (email: string, isSuperAdmin = false) => {
    const user = { id: randomUUID(), email, isSuperAdmin };
    tables.user.push(user);
    return user;
  };
  const bind = (userId: string, providerId = INSTANCE_IDP) =>
    tables.federatedIdentity.push({
      id: randomUUID(),
      providerId,
      userId,
      subject: `sub-${userId}`,
      grantedSuperadmin: false
    });
  const provider = (id: string) => tables.identityProvider.find((p) => p.id === id) as any;

  return {
    tables,
    prisma,
    audits,
    sessionWipes,
    settings,
    identity,
    mapping,
    addUser,
    bind,
    provider,
    breakClaim: () => {
      failClaim = true;
    }
  };
}

type World = ReturnType<typeof makeWorld>;

async function autoCreateOn(w: World) {
  await w.identity.setAutoCreateOrgs(true, admin);
}

async function loginWith(w: World, providerId: string, groups: string[], userId?: string) {
  const provider = w.provider(providerId);
  const ctx = await w.mapping.prepare(provider, { groups }, userId);
  await w.mapping.materialize(provider, ctx);
  return { provider, ctx };
}

test('auto-creating organizations is off until an instance admin turns it on', async () => {
  const w = makeWorld();
  assert.equal((await w.identity.getPolicy()).autoCreateOrgs.enabled, false);
  await w.identity.replaceAutoCreateRules(
    w.provider(INSTANCE_IDP),
    { rules: [{ value: 'acme-eng', role: 'admin' }] },
    admin
  );

  const { ctx } = await loginWith(w, INSTANCE_IDP, ['acme-eng']);
  assert.equal(ctx.pending.length, 0);
  assert.equal(w.tables.organization.length, 0);
  assert.equal(w.tables.idpGroupRule.length, 0);
});

test('with the switch on, a matching group creates the organization once', async () => {
  const w = makeWorld();
  await autoCreateOn(w);
  await w.identity.replaceAutoCreateRules(
    w.provider(INSTANCE_IDP),
    { rules: [{ value: 'Acme Eng', role: 'admin' }] },
    admin
  );
  const ada = w.addUser('ada@example.com');
  w.bind(ada.id);

  const first = await loginWith(w, INSTANCE_IDP, ['Acme Eng'], ada.id);
  assert.equal(first.ctx.allowed, true);
  assert.equal(w.tables.organization.length, 1);
  const org = w.tables.organization[0];
  assert.equal(org.name, 'Acme Eng');
  assert.equal(org.slug, 'acme-eng');
  assert.equal(w.tables.idpAutoCreateRule[0].organizationId, org.id);
  assert.equal(w.tables.idpGroupRule.length, 1);
  assert.equal(w.tables.idpGroupRule[0].organizationId, org.id);
  assert.equal(w.tables.idpGroupRule[0].role, 'admin');
  assert.equal(first.ctx.decisions.get(org.id)?.role, 'admin');

  await w.mapping.apply(first.provider, ada as any, first.ctx);
  const member = w.tables.organizationMember.find((m) => m.userId === ada.id)!;
  assert.equal(member.organizationId, org.id);
  assert.equal(member.role, 'admin');
  assert.equal(member.managedByProviderId, INSTANCE_IDP);
  assert.ok(
    w.audits.some((a) => a.action === 'org.created' && a.metadata.via === 'idp_auto_create')
  );
  assert.ok(w.audits.some((a) => a.action === 'sso.org.auto_created'));

  const second = await loginWith(w, INSTANCE_IDP, ['Acme Eng'], ada.id);
  assert.equal(second.ctx.pending.length, 0);
  assert.equal(w.tables.organization.length, 1, 'a second login creates nothing');
  assert.equal(second.ctx.decisions.get(org.id)?.role, 'admin');
});

test('a user in no mapped group is denied and creates nothing', async () => {
  const w = makeWorld();
  await autoCreateOn(w);
  await w.identity.replaceAutoCreateRules(
    w.provider(INSTANCE_IDP),
    { rules: [{ value: 'acme-eng', role: 'member' }] },
    admin
  );
  const { ctx } = await loginWith(w, INSTANCE_IDP, ['someone-else']);
  assert.equal(ctx.hasRules, true);
  assert.equal(ctx.allowed, false);
  assert.equal(w.tables.organization.length, 0);
});

test('the environment pin outranks the stored switch', async () => {
  const w = makeWorld();
  const before = process.env.IDP_AUTO_CREATE_ORGS;
  process.env.IDP_AUTO_CREATE_ORGS = 'false';
  try {
    await assert.rejects(() => w.identity.setAutoCreateOrgs(true, admin), /IDP_AUTO_CREATE_ORGS/);
    assert.equal((await w.identity.getPolicy()).autoCreateOrgs.enabled, false);
  } finally {
    if (before === undefined) delete process.env.IDP_AUTO_CREATE_ORGS;
    else process.env.IDP_AUTO_CREATE_ORGS = before;
  }
});

test('an organization identity provider can never create organizations', async () => {
  const w = makeWorld();
  await autoCreateOn(w);
  await assert.rejects(
    () =>
      w.identity.replaceAutoCreateRules(
        w.provider(ORG_IDP),
        { rules: [{ value: 'acme-eng', role: 'admin' }] },
        admin
      ),
    /Only instance identity providers/
  );

  w.tables.idpAutoCreateRule.push({
    id: randomUUID(),
    providerId: ORG_IDP,
    value: 'acme-eng',
    role: 'admin',
    organizationId: null
  });
  const { ctx } = await loginWith(w, ORG_IDP, ['acme-eng']);
  assert.equal(ctx.pending.length, 0);
  assert.equal(w.tables.organization.length, 0);
});

test('auto-create rules refuse owner and bad names', async () => {
  const w = makeWorld();
  await assert.rejects(
    () =>
      w.identity.replaceAutoCreateRules(
        w.provider(INSTANCE_IDP),
        { rules: [{ value: 'acme', role: 'owner' }] },
        admin
      ),
    /never owner/
  );
  await assert.rejects(
    () =>
      w.identity.replaceAutoCreateRules(
        w.provider(INSTANCE_IDP),
        { rules: [{ value: 'аcme-eng', role: 'member' }] },
        admin
      ),
    /mixes/
  );
});

test('losing the claim race creates no organization', async () => {
  const w = makeWorld();
  await autoCreateOn(w);
  await w.identity.replaceAutoCreateRules(
    w.provider(INSTANCE_IDP),
    { rules: [{ value: 'acme-eng', role: 'member' }] },
    admin
  );
  const provider = w.provider(INSTANCE_IDP);
  const ctx = await w.mapping.prepare(provider, { groups: ['acme-eng'] });
  w.breakClaim();
  await w.mapping.materialize(provider, ctx);
  assert.equal(w.tables.organization.length, 0);
  assert.equal(w.tables.idpGroupRule.length, 0);
});

test('slugs avoid reserved names', () => {
  assert.equal(slugFor('Admin'), 'admin-org');
  assert.equal(slugFor('Acme Eng!'), 'acme-eng');
  assert.equal(slugFor('???'), 'org');
});

test('the superadmin rule is off by default and takes only an instance provider', async () => {
  const w = makeWorld();
  assert.equal((await w.identity.getPolicy()).superadminRule, null);
  await assert.rejects(
    () => w.identity.setSuperadminRule({ providerId: ORG_IDP, value: 'root' }, admin),
    /instance identity provider/
  );
  await assert.rejects(
    () => w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'bad\u0000' }, admin),
    /Group names/
  );
});

test('a matching group makes an instance user superadmin and losing it revokes only that grant', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  const keeper = w.addUser('keeper@example.com', true);
  const ada = w.addUser('ada@example.com');
  w.bind(ada.id);

  const granted = await w.identity.syncSuperadmin(
    w.provider(INSTANCE_IDP),
    ada,
    new Set(['platform-root']),
    true
  );
  assert.equal(granted, true);
  assert.equal(w.tables.user.find((u) => u.id === ada.id)!.isSuperAdmin, true);
  assert.equal(w.tables.federatedIdentity[0].grantedSuperadmin, true);
  assert.ok(w.audits.some((a) => a.action === 'sso.superadmin.granted'));

  const adaNow = w.tables.user.find((u) => u.id === ada.id)! as any;
  const still = await w.identity.syncSuperadmin(w.provider(INSTANCE_IDP), adaNow, new Set(), true);
  assert.equal(still, false);
  assert.equal(adaNow.isSuperAdmin, false);
  assert.ok(w.sessionWipes.length >= 1);
  assert.ok(w.audits.some((a) => a.action === 'sso.superadmin.revoked'));
  assert.equal(w.tables.user.find((u) => u.id === keeper.id)!.isSuperAdmin, true);
});

test('a hand-made superadmin is never demoted by the rule', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  const root = w.addUser('root@example.com', true);
  w.addUser('second@example.com', true);
  w.bind(root.id);

  assert.equal(
    await w.identity.syncSuperadmin(w.provider(INSTANCE_IDP), root, new Set(), true),
    true
  );
  assert.equal(root.isSuperAdmin, true);
});

test('the last superadmin is kept even when the grant disappears', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  const ada = w.addUser('ada@example.com');
  w.bind(ada.id);
  await w.identity.syncSuperadmin(w.provider(INSTANCE_IDP), ada, new Set(['platform-root']), true);
  const now = w.tables.user.find((u) => u.id === ada.id)! as any;

  assert.equal(
    await w.identity.syncSuperadmin(w.provider(INSTANCE_IDP), now, new Set(), true),
    true
  );
  assert.equal(now.isSuperAdmin, true);
});

test('no grant without a verified email or a bound identity', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  const unbound = w.addUser('unbound@example.com');
  const unverified = w.addUser('unverified@example.com');
  w.bind(unverified.id);
  const groups = new Set(['platform-root']);

  assert.equal(
    await w.identity.syncSuperadmin(w.provider(INSTANCE_IDP), unbound, groups, true),
    false
  );
  assert.equal(
    await w.identity.syncSuperadmin(w.provider(INSTANCE_IDP), unverified, groups, false),
    false
  );
});

test('an organization identity provider can never mint a superadmin', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  const mallory = w.addUser('mallory@tenant.example');
  w.bind(mallory.id, ORG_IDP);

  const result = await w.identity.syncSuperadmin(
    w.provider(ORG_IDP),
    mallory,
    new Set(['platform-root']),
    true
  );
  assert.equal(result, false);
  assert.equal(mallory.isSuperAdmin, false);

  w.tables.instanceSetting.push(
    { key: 'idp_superadmin_provider_id', value: ORG_IDP },
    { key: 'idp_superadmin_group', value: 'platform-root' }
  );
  assert.equal(
    await w.identity.syncSuperadmin(w.provider(ORG_IDP), mallory, new Set(['platform-root']), true),
    false
  );
});

test('another instance provider cannot use the rule bound to the first', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  const eve = w.addUser('eve@example.com');
  w.bind(eve.id, OTHER_IDP);
  assert.equal(
    await w.identity.syncSuperadmin(w.provider(OTHER_IDP), eve, new Set(['platform-root']), true),
    false
  );
});

test('clearing or moving the rule demotes everyone it granted', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  w.addUser('keeper@example.com', true);
  const ada = w.addUser('ada@example.com');
  w.bind(ada.id);
  await w.identity.syncSuperadmin(w.provider(INSTANCE_IDP), ada, new Set(['platform-root']), true);
  assert.equal(w.tables.user.find((u) => u.id === ada.id)!.isSuperAdmin, true);

  await w.identity.setSuperadminRule(null, admin);
  assert.equal(w.tables.user.find((u) => u.id === ada.id)!.isSuperAdmin, false);
  assert.equal((await w.identity.getPolicy()).superadminRule, null);
  const audit = w.audits.findLast((a) => a.action === 'admin.sso.superadmin_rule_updated');
  assert.equal(audit?.metadata.demoted, 1);
});

test('a superadmin group lets the user through when other rules would deny them', async () => {
  const w = makeWorld();
  await w.identity.setSuperadminRule({ providerId: INSTANCE_IDP, value: 'platform-root' }, admin);
  w.tables.organization.push({ id: HOME_ORG });
  w.tables.idpGroupRule.push({
    id: randomUUID(),
    providerId: INSTANCE_IDP,
    organizationId: HOME_ORG,
    value: 'acme',
    role: 'member'
  });
  const ctx = await w.mapping.prepare(w.provider(INSTANCE_IDP), { groups: ['platform-root'] });
  assert.equal(ctx.hasRules, true);
  assert.equal(ctx.allowed, true);

  const denied = await w.mapping.prepare(w.provider(INSTANCE_IDP), { groups: ['nope'] });
  assert.equal(denied.allowed, false);
});
