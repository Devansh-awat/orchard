import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationsService } from '../src/organizations/organizations.service';

function service(user: { email: string; emailVerified: boolean } | null) {
  const queried: unknown[] = [];
  const svc = Object.create(OrganizationsService.prototype);
  Object.assign(svc, {
    usersService: { findOrCreateByClerkId: async () => user },
    prisma: {
      organizationInvitation: {
        findMany: async (args: unknown) => {
          queried.push(args);
          return [
            {
              id: 'inv-1',
              email: user?.email,
              role: 'member',
              organization: { id: 'org-1', name: 'Secret Org', slug: 'secret' }
            }
          ];
        }
      }
    }
  });
  return { svc, queried };
}

test('an account with an unverified email never sees which orgs invited that email', async () => {
  const { svc, queried } = service({ email: 'victim@example.com', emailVerified: false });
  assert.deepEqual(await svc.getPendingInvitationsForUser('clerk-1'), []);
  assert.deepEqual(await svc.acceptPendingInvitationsForUser('clerk-1'), { invitations: [] });
  assert.equal(queried.length, 0);
});

test('a verified account still lists its pending invitations', async () => {
  const { svc } = service({ email: 'ada@example.com', emailVerified: true });
  const rows = await svc.getPendingInvitationsForUser('clerk-1');
  assert.equal(rows.length, 1);
});
