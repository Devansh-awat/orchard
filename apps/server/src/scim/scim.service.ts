import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import SCIMMY from 'scimmy';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { IdentityMappingService } from '../sso/identity-mapping.service';
import { ScimError } from './scim-error';
import { ScimGroupsService } from './scim-groups.service';
import { ScimQuery, SCIM_MAX_RESULTS } from './scim-query';

interface Ctx {
  organizationId: string;
}

// Normalized shape both a live membership and a deactivated tombstone reduce
// to, so the SCIM projection has one code path.
interface ScimMemberView {
  id: string;
  userId: string;
  externalId: string | null;
  role: string;
  enterprise: any;
  userName: string;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  active: boolean;
  created: Date;
  lastModified: Date;
  user: any;
}

// The attributes SCIM owns outright, all of them on the membership. Assembled
// once per write so replace semantics are applied in exactly one place.
interface ScimWrite {
  externalId: string | null;
  enterprise: any;
  userName: string;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
}

const SCIM_BASEPATH = '/apiv1/scim/v2';

const ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

// The org roles SCIM Groups project onto, and the set an IdP may provision
// into via `roles` / `userType`.
const ROLE_GROUPS = ['owner', 'admin', 'member', 'guest'] as const;
const PROVISIONABLE_ROLES = ['admin', 'member', 'guest'] as const;

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
      `Unknown role "${raw}"; expected one of ${ROLE_GROUPS.join(', ')}`
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
// touch still echoes the role we last sent it, and a pathless `replace` on a
// multi-valued attribute *appends*, leaving the old role sitting in front of
// the new one in `roles`. Either way the value that already matches the current
// role carries no instruction, and the one that differs is the request.
function roleFromInstance(instance: any, currentRole?: string | null): string | null {
  const roles = Array.isArray(instance?.roles) ? instance.roles : [];
  // Primary first, so the fallback picks the preferred value when nothing changed.
  const ordered = [...roles].sort((a, b) => Number(!!b?.primary) - Number(!!a?.primary));
  const candidates = [
    ...ordered.map((r: any) => normalizeRole(r?.value)),
    normalizeRole(instance?.userType)
  ].filter((r): r is string => r !== null);

  if (!candidates.length) return null;
  const chosen = candidates.find((r) => r !== currentRole) ?? candidates[0];
  if (chosen === 'owner' && currentRole !== 'owner') {
    throw ScimError(
      400,
      'invalidValue',
      `An identity provider can't grant owner; expected one of ${PROVISIONABLE_ROLES.join(', ')}`
    );
  }
  return chosen;
}

