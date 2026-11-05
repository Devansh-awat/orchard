import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { parseManifest } from '../src/grafts/manifest';
import { AuthorizationService } from '../src/auth/authorization.service';
import { orgSsoRefusal } from '../src/auth/org-sso-refusal';
import { requestAuthStorage } from '../src/auth/request-context';
import { execRequestContext } from '../src/kubernetes/exec-session-engine';
import { OrganizationsService } from '../src/organizations/organizations.service';
import { SsoLoginService } from '../src/sso/sso-login.service';

const ENFORCING = 'org-enforcing';
const OTHER = 'org-other';

function buildAuthz(roles: Record<string, string>) {
  const prisma = {
    user: { findUnique: async () => ({ isSuperAdmin: false }) },
    organization: { findUnique: async () => ({ id: ENFORCING }) },
    organizationMember: {
      findUnique: async ({ where }: any) => {
        const role = roles[where.organizationId_userId.organizationId];
        return role ? { role } : null;
      },
      findMany: async () =>
        roles[ENFORCING] && roles[ENFORCING] !== 'owner' ? [{ organizationId: ENFORCING }] : []
    },
    projectMember: { findFirst: async () => null },
    orgSsoSettings: {
      findFirst: async ({ where }: any) =>
        where.organizationId === ENFORCING ? { organizationId: ENFORCING } : null
    }
  };
  return new AuthorizationService(prisma as any, { isSsoEnforced: async () => false } as any);
}

const session = (extra = {}) => ({ browserSession: true, ...extra });

test('a normal session stays out of an enforcing org and keeps every other org', async () => {
  const authz = buildAuthz({ [ENFORCING]: 'member', [OTHER]: 'owner' });
  await requestAuthStorage.run(session(), async () => {
    assert.equal(await authz.getOrgAccess(ENFORCING, 'pepito'), null);
    assert.equal(await authz.resolveProjectAccess('p', ENFORCING, 'pepito'), null);
    assert.equal((await authz.getOrgAccess(OTHER, 'pepito'))?.role, 'owner');
    assert.equal((await authz.resolveProjectAccess('p', OTHER, 'pepito'))?.canEdit, true);
    assert.equal(await authz.orgRequiresSso(ENFORCING, 'pepito'), true);
    assert.equal(await authz.orgRequiresSso(OTHER, 'pepito'), false);
    assert.deepEqual(await authz.ssoBlockedOrgIds('pepito'), [ENFORCING]);
  });
});

test("that org's own SSO session gets in, and stays confined to it", async () => {
  const authz = buildAuthz({ [ENFORCING]: 'member', [OTHER]: 'owner' });
  await requestAuthStorage.run(session({ sessionOrgId: ENFORCING }), async () => {
    assert.equal((await authz.getOrgAccess(ENFORCING, 'pepito'))?.role, 'member');
    assert.equal(await authz.getOrgAccess(OTHER, 'pepito'), null);
    assert.deepEqual(await authz.ssoBlockedOrgIds('pepito'), []);
  });
});

test('owners keep a way in when their provider breaks', async () => {
  const authz = buildAuthz({ [ENFORCING]: 'owner' });
  await requestAuthStorage.run(session(), async () => {
    assert.equal((await authz.getOrgAccess(ENFORCING, 'owner'))?.role, 'owner');
    assert.equal(await authz.orgRequiresSso(ENFORCING, 'owner'), false);
  });
});

test('background work and public routes are not gated', async () => {
  const authz = buildAuthz({ [ENFORCING]: 'member' });
  assert.equal((await authz.getOrgAccess(ENFORCING, 'pepito'))?.role, 'member');
  await requestAuthStorage.run({}, async () => {
    assert.equal((await authz.getOrgAccess(ENFORCING, 'pepito'))?.role, 'member');
  });
});

