import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SsoAdminController } from '../src/sso/sso-admin.controller';
import { SsoService } from '../src/sso/sso.service';
import { IdentityMappingService } from '../src/sso/identity-mapping.service';
import { AuthorizationService } from '../src/auth/authorization.service';
import { requestAuthStorage, type RequestAuthContext } from '../src/auth/request-context';
import { IS_PUBLIC_KEY } from '../src/auth/decorators';

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const provider = (id: string, organizationId: string | null) => ({
  id,
  organizationId,
  slug: id,
  name: id,
  protocol: 'oidc',
  enabled: true,
  clientSecret: 'sealed',
  callbackPath: null,
  samlIssuer: null
});

function world() {
  const members = [
    { organizationId: ORG_A, userId: 'owner-a', role: 'owner', status: 'active' },
    { organizationId: ORG_A, userId: 'admin-a', role: 'admin', status: 'active' },
    { organizationId: ORG_A, userId: 'member-a', role: 'member', status: 'active' },
    { organizationId: ORG_A, userId: 'guest-a', role: 'guest', status: 'active' },
    { organizationId: ORG_A, userId: 'off-a', role: 'owner', status: 'disabled' },
    { organizationId: ORG_B, userId: 'owner-b', role: 'owner', status: 'active' }
  ];
  const providers = [
    provider('prov-a', ORG_A),
    provider('prov-b', ORG_B),
    provider('prov-instance', null)
  ];
  const prisma: any = {
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
    user: { findUnique: async () => ({ isSuperAdmin: false }) },
    identityProvider: {
      findUnique: async ({ where }: any) => providers.find((p) => p.id === where.id) ?? null,
      findFirst: async ({ where }: any) =>
        providers.find((p) => p.id === where.id && p.organizationId === where.organizationId) ??
        null
    }
  };
  const calls: { target: string; method: string; args: unknown[] }[] = [];
  const recorder = (target: string, real: Record<string, any> = {}) =>
    new Proxy(real, {
      get: (obj, method: string) => {
        if (method in obj) return obj[method];
        return async (...args: unknown[]) => {
          calls.push({ target, method, args });
          return { ok: true };
        };
      }
    });
  const realSso = new SsoService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  const realMapping = new IdentityMappingService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  const sso = recorder('sso', {
    getProviderForAdmin: (id: string, org: string | null) => {
      calls.push({ target: 'sso', method: 'getProviderForAdmin', args: [id, org] });
      return realSso.getProviderForAdmin(id, org);
    }
  });
  const mapping = recorder('mapping', {
    requireProvider: (id: string, org: string | null) => realMapping.requireProvider(id, org)
  });
  const login = recorder('login');
  const domains = recorder('domains');
  const users = {
    findOrCreateByClerkId: async (sub: string) => ({ id: sub, email: `${sub}@example.com` })
  };
  const authz = new AuthorizationService(prisma, {} as any);
  const controller = new SsoAdminController(
    sso as any,
    login as any,
    domains as any,
    authz,
    users as any,
    mapping as any
  );
  return { controller, calls };
}

const req = (sub: string) => ({ user: { sub, email: `${sub}@example.com` }, auth: {} });
const png = {
  mimetype: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a00', 'hex'),
  size: 9
} as any;

type Route = {
  name: string;
  level: 'admin' | 'owner';
  call: (c: SsoAdminController, org: string, r: any) => Promise<unknown>;
};

const routes: Route[] = [
  { name: 'overview', level: 'admin', call: (c, o, r) => c.overview(o, r) },
  { name: 'listDomains', level: 'admin', call: (c, o, r) => c.listDomains(o, r) },
  { name: 'listProviders', level: 'admin', call: (c, o, r) => c.listProviders(o, r) },
  { name: 'getProvider', level: 'admin', call: (c, o, r) => c.getProvider(o, 'prov-a', r) },
  { name: 'listRules', level: 'admin', call: (c, o, r) => c.listRules(o, 'prov-a', r) },
  {
    name: 'listProjectRules',
    level: 'admin',
    call: (c, o, r) => c.listProjectRules(o, 'prov-a', r)
  },
  {
    name: 'previewRules',
    level: 'admin',
    call: (c, o, r) => c.previewRules(o, 'prov-a', ['admins'], r)
  },
  { name: 'addDomain', level: 'owner', call: (c, o, r) => c.addDomain(o, 'acme.test', r) },
  { name: 'verifyDomain', level: 'owner', call: (c, o, r) => c.verifyDomain(o, 'd1', r) },
  { name: 'removeDomain', level: 'owner', call: (c, o, r) => c.removeDomain(o, 'd1', r) },
  {
    name: 'updateSettings',
    level: 'owner',
    call: (c, o, r) => c.updateSettings(o, { enforced: true } as any, r)
  },
  {
    name: 'createProvider',
    level: 'owner',
    call: (c, o, r) => c.createProvider(o, { name: 'x' } as any, r)
  },
  {
    name: 'updateProvider',
    level: 'owner',
    call: (c, o, r) => c.updateProvider(o, 'prov-a', { name: 'x' } as any, r)
  },
  { name: 'deleteProvider', level: 'owner', call: (c, o, r) => c.deleteProvider(o, 'prov-a', r) },
  {
    name: 'uploadProviderIcon',
    level: 'owner',
    call: (c, o, r) => c.uploadProviderIcon(o, 'prov-a', png, r)
  },
  {
    name: 'removeProviderIcon',
    level: 'owner',
    call: (c, o, r) => c.removeProviderIcon(o, 'prov-a', r)
  },
  {
    name: 'replaceRules',
    level: 'owner',
    call: (c, o, r) => c.replaceRules(o, 'prov-a', { rules: [] } as any, r)
  },
  {
    name: 'replaceProjectRules',
    level: 'owner',
    call: (c, o, r) => c.replaceProjectRules(o, 'prov-a', { rules: [] }, r)
  },
  { name: 'testProvider', level: 'owner', call: (c, o, r) => c.testProvider(o, 'prov-a', r) }
];