// RFC 7644 §3.5.1: a PUT replaces the resource, so an attribute the client
// omitted is cleared. Safe to do literally here because these live on the
// membership, not on the account the user shares with other orgs.
function profileFromInstance(instance: any, fallbackUserName: string) {
  const trim = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    // userName is required by the schema, so an absent one means "unchanged"
    // rather than "clear": there's no valid empty state to replace it with.
    userName: trim(instance?.userName)?.toLowerCase() ?? fallbackUserName,
    givenName: trim(instance?.name?.givenName),
    familyName: trim(instance?.name?.familyName),
    displayName: trim(instance?.displayName)
  };
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
    private readonly email: EmailService,
    private readonly rateLimit: RateLimitService,
    @Optional() private readonly membershipCache?: MembershipCacheService,
    @Optional() private readonly groups?: ScimGroupsService,
    @Optional() private readonly mapping?: IdentityMappingService
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
      SCIMMY.Resources.ServiceProviderConfig
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
          description: 'Authentication via the SCIM bearer token from Organization settings.'
        }
      ]
    });

    // Optional (not required) so an IdP that never sends it still validates.
    SCIMMY.Resources.User.extend(SCIMMY.Schemas.EnterpriseUser, false);

    SCIMMY.Resources.User.ingress((resource, instance, ctx: Ctx) =>
      this.ingressUser(resource, instance, ctx)
    )
      .egress((resource, ctx: Ctx) => this.egressUsers(resource, ctx))
      .degress((resource, ctx: Ctx) => this.degressUser(resource, ctx));

    SCIMMY.Resources.Group.ingress((resource, instance, ctx: Ctx) =>
      this.groupsOrFail().ingress(resource, instance, ctx)
    )
      .egress((resource, ctx: Ctx) =>
        this.groups ? this.groups.egress(resource, ctx) : this.egressGroups(resource, ctx)
      )
      .degress((resource, ctx: Ctx) => this.groupsOrFail().degress(resource, ctx));

    SCIMMY.Resources.declare(SCIMMY.Resources.User);
    SCIMMY.Resources.declare(SCIMMY.Resources.Group);
  }

  private groupsOrFail(): ScimGroupsService {
    if (!this.groups) throw ScimError(501, null, 'Group provisioning is not available');
    return this.groups;
  }

  private async revokeAccess(organizationId: string, userId: string) {
    this.membershipCache?.revoked(organizationId, userId);
    await this.mapping?.revoke(organizationId, userId);
  }

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
    scimManaged?: boolean;
    scimUserName?: string | null;
    scimGivenName?: string | null;
    scimFamilyName?: string | null;
    scimDisplayName?: string | null;
    addedAt: Date;
    userId: string;
    user: any;
  }): ScimMemberView {
    // A membership added in-app has no IdP profile of its own, so it reads
    // through to the account. Once SCIM owns it, the per-org profile is the
    // whole truth: that's what makes replace-on-omit safe.
    const owned = member.scimManaged === true;
    return {
      id: member.id,
      userId: member.userId,
      externalId: member.scimExternalId,
      role: member.role,
      enterprise: member.scimEnterprise ?? null,
      userName: (owned ? member.scimUserName : null) ?? member.user?.email,
      givenName: owned ? (member.scimGivenName ?? null) : (member.user?.firstName ?? null),
      familyName: owned ? (member.scimFamilyName ?? null) : (member.user?.lastName ?? null),
      displayName: owned ? (member.scimDisplayName ?? null) : null,
      active: true,
      created: member.addedAt,
      lastModified: member.addedAt,
      user: member.user
    };
  }

  private viewFromTombstone(row: {
    id: string;
    role: string;
    externalId: string | null;
    enterprise?: any;
    userName?: string | null;
    givenName?: string | null;
    familyName?: string | null;
    displayName?: string | null;
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
      userName: row.userName ?? row.user?.email,
      givenName: row.givenName ?? null,
      familyName: row.familyName ?? null,
      displayName: row.displayName ?? null,
      active: false,
      created: row.deactivatedAt,
      lastModified: row.deactivatedAt,
      user: row.user
    };
  }

  private toScimUser(view: ScimMemberView) {
    const { user } = view;
    const fullName = [view.givenName, view.familyName].filter(Boolean).join(' ');
    return {
      id: view.id,
      ...(view.externalId ? { externalId: view.externalId } : {}),
      userName: view.userName,
      name: {
        givenName: view.givenName ?? undefined,
        familyName: view.familyName ?? undefined
      },
      displayName: view.displayName || fullName || user.username || view.userName,
      emails: [{ value: view.userName, primary: true, type: 'work' }],
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
        lastModified: view.lastModified
      }
    };
  }

  // An org with no owner can't be administered back into shape, so SCIM is not
  // allowed to remove the last one, by deactivation, deletion, or demotion.
  private async assertNotLastOwner(view: ScimMemberView, ctx: Ctx, action: string) {
    if (view.role !== 'owner') return;
    const owners = await this.prisma.organizationMember.count({
      where: { organizationId: ctx.organizationId, role: 'owner' }
    });
    if (owners <= 1) {
      throw ScimError(
        400,
        'invalidValue',
        `Refusing to ${action} the organization's last owner; promote another owner first`
      );
    }
  }

  // A SCIM user is either a live membership or a deactivated tombstone. Both
  // have to be readable under the same id; only the live one grants access.
  private async findViewById(id: string, ctx: Ctx): Promise<ScimMemberView | null> {
    const member = await this.prisma.organizationMember.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: { user: true }
    });
    if (member) return this.viewFromMember(member);

    const tombstone = await this.prisma.scimDeprovisionedMember.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: { user: true }
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
        orderBy: { addedAt: 'asc' }
      }),
      this.prisma.scimDeprovisionedMember.findMany({
        where: { organizationId: ctx.organizationId },
        include: { user: true },
        orderBy: { deactivatedAt: 'asc' }
      })
    ]);

    // A live membership wins over a stale tombstone for the same person: that
    // pairing only happens if someone was re-added in-app after SCIM deactivated
    // them, and the live row is the truth.
    const live = new Set(members.map((m) => m.userId));
    const mapped = [
      ...members.map((m) => this.viewFromMember(m)),
      ...tombstones.filter((t) => !live.has(t.userId)).map((t) => this.viewFromTombstone(t))
    ].map((v) => this.toScimUser(v));

    // SCIMMY applies sort + pagination in the ListResponse, but filtering is the
    // handler's job: `resource.filter.match` evaluates the parsed expression.
    return resource.filter ? resource.filter.match(mapped) : mapped;
  }

  private async ensureUniqueUsername(base: string): Promise<string> {
    const seed =
      (base.split('@')[0] || 'user')
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
  // readable and reactivatable. The global account is untouched: the person
  // may belong to other orgs.
  private async notifyAdded(email: string, name: string, organizationId: string) {
    try {
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, createdAt: true }
      });
      if (!organization) return;
      await this.rateLimit.checkInviteMail({
        email,
        organizationId,
        organizationCreatedAt: organization.createdAt
      });
      await this.email.sendOrganizationAddedEmail({
        recipientEmail: email,
        recipientName: name,
        organizationName: organization.name
      });
    } catch (err) {
      this.logger.warn(`Skipped the added-to-organization email: ${(err as Error).message}`);
    }
  }

  private async deactivate(view: ScimMemberView, write: ScimWrite, ctx: Ctx) {
    await this.assertNotLastOwner(view, ctx, 'deactivate');

    const fields = { ...write, role: view.role as any };

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.delete({ where: { id: view.id } });
      await tx.scimDeprovisionedMember.upsert({
        where: {
          organizationId_userId: { organizationId: ctx.organizationId, userId: view.userId }
        },
        create: {
          id: view.id,
          organizationId: ctx.organizationId,
          userId: view.userId,
          ...fields
        },
        update: fields
      });
    });
    await this.revokeAccess(ctx.organizationId, view.userId);

    void this.audit.log({
      action: 'scim.user.deactivated',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: view.userId,
      targetLabel: view.user.email
    });

    return { ...view, ...write, active: false, lastModified: new Date() };
  }

  // Reactivate: restore the membership under the tombstone's id (and its old
  // role, unless the write names a new one) so the IdP's resource id survives a
  // deactivate/reactivate round trip.
  private async reactivate(view: ScimMemberView, write: ScimWrite, role: string, ctx: Ctx) {
    const member = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: ctx.organizationId, userId: view.userId }
        },
        include: { user: true }
      });
      await tx.scimDeprovisionedMember.delete({ where: { id: view.id } });
      if (existing) return existing;

      return tx.organizationMember.create({
        data: {
          id: view.id,
          organizationId: ctx.organizationId,
          userId: view.userId,
          role: (role === 'owner' ? 'admin' : role) as any,
          scimManaged: true,
          scimExternalId: write.externalId,
          scimEnterprise: write.enterprise,
          scimGivenName: write.givenName,
          scimFamilyName: write.familyName,
          scimDisplayName: write.displayName
        },
        include: { user: true }
      });
    });

    void this.audit.log({
      action: 'scim.user.reactivated',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: member.user.email
    });

    await this.groups?.regrant(ctx.organizationId, member.userId);
    const refreshed = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: ctx.organizationId, userId: member.userId }
      },
      include: { user: true }
    });
    return this.viewFromMember(refreshed ?? member);
  }

  private async ingressUser(resource: any, instance: any, ctx: Ctx) {
    const email = this.primaryEmail(instance);

    // Replace (PUT) or PATCH-derived write targets an existing membership.
    if (resource.id) {
      const view = await this.findViewById(resource.id, ctx);
      if (!view) {
        throw ScimError(404, null, `User ${resource.id} not found`);
      }
      // Everything SCIM owns lives on the membership, so a PUT that omits any
      // of it clears it: RFC 7644 §3.5.1 replace semantics, applied literally.
      // Nothing here touches the shared account.
      const write: ScimWrite = {
        externalId: instance.externalId ?? null,
        enterprise: enterpriseFromInstance(instance),
        ...profileFromInstance(instance, email ?? view.userName)
      };
      const requestedRole = roleFromInstance(instance, view.role);

      if (instance.active === false) {
        // Already deactivated: RFC 7644 writes are idempotent, so this is a
        // no-op rather than an error.
        if (!view.active) {
          return this.toScimUser({ ...view, ...write });
        }
        return this.toScimUser(await this.deactivate(view, write, ctx));
      }

      // Reactivation has to be asked for. A write that just updates a name on a
      // deactivated user must not hand back org access as a side effect, so
      // anything short of an explicit `active: true` leaves the tombstone alone.
      if (!view.active && instance.active !== true) {
        await this.prisma.scimDeprovisionedMember.update({
          where: { id: view.id },
          data: { ...write, role: (requestedRole ?? view.role) as any }
        });
        return this.toScimUser({ ...view, ...write, role: requestedRole ?? view.role });
      }

      const target = view.active
        ? view
        : await this.reactivate(view, write, requestedRole ?? view.role, ctx);

      // An omitted role means "unchanged", not "reset to member". Clearing it
      // the way replace semantics imply would silently demote every user on any
      // PUT from an IdP that doesn't map roles, which is most of them.
      const role =
        requestedRole === 'owner' && target.role !== 'owner'
          ? target.role
          : (requestedRole ?? target.role);
      if (role !== target.role) {
        await this.assertNotLastOwner(target, ctx, 'demote');
      }

      const updatedMember = await this.prisma.organizationMember.update({
        where: { id: target.id },
        data: {
          scimManaged: true,
          scimExternalId: write.externalId,
          scimEnterprise: write.enterprise,
          scimUserName: write.userName,
          scimGivenName: write.givenName,
          scimFamilyName: write.familyName,
          scimDisplayName: write.displayName,
          role: role as any
        },
        include: { user: true }
      });

      if (role !== view.role) {
        void this.audit.log({
          action: 'scim.user.role_changed',
          organizationId: ctx.organizationId,
          targetType: 'user',
          targetId: target.userId,
          targetLabel: `${write.userName}: ${view.role} -> ${role}`
        });
      }

      return this.toScimUser(this.viewFromMember(updatedMember));
    }

    // Create (POST).
    if (!email) {
      throw ScimError(400, 'invalidValue', 'A primary email or email-shaped userName is required');
    }

    const write: ScimWrite = {
      externalId: instance.externalId ?? null,
      enterprise: enterpriseFromInstance(instance),
      ...profileFromInstance(instance, email)
    };
    const role = roleFromInstance(instance) ?? DEFAULT_ROLE;
    const existingUser = await this.prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      const member = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: ctx.organizationId, userId: existingUser.id }
        }
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
          organizationId_userId: { organizationId: ctx.organizationId, userId: existingUser.id }
        },
        include: { user: true }
      });
      if (tombstone) {
        const revived = await this.reactivate(
          this.viewFromTombstone(tombstone),
          write,
          roleFromInstance(instance, tombstone.role) ?? tombstone.role,
          ctx
        );
        return this.toScimUser(revived);
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Creating the account is the one and only time SCIM writes to `users`.
      // An account that already exists is linked as-is: this org's IdP has no
      // business editing a profile that other orgs also see.
      const user =
        existingUser ??
        (await tx.user.create({
          data: {
            email,
            username: await this.ensureUniqueUsername(email),
            firstName: write.givenName,
            lastName: write.familyName,
            emailVerified: false,
            emailVerifiedAt: null
          }
        }));

      return tx.organizationMember.create({
        data: {
          organizationId: ctx.organizationId,
          userId: user.id,
          role: role as any,
          scimManaged: true,
          scimExternalId: write.externalId,
          scimEnterprise: write.enterprise,
          scimUserName: write.userName,
          scimGivenName: write.givenName,
          scimFamilyName: write.familyName,
          scimDisplayName: write.displayName
        },
        include: { user: true }
      });
    });

    void this.audit.log({
      action: 'scim.user.provisioned',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: result.userId,
      targetLabel: `${result.user.email} as ${role}`
    });

    await this.notifyAdded(
      result.user.email,
      result.user.firstName || result.user.username || result.user.email,
      ctx.organizationId
    );

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
        where: { id: view.id, organizationId: ctx.organizationId }
      });
      await tx.scimDeprovisionedMember.deleteMany({
        where: { organizationId: ctx.organizationId, userId: view.userId }
      });
    });
    await this.groups?.dropUser(ctx.organizationId, view.userId);
    await this.revokeAccess(ctx.organizationId, view.userId);

    void this.audit.log({
      action: 'scim.user.deprovisioned',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: view.userId,
      targetLabel: view.user.email
    });
  }

  private async egressGroups(resource: any, ctx: Ctx) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: true }
    });

    const build = (role: string) => ({
      id: `role:${role}`,
      displayName: groupDisplayName(role),
      members: members
        .filter((m) => m.role === role)
        .map((m) => ({ value: m.id, display: m.user.email, type: 'User' })),
      meta: { resourceType: 'Group' }
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

  async listUsers(query: ScimQuery, ctx: Ctx) {
    return new SCIMMY.Resources.User(query as any).read(ctx);
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
    return new SCIMMY.Resources.Group(query as any).read(ctx);
  }

  async getGroup(id: string, query: ScimQuery, ctx: Ctx) {
    return new SCIMMY.Resources.Group(id, query).read(ctx);
  }

  async createGroup(body: any, ctx: Ctx) {
    return new SCIMMY.Resources.Group().write(body, ctx);
  }

  async replaceGroup(id: string, body: any, ctx: Ctx) {
    return new SCIMMY.Resources.Group(id).write(body, ctx);
  }

  async patchGroup(id: string, body: any, ctx: Ctx) {
    return new SCIMMY.Resources.Group(id).patch(body, ctx);
  }

  async deleteGroup(id: string, ctx: Ctx) {
    return new SCIMMY.Resources.Group(id).dispose(ctx);
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
