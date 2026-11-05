/**
 * RBAC end-to-end test.
 *
 * Boots no application: hits a running server. Seeds test users, an org, and
 * a project directly via Prisma, mints session JWTs locally, and asserts that
 * every endpoint enforces the RBAC contract.
 *
 * Run:
 *   1. Start the server in another terminal:  `pnpm dev`
 *   2. In this terminal:                      `pnpm test:rbac`
 *
 * Env vars:
 *   SERVER_URL    Default http://localhost:3001 (matches main.ts default port).
 *   JWT_SECRET    Same secret the server is using: required to mint test tokens.
 *   TEST_DATABASE_URL  The throwaway database the server under test uses. DATABASE_URL is
 *                      only accepted when it is not localhost:5432 (see test/support/test-database.ts).
 *
 * The script uses a single fixed UUID prefix for all rows it creates and
 * cleans up everything on exit (including on assertion failure) so it can be
 * re-run safely.
 */
import 'dotenv/config';
import { testPrismaClient } from './support/test-database';
import { createHash } from 'node:crypto';
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

const prisma = testPrismaClient();

// All fixture rows are tagged with this run ID so we can clean them up later
// without disturbing any other rows that happen to share a column value.
const RUN_TAG = `rbac-e2e-${randomUUID().slice(0, 8)}`;

interface Fixture {
  // Two orgs so we can verify cross-org isolation.
  orgA: { id: string; slug: string };
  orgB: { id: string; slug: string };
  // Five users in orgA: owner, admin, member, viewer, and a guest (who is
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
  // SuperAdminGuard rejects any JWT without a sessionId (post-fix, all
  // issuance paths mint sessions). Tests must do the same or every request
  // 401s with "Session has been revoked" before reaching the RBAC layer.
  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 3600_000),
      ipAddress: '127.0.0.1',
      userAgent: RUN_TAG
    }
  });
  return new SignJWT({ sub: userId, sessionId: session.id })
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
    prisma.role.upsert({ where: { name: 'viewer' }, update: {}, create: { name: 'viewer' } })
  ]);

  async function mkUser(label: string) {
    const email = `${RUN_TAG}-${label}@example.test`;
    const u = await prisma.user.create({
      data: {
        email,
        username: `${RUN_TAG}-${label}`,
        firstName: label,
        lastName: 'Test'
      }
    });
    return { id: u.id, email, token: await mintToken(u.id) };
  }

  const owner = await mkUser('owner');
  const admin = await mkUser('admin');
  const plainMember = await mkUser('member');
  const viewer = await mkUser('viewer');
  const guest = await mkUser('guest');
  const outsider = await mkUser('outsider');

  const orgA = await prisma.organization.create({
    data: {
      name: `${RUN_TAG}-orgA`,
      slug: `${RUN_TAG}-org-a`,
      createdBy: owner.id
    }
  });
  const orgB = await prisma.organization.create({
    data: {
      name: `${RUN_TAG}-orgB`,
      slug: `${RUN_TAG}-org-b`,
      createdBy: outsider.id
    }
  });

  await prisma.organizationMember.createMany({
    data: [
      { organizationId: orgA.id, userId: owner.id, role: 'owner' },
      { organizationId: orgA.id, userId: admin.id, role: 'admin' },
      { organizationId: orgA.id, userId: plainMember.id, role: 'member' },
      { organizationId: orgA.id, userId: viewer.id, role: 'member' },
      { organizationId: orgA.id, userId: guest.id, role: 'guest' },
      { organizationId: orgB.id, userId: outsider.id, role: 'owner' }
    ]
  });

  const projectA = await prisma.project.create({
    data: {
      organizationId: orgA.id,
      name: 'Project A',
      slug: 'project-a',
      namespace: `${RUN_TAG}-ns-a`,
      createdBy: owner.id
    }
  });
  const projectB = await prisma.project.create({
    data: {
      organizationId: orgA.id,
      name: 'Project B',
      slug: 'project-b',
      namespace: `${RUN_TAG}-ns-b`,
      createdBy: owner.id
    }
  });

  // Project memberships on projectA only. Guest is a project admin to prove
  // a guest org-member can hold an elevated project role.
  await prisma.projectMember.createMany({
    data: [
      { projectId: projectA.id, userId: plainMember.id, roleId: memberRole.id },
      { projectId: projectA.id, userId: viewer.id, roleId: viewerRole.id },
      { projectId: projectA.id, userId: guest.id, roleId: adminRole.id }
    ]
  });

  // A deployment on projectA
  const deploymentA = await prisma.deployment.create({
    data: {
      projectId: projectA.id,
      name: 'dep-a',
      image: 'nginx:alpine',
      namespace: projectA.namespace,
      status: 'pending'
    }
  });

  fx = {
    orgA: { id: orgA.id, slug: orgA.slug },
    orgB: { id: orgB.id, slug: orgB.slug },
    owner,
    admin,
    plainMember,
    viewer,
    outsider,
    guest,
    projectA: { id: projectA.id, slug: projectA.slug, namespace: projectA.namespace },
    projectB: { id: projectB.id, slug: projectB.slug, namespace: projectB.namespace },
    deploymentA: { id: deploymentA.id }
  };

  // Smoke-check the server is up before doing anything else.
  const ping = await fetch(`${SERVER_URL}/${PREFIX}/organizations/user`, {
    headers: { Authorization: `Bearer ${owner.token}` }
  });
  if (!ping.ok && ping.status !== 200) {
    console.error(
      `Server at ${SERVER_URL} did not respond OK (status ${ping.status}). Is it running?`
    );
    process.exit(1);
  }
});

