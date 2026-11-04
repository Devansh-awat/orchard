import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { SignJWT } from 'jose';
import { AuthorizationService } from '../src/auth/authorization.service';
import { SessionsService } from '../src/auth/sessions.service';
import { McpOAuthService } from '../src/mcp/mcp-oauth.service';
import { ProjectsService } from '../src/projects/projects.service';

process.env.JWT_SECRET ||= 'test-secret-for-project-member-role';

function build(roleName: string, adminCount = 2) {
  const roles = ['admin', 'member', 'viewer'].map((name) => ({ id: name, name }));
  const member = { id: 'membership', projectId: 'project', userId: 'user', roleId: roleName };
  const user = { id: 'user', email: 'user@example.com', isSuperAdmin: false };
  const sessionRows = ['browser', 'claude'].map((id) => ({
    id,
    userId: user.id,
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 60_000)
  }));
  const prisma = {
    user: { findUnique: async () => user },
    role: {
      findUnique: async ({ where }: any) =>
        roles.find((role) => role.id === where.id || role.name === where.name) ?? null
    },
    project: { findUnique: async () => ({ id: 'project', organizationId: 'org' }) },
    organizationMember: { findUnique: async () => ({ role: 'guest' }) },
    projectMember: {
      findUnique: async () => ({ ...member }),
      findFirst: async () => ({ ...member, role: roles.find((role) => role.id === member.roleId) }),
      count: async () => adminCount,
      update: async ({ data }: any) => {
        member.roleId = data.roleId;
        return { ...member, user, role: roles.find((role) => role.id === member.roleId) };
      }
    },
    session: {
      findUnique: async ({ where }: any) => sessionRows.find((row) => row.id === where.id),
      update: async () => ({}),
      updateMany: async ({ where, data }: any) => {
        const rows = sessionRows.filter((row) => row.userId === where.userId);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }
    }
  };
  const sessions = new SessionsService(prisma as any, {} as any, {} as any);
  const authz = new AuthorizationService(prisma as any, {} as any);
  const service = Object.assign(Object.create(ProjectsService.prototype) as ProjectsService, {
    prisma,
    sessions,
    usersService: { findOrCreateByClerkId: async () => ({ id: 'actor' }) },
    access: { assertProjectAdmin: async () => {} },
    audit: { log: async () => {} }
  });
  return { service, sessions, authz, mcp: new McpOAuthService(sessions, prisma as any) };
}

for (const [before, after] of [
  ['admin', 'viewer'],
  ['admin', 'member'],
  ['member', 'viewer'],
  ['viewer', 'admin'],
  ['member', 'member']
]) {
  test(`${before} → ${after} applies project permissions without signing out browser or Claude`, async () => {
    const { service, sessions, authz, mcp } = build(before);
    const token = await new SignJWT({ type: 'mcp', sessionId: 'claude' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    assert.equal((await authz.requireProjectView('project', 'user')).projectRoleName, before);
    assert.equal(await sessions.validateSession('browser'), true);
    assert.ok(await mcp.validateBearerTokenWithSub(`Bearer ${token}`));

    const updated = await service.updateProjectMemberRole('project', 'membership', after, 'actor');

    assert.equal(updated.role.name, after);
    assert.equal(await sessions.validateSession('browser'), true);
    assert.ok(await mcp.validateBearerTokenWithSub(`Bearer ${token}`));
    const access = await authz.requireProjectView('project', 'user');
    assert.equal(access.projectRoleName, after);
    assert.equal(access.canEdit, after !== 'viewer');
    assert.equal(access.canManageMembers, after === 'admin');
    if (after === 'viewer') {
      await assert.rejects(() => authz.requireProjectEdit('project', 'user'), ForbiddenException);
    }
    if (after !== 'admin') {
      await assert.rejects(
        () => authz.requireProjectManageMembers('project', 'user'),
        ForbiddenException
      );
    }
  });
}

test('the last project admin still cannot be demoted', async () => {
  const { service } = build('admin', 1);
  await assert.rejects(
    () => service.updateProjectMemberRole('project', 'membership', 'viewer', 'actor'),
    /can't demote the last admin/
  );
});

test('a caller without project admin access still cannot change a role', async () => {
  const { service } = build('member');
  Object.assign(service, {
    access: {
      assertProjectAdmin: async () => {
        throw new ForbiddenException();
      }
    }
  });
  await assert.rejects(
    () => service.updateProjectMemberRole('project', 'membership', 'viewer', 'actor'),
    ForbiddenException
  );
});
