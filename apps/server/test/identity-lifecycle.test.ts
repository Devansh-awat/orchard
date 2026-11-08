import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IdentityMappingService } from '../src/sso/identity-mapping.service';
import { OrganizationsService } from '../src/organizations/organizations.service';
import { SessionsService } from '../src/auth/sessions.service';
import { AdminService } from '../src/admin/admin.service';
import { collection, type Row } from './support/memory-db';

const ORG = 'org-a';
const OTHER = 'org-b';
const ROLES = [
  { id: 'r-viewer', name: 'viewer' },
  { id: 'r-member', name: 'member' },
  { id: 'r-admin', name: 'admin' }
];

function mappingWorld() {
  const tables: Record<string, Row[]> = {
    idpProjectRule: [],
    projectMember: [],
    organizationMember: [],
    project: [
      { id: 'p1', organizationId: ORG },
      { id: 'p2', organizationId: ORG },
      { id: 'px', organizationId: OTHER }
    ],
    role: ROLES.map((r) => ({ ...r }))
  };
  const hydrateRule = (row: Row | undefined) =>
    row ? { ...row, role: ROLES.find((r) => r.id === row.roleId) } : null;
  const prisma: any = {
    idpProjectRule: collection(tables, 'idpProjectRule', () => ({ id: randomUUID() }), hydrateRule),
    projectMember: collection(tables, 'projectMember', () => ({ id: randomUUID() })),
    organizationMember: collection(tables, 'organizationMember'),
    project: collection(tables, 'project'),
    role: {
      findMany: async ({ where }: any) => ROLES.filter((r) => where.name.in.includes(r.name))
    }
  };
  prisma.$transaction = async (ops: any[]) => Promise.all(ops);
  const mapping = new IdentityMappingService(
    prisma,
    { log: async () => {} } as any,
    {} as any,
    { invalidateInternalUserId: () => {}, revoked: () => {} } as any,
    {} as any
  );
  return { tables, mapping };
}

const provider: any = { id: 'idp', organizationId: null, protocol: 'oidc', name: 'IdP' };

test('project rules grant the highest matching role, only inside active memberships', async () => {
  const w = mappingWorld();
  w.tables.organizationMember.push({ organizationId: ORG, userId: 'u1', status: 'active' });
  w.tables.idpProjectRule.push(
    { providerId: 'idp', organizationId: ORG, projectId: 'p1', value: 'eng', roleId: 'r-member' },
    { providerId: 'idp', organizationId: ORG, projectId: 'p1', value: 'leads', roleId: 'r-admin' },
    { providerId: 'idp', organizationId: OTHER, projectId: 'px', value: 'eng', roleId: 'r-admin' }
  );
  await w.mapping.syncProjects(provider, 'u1', new Set(['eng', 'leads']));
  assert.equal(w.tables.projectMember.length, 1, 'no project in an org the user is not in');
  assert.equal(w.tables.projectMember[0].roleId, 'r-admin');
  assert.equal(w.tables.projectMember[0].managedByProviderId, 'idp');

  await w.mapping.syncProjects(provider, 'u1', new Set(['eng']));
  assert.equal(w.tables.projectMember[0].roleId, 'r-member', 'losing a group lowers the role');

  await w.mapping.syncProjects(provider, 'u1', new Set());
  assert.equal(w.tables.projectMember.length, 0, 'losing every group drops the managed membership');
});

test('project rules never touch a membership someone added by hand', async () => {
  const w = mappingWorld();
  w.tables.organizationMember.push({ organizationId: ORG, userId: 'u1', status: 'active' });
  w.tables.projectMember.push({ id: 'manual', projectId: 'p2', userId: 'u1', roleId: 'r-viewer' });
  w.tables.idpProjectRule.push({
    providerId: 'idp',
    organizationId: ORG,
    projectId: 'p2',
    value: 'eng',
    roleId: 'r-admin'
  });
  await w.mapping.syncProjects(provider, 'u1', new Set(['eng']));
  assert.equal(w.tables.projectMember[0].roleId, 'r-viewer');
  await w.mapping.syncProjects(provider, 'u1', new Set());
  assert.equal(w.tables.projectMember.length, 1);
});

test('a disabled org membership gets no project access from rules', async () => {
  const w = mappingWorld();
  w.tables.organizationMember.push({ organizationId: ORG, userId: 'u1', status: 'disabled' });
  w.tables.idpProjectRule.push({
    providerId: 'idp',
    organizationId: ORG,
    projectId: 'p1',
    value: 'eng',
    roleId: 'r-admin'
  });
  await w.mapping.syncProjects(provider, 'u1', new Set(['eng']));
  assert.equal(w.tables.projectMember.length, 0);
});

test("an org provider's project rules cannot reach another org's project", async () => {
  const w = mappingWorld();
  const orgProvider = { ...provider, organizationId: ORG };
  await assert.rejects(
    () =>
      w.mapping.replaceProjectRules(
        orgProvider,
        { rules: [{ value: 'eng', projectId: 'px', role: 'admin' }] },
        { userId: 'owner' }
      ),
    BadRequestException
  );
  await assert.rejects(
    () =>
      w.mapping.replaceProjectRules(
        orgProvider,
        { rules: [{ value: 'eng', projectId: 'p1', role: 'owner' }] },
        { userId: 'owner' }
      ),
    /admin, member or viewer/
  );
  const saved = await w.mapping.replaceProjectRules(
    orgProvider,
    { rules: [{ value: 'eng', projectId: 'p1', role: 'member' }] },
    { userId: 'owner' }
  );
  assert.equal(saved.length, 1);
  assert.equal(w.tables.idpProjectRule[0].organizationId, ORG);
});