after(async () => {
  // Order: project members → projects → org members → invitations → orgs → users.
  // Cascade should handle most of this but be explicit on the things we touched.
  try {
    await prisma.deployment.deleteMany({ where: { id: fx.deploymentA.id } });
    await prisma.projectMember.deleteMany({
      where: { projectId: { in: [fx.projectA.id, fx.projectB.id] } }
    });
    await prisma.project.deleteMany({ where: { id: { in: [fx.projectA.id, fx.projectB.id] } } });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: { in: [fx.orgA.id, fx.orgB.id] } }
    });
    await prisma.organization.deleteMany({ where: { id: { in: [fx.orgA.id, fx.orgB.id] } } });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [
            fx.owner.id,
            fx.admin.id,
            fx.plainMember.id,
            fx.viewer.id,
            fx.guest.id,
            fx.outsider.id
          ]
        }
      }
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
      body: JSON.stringify({ description: 'hacked' })
    });
    assert.equal(res.status, 403);
  });

  test('admin can update org', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.admin.token, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'updated by admin' })
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
    const res = await req(`/deployments/${fx.deploymentA.id}`, fx.viewer.token, {
      method: 'DELETE'
    });
    assert.equal(res.status, 403);
  });

  test('viewer cannot scale deployment (403)', async () => {
    const res = await req(`/deployments/${fx.deploymentA.id}/scale`, fx.viewer.token, {
      method: 'POST',
      body: JSON.stringify({ replicas: 2 })
    });
    assert.equal(res.status, 403);
  });

  test('viewer cannot update project (403)', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.viewer.token, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'viewer attempt' })
    });
    assert.equal(res.status, 403);
  });

  test('member CAN scale deployment (not 403)', async () => {
    const res = await req(`/deployments/${fx.deploymentA.id}/scale`, fx.plainMember.token, {
      method: 'POST',
      body: JSON.stringify({ replicas: 1 })
    });
    // The action may fail downstream (no real K8s), but auth must not reject.
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
  });

  test('member cannot delete project (403) — only admin/owner can', async () => {
    const res = await req(`/projects/${fx.projectA.id}`, fx.plainMember.token, {
      method: 'DELETE'
    });
    assert.equal(res.status, 403);
  });

  test('member cannot add project member (403)', async () => {
    const res = await req(`/projects/${fx.projectA.id}/members`, fx.plainMember.token, {
      method: 'POST',
      body: JSON.stringify({ email: fx.outsider.id, role: 'member' })
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
      body: JSON.stringify({ organizationId: fx.orgA.id, name: 'guest-attempt' })
    });
    assert.equal(res.status, 403);
  });

  test('plain member CAN create a new project (not 403/404) — guests are uniquely blocked', async () => {
    const res = await req(`/projects`, fx.plainMember.token, {
      method: 'POST',
      body: JSON.stringify({ organizationId: fx.orgA.id, name: `${RUN_TAG}-member-spawn` })
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
      body: JSON.stringify({ email: 'someone@example.test', role: 'guest' })
    });
    assert.equal(res.status, 400);
  });

  test('guest cannot see org settings page data they should not (cannot update org)', async () => {
    const res = await req(`/organizations/${fx.orgA.id}`, fx.guest.token, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'guest attempt' })
    });
    assert.equal(res.status, 403);
  });

  test('adding an account outside the org to a project invites them instead of joining them', async () => {
    // Create a fresh user with no org membership at all.
    const newGuestEmail = `${RUN_TAG}-fresh-guest@example.test`;
    const newGuest = await prisma.user.create({
      data: {
        email: newGuestEmail,
        username: `${RUN_TAG}-fresh-guest`
      }
    });
    try {
      // admin invites them to projectA as a member.
      const res = await req(`/projects/${fx.projectA.id}/members`, fx.admin.token, {
        method: 'POST',
        body: JSON.stringify({ email: newGuestEmail, role: 'member' })
      });
      assert.equal(res.status, 201, `expected 201, got ${res.status}`);

      assert.equal((await res.json()).invited, true);

      // Joining an org is the recipient's decision.
      const orgMembership = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: fx.orgA.id, userId: newGuest.id } }
      });
      assert.equal(orgMembership, null);
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
      where: { organizationId_userId: { organizationId: fx.orgA.id, userId: fx.plainMember.id } }
    });
    assert.ok(membershipRow, 'membership should exist before removal');
    const del = await req(
      `/organizations/${fx.orgA.id}/members/${membershipRow!.id}`,
      fx.admin.token,
      { method: 'DELETE' }
    );
    assert.equal(del.status, 200, 'admin should be able to remove the member');

    // Immediately re-check: the removed member must lose access right away.
    // Removal revokes their sessions (401) before the membership cache is even
    // consulted; if revocation is skipped, cache invalidation yields 404. Either
    // way the denial is immediate (not deferred to the cache TTL).
    res = await req(`/organizations/${fx.orgA.id}`, fx.plainMember.token);
    assert.ok(
      res.status === 401 || res.status === 404,
      `removed member must lose access immediately, not after cache TTL (got ${res.status})`
    );

    // Restore the membership so subsequent tests / teardown remain consistent.
    await prisma.organizationMember.create({
      data: { organizationId: fx.orgA.id, userId: fx.plainMember.id, role: 'member' }
    });
  });
});

