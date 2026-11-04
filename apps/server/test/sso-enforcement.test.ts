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

test('org enforcement still blocks the platform providers that instance enforcement allows', async () => {
  const { prisma, authz } = build(false);
  prisma.enforcedOrgMembers.add(member.id);
  await assert.rejects(
    () => authz.assertSsoNotEnforced(member, 'instance_sso'),
    ForbiddenException
  );
  await assert.rejects(() => authz.assertSsoNotEnforced(member, 'oauth'), ForbiddenException);
  await authz.assertSsoNotEnforced(member, 'sso');
  await authz.assertSsoNotEnforced({ id: 'other', isSuperAdmin: false }, 'otp');
});

test('a pending invitation from an enforcing org gates a brand-new identity', async () => {
  const { prisma, authz } = build(false);
  prisma.enforcedOrgInvites.add('invited@corp.example');
  await assert.rejects(
    () => authz.assertSsoNotEnforcedForEmail('Invited@Corp.Example', 'otp'),
    ForbiddenException
  );
  await authz.assertSsoNotEnforcedForEmail('nobody@corp.example', 'otp');
});

test('an org only blocks account-wide sign-in for emails on its verified domains', async () => {
  const { prisma, authz } = build(false);
  prisma.enforcedOrgMembers.add('pepito');
  prisma.enforcedOrgInvites.add('pepito@gmail.example');
  const pepito = { id: 'pepito', email: 'pepito@gmail.example', isSuperAdmin: false };
  for (const method of ['otp', 'passkey', 'password', 'oauth', 'instance_sso'] as const) {
    await authz.assertSsoNotEnforced(pepito, method);
  }
  await authz.assertSsoNotEnforcedForEmail('pepito@gmail.example', 'otp');
});
