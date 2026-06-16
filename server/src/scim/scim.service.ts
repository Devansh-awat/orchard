import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import SCIMMY from 'scimmy';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

type Ctx = { organizationId: string };

const SCIM_BASEPATH = '/apiv1/scim/v2';

// The org roles SCIM Groups project onto. Group membership is read-only for
// now (see egressGroups); role changes are made in-app.
const ROLE_GROUPS = ['owner', 'admin', 'member', 'guest'] as const;

function ScimError(status: number, scimType: string | null, detail: string) {
  return new SCIMMY.Types.Error(status, scimType as any, detail);
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
      filter: { supported: true, maxResults: 200 },
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

    SCIMMY.Resources.User
      .ingress((resource, instance, ctx: Ctx) => this.ingressUser(resource, instance, ctx))
      .egress((resource, ctx: Ctx) => this.egressUsers(resource, ctx))
      .degress((resource, ctx: Ctx) => this.degressUser(resource, ctx));

    SCIMMY.Resources.Group
      .ingress(() => {
        throw ScimError(400, 'invalidValue', 'Group provisioning is read-only; manage roles in-app');
      })
      .egress((resource, ctx: Ctx) => this.egressGroups(resource, ctx))
      .degress(() => {
        throw ScimError(400, 'invalidValue', 'Group provisioning is read-only; manage roles in-app');
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

  private memberToScimUser(member: { id: string; scimExternalId: string | null; addedAt: Date }, user: any) {
    return {
      id: member.id,
      ...(member.scimExternalId ? { externalId: member.scimExternalId } : {}),
      userName: user.email,
      name: {
        givenName: user.firstName ?? undefined,
        familyName: user.lastName ?? undefined,
      },
      displayName:
        [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.email,
      emails: [{ value: user.email, primary: true, type: 'work' }],
      active: true,
      meta: {
        resourceType: 'User',
        created: member.addedAt,
        lastModified: member.addedAt,
      },
    };
  }

  private async egressUsers(resource: any, ctx: Ctx) {
    if (resource.id) {
      const member = await this.prisma.organizationMember.findFirst({
        where: { id: resource.id, organizationId: ctx.organizationId },
        include: { user: true },
      });
      if (!member) {
        throw ScimError(404, null, `User ${resource.id} not found`);
      }
      return this.memberToScimUser(member, member.user);
    }

    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: true },
      orderBy: { addedAt: 'asc' },
    });
    const mapped = members.map((m) => this.memberToScimUser(m, m.user));
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

  private async ingressUser(resource: any, instance: any, ctx: Ctx) {
    const email = this.primaryEmail(instance);

    // Replace (PUT) or PATCH-derived write targets an existing membership.
    if (resource.id) {
      const member = await this.prisma.organizationMember.findFirst({
        where: { id: resource.id, organizationId: ctx.organizationId },
        include: { user: true },
      });
      if (!member) {
        throw ScimError(404, null, `User ${resource.id} not found`);
      }

      // Deprovision: drop the org membership, keep the global account so the
      // same person can be re-provisioned (or stay a member of other orgs).
      if (instance.active === false) {
        await this.prisma.organizationMember.delete({ where: { id: member.id } });
        void this.audit.log({
          action: 'scim.user.deactivated',
          organizationId: ctx.organizationId,
          targetType: 'user',
          targetId: member.userId,
          targetLabel: member.user.email,
        });
        return {
          ...this.memberToScimUser(member, member.user),
          active: false,
        };
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: member.userId },
        data: {
          email: email ?? member.user.email,
          firstName: instance.name?.givenName ?? member.user.firstName,
          lastName: instance.name?.familyName ?? member.user.lastName,
        },
      });
      const updatedMember = await this.prisma.organizationMember.update({
        where: { id: member.id },
        data: {
          scimManaged: true,
          scimExternalId: instance.externalId ?? member.scimExternalId,
        },
      });
      return this.memberToScimUser(updatedMember, updatedUser);
    }

    // Create (POST).
    if (!email) {
      throw ScimError(400, 'invalidValue', 'A primary email or email-shaped userName is required');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email } });
      if (!user) {
        user = await tx.user.create({
          data: {
            email,
            username: await this.ensureUniqueUsername(email),
            firstName: instance.name?.givenName ?? null,
            lastName: instance.name?.familyName ?? null,
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });
      }

      const member = await tx.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: ctx.organizationId, userId: user.id } },
        create: {
          organizationId: ctx.organizationId,
          userId: user.id,
          role: 'member',
          scimManaged: true,
          scimExternalId: instance.externalId ?? null,
        },
        update: {
          scimManaged: true,
          scimExternalId: instance.externalId ?? null,
        },
        include: { user: true },
      });
      return member;
    });

    void this.audit.log({
      action: 'scim.user.provisioned',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: result.userId,
      targetLabel: result.user.email,
    });

    return this.memberToScimUser(result, result.user);
  }

  private async degressUser(resource: any, ctx: Ctx) {
    if (!resource.id) {
      throw ScimError(400, 'invalidValue', 'DELETE requires a resource id');
    }
    const member = await this.prisma.organizationMember.findFirst({
      where: { id: resource.id, organizationId: ctx.organizationId },
      include: { user: true },
    });
    if (!member) {
      throw ScimError(404, null, `User ${resource.id} not found`);
    }
    await this.prisma.organizationMember.delete({ where: { id: member.id } });
    void this.audit.log({
      action: 'scim.user.deprovisioned',
      organizationId: ctx.organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: member.user.email,
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
      displayName: role.charAt(0).toUpperCase() + role.slice(1),
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

export type ScimQuery = {
  filter?: string;
  attributes?: string;
  excludedAttributes?: string;
  sortBy?: string;
  sortOrder?: string;
  startIndex?: number;
  count?: number;
};