for (const [name, credential] of [
  ['an API token', { apiTokenId: 't', tokenScopes: ['deploy'], tokenProjectIds: [] }],
  ['a project token', { apiTokenId: 't', tokenScopes: ['deploy'], tokenProjectIds: ['p'] }],
  ['an MCP connection', { mcpGateway: true }]
] as const) {
  test(`${name} made without SSO stays out of an enforcing org and keeps the others`, async () => {
    const authz = buildAuthz({ [ENFORCING]: 'member', [OTHER]: 'member' });
    await requestAuthStorage.run({ ...credential }, async () => {
      assert.equal(await authz.getOrgAccess(ENFORCING, 'pepito'), null);
      assert.equal(await authz.resolveProjectAccess('p', ENFORCING, 'pepito'), null);
      assert.equal(await authz.orgRequiresSso(ENFORCING, 'pepito'), true);
      assert.deepEqual(await authz.ssoBlockedOrgIds('pepito'), [ENFORCING]);
      assert.equal((await authz.getOrgAccess(OTHER, 'pepito'))?.role, 'member');
    });
  });

  test(`${name} made from that org's SSO gets in, and stays confined to it`, async () => {
    const authz = buildAuthz({ [ENFORCING]: 'member', [OTHER]: 'member' });
    await requestAuthStorage.run({ ...credential, sessionOrgId: ENFORCING }, async () => {
      assert.equal((await authz.getOrgAccess(ENFORCING, 'pepito'))?.role, 'member');
      assert.equal(await authz.getOrgAccess(OTHER, 'pepito'), null);
      assert.deepEqual(await authz.ssoBlockedOrgIds('pepito'), []);
    });
  });

  test(`${name} of an owner keeps working when their provider breaks`, async () => {
    const authz = buildAuthz({ [ENFORCING]: 'owner' });
    await requestAuthStorage.run({ ...credential }, async () => {
      assert.equal((await authz.getOrgAccess(ENFORCING, 'owner'))?.role, 'owner');
    });
  });
}

test('a token refused by SSO is told why instead of getting a 404', async () => {
  const authz = buildAuthz({ [ENFORCING]: 'member' });
  await requestAuthStorage.run({ apiTokenId: 't' }, async () => {
    assert.equal(orgSsoRefusal(new NotFoundException()), null);
    await authz.getOrgAccess(ENFORCING, 'pepito');
    const refusal = orgSsoRefusal(new NotFoundException());
    assert.ok(refusal instanceof ForbiddenException);
    assert.equal((refusal.getResponse() as any).error, 'org_sso_required');
    assert.ok(orgSsoRefusal(new ForbiddenException()) instanceof ForbiddenException);
    assert.equal(orgSsoRefusal(new UnauthorizedException()), null);
    assert.equal(orgSsoRefusal(new Error('boom')), null);
  });
});

test('a browser session and a token confined elsewhere keep the plain 404', async () => {
  const authz = buildAuthz({ [ENFORCING]: 'member' });
  await requestAuthStorage.run(session(), async () => {
    await authz.getOrgAccess(ENFORCING, 'pepito');
    assert.equal(orgSsoRefusal(new NotFoundException()), null);
  });
  await requestAuthStorage.run({ apiTokenId: 't', sessionOrgId: OTHER }, async () => {
    await authz.resolveProjectAccess('p', ENFORCING, 'pepito');
    assert.equal(orgSsoRefusal(new NotFoundException()), null);
  });
});

test('a terminal keeps the org limit of the token that opened it', () => {
  const tokenAuthCtx = { apiTokenId: 't', tokenScopes: ['exec'], tokenProjectIds: [] };
  assert.deepEqual(execRequestContext({ sessionOrgScope: ENFORCING, tokenAuthCtx }), {
    ...tokenAuthCtx,
    sessionOrgId: ENFORCING
  });
  assert.deepEqual(execRequestContext({ sessionOrgScope: undefined, tokenAuthCtx }), tokenAuthCtx);
  assert.deepEqual(execRequestContext({ sessionOrgScope: ENFORCING, tokenAuthCtx: null }), {
    sessionOrgId: ENFORCING,
    browserSession: true
  });
});

