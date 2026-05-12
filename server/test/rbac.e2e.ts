/**
 * RBAC end-to-end test.
 *
 * Boots no application — hits a running server. Seeds test users, an org, and
 * a project directly via Prisma, mints session JWTs locally, and asserts that
 * every endpoint enforces the RBAC contract.
 *
 * Run:
 *   1. Start the server in another terminal:  `pnpm dev`
 *   2. In this terminal:                      `pnpm test:rbac`
 *
 * Env vars:
 *   SERVER_URL    Default http://localhost:3001 (matches main.ts default port).
 *   JWT_SECRET    Same secret the server is using — required to mint test tokens.
 *   DATABASE_URL  Same as the server.
 *
 * The script uses a single fixed UUID prefix for all rows it creates and
 * cleans up everything on exit (including on assertion failure) so it can be
 * re-run safely.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const PREFIX = `apiv1`;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET env var is required (must match the running server).');
  process.exit(1);
}
const SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

const prisma = new PrismaClient();

// All fixture rows are tagged with this run ID so we can clean them up later
// without disturbing any other rows that happen to share a column value.
const RUN_TAG = `rbac-e2e-${randomUUID().slice(0, 8)}`;

interface Fixture {
  // Two orgs so we can verify cross-org isolation.
  orgA: { id: string; slug: string };
  orgB: { id: string; slug: string };
  // Five users in orgA — owner, admin, member, viewer, and a guest (who is
  // only on orgA because someone invited them to projectA). Plus one user
  // that's only in orgB (the outsider w.r.t. orgA).
  owner: { id: string; token: string };
  admin: { id: string; token: string };
  plainMember: { id: string; token: string };
  viewer: { id: string; token: string };
  guest: { id: string; email: string; token: string };
  outsider: { id: string; token: string };
  // Two projects in orgA. projectA has plainMember as a member; viewer is a viewer.
  // projectB has nobody attached except via org-admin bypass.
  projectA: { id: string; slug: string; namespace: string };
  projectB: { id: string; slug: string; namespace: string };
  // A deployment on projectA so we can test deployment-level endpoints.
  deploymentA: { id: string };
}

let fx: Fixture;

async function mintToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SECRET_BYTES);
}

async function req(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${SERVER_URL}/${PREFIX}${path}`, { ...init, headers });
}

before(async () => {
  // Make sure the role lookup table has the three names we depend on.
  const [adminRole, memberRole, viewerRole] = await Promise.all([
    prisma.role.upsert({ where: { name: 'admin' }, update: {}, create: { name: 'admin' } }),
    prisma.role.upsert({ where: { name: 'member' }, update: {}, create: { name: 'member' } }),
    prisma.role.upsert({ where: { name: 'viewer' }, update: {}, create: { name: 'viewer' } }),
  ]);

  // Users
  async function mkUser(label: string) {
    const email = `${RUN_TAG}-${label}@example.test`;
    const u = await prisma.user.create({
      data: {
        email,
        username: `${RUN_TAG}-${label}`,
        firstName: label,
        lastName: 'Test',
      },
    });
    return { id: u.id, email, token: await mintToken(u.id) };
  }

  const owner = await mkUser('owner');
  const admin = await mkUser('admin');
  const plainMember = await mkUser('member');
  const viewer = await mkUser('viewer');
  const guest = await mkUser('guest');
  const outsider = await mkUser('outsider');

  // Orgs
  const orgA = await prisma.organization.create({
    data: {
      name: `${RUN_TAG}-orgA`,
      slug: `${RUN_TAG}-org-a`,
      createdBy: owner.id,
    },
  });
  const orgB = await prisma.organization.create({
    data: {
      name: `${RUN_TAG}-orgB`,
      slug: `${RUN_TAG}-org-b`,
      createdBy: outsider.id,
    },
  });

  // Org memberships
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgA.id, userId: owner.id, role: 'owner' },
      { organizationId: orgA.id, userId: admin.id, role: 'admin' },
      { organizationId: orgA.id, userId: plainMember.id, role: 'member' },
      { organizationId: orgA.id, userId: viewer.id, role: 'member' },
      { organizationId: orgA.id, userId: guest.id, role: 'guest' },
      { organizationId: orgB.id, userId: outsider.id, role: 'owner' },
    ],
  });

  // Projects (in orgA)
  const projectA = await prisma.project.create({
    data: {
      organizationId: orgA.id,
      name: 'Project A',
      slug: 'project-a',
      namespace: `${RUN_TAG}-ns-a`,
      createdBy: owner.id,
    },
  });
  const projectB = await prisma.project.create({
    data: {
      organizationId: orgA.id,
      name: 'Project B',
      slug: 'project-b',
      namespace: `${RUN_TAG}-ns-b`,
      createdBy: owner.id,
    },
  });

  // Project memberships on projectA only. Guest is a project admin to prove
  // a guest org-member can hold an elevated project role.
  await prisma.projectMember.createMany({
    data: [
      { projectId: projectA.id, userId: plainMember.id, roleId: memberRole.id },
      { projectId: projectA.id, userId: viewer.id, roleId: viewerRole.id },
      { projectId: projectA.id, userId: guest.id, roleId: adminRole.id },
    ],
  });

  // A deployment on projectA
  const deploymentA = await prisma.deployment.create({
    data: {
      projectId: projectA.id,
      name: 'dep-a',
      image: 'nginx:alpine',
      namespace: projectA.namespace,
      status: 'pending',
    },
  });

  fx = {
    orgA: { id: orgA.id, slug: orgA.slug },
    orgB: { id: orgB.id, slug: orgB.slug },
    owner, admin, plainMember, viewer, outsider,
    guest,
    projectA: { id: projectA.id, slug: projectA.slug, namespace: projectA.namespace },
    projectB: { id: projectB.id, slug: projectB.slug, namespace: projectB.namespace },
    deploymentA: { id: deploymentA.id },
  };

  // Smoke-check the server is up before doing anything else.
  const ping = await fetch(`${SERVER_URL}/${PREFIX}/organizations/user`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  if (!ping.ok && ping.status !== 200) {
    console.error(`Server at ${SERVER_URL} did not respond OK (status ${ping.status}). Is it running?`);
    process.exit(1);
  }
});

after(async () => {
  // Order: project members → projects → org members → invitations → orgs → users.
  // Cascade should handle most of this but be explicit on the things we touched.
  try {
    await prisma.deployment.deleteMany({ where: { id: fx.deploymentA.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: { in: [fx.projectA.id, fx.projectB.id] } } });
    await prisma.project.deleteMany({ where: { id: { in: [fx.projectA.id, fx.projectB.id] } } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: { in: [fx.orgA.id, fx.orgB.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [fx.orgA.id, fx.orgB.id] } } });
    await prisma.user.deleteMany({
      where: { id: { in: [fx.owner.id, fx.admin.id, fx.plainMember.id, fx.viewer.id, fx.guest.id, fx.outsider.id] } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

describe('Org-level RBAC', () => {
  test('non-member cannot read org by id (404)', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.outsider.token);
    assert.equal(res.status, 404);
  });

  test('non-member cannot read org by slug (404)', async () => {
    const res = await req(`/organizations/slug/${fx.orgA.slug}`, fx.outsider.token);
    assert.equal(res.status, 404);
  });

  test('non-member cannot list org members (404)', async () => {
    const res = await req(`/organizations/${fx.orgA.id}/members`, fx.outsider.token);
    assert.equal(res.status, 404);
  });

  test('plain member can read their org', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.plainMember.token);
    assert.equal(res.status, 200);
  });

  test('plain member cannot update org (403)', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.plainMember.token, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'hacked' }),
    });
    assert.equal(res.status, 403);
  });

  test('admin can update org', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.admin.token, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'updated by admin' }),
    });
    assert.equal(res.status, 200);
  });

  test('plain member sees only their projects in org payload (no projectB)', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.plainMember.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    assert.ok(ids.includes(fx.projectA.id), 'should see projectA');
    assert.ok(!ids.includes(fx.projectB.id), 'should NOT see projectB');
  });

  test('admin sees every project in org payload', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.admin.token);
    const body = await res.json();
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    assert.ok(ids.includes(fx.projectA.id) && ids.includes(fx.projectB.id));
  });
});

describe('Project-level RBAC', () => {
  test('non-org-member cannot read project (404)', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.outsider.token);
    assert.equal(res.status, 404);
  });

  test('plain org member without project membership cannot read project (404)', async () => {
    // plainMember is on projectA but NOT projectB
    const res = await req(`/projects/${fx.projectB.id}`, fx.plainMember.token);
    assert.equal(res.status, 404);
  });

  test('org admin gets project bypass (200 on a project they are not a member of)', async () => {
    const res = await req(`/projects/${fx.projectB.id}`, fx.admin.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.currentUserRole.canEdit, true, 'org admin should have edit rights');
    assert.equal(body.currentUserRole.canDelete, true, 'org admin should have delete rights');
    assert.equal(body.currentUserRole.source, 'orgAdmin');
  });

  test('viewer can read project but currentUserRole.canEdit is false', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.viewer.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.currentUserRole.canEdit, false);
    assert.equal(body.currentUserRole.canManageMembers, false);
    assert.equal(body.currentUserRole.canDelete, false);
  });

  test('viewer cannot delete deployment (403)', async () => {
    const res = await req(`/deployments/${fx.deploymentA.id}`, fx.viewer.token, { method: 'DELETE' });
    assert.equal(res.status, 403);
  });

  test('viewer cannot scale deployment (403)', async () => {
    const res = await req(`/deployments/${fx.deploymentA.id}/scale`, fx.viewer.token, {
      method: 'POST',
      body: JSON.stringify({ replicas: 2 }),
    });
    assert.equal(res.status, 403);
  });

  test('viewer cannot update project (403)', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.viewer.token, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'viewer attempt' }),
    });
    assert.equal(res.status, 403);
  });

  test('member CAN scale deployment (not 403)', async () => {
    const res = await req(`/deployments/${fx.deploymentA.id}/scale`, fx.plainMember.token, {
      method: 'POST',
      body: JSON.stringify({ replicas: 1 }),
    });
    // The action may fail downstream (no real K8s), but auth must not reject.
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
  });

  test('member cannot delete project (403) — only admin/owner can', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.plainMember.token, { method: 'DELETE' });
    assert.equal(res.status, 403);
  });

  test('member cannot add project member (403)', async () => {
    const res = await req(`/projects/${fx.projectA.id}/members`, fx.plainMember.token, {
      method: 'POST',
      body: JSON.stringify({ email: fx.outsider.id, role: 'member' }),
    });
    assert.equal(res.status, 403);
  });

  test('non-member cannot view deployment (404)', async () => {
    const res = await req(`/deployments/${fx.deploymentA.id}`, fx.outsider.token);
    assert.equal(res.status, 404);
  });

  test('viewer can view deployment (200)', async () => {
    const res = await req(`/deployments/${fx.deploymentA.id}`, fx.viewer.token);
    assert.equal(res.status, 200);
  });
});

describe('Audit-log RBAC', () => {
  test('plain member cannot read org audit logs (403)', async () => {
    const res = await req(`/audit-logs/organization/${fx.orgA.id}`, fx.plainMember.token);
    assert.equal(res.status, 403);
  });

  test('admin can read org audit logs (200)', async () => {
    const res = await req(`/audit-logs/organization/${fx.orgA.id}`, fx.admin.token);
    assert.equal(res.status, 200);
  });

  test('non-member cannot read org audit logs (404)', async () => {
    const res = await req(`/audit-logs/organization/${fx.orgA.id}`, fx.outsider.token);
    assert.equal(res.status, 404);
  });
});

describe('Guest org members', () => {
  test('guest can view their project (200) — being a guest does not restrict project-level access', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.guest.token);
    assert.equal(res.status, 200);
  });

  test('guest sees their project even though they are not a regular org member', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.guest.token);
    const body = await res.json();
    assert.equal(body.currentUserRole.orgRole, 'guest');
    assert.equal(body.currentUserRole.projectRole, 'admin');
    // The guest is a project ADMIN, so all the project-level flags are on.
    assert.equal(body.currentUserRole.canEdit, true);
    assert.equal(body.currentUserRole.canManageMembers, true);
    assert.equal(body.currentUserRole.canDelete, true);
  });

  test('guest cannot see projects they were not invited to (404)', async () => {
    const res = await req(`/projects/${fx.projectB.id}`, fx.guest.token);
    assert.equal(res.status, 404);
  });

  test('guest org payload contains only projects they belong to', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.guest.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    assert.deepEqual(ids.sort(), [fx.projectA.id].sort());
  });

  test('guest cannot create a new project (403)', async () => {
    const res = await req(`/projects`, fx.guest.token, {
      method: 'POST',
      body: JSON.stringify({ organizationId: fx.orgA.id, name: 'guest-attempt' }),
    });
    assert.equal(res.status, 403);
  });

  test('plain member CAN create a new project (not 403/404) — guests are uniquely blocked', async () => {
    const res = await req(`/projects`, fx.plainMember.token, {
      method: 'POST',
      body: JSON.stringify({ organizationId: fx.orgA.id, name: `${RUN_TAG}-member-spawn` }),
    });
    // Action may succeed (200) or hit a downstream constraint (400, no K8s, etc.) but
    // must not be rejected by auth.
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
    if (res.ok) {
      const body = await res.json();
      // Clean up the project we just created so we don't leak it.
      if (body?.id) await prisma.project.delete({ where: { id: body.id } }).catch(() => {});
    }
  });

  test('org admin cannot invite someone as a guest directly (400)', async () => {
    const res = await req(`/organizations/${fx.orgA.id}/members`, fx.admin.token, {
      method: 'POST',
      body: JSON.stringify({ email: 'someone@example.test', role: 'guest' }),
    });
    assert.equal(res.status, 400);
  });

  test('guest cannot see org settings page data they should not (cannot update org)', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.guest.token, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'guest attempt' }),
    });
    assert.equal(res.status, 403);
  });

  test('inviting a brand-new user to a project auto-creates them as a guest org member', async () => {
    // Create a fresh user with no org membership at all.
    const newGuestEmail = `${RUN_TAG}-fresh-guest@example.test`;
    const newGuest = await prisma.user.create({
      data: {
        email: newGuestEmail,
        username: `${RUN_TAG}-fresh-guest`,
      },
    });
    try {
      // admin invites them to projectA as a member.
      const res = await req(`/projects/${fx.projectA.id}/members`, fx.admin.token, {
        method: 'POST',
        body: JSON.stringify({ email: newGuestEmail, role: 'member' }),
      });
      assert.equal(res.status, 201, `expected 201, got ${res.status}`);

      // They should now have an OrgMember row with role=guest.
      const orgMembership = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: fx.orgA.id, userId: newGuest.id } },
      });
      assert.ok(orgMembership, 'org membership should have been auto-created');
      assert.equal(orgMembership!.role, 'guest');
    } finally {
      // Cascade-cleanup: deleting the user removes their project + org memberships.
      await prisma.user.delete({ where: { id: newGuest.id } }).catch(() => {});
    }
  });
});

describe('Membership cache invalidation', () => {
  test('removing a member denies them on next call within cache TTL', async () => {
    // Sanity: plainMember can currently see the org.
    let res = await req(`/organizations/${fx.orgA.id}`, fx.plainMember.token);
    assert.equal(res.status, 200);

    // Remove plainMember from orgA via the API (must be admin).
    const membershipRow = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: fx.orgA.id, userId: fx.plainMember.id } },
    });
    assert.ok(membershipRow, 'membership should exist before removal');
    const del = await req(`/organizations/${fx.orgA.id}/members/${membershipRow!.id}`, fx.admin.token, { method: 'DELETE' });
    assert.equal(del.status, 200, 'admin should be able to remove the member');

    // Immediately re-check — if cache invalidation works, this is 404 right now.
    // If it didn't, we'd still get 200 for up to 30s.
    res = await req(`/organizations/${fx.orgA.id}`, fx.plainMember.token);
    assert.equal(res.status, 404, 'removed member must lose access immediately, not after cache TTL');

    // Restore the membership so subsequent tests / teardown remain consistent.
    await prisma.organizationMember.create({
      data: { organizationId: fx.orgA.id, userId: fx.plainMember.id, role: 'member' },
    });
  });
});
