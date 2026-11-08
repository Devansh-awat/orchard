import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { AuthorizationService } from '../src/auth/authorization.service';

class FakePrisma {
  enforcedOrgMembers = new Set<string>();

  enforcedOrgInvites = new Set<string>();

  verifiedDomains = new Set<string>(['corp.example']);

  organizationMember = {
    findFirst: async ({ where }: any) =>
      this.enforcedOrgMembers.has(where.userId) &&
      this.verifiedDomains.has(where.organization.domains.some.domain)
        ? { organizationId: 'org' }
        : null
  };

  organizationInvitation = {
    findFirst: async ({ where }: any) =>
      this.enforcedOrgInvites.has(where.email) &&
      this.verifiedDomains.has(where.organization.domains.some.domain)
        ? { organizationId: 'org' }
        : null
  };
}

function build(instanceEnforced: boolean) {
  const prisma = new FakePrisma();
  const settings = { isSsoEnforced: async () => instanceEnforced };
  return { prisma, authz: new AuthorizationService(prisma as any, settings as any) };
}

const member = { id: 'u1', email: 'a@corp.example', isSuperAdmin: false };
const superadmin = { id: 'root', isSuperAdmin: true };

test('an instance that requires SSO refuses mailbox and credential sign-ins', async () => {
  const { authz } = build(true);
  for (const method of ['otp', 'passkey', 'password'] as const) {
    await assert.rejects(() => authz.assertSsoNotEnforced(member, method), ForbiddenException);
    await assert.rejects(() => authz.assertSsoNotEnforced(null, method), ForbiddenException);
    await assert.rejects(
      () => authz.assertSsoNotEnforcedForEmail('new@example.com', method),
      ForbiddenException
    );
  }
});

test('every identity provider still signs people in under instance enforcement', async () => {
  const { authz } = build(true);
  for (const method of ['sso', 'instance_sso', 'oauth'] as const) {
    await authz.assertSsoNotEnforced(member, method);
    await authz.assertSsoNotEnforced(null, method);
    await authz.assertSsoNotEnforcedForEmail('new@example.com', method);
  }
});

test('superadmins keep their break-glass sign-in', async () => {
  const { authz } = build(true);
  await authz.assertSsoNotEnforced(superadmin, 'password');
  await authz.assertSsoNotEnforced(superadmin, 'otp');
});

test('an organization enforcing SSO never blocks sign-in to the account itself', async () => {
  const { prisma, authz } = build(false);
  prisma.enforcedOrgMembers.add(member.id);
  prisma.enforcedOrgInvites.add('invited@corp.example');
  for (const method of ['otp', 'passkey', 'password', 'oauth', 'instance_sso'] as const) {
    await authz.assertSsoNotEnforced(member, method);
  }
  await authz.assertSsoNotEnforcedForEmail('Invited@Corp.Example', 'otp');
});