test('members and guests of the organization get 403 on every SSO admin route', async () => {
  for (const who of ['member-a', 'guest-a']) {
    const { controller, calls } = world();
    for (const route of routes) {
      await assert.rejects(
        route.call(controller, ORG_A, req(who)),
        ForbiddenException,
        `${who} ${route.name}`
      );
    }
    assert.deepEqual(calls, [], who);
  }
});

test('outsiders, disabled members and owners of other organizations get 404 on every SSO admin route', async () => {
  for (const who of ['owner-b', 'off-a', 'stranger']) {
    const { controller, calls } = world();
    for (const route of routes) {
      await assert.rejects(
        route.call(controller, ORG_A, req(who)),
        NotFoundException,
        `${who} ${route.name}`
      );
    }
    assert.deepEqual(calls, [], who);
  }
});

test('an admin can read the SSO configuration but cannot change who the IdP may sign in as', async () => {
  const { controller, calls } = world();
  for (const route of routes.filter((r) => r.level === 'admin')) {
    await route.call(controller, ORG_A, req('admin-a'));
  }
  const reads = calls.length;
  assert.ok(reads > 0);
  for (const route of routes.filter((r) => r.level === 'owner')) {
    await assert.rejects(
      route.call(controller, ORG_A, req('admin-a')),
      ForbiddenException,
      route.name
    );
  }
  assert.equal(calls.length, reads);
});

test('the owner reaches every SSO admin route, always scoped to the organization in the URL', async () => {
  const { controller, calls } = world();
  for (const route of routes) {
    await route.call(controller, ORG_A, req('owner-a'));
  }
  const scoped = calls.filter((c) => c.target !== 'login');
  assert.ok(scoped.length >= routes.length - 1);
  for (const call of scoped) {
    const orgArg = call.args.find((a) => a === ORG_A || a === ORG_B || a === null);
    if (
      call.method === 'listRules' ||
      call.method === 'listProjectRules' ||
      call.method === 'preview' ||
      call.method === 'replaceRules' ||
      call.method === 'replaceProjectRules'
    ) {
      assert.equal((call.args[0] as any).organizationId, ORG_A, call.method);
      continue;
    }
    assert.equal(orgArg, ORG_A, `${call.target}.${call.method}`);
  }
  assert.deepEqual(
    calls.filter((c) => c.target === 'login').map((c) => c.args),
    [['prov-a']]
  );
});

test('a provider id from another organization or the instance is 404 through this organization routes', async () => {
  const { controller, calls } = world();
  for (const foreign of ['prov-b', 'prov-instance', 'nope']) {
    await assert.rejects(controller.getProvider(ORG_A, foreign, req('owner-a')), NotFoundException);
    await assert.rejects(controller.listRules(ORG_A, foreign, req('owner-a')), NotFoundException);
    await assert.rejects(
      controller.listProjectRules(ORG_A, foreign, req('owner-a')),
      NotFoundException
    );
    await assert.rejects(
      controller.previewRules(ORG_A, foreign, ['x'], req('owner-a')),
      NotFoundException
    );
    await assert.rejects(
      controller.replaceRules(ORG_A, foreign, { rules: [] } as any, req('owner-a')),
      NotFoundException
    );
    await assert.rejects(
      controller.replaceProjectRules(ORG_A, foreign, { rules: [] }, req('owner-a')),
      NotFoundException
    );
    await assert.rejects(
      controller.testProvider(ORG_A, foreign, req('owner-a')),
      NotFoundException
    );
  }
  assert.deepEqual(
    calls.filter((c) => c.target !== 'sso' || c.method !== 'getProviderForAdmin'),
    []
  );
});

test('a project-scoped token held by the owner cannot read or change SSO', async () => {
  const { controller, calls } = world();
  const ctx: RequestAuthContext = {
    apiTokenId: 't',
    tokenScopes: ['deploy'],
    tokenProjectIds: ['p1']
  };
  for (const route of routes) {
    await assert.rejects(
      requestAuthStorage.run(ctx, () => route.call(controller, ORG_A, req('owner-a'))),
      ForbiddenException,
      route.name
    );
  }
  assert.deepEqual(calls, []);
});

test('a session confined to another organization cannot reach this organization SSO', async () => {
  const { controller, calls } = world();
  const ctx: RequestAuthContext = { browserSession: true, sessionId: 's', sessionOrgId: ORG_B };
  for (const route of routes) {
    await assert.rejects(
      requestAuthStorage.run(ctx, () => route.call(controller, ORG_A, req('owner-a'))),
      NotFoundException,
      route.name
    );
  }
  assert.deepEqual(calls, []);
});

test('the owner of one organization cannot test or edit another organization provider through their own', async () => {
  const { controller, calls } = world();
  await assert.rejects(controller.testProvider(ORG_B, 'prov-b', req('owner-a')), NotFoundException);
  await assert.rejects(controller.testProvider(ORG_A, 'prov-b', req('owner-a')), NotFoundException);
  assert.equal(calls.filter((c) => c.target === 'login').length, 0);
});

test('the organization SSO admin routes are authenticated, never public', () => {
  assert.notEqual(Reflect.getMetadata(IS_PUBLIC_KEY, SsoAdminController), true);
  for (const route of routes) {
    const handler = (SsoAdminController.prototype as any)[route.name];
    assert.equal(typeof handler, 'function', route.name);
    assert.notEqual(Reflect.getMetadata(IS_PUBLIC_KEY, handler), true, route.name);
  }
});
