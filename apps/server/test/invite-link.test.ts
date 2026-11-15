import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { OrganizationsService } from '../src/organizations/organizations.service';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

type Invitation = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  tokenHash: string;
  token: null;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
  projectId: string | null;
  projectRoleId: string | null;
};

function invitationRow(token: string, overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: 'inv1',
    organizationId: 'org1',
    email: 'new@example.com',
    role: 'member',
    tokenHash: hash(token),
    token: null,
    invitedBy: 'admin1',
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    projectId: null,
    projectRoleId: null,
    ...overrides
  };
}

function setup(
  opts: {
    email?: boolean;
    mailFails?: boolean;
    invitation?: Invitation | null;
    accounts?: any[];
    orgRole?: 'owner' | 'admin' | 'member' | null;
    ssoBlocked?: boolean;
    rateLimited?: boolean;
  } = {}
) {
  const state = {
    invitation: opts.invitation ?? null,
    accounts: [...(opts.accounts ?? [])],
    members: [] as any[],
    projectMembers: [] as any[],
    audit: [] as string[],
    mails: 0
  };
  const inviter = { id: 'admin1', email: 'admin@example.com', username: 'admin' };

  const invitationDelegate = {
    findUnique: async ({ where }: any) => {
      const row = state.invitation;
      if (!row) return null;
      if (where.tokenHash && where.tokenHash !== row.tokenHash) return null;
      if (where.id && where.id !== row.id) return null;
      return {
        ...row,
        organization: { id: 'org1', name: 'Org', slug: 'org' },
        inviter
      };
    },
    deleteMany: async ({ where }: any) => {
      const row = state.invitation;
      if (!row) return { count: 0 };
      if (where.tokenHash && where.tokenHash !== row.tokenHash) return { count: 0 };
      if (where.email && where.email !== row.email) return { count: 0 };
      state.invitation = null;
      return { count: 1 };
    },
    create: async ({ data }: any) => {
      state.invitation = { ...invitationRow('x'), ...data };
      return {
        ...state.invitation,
        organization: { id: 'org1', name: 'Org' },
        inviter
      };
    },
    update: async ({ data }: any) => {
      state.invitation = { ...state.invitation!, ...data };
      return state.invitation;
    },
    delete: async () => {
      state.invitation = null;
    },
    findMany: async () => (state.invitation ? [{ ...state.invitation, inviter }] : [])
  };

  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) =>
        state.accounts.find(
          (a) =>
            ((where.email ?? where.emailScope_email?.email) &&
              a.email === (where.email ?? where.emailScope_email?.email)) ||
            (where.username && a.username === where.username)
        ) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: 'new-user',
          firstName: null,
          lastName: null,
          imageUrl: null,
          setupCompleted: false,
          isSuperAdmin: false,
          emailVerified: false,
          ...data
        };
        state.accounts.push(row);
        return row;
      }
    },
    organization: { findUnique: async () => ({ id: 'org1', name: 'Org' }) },
    organizationInvitation: invitationDelegate,
    organizationMember: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        state.members.push(data);
        return data;
      }
    },
    projectMember: {
      create: async ({ data }: any) => {
        state.projectMembers.push(data);
        return data;
      }
    }
  };
  prisma.$transaction = (fn: any) => fn(prisma);

  const authz = {
    requireOrgAdmin: async () => {
      if (opts.orgRole === 'member' || opts.orgRole === null) throw new ForbiddenException('no');
      return { role: opts.orgRole ?? 'owner', isAdmin: true };
    },
    requireOrgOwner: async () => {
      if ((opts.orgRole ?? 'owner') !== 'owner') throw new ForbiddenException('owners only');
    },
    getOrgAccess: async () => {
      const role = opts.orgRole ?? 'owner';
      return role === null ? null : { role, isAdmin: role === 'owner' || role === 'admin' };
    },
    assertSsoNotEnforcedForEmail: async () => {
      if (opts.ssoBlocked) throw new ForbiddenException('Use single sign-on.');
    }
  };
  const emailService = {
    isConfigured: () => opts.email === true,
    sendOrganizationInviteEmail: async () => {
      state.mails += 1;
      return !opts.mailFails;
    },
    sendProjectInviteEmail: async () => {
      state.mails += 1;
      return !opts.mailFails;
    }
  };
  const users = { findOrCreateByClerkId: async () => inviter };
  const audit = {
    log: async (entry: any) => {
      state.audit.push(entry.action);
    }
  };
  const rateLimit = {
    checkRateLimit: async () => undefined,
    checkInviteMail: async () => {
      if (opts.rateLimited) throw new Error('rate limited');
    }
  };
  const service = new (OrganizationsService as any)(
    prisma,
    users,
    emailService,
    audit,
    authz,
    { invalidateInternalUserId: () => undefined },
    {},
    {},
    {},
    rateLimit
  ) as OrganizationsService;
  return { service, state };
}