function orgsWorld(member: Row) {
  const state = {
    member: { ...member },
    projectMembersDeleted: 0,
    tokensDeleted: [] as Row[],
    grantsDeleted: [] as Row[],
    sessionsRevoked: [] as Row[]
  };
  const service = Object.create(OrganizationsService.prototype) as any;
  service.logger = { warn() {} };
  service.membershipCache = { revoked: () => {}, invalidateInternalUserId: () => {} };
  service.tailscale = { cleanupDeployment: async () => {} };
  service.prisma = {
    organizationMember: {
      update: async ({ data }: any) => Object.assign(state.member, data),
      count: async () => 0
    },
    projectMember: {
      deleteMany: async () => {
        state.projectMembersDeleted += 1;
        return { count: 1 };
      }
    },
    project: { findMany: async () => [{ id: 'p1' }] },
    apiToken: {
      deleteMany: async ({ where }: any) => {
        state.tokensDeleted.push(where);
        return { count: 1 };
      }
    },
    sessionOrgGrant: {
      deleteMany: async ({ where }: any) => {
        state.grantsDeleted.push(where);
        return { count: 1 };
      }
    },
    session: {
      updateMany: async ({ where }: any) => {
        state.sessionsRevoked.push(where);
        return { count: 1 };
      }
    },
    deployment: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    user: { update: async () => ({}) }
  };
  return { service, state };
}

test('turning a member off keeps the row and closes every way in to that org', async () => {
  const { service, state } = orgsWorld({ id: 'm1', userId: 'u1', status: 'active' });
  await service.disableMember(
    { id: 'm1', userId: 'u1', user: { homeOrganizationId: null } },
    ORG,
    'left'
  );
  assert.equal(state.member.status, 'disabled');
  assert.ok(state.member.disabledAt instanceof Date);
  assert.equal(state.projectMembersDeleted, 1, 're-enabling never restores old project roles');
  assert.ok(state.tokensDeleted.some((w) => w.scopeOrganizationId === ORG));
  assert.deepEqual(state.grantsDeleted[0], { organizationId: ORG, session: { userId: 'u1' } });
  assert.equal(state.sessionsRevoked.length, 0, "an account's other sessions are not the org's");
});

test('turning an org identity off also ends its sessions, which only ever reached that org', async () => {
  const { service, state } = orgsWorld({ id: 'm1', userId: 'id1', status: 'active' });
  await service.disableMember(
    { id: 'm1', userId: 'id1', user: { homeOrganizationId: ORG } },
    ORG,
    'offboarded'
  );
  assert.deepEqual(state.sessionsRevoked[0], { userId: 'id1', revokedAt: null });
});

function sessionsWorld(user: Row | null) {
  const svc = Object.create(SessionsService.prototype) as any;
  svc.prisma = {
    user: { findUnique: async () => user },
    session: {
      findUnique: async () => ({
        id: 's',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user
      }),
      create: async () => ({ id: 'new-session' })
    }
  };
  svc.lookupLocation = async () => null;
  svc.parseDeviceName = () => null;
  return svc as SessionsService;
}

test('no sign-in method can open a session for a turned-off account, and old ones stop working', async () => {
  const off = sessionsWorld({ disabledAt: new Date() });
  await assert.rejects(() => off.createSession({ userId: 'u1' }), ForbiddenException);
  assert.equal(await off.validateSession('s'), false);
  const on = sessionsWorld({ disabledAt: null });
  assert.equal(await on.validateSession('s'), true);
});

function adminWorld(users: Row[]) {
  const svc = Object.create(AdminService.prototype) as any;
  const revoked: string[] = [];
  const tokens: string[] = [];
  svc.audit = { log: async () => {} };
  svc.prisma = {
    user: {
      findUnique: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
      count: async ({ where }: any) =>
        users.filter((u) => u.isSuperAdmin && !u.disabledAt && u.id !== where.id.not).length,
      update: async ({ where, data }: any) =>
        Object.assign(
          users.find((u) => u.id === where.id)!,
          data
        )
    },
    session: {
      updateMany: async ({ where }: any) => {
        revoked.push(where.userId);
        return { count: 1 };
      }
    },
    apiToken: {
      deleteMany: async ({ where }: any) => {
        tokens.push(where.userId);
        return { count: 1 };
      }
    }
  };
  return { svc: svc as AdminService, revoked, tokens };
}

test('a superadmin turns accounts off and on, never their own and never the last superadmin', async () => {
  const users = [
    { id: 'root', email: 'root@x', isSuperAdmin: true, disabledAt: null },
    { id: 'u1', email: 'u1@x', isSuperAdmin: false, disabledAt: null }
  ];
  const { svc, revoked, tokens } = adminWorld(users);
  await assert.rejects(() => svc.setUserDisabled('root', 'root', true), /own account/);
  await assert.rejects(() => svc.setUserDisabled('root', 'u1', true), /last superadmin/);

  await svc.setUserDisabled('u1', 'root', true, 'left the company');
  assert.ok(users[1].disabledAt);
  assert.deepEqual(revoked, ['u1']);
  assert.deepEqual(tokens, ['u1']);

  await svc.setUserDisabled('u1', 'root', false);
  assert.equal(users[1].disabledAt, null);
});
