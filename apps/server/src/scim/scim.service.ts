import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import SCIMMY from 'scimmy';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ScimError } from './scim-error';
import { ScimQuery, SCIM_MAX_RESULTS } from './scim-query';

interface Ctx { organizationId: string }

// Normalized shape both a live membership and a deactivated tombstone reduce
// to, so the SCIM projection has one code path.
interface ScimMemberView {
  id: string;
  userId: string;
  externalId: string | null;
  role: string;
  enterprise: any;
  active: boolean;
  created: Date;
  lastModified: Date;
  user: any;
}

const SCIM_BASEPATH = '/apiv1/scim/v2';

const ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

// The org roles SCIM Groups project onto, and the set an IdP may provision
// into via `roles` / `userType`.
const ROLE_GROUPS = ['owner', 'admin', 'member', 'guest'] as const;

const DEFAULT_ROLE = 'member';

function groupDisplayName(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function normalizeRole(raw: any): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const role = String(raw).trim().toLowerCase();
  if (!ROLE_GROUPS.includes(role as any)) {
    throw ScimError(
      400,
      'invalidValue',
      `Unknown role "${raw}"; expected one of ${ROLE_GROUPS.join(', ')}`,
    );
  }
  return role;
}

// RFC 7643 §4.1.2 `roles` is the standard place to carry an application role,
// and it's what Entra populates from app-role assignments. Okta setups more
// often map to `userType`, so both are accepted.
//
// currentRole disambiguates PATCH. SCIMMY applies the operation to the whole
// resource and hands the merged result back, so the attribute the client didn't
// touch still echoes the role we last sent it — and a pathless `replace` on a
// multi-valued attribute *appends*, leaving the old role sitting in front of
// the new one in `roles`. Either way the value that already matches the current
// role carries no instruction, and the one that differs is the request.
function roleFromInstance(instance: any, currentRole?: string | null): string | null {
  const roles = Array.isArray(instance?.roles) ? instance.roles : [];
  // Primary first, so the fallback picks the preferred value when nothing changed.
  const ordered = [...roles].sort((a, b) => Number(!!b?.primary) - Number(!!a?.primary));
  const candidates = [
    ...ordered.map((r: any) => normalizeRole(r?.value)),
    normalizeRole(instance?.userType),
  ].filter((r): r is string => r !== null);

  if (!candidates.length) return null;
  return candidates.find((r) => r !== currentRole) ?? candidates[0];
}

function enterpriseFromInstance(instance: any) {
  const payload = instance?.[ENTERPRISE_SCHEMA];
  if (Object(payload) !== payload || Array.isArray(payload)) return null;
  // SCIMMY hands back a schema instance with undefined-valued keys for every
  // unset attribute; strip them so an omitted extension stores as null rather
  // than a bag of nulls.
  const entries = Object.entries(payload).filter(([, v]) => v !== undefined && v !== null);
  return entries.length ? Object.fromEntries(entries) : null;
}

@Injectable()
export class ScimService implements OnModuleInit {
  private readonly logger = new Logger(ScimService.name);