test('with no email, inviting returns a one-time link and stores only its hash', async () => {
  const { service, state } = setup();
  const result: any = await service.inviteMemberToOrganization(
    'org1',
    'New@Example.com',
    'member' as any,
    'clerk'
  );

  assert.equal(result.delivery, 'link');
  const token = result.inviteLink.split('/invite/')[1];
  assert.equal(state.invitation!.tokenHash, hash(token));
  assert.equal(state.invitation!.token, null);
  assert.equal('tokenHash' in result, false);
  assert.equal(JSON.stringify(state.invitation).includes(token), false);
});

test('with email, inviting mails and never returns a link', async () => {
  const { service, state } = setup({ email: true });
  const result: any = await service.inviteMemberToOrganization(
    'org1',
    'new@example.com',
    'member' as any,
    'clerk'
  );

  assert.equal(result.delivery, 'email');
  assert.equal('inviteLink' in result, false);
  assert.equal(state.mails, 1);
});

test('when the invite email fails, inviting returns the link instead of claiming it was sent', async () => {
  const { service, state } = setup({ email: true, mailFails: true });
  const result: any = await service.inviteMemberToOrganization(
    'org1',
    'new@example.com',
    'member' as any,
    'clerk'
  );

  assert.equal(state.mails, 1);
  assert.equal(result.delivery, 'link');
  assert.equal(result.emailFailed, true);
  const token = result.inviteLink.split('/invite/')[1];
  assert.equal(state.invitation!.tokenHash, hash(token));
});

test('a failed project guest invite email is reported, not called sent', async () => {
  const result: any = await setup({
    email: true,
    mailFails: true,
    orgRole: 'admin'
  }).service.createProjectGuestInvitation({
    organizationId: 'org1',
    projectId: 'p1',
    projectName: 'P',
    projectRoleId: 'r1',
    projectRoleName: 'viewer',
    email: 'guest@example.com',
    inviter: { id: 'admin1', email: 'a@example.com' }
  });

  assert.equal(result.delivery, 'link');
  assert.equal(result.emailFailed, true);
  assert.ok(result.inviteLink);
});

test('a non-admin gets nothing, because the invite itself is refused', async () => {
  const { service } = setup({ orgRole: 'member' });
  await assert.rejects(
    service.inviteMemberToOrganization('org1', 'new@example.com', 'member' as any, 'clerk'),
    ForbiddenException
  );
});

test('a project guest invite only shows the link to an org admin', async () => {
  const params = {
    organizationId: 'org1',
    projectId: 'p1',
    projectName: 'P',
    projectRoleId: 'r1',
    projectRoleName: 'viewer',
    email: 'guest@example.com',
    inviter: { id: 'admin1', email: 'a@example.com' }
  };
  const asAdmin: any = await setup({ orgRole: 'admin' }).service.createProjectGuestInvitation(
    params
  );
  assert.ok(asAdmin.inviteLink);

  const asMember: any = await setup({ orgRole: 'member' }).service.createProjectGuestInvitation(
    params
  );
  assert.equal(asMember.delivery, 'link');
  assert.equal('inviteLink' in asMember, false);
});

test('resending with no email rotates the token, so the old link dies', async () => {
  const { service, state } = setup({ invitation: invitationRow('old') });
  const result: any = await service.resendInvitation('inv1', 'clerk');

  assert.equal(result.delivery, 'link');
  const token = result.inviteLink.split('/invite/')[1];
  assert.notEqual(token, 'old');
  assert.equal(state.invitation!.tokenHash, hash(token));
  assert.equal(state.mails, 0);
  assert.ok(state.audit.includes('org.invitation.link_issued'));
  await assert.rejects(service.getInvitationByToken('old'));
});

test('resending with email mails and leaves the token alone', async () => {
  const { service, state } = setup({ email: true, invitation: invitationRow('old') });
  const result: any = await service.resendInvitation('inv1', 'clerk');

  assert.equal('inviteLink' in result, false);
  assert.equal(state.mails, 1);
  assert.equal(state.invitation!.tokenHash, hash('old'));
});

test('resending when the email fails hands back a fresh link', async () => {
  const { service, state } = setup({
    email: true,
    mailFails: true,
    invitation: invitationRow('old')
  });
  const result: any = await service.resendInvitation('inv1', 'clerk');

  assert.equal(state.mails, 1);
  assert.equal(result.delivery, 'link');
  assert.equal(result.emailFailed, true);
  const token = result.inviteLink.split('/invite/')[1];
  assert.equal(state.invitation!.tokenHash, hash(token));
});

test('an admin cannot take the link of an owner invitation', async () => {
  const { service, state } = setup({
    orgRole: 'admin',
    invitation: invitationRow('old', { role: 'owner' })
  });
  await assert.rejects(service.resendInvitation('inv1', 'clerk'), ForbiddenException);
  assert.equal(state.invitation!.tokenHash, hash('old'));
});