function buildLogin(user: any, role: string, verifiedDomain: boolean) {
  const login = Object.create(SsoLoginService.prototype) as any;
  login.logger = { warn() {} };
  login.domains = { isVerifiedFor: async () => verifiedDomain };
  login.prisma = {
    user: { findUnique: async () => user },
    organizationMember: { findUnique: async () => ({ role }) },
    organization: { findUnique: async () => ({ slug: 'acme' }) }
  };
  return (linked?: string) =>
    login.resolveOrgUser(
      { id: 'p', organizationId: 'org', createdBy: 'someone' },
      user.email,
      'Name',
      linked
    );
}

const pepito = { id: 'pepito', email: 'pepito@gmail.example', emailVerified: true };

test('an org IdP cannot sign in as an account it does not own', async () => {
  const resolve = buildLogin(pepito, 'member', false);
  await assert.rejects(() => resolve(), UnauthorizedException);
  await assert.rejects(() => resolve('someone-else'), UnauthorizedException);
});

test('the person can start that sign-in from their own session', async () => {
  const resolve = buildLogin(pepito, 'member', false);
  assert.equal((await resolve('pepito')).id, 'pepito');
});

test('a verified domain lets the org sign in its own people', async () => {
  const resolve = buildLogin(pepito, 'member', true);
  assert.equal((await resolve()).id, 'pepito');
});

test('an account nobody has claimed yet can sign in through the org that provisioned it', async () => {
  const resolve = buildLogin({ ...pepito, emailVerified: false }, 'member', false);
  assert.equal((await resolve()).id, 'pepito');
});

function buildOrgs(member: any, verifiedDomain = false) {
  const calls: string[] = [];
  const service = Object.create(OrganizationsService.prototype) as any;
  service.usersService = {
    findOrCreateByClerkId: async () => ({ id: 'pepito', email: 'pepito@gmail.example' })
  };
  service.audit = { log: () => calls.push('audit') };
  service.detachMember = async () => calls.push('detached');
  service.prisma = {
    organizationMember: { findUnique: async () => member },
    orgDomain: { findFirst: async () => (verifiedDomain ? { id: 'd' } : null) }
  };
  return { service, calls };
}

const inBrowser = <T>(fn: () => Promise<T>) => requestAuthStorage.run(session(), fn);

test('someone added without asking can leave, even without the org SSO', async () => {
  const { service, calls } = buildOrgs({ id: 'm', role: 'member', scimManaged: true });
  await inBrowser(() => service.leaveOrganization('org', 'pepito'));
  assert.deepEqual(calls, ['detached', 'audit']);
});

test('tokens, owners and domain-managed members cannot leave', async () => {
  const member = { id: 'm', role: 'member', scimManaged: true };
  await assert.rejects(
    () =>
      requestAuthStorage.run({ apiTokenId: 't' }, () =>
        buildOrgs(member).service.leaveOrganization('org', 'pepito')
      ),
    /signed-in browser/
  );
  await assert.rejects(
    () =>
      inBrowser(() =>
        buildOrgs({ ...member, role: 'owner' }).service.leaveOrganization('org', 'x')
      ),
    /Transfer ownership/
  );
  await assert.rejects(
    () => inBrowser(() => buildOrgs(member, true).service.leaveOrganization('org', 'x')),
    /manages your membership/
  );
});

test('a confined session cannot leave a different org', async () => {
  const { service } = buildOrgs({ id: 'm', role: 'member' });
  await assert.rejects(
    () =>
      requestAuthStorage.run(session({ sessionOrgId: 'elsewhere' }), () =>
        service.leaveOrganization('org', 'pepito')
      ),
    /not found/i
  );
});

test('a minimal graft manifest still gets every nested default', () => {
  const manifest = parseManifest({
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'someone',
    engines: { platform: '*', sdk: '*' }
  });
  assert.deepEqual(manifest.requires, { grafts: {}, kubernetes: { crds: [], verbs: [] } });
  assert.deepEqual(manifest.claims.engineShards, []);
  assert.deepEqual(manifest.claims.apiAliases, []);
  assert.deepEqual(manifest.database, { coreReads: {}, adopts: [] });
  assert.deepEqual(manifest.ui, { screens: [] });
  assert.deepEqual(manifest.public, { routes: [] });
  assert.deepEqual(manifest.entries, {});
  assert.throws(() => parseManifest({ id: 'demo', extra: true }), /invalid graft\.json/);
});