  private declared = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.declareResources();
  }

  // SCIMMY's resource registry is process-global, so this runs once. Handlers
  // are bound to `this`; per-request org scoping rides in via the `ctx` arg
  // threaded through read/write/patch/dispose.
  private declareResources() {
    if (this.declared) return;
    this.declared = true;

    for (const R of [
      SCIMMY.Resources.User,
      SCIMMY.Resources.Group,
      SCIMMY.Resources.Schema,
      SCIMMY.Resources.ResourceType,
      SCIMMY.Resources.ServiceProviderConfig,
    ]) {
      R.basepath(SCIM_BASEPATH);
    }

    SCIMMY.Config.set({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
      changePassword: { supported: false },
      sort: { supported: true },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Authentication via the SCIM bearer token minted in org settings.',
        },
      ],
    });

    // Optional (not required) so an IdP that never sends it still validates.
    SCIMMY.Resources.User.extend(SCIMMY.Schemas.EnterpriseUser, false);

    SCIMMY.Resources.User
      .ingress((resource, instance, ctx: Ctx) => this.ingressUser(resource, instance, ctx))
      .egress((resource, ctx: Ctx) => this.egressUsers(resource, ctx))
      .degress((resource, ctx: Ctx) => this.degressUser(resource, ctx));

    SCIMMY.Resources.Group
      .ingress(() => {
        throw ScimError(501, null, 'Group provisioning is read-only; manage roles in-app');
      })
      .egress((resource, ctx: Ctx) => this.egressGroups(resource, ctx))
      .degress(() => {
        throw ScimError(501, null, 'Group provisioning is read-only; manage roles in-app');
      });

    SCIMMY.Resources.declare(SCIMMY.Resources.User);
    SCIMMY.Resources.declare(SCIMMY.Resources.Group);
  }

  // ---- Users -------------------------------------------------------------

  private primaryEmail(instance: any): string | null {
    const emails = Array.isArray(instance.emails) ? instance.emails : [];
    const primary = emails.find((e: any) => e?.primary) ?? emails[0];
    const fromEmails = primary?.value?.trim();
    if (fromEmails) return fromEmails.toLowerCase();
    const userName = typeof instance.userName === 'string' ? instance.userName.trim() : '';
    if (userName.includes('@')) return userName.toLowerCase();
    return null;
  }

  private viewFromMember(member: {
    id: string;
    role: string;
    scimExternalId: string | null;
    scimEnterprise?: any;
    addedAt: Date;
    userId: string;
    user: any;
  }): ScimMemberView {
    return {
      id: member.id,
      userId: member.userId,
      externalId: member.scimExternalId,
      role: member.role,
      enterprise: member.scimEnterprise ?? null,
      active: true,
      created: member.addedAt,
      lastModified: member.addedAt,
      user: member.user,
    };
  }

  private viewFromTombstone(row: {
    id: string;
    role: string;
    externalId: string | null;
    enterprise?: any;
    deactivatedAt: Date;
    userId: string;
    user: any;
  }): ScimMemberView {
    return {
      id: row.id,
      userId: row.userId,
      externalId: row.externalId,
      role: row.role,
      enterprise: row.enterprise ?? null,
      active: false,
      created: row.deactivatedAt,
      lastModified: row.deactivatedAt,
      user: row.user,
    };
  }

  private toScimUser(view: ScimMemberView) {
    const { user } = view;
    return {
      id: view.id,
      ...(view.externalId ? { externalId: view.externalId } : {}),
      userName: user.email,
      name: {
        givenName: user.firstName ?? undefined,
        familyName: user.lastName ?? undefined,
      },
      displayName:
        [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.email,
      emails: [{ value: user.email, primary: true, type: 'work' }],
      active: view.active,
      // The org role, surfaced three ways so an IdP can round-trip it however
      // it's wired: `roles` is the RFC 7643 home for it, `userType` is what
      // most Okta profile mappings reach for, and `groups` mirrors the
      // read-only Group projection.
      roles: [{ value: view.role, display: groupDisplayName(view.role), primary: true }],
      userType: view.role,
      groups: view.active
        ? [{ value: `role:${view.role}`, display: groupDisplayName(view.role), type: 'direct' }]
        : [],
      ...(view.enterprise ? { [ENTERPRISE_SCHEMA]: view.enterprise } : {}),
      meta: {
        resourceType: 'User',
        created: view.created,
        lastModified: view.lastModified,
      },
    };
  }

  // An org with no owner can't be administered back into shape, so SCIM is not
  // allowed to remove the last one — by deactivation, deletion, or demotion.
  private async assertNotLastOwner(view: ScimMemberView, ctx: Ctx, action: string) {
    if (view.role !== 'owner') return;
    const owners = await this.prisma.organizationMember.count({
      where: { organizationId: ctx.organizationId, role: 'owner' },
    });
    if (owners <= 1) {
      throw ScimError(
        400,
        'invalidValue',
        `Refusing to ${action} the organization's last owner; promote another owner first`,
      );
    }
  }

  // A SCIM user is either a live membership or a deactivated tombstone. Both
  // have to be readable under the same id; only the live one grants access.
  private async findViewById(id: string, ctx: Ctx): Promise<ScimMemberView | null> {
    const member = await this.prisma.organizationMember.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: { user: true },
    });
    if (member) return this.viewFromMember(member);

    const tombstone = await this.prisma.scimDeprovisionedMember.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: { user: true },
    });
    return tombstone ? this.viewFromTombstone(tombstone) : null;
  }

  private async egressUsers(resource: any, ctx: Ctx) {
    if (resource.id) {
      const view = await this.findViewById(resource.id, ctx);
      if (!view) {
        throw ScimError(404, null, `User ${resource.id} not found`);
      }
      return this.toScimUser(view);
    }

    const [members, tombstones] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId: ctx.organizationId },
        include: { user: true },
        orderBy: { addedAt: 'asc' },
      }),
      this.prisma.scimDeprovisionedMember.findMany({
        where: { organizationId: ctx.organizationId },
        include: { user: true },
        orderBy: { deactivatedAt: 'asc' },
      }),
    ]);

    // A live membership wins over a stale tombstone for the same person — that
    // pairing only happens if someone was re-added in-app after SCIM deactivated
    // them, and the live row is the truth.
    const live = new Set(members.map((m) => m.userId));
    const mapped = [
      ...members.map((m) => this.viewFromMember(m)),
      ...tombstones.filter((t) => !live.has(t.userId)).map((t) => this.viewFromTombstone(t)),
    ].map((v) => this.toScimUser(v));

    // SCIMMY applies sort + pagination in the ListResponse, but filtering is the
    // handler's job — `resource.filter.match` evaluates the parsed expression.
    return resource.filter ? resource.filter.match(mapped) : mapped;
  }

  private async ensureUniqueUsername(base: string): Promise<string> {
    const seed = (base.split('@')[0] || 'user')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 80) || 'user';
    let candidate = seed;
    for (let i = 0; i < 6; i++) {
      const clash = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!clash) return candidate;
      candidate = `${seed}-${randomBytes(3).toString('hex')}`;
    }
    return `${seed}-${randomBytes(6).toString('hex')}`;
  }

  // Deactivate: drop the org membership so access is really gone, and park the
  // SCIM identity in a tombstone under the same id so the resource stays
  // readable and reactivatable. The global account is untouched — the person
  // may belong to other orgs.
  private async deactivate(
    view: ScimMemberView,
    externalId: string | null,
    enterprise: any,
    ctx: Ctx,
  ) {
    await this.assertNotLastOwner(view, ctx, 'deactivate');

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.delete({ where: { id: view.id } });
      await tx.scimDeprovisionedMember.upsert({
        where: {
          organizationId_userId: { organizationId: ctx.organizationId, userId: view.userId },
        },
        create: {
          id: view.id,
          organizationId: ctx.organizationId,
          userId: view.userId,
          externalId,
          enterprise,
          role: view.role as any,
        },
        update: { externalId, enterprise, role: view.role as any },
      });
    });

    void this.audit.log({
      action: 'scim.user.deactivated',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: view.userId,
      targetLabel: view.user.email,
    });

    return { ...view, active: false, lastModified: new Date(), externalId, enterprise };
  }

  // Reactivate: restore the membership under the tombstone's id (and its old
  // role, unless the write names a new one) so the IdP's resource id survives a
  // deactivate/reactivate round trip.
  private async reactivate(
    view: ScimMemberView,
    externalId: string | null,
    enterprise: any,
    role: string,
    ctx: Ctx,
  ) {
    const member = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: ctx.organizationId, userId: view.userId },
        },
        include: { user: true },
      });
      await tx.scimDeprovisionedMember.delete({ where: { id: view.id } });
      if (existing) return existing;

      return tx.organizationMember.create({
        data: {
          id: view.id,
          organizationId: ctx.organizationId,
          userId: view.userId,
          role: role as any,
          scimManaged: true,
          scimExternalId: externalId,
          scimEnterprise: enterprise,
        },
        include: { user: true },
      });
    });

    void this.audit.log({
      action: 'scim.user.reactivated',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: member.user.email,
    });

    return this.viewFromMember(member);
  }

  private async ingressUser(resource: any, instance: any, ctx: Ctx) {
    const email = this.primaryEmail(instance);

    // Replace (PUT) or PATCH-derived write targets an existing membership.
    if (resource.id) {
      const view = await this.findViewById(resource.id, ctx);
      if (!view) {
        throw ScimError(404, null, `User ${resource.id} not found`);
      }
      // externalId and the enterprise extension are SCIM's own fields on the
      // membership, so a PUT that omits them clears them — RFC 7644 §3.5.1
      // replace semantics. Name and email live on the shared user account,
      // which other orgs also read, so those stay preserve-on-omit.
      const externalId = instance.externalId ?? null;
      const enterprise = enterpriseFromInstance(instance);
      const requestedRole = roleFromInstance(instance, view.role);

      if (instance.active === false) {
        // Already deactivated — RFC 7644 writes are idempotent, so this is a
        // no-op rather than an error.
        if (!view.active) {
          return this.toScimUser({ ...view, externalId, enterprise });
        }
        return this.toScimUser(await this.deactivate(view, externalId, enterprise, ctx));
      }

      // Reactivation has to be asked for. A write that just updates a name on a
      // deactivated user must not hand back org access as a side effect, so
      // anything short of an explicit `active: true` leaves the tombstone alone.
      if (!view.active && instance.active !== true) {
        const [updated] = await Promise.all([
          this.prisma.user.update({
            where: { id: view.userId },
            data: {
              email: email ?? view.user.email,
              firstName: instance.name?.givenName ?? view.user.firstName,
              lastName: instance.name?.familyName ?? view.user.lastName,
            },
          }),
          this.prisma.scimDeprovisionedMember.update({
            where: { id: view.id },
            data: { externalId, enterprise, role: (requestedRole ?? view.role) as any },
          }),
        ]);
        return this.toScimUser({
          ...view,
          externalId,
          enterprise,
          role: requestedRole ?? view.role,
          user: updated,
        });
      }

      const target = view.active
        ? view
        : await this.reactivate(view, externalId, enterprise, requestedRole ?? view.role, ctx);

      // An omitted role means "unchanged", not "reset to member". Clearing it
      // the way replace semantics imply would silently demote every user on any
      // PUT from an IdP that doesn't map roles, which is most of them.
      const role = requestedRole ?? target.role;
      if (role !== target.role) {
        await this.assertNotLastOwner(target, ctx, 'demote');
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: target.userId },
        data: {
          email: email ?? target.user.email,
          firstName: instance.name?.givenName ?? target.user.firstName,
          lastName: instance.name?.familyName ?? target.user.lastName,
        },
      });
      const updatedMember = await this.prisma.organizationMember.update({
        where: { id: target.id },
        data: {
          scimManaged: true,
          scimExternalId: externalId,
          scimEnterprise: enterprise,
          role: role as any,
        },
        include: { user: true },
      });

      if (role !== view.role) {
        void this.audit.log({
          action: 'scim.user.role_changed',
          organizationId: ctx.organizationId,
          targetType: 'user',
          targetId: target.userId,
          targetLabel: `${updatedUser.email}: ${view.role} -> ${role}`,
        });
      }

      return this.toScimUser(this.viewFromMember({ ...updatedMember, user: updatedUser }));
    }

    // Create (POST).
    if (!email) {
      throw ScimError(400, 'invalidValue', 'A primary email or email-shaped userName is required');
    }

    const externalId = instance.externalId ?? null;
    const enterprise = enterpriseFromInstance(instance);
    const role = roleFromInstance(instance) ?? DEFAULT_ROLE;
    const existingUser = await this.prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      const member = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: ctx.organizationId, userId: existingUser.id },
        },
      });
      // RFC 7644 §3.3: creating a resource that already exists is a conflict,
      // not a silent update. IdPs branch on this to switch to PUT/PATCH.
      if (member) {
        throw ScimError(409, 'uniqueness', `User ${email} is already provisioned`);
      }

      // Re-adding someone the IdP previously deactivated: revive the tombstone
      // so the SCIM id the IdP already knows keeps working.
      const tombstone = await this.prisma.scimDeprovisionedMember.findUnique({
        where: {
          organizationId_userId: { organizationId: ctx.organizationId, userId: existingUser.id },
        },
        include: { user: true },
      });
      if (tombstone) {
        const revived = await this.reactivate(
          this.viewFromTombstone(tombstone),
          externalId,
          enterprise,
          roleFromInstance(instance, tombstone.role) ?? tombstone.role,
          ctx,
        );
        return this.toScimUser(revived);
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user =
        existingUser ??
        (await tx.user.create({
          data: {
            email,
            username: await this.ensureUniqueUsername(email),
            firstName: instance.name?.givenName ?? null,
            lastName: instance.name?.familyName ?? null,
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        }));

      return tx.organizationMember.create({
        data: {
          organizationId: ctx.organizationId,
          userId: user.id,
          role: role as any,
          scimManaged: true,
          scimExternalId: externalId,
          scimEnterprise: enterprise,
        },
        include: { user: true },
      });
    });

    void this.audit.log({
      action: 'scim.user.provisioned',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: result.userId,
      targetLabel: `${result.user.email} as ${role}`,
    });

    return this.toScimUser(this.viewFromMember(result));
  }

  private async degressUser(resource: any, ctx: Ctx) {
    if (!resource.id) {
      throw ScimError(400, 'invalidValue', 'DELETE requires a resource id');
    }
    const view = await this.findViewById(resource.id, ctx);
    if (!view) {
      throw ScimError(404, null, `User ${resource.id} not found`);
    }

    await this.assertNotLastOwner(view, ctx, 'delete');

    // DELETE is the real removal: clear the membership and the tombstone, so
    // the id stops resolving entirely.
    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.deleteMany({
        where: { id: view.id, organizationId: ctx.organizationId },
      });
      await tx.scimDeprovisionedMember.deleteMany({
        where: { organizationId: ctx.organizationId, userId: view.userId },
      });
    });

    void this.audit.log({
      action: 'scim.user.deprovisioned',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: view.userId,
      targetLabel: view.user.email,
    });
  }

  // ---- Groups (read-only role projection) --------------------------------

  private async egressGroups(resource: any, ctx: Ctx) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: true },
    });

    const build = (role: string) => ({
      id: `role:${role}`,
      displayName: groupDisplayName(role),
      members: members
        .filter((m) => m.role === role)
        .map((m) => ({ value: m.id, display: m.user.email, type: 'User' })),
      meta: { resourceType: 'Group' },
    });

    if (resource.id) {
      const role = String(resource.id).replace(/^role:/, '');
      if (!ROLE_GROUPS.includes(role as any)) {
        throw ScimError(404, null, `Group ${resource.id} not found`);
      }
      return build(role);
    }

    const groups = ROLE_GROUPS.map(build);
    return resource.filter ? resource.filter.match(groups) : groups;
  }

  // ---- Protocol entry points used by the controller ----------------------

  async listUsers(query: ScimQuery, ctx: Ctx) {
    return new SCIMMY.Resources.User(query).read(ctx);
  }

  async getUser(id: string, query: ScimQuery, ctx: Ctx) {
    return new SCIMMY.Resources.User(id, query).read(ctx);
  }

  async createUser(body: any, ctx: Ctx) {
    return new SCIMMY.Resources.User().write(body, ctx);
  }

  async replaceUser(id: string, body: any, ctx: Ctx) {
    return new SCIMMY.Resources.User(id).write(body, ctx);
  }

  async patchUser(id: string, body: any, ctx: Ctx) {
    return new SCIMMY.Resources.User(id).patch(body, ctx);
  }

  async deleteUser(id: string, ctx: Ctx) {
    return new SCIMMY.Resources.User(id).dispose(ctx);
  }

  async listGroups(query: ScimQuery, ctx: Ctx) {
    return new SCIMMY.Resources.Group(query).read(ctx);
  }

  async getGroup(id: string, query: ScimQuery, ctx: Ctx) {
    return new SCIMMY.Resources.Group(id, query).read(ctx);
  }

  async serviceProviderConfig() {
    return new SCIMMY.Resources.ServiceProviderConfig().read();
  }

  async resourceTypes(id?: string) {
    return new SCIMMY.Resources.ResourceType(id).read();
  }

  async schemas(id?: string) {
    return new SCIMMY.Resources.Schema(id).read();
  }
}

export { ScimQuery };