test('the landing page tells a link holder what to do next', async () => {
  const fresh = setup({ invitation: invitationRow('t') });
  const page: any = await fresh.service.getInvitationByToken('t');
  assert.equal(page.email, 'new@example.com');
  assert.equal(page.next, 'sign_up');

  const taken = setup({
    invitation: invitationRow('t'),
    accounts: [{ id: 'u', email: 'new@example.com', username: 'new' }]
  });
  assert.equal(((await taken.service.getInvitationByToken('t')) as any).next, 'sign_in');

  const sso = setup({ invitation: invitationRow('t'), ssoBlocked: true });
  assert.equal(((await sso.service.getInvitationByToken('t')) as any).next, 'sso');

  const mailed: any = await setup({
    email: true,
    invitation: invitationRow('t')
  }).service.getInvitationByToken('t');
  assert.equal('email' in mailed, false);
  assert.equal('next' in mailed, false);
});

test('signing up by link makes the account, joins and spends the link', async () => {
  const { service, state } = setup({
    invitation: invitationRow('t', { role: 'admin', projectId: 'p1', projectRoleId: 'r1' })
  });
  const { user, organization } = await service.signUpWithInvitation('t', 'correct horse battery');

  assert.equal(user.email, 'new@example.com');
  assert.equal(user.emailVerified, false);
  assert.ok(await bcrypt.compare('correct horse battery', user.passwordHash!));
  assert.equal(organization.slug, 'org');
  assert.deepEqual(state.members[0], {
    organizationId: 'org1',
    userId: 'new-user',
    role: 'admin',
    addedBy: 'admin1'
  });
  assert.equal(state.projectMembers[0].roleId, 'r1');
  assert.equal(state.invitation, null);

  await assert.rejects(service.signUpWithInvitation('t', 'correct horse battery'));
});

test('a passkey sign-up has no password to fall back on', async () => {
  const { service } = setup({ invitation: invitationRow('t') });
  const { user } = await service.signUpWithInvitation('t', null);
  assert.equal(user.passwordHash, null);
});

test('sign-up refuses what must not work', async () => {
  const mailed = setup({ email: true, invitation: invitationRow('t') });
  await assert.rejects(
    mailed.service.signUpWithInvitation('t', 'correct horse battery'),
    /not found/i
  );
  assert.notEqual(mailed.state.invitation, null);

  const short = setup({ invitation: invitationRow('t') });
  await assert.rejects(short.service.signUpWithInvitation('t', 'short'), /12 characters/);
  assert.notEqual(short.state.invitation, null);

  const taken = setup({
    invitation: invitationRow('t'),
    accounts: [{ id: 'victim', email: 'new@example.com', username: 'new', passwordHash: 'keep' }]
  });
  await assert.rejects(
    taken.service.signUpWithInvitation('t', 'correct horse battery'),
    /already has an account/
  );
  assert.equal(taken.state.accounts[0].passwordHash, 'keep');

  const sso = setup({ invitation: invitationRow('t'), ssoBlocked: true });
  await assert.rejects(
    sso.service.signUpWithInvitation('t', 'correct horse battery'),
    ForbiddenException
  );

  const expired = setup({
    invitation: invitationRow('t', { expiresAt: new Date(Date.now() - 1000) })
  });
  await assert.rejects(expired.service.signUpWithInvitation('t', 'correct horse battery'));

  const previous = process.env.SIGNUP_MODE;
  process.env.SIGNUP_MODE = 'closed';
  try {
    const closed = setup({ invitation: invitationRow('t') });
    await assert.rejects(
      closed.service.signUpWithInvitation('t', 'correct horse battery'),
      /signups_disabled/
    );
  } finally {
    if (previous === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = previous;
  }
});

test('a link only skips address proof when the instance has no email', async () => {
  const account = {
    id: 'u1',
    email: 'new@example.com',
    username: 'new',
    emailVerified: false
  };
  const build = (email: boolean) => {
    const built = setup({ email, invitation: invitationRow('t'), accounts: [account] });
    (built.service as any).usersService = { findOrCreateByClerkId: async () => account };
    return built;
  };

  await assert.rejects(build(true).service.acceptInvitationByToken('t', 'clerk'), /not found/i);
  await build(false).service.acceptInvitationByToken('t', 'clerk');
  await assert.rejects(build(false).service.acceptInvitationById('inv1', 'clerk'), /not found/i);
});

test('a project guest invitation is throttled before anything is written or mailed', async () => {
  const { service, state } = setup({ email: true, orgRole: 'admin', rateLimited: true });
  await assert.rejects(
    service.createProjectGuestInvitation({
      organizationId: 'org1',
      projectId: 'p1',
      projectName: 'P',
      projectRoleId: 'r1',
      projectRoleName: 'viewer',
      email: 'guest@example.com',
      inviter: { id: 'admin1', email: 'a@example.com' }
    }),
    /rate limited/
  );
  assert.equal(state.mails, 0);
  assert.equal(state.invitation, null);
});

test('resending an invitation email is throttled', async () => {
  const { service, state } = setup({
    email: true,
    invitation: invitationRow('old'),
    rateLimited: true
  });
  await assert.rejects(service.resendInvitation('inv1', 'clerk'), /rate limited/);
  assert.equal(state.mails, 0);
});