describe('Hardening rules', () => {
  test('viewer gets 403 on log routes, member does not', async () => {
    const paths = [
      `/deployments/${fx.deploymentA.id}/killed-containers/x/logs`,
      `/observe/deployments/${fx.deploymentA.id}/logs/structured`
    ];
    for (const p of paths) {
      assert.equal((await req(p, fx.viewer.token)).status, 403, p);
      assert.notEqual((await req(p, fx.plainMember.token)).status, 403, p);
    }
  });

  test('a member cannot delete an environment, only someone who may delete the project', async () => {
    const envs = (await (
      await req(`/projects/${fx.projectA.id}/environments`, fx.owner.token)
    ).json()) as { id: string }[] | { environments?: { id: string }[] };
    const list = Array.isArray(envs) ? envs : (envs.environments ?? []);
    if (list.length === 0) return;
    const res = await req(`/environments/${list[0].id}`, fx.plainMember.token, {
      method: 'DELETE'
    });
    assert.equal(res.status, 403);
  });

  test('a read-scoped api token cannot mutate', async () => {
    const minted = await req('/auth/tokens', fx.owner.token, {
      method: 'POST',
      body: JSON.stringify({ name: `${RUN_TAG}-read`, scopes: ['read'] })
    });
    assert.equal(minted.status, 201);
    const { token } = (await minted.json()) as { token: string };
    const res = await req(`/deployments/${fx.deploymentA.id}/restart`, token, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  test('a project-restricted token cannot mint a broader token', async () => {
    const minted = await req('/auth/tokens', fx.owner.token, {
      method: 'POST',
      body: JSON.stringify({
        name: `${RUN_TAG}-narrow`,
        scopes: ['deploy'],
        restrictedProjectIds: [fx.projectA.id]
      })
    });
    assert.equal(minted.status, 201);
    const { token } = (await minted.json()) as { token: string };
    const wider = await req('/auth/tokens', token, {
      method: 'POST',
      body: JSON.stringify({ name: `${RUN_TAG}-wider`, scopes: ['exec'] })
    });
    assert.equal(wider.status, 403);
    const unscoped = await req('/auth/tokens', token, {
      method: 'POST',
      body: JSON.stringify({ name: `${RUN_TAG}-unscoped`, scopes: ['deploy'] })
    });
    assert.equal(unscoped.status, 403);
  });

  test('an api token never reaches admin routes, even for a superadmin', async () => {
    await prisma.user.update({ where: { id: fx.owner.id }, data: { isSuperAdmin: true } });
    try {
      assert.equal((await req('/admin/users', fx.owner.token)).status, 200);
      const minted = await req('/auth/tokens', fx.owner.token, {
        method: 'POST',
        body: JSON.stringify({ name: `${RUN_TAG}-sa`, scopes: ['exec'] })
      });
      const { token } = (await minted.json()) as { token: string };
      assert.equal((await req('/admin/users', token)).status, 403);
    } finally {
      await prisma.user.update({ where: { id: fx.owner.id }, data: { isSuperAdmin: false } });
    }
  });

  test('a token carrying a type claim is not a session', async () => {
    const session = await prisma.session.findFirst({ where: { userId: fx.owner.id } });
    const typed = await new SignJWT({ sub: fx.owner.id, sessionId: session!.id, type: 'mcp' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(SECRET_BYTES);
    assert.equal((await req('/auth/me', typed)).status, 401);
  });

  test('a cookie session cannot mutate from a foreign origin', async () => {
    const attempt = (origin: string) =>
      fetch(`${SERVER_URL}/${PREFIX}/organizations/${fx.orgA.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session_token=${fx.owner.token}`,
          Origin: origin
        },
        body: JSON.stringify({ description: RUN_TAG })
      });
    assert.equal((await attempt('https://evil.example')).status, 403);
    assert.equal((await attempt('http://localhost:4000')).status, 200);
  });

  test('invitations to one address stop after five in an hour', async () => {
    const target = `${RUN_TAG}-flood@example.test`;
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await req(`/organizations/${fx.orgA.id}/members`, fx.owner.token, {
        method: 'POST',
        body: JSON.stringify({ email: target, role: 'member' })
      });
      last = res.status;
      if (last === 429) break;
    }
    assert.equal(last, 429);
    await prisma.organizationInvitation.deleteMany({ where: { email: target } });
    await prisma.rateLimitRecord.deleteMany({
      where: { identifier: { in: [target, fx.orgA.id] } }
    });
  });
});

describe('Org isolation', () => {
  const tag = `${RUN_TAG}-iso`;
  let pepito: { id: string; email: string; token: string };
  let enforcing: { id: string; slug: string };
  let own: { id: string; slug: string };
  let enforcingProject: { id: string };
  let ownProject: { id: string };

  async function orgScopedToken(userId: string, organizationId: string) {
    const session = await prisma.session.create({
      data: { userId, authMethod: 'sso', expiresAt: new Date(Date.now() + 3600_000) }
    });
    return new SignJWT({ sub: userId, sessionId: session.id, orgScope: organizationId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(SECRET_BYTES);
  }

  before(async () => {
    const email = `${tag}-pepito@gmail.example`;
    const user = await prisma.user.create({
      data: { email, username: `${tag}-pepito`, emailVerified: true }
    });
    pepito = { id: user.id, email, token: await mintToken(user.id) };
    enforcing = await prisma.organization.create({
      data: { name: `${tag} enforcing`, slug: `${tag}-enforcing` }
    });
    own = await prisma.organization.create({ data: { name: `${tag} own`, slug: `${tag}-own` } });
    await prisma.organizationMember.createMany({
      data: [
        { organizationId: enforcing.id, userId: user.id, role: 'member' },
        { organizationId: own.id, userId: user.id, role: 'owner' }
      ]
    });
    await prisma.orgSsoSettings.create({
      data: { organizationId: enforcing.id, platformEnabled: true, enabled: true, enforced: true }
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'member' } });
    enforcingProject = await prisma.project.create({
      data: {
        name: `${tag}-a`,
        slug: `${tag}-a`,
        namespace: `${tag}-a`,
        organizationId: enforcing.id,
        createdBy: user.id
      }
    });
    await prisma.projectMember.create({
      data: { projectId: enforcingProject.id, userId: user.id, roleId: role.id }
    });
    ownProject = await prisma.project.create({
      data: {
        name: `${tag}-b`,
        slug: `${tag}-b`,
        namespace: `${tag}-b`,
        organizationId: own.id,
        createdBy: user.id
      }
    });
  });

  after(async () => {
    await prisma.project.deleteMany({
      where: { id: { in: [enforcingProject.id, ownProject.id] } }
    });
    await prisma.organization.deleteMany({ where: { id: { in: [enforcing.id, own.id] } } });
    await prisma.user.delete({ where: { id: pepito.id } }).catch(() => {});
  });

  test('being in an enforcing org leaves other orgs open', async () => {
    assert.equal((await req(`/organizations/${own.id}`, pepito.token)).status, 200);
    assert.equal((await req(`/projects/${ownProject.id}`, pepito.token)).status, 200);
  });

  test('the enforcing org itself needs its SSO', async () => {
    assert.equal((await req(`/organizations/${enforcing.id}`, pepito.token)).status, 404);
    assert.equal((await req(`/projects/${enforcingProject.id}`, pepito.token)).status, 404);
    const overview = await req(`/overview/orgs/${enforcing.slug}`, pepito.token);
    assert.equal(overview.status, 403);
    assert.equal((await overview.json()).error, 'org_sso_required');
  });

  test('org lists mark it and leak nothing inside it', async () => {
    const orgs = await (await req('/organizations/user', pepito.token)).json();
    const blocked = orgs.find((o: any) => o.id === enforcing.id);
    assert.equal(blocked.ssoRequired, true);
    assert.deepEqual(Object.keys(blocked).sort(), ['id', 'myRole', 'name', 'slug', 'ssoRequired']);
    assert.equal(orgs.find((o: any) => o.id === own.id).ssoRequired, undefined);

    const overview = await (await req('/overview', pepito.token)).json();
    assert.deepEqual(
      overview.organizations.map((o: any) => o.id),
      [own.id]
    );
    assert.equal(
      overview.projects.some((p: any) => p.id === enforcingProject.id),
      false
    );
  });

  test('its SSO session opens it and sees nothing of his other orgs', async () => {
    const scoped = await orgScopedToken(pepito.id, enforcing.id);
    assert.equal((await req(`/organizations/${enforcing.id}`, scoped)).status, 200);
    assert.equal((await req(`/projects/${enforcingProject.id}`, scoped)).status, 200);
    assert.equal((await req(`/organizations/${own.id}`, scoped)).status, 404);
    assert.equal((await req(`/projects/${ownProject.id}`, scoped)).status, 404);
    const overview = await (await req('/overview', scoped)).json();
    assert.deepEqual(
      overview.organizations.map((o: any) => o.id),
      [enforcing.id]
    );
    assert.equal(
      overview.projects.some((p: any) => p.id === ownProject.id),
      false
    );
    assert.equal((await req('/auth/tokens', scoped)).status, 200);
    assert.equal((await req('/auth/sessions', scoped)).status, 403);
  });

  test('what its SSO session mints stays inside that org', async () => {
    const scoped = await orgScopedToken(pepito.id, enforcing.id);

    const mcp = await req('/auth/mcp-token', scoped, { method: 'POST' });
    assert.equal(mcp.status, 200);
    const { token: mcpToken } = await mcp.json();
    assert.equal((await req(`/projects/${enforcingProject.id}`, mcpToken)).status, 200);
    assert.equal((await req(`/projects/${ownProject.id}`, mcpToken)).status, 404);

    const created = await req('/auth/tokens', scoped, {
      method: 'POST',
      body: JSON.stringify({ name: `${tag}-sso-cli`, scopes: ['read'] })
    });
    assert.equal(created.status, 201);
    const { token: apiToken } = await created.json();
    assert.equal((await req(`/projects/${enforcingProject.id}`, apiToken)).status, 200);
    assert.equal((await req(`/organizations/${own.id}`, apiToken)).status, 404);
    assert.equal((await req(`/projects/${ownProject.id}`, apiToken)).status, 404);
    for (const path of ['/auth/tokens', '/auth/sessions']) {
      assert.equal((await req(path, apiToken)).status, 403, path);
    }
    const again = await req('/auth/tokens', apiToken, {
      method: 'POST',
      body: JSON.stringify({ name: `${tag}-sso-cli-2`, scopes: ['read'] })
    });
    assert.equal(again.status, 403);
  });

  test('a token made without its SSO stays out of the org and hears why', async () => {
    const raw = `orch_${RUN_TAG}_plain_${Date.now()}`;
    const plain = await prisma.apiToken.create({
      data: {
        userId: pepito.id,
        name: `${tag}-plain`,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        scopes: ['deploy'],
        expiresAt: new Date(Date.now() + 3600_000)
      } as any
    });
    for (const path of [
      `/organizations/${enforcing.id}`,
      `/projects/${enforcingProject.id}`,
      `/overview/orgs/${enforcing.slug}`
    ]) {
      const refused = await req(path, raw);
      assert.equal(refused.status, 403, path);
      assert.equal((await refused.json()).error, 'org_sso_required', path);
    }
    assert.equal((await req(`/organizations/${own.id}`, raw)).status, 200);
    assert.equal((await req(`/projects/${ownProject.id}`, raw)).status, 200);
    const orgs = await (await req('/organizations/user', raw)).json();
    assert.equal(orgs.find((o: any) => o.id === enforcing.id).ssoRequired, true);

    const missing = await req(`/organizations/${randomUUID()}`, raw);
    assert.equal(missing.status, 404);

    await prisma.apiToken.delete({ where: { id: plain.id } });
  });

  test('its SSO session manages only the tokens made inside that org', async () => {
    const scoped = await orgScopedToken(pepito.id, enforcing.id);
    const inside = await (
      await req('/auth/tokens', scoped, {
        method: 'POST',
        body: JSON.stringify({ name: `${tag}-inside`, scopes: ['read'] })
      })
    ).json();
    const raw = `orch_${RUN_TAG}_outside_${Date.now()}`;
    const outside = await prisma.apiToken.create({
      data: {
        userId: pepito.id,
        name: `${tag}-outside`,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 3600_000)
      } as any
    });
    const listed = await (await req('/auth/tokens', scoped)).json();
    assert.ok(listed.some((t: any) => t.id === inside.id));
    assert.equal(listed.find((t: any) => t.id === inside.id).scopeOrganizationName, enforcing.name);
    assert.equal(
      listed.some((t: any) => t.id === outside.id),
      false
    );
    const rename = { method: 'PATCH', body: JSON.stringify({ name: `${tag}-renamed` }) };
    assert.equal((await req(`/auth/tokens/${outside.id}`, scoped, rename)).status, 404);
    assert.equal((await req(`/auth/tokens/${inside.id}`, scoped, rename)).status, 200);
    const del = { method: 'DELETE' };
    assert.equal((await req(`/auth/tokens/${outside.id}`, scoped, del)).status, 404);
    assert.equal((await req(`/auth/tokens/${inside.id}`, scoped, del)).status, 200);
    await prisma.apiToken.delete({ where: { id: outside.id } });
  });

  test('removal by the org keeps him signed in everywhere else', async () => {
    const row = await prisma.organizationMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: enforcing.id, userId: pepito.id } }
    });
    const admin = await prisma.user.create({
      data: { email: `${tag}-admin@example.test`, username: `${tag}-admin` }
    });
    await prisma.organizationMember.create({
      data: { organizationId: enforcing.id, userId: admin.id, role: 'owner' }
    });
    const adminToken = await mintToken(admin.id);
    const removed = await req(`/organizations/${enforcing.id}/members/${row.id}`, adminToken, {
      method: 'DELETE'
    });
    assert.equal(removed.status, 200);
    assert.equal((await req(`/organizations/${own.id}`, pepito.token)).status, 200);
    assert.ok(await prisma.user.findUnique({ where: { id: pepito.id } }));

    await prisma.organizationMember.create({
      data: { organizationId: enforcing.id, userId: pepito.id, role: 'member' }
    });
    await prisma.user.delete({ where: { id: admin.id } });
  });

  test('a sign-in form on another site cannot post credentials', async () => {
    const attempt = (origin: string) =>
      fetch(`${SERVER_URL}/${PREFIX}/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password-123' })
      });
    assert.equal((await attempt('https://evil.example')).status, 403);
    assert.notEqual((await attempt('http://localhost:4000')).status, 403);
  });

  test('SSO callbacks need the cookie from starting in this browser', async () => {
    const provider = await prisma.identityProvider.create({
      data: {
        organizationId: own.id,
        slug: `${tag}-idp`,
        name: 'Test',
        protocol: 'oidc',
        enabled: true,
        issuerUrl: 'https://idp.example.test',
        clientId: 'x'
      } as any
    });
    try {
      const res = await fetch(
        `${SERVER_URL}/${PREFIX}/sso/callback/${provider.id}?code=c&state=forged`,
        { redirect: 'manual' }
      );
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location') ?? '', /error=sso_failed/);
    } finally {
      await prisma.identityProvider.delete({ where: { id: provider.id } });
    }
  });

  test('tokens cannot reach identity admin, and project tokens stay out of account routes', async () => {
    const mint = async (restrictedProjectIds: string[]) => {
      const raw = `orch_${RUN_TAG}_${restrictedProjectIds.length}_${Date.now()}`;
      await prisma.apiToken.create({
        data: {
          userId: pepito.id,
          name: `${tag}-${restrictedProjectIds.length}`,
          tokenHash: createHash('sha256').update(raw).digest('hex'),
          scopes: ['exec'],
          restrictedProjectIds,
          expiresAt: new Date(Date.now() + 3600_000)
        } as any
      });
      return raw;
    };
    const full = await mint([]);
    const limited = await mint([ownProject.id]);
    assert.equal((await req(`/organizations/${own.id}/scim/tokens`, full)).status, 403);
    assert.equal((await req(`/organizations/${own.id}/sso/providers`, full)).status, 403);
    assert.equal((await req('/auth/sessions', full)).status, 200);
    assert.equal((await req('/auth/me', limited)).status, 200);
    assert.equal((await req('/auth/sessions', limited)).status, 403);
    assert.equal((await req('/github/status', limited)).status, 403);
    assert.equal((await req(`/projects/${ownProject.id}`, limited)).status, 200);
    await prisma.apiToken.deleteMany({ where: { userId: pepito.id } });
  });

  test('he can leave an enforcing org without its SSO, and owners cannot leave', async () => {
    const left = await req(`/organizations/${enforcing.id}/leave`, pepito.token, {
      method: 'POST'
    });
    assert.equal(left.status, 201);
    const gone = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: enforcing.id, userId: pepito.id } }
    });
    assert.equal(gone, null);
    assert.equal((await req(`/organizations/${own.id}`, pepito.token)).status, 200);
    const owner = await req(`/organizations/${own.id}/leave`, pepito.token, { method: 'POST' });
    assert.equal(owner.status, 400);
  });
});
