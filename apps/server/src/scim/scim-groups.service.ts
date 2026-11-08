import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { IdentityMappingService } from '../sso/identity-mapping.service';
import { normalizeGroup } from '../sso/group-rules';
import { ScimError } from './scim-error';

interface Ctx {
  organizationId: string;
}

export const ROLE_GROUP_PREFIX = 'role:';
export const MAX_SCIM_GROUPS_PER_ORG = 1000;
export const MAX_SCIM_GROUP_MEMBERS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRoleGroupId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(ROLE_GROUP_PREFIX);
}

function readOnlyRoleGroup(): never {
  throw ScimError(
    400,
    'mutability',
    'Role groups are a read-only projection of organization roles; create a group of your own and map it to a role in the identity provider rules'
  );
}

function displayNameOf(instance: any): string {
  const name = normalizeGroup(instance?.displayName);
  if (!name) {
    throw ScimError(
      400,
      'invalidValue',
      'displayName is required: 1-256 characters with no control or invisible characters'
    );
  }
  return name;
}

@Injectable()
export class ScimGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mapping: IdentityMappingService
  ) {}

  private async directory(organizationId: string) {
    const [members, tombstones] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId },
        include: { user: true }
      }),
      this.prisma.scimDeprovisionedMember.findMany({
        where: { organizationId },
        include: { user: true }
      })
    ]);
    const live = new Set<string>(members.map((m: any) => m.userId));
    const byUser = new Map<string, { id: string; email: string }>();
    for (const t of tombstones) {
      if (!live.has(t.userId)) byUser.set(t.userId, { id: t.id, email: t.user?.email });
    }
    for (const m of members) byUser.set(m.userId, { id: m.id, email: m.user?.email });
    return byUser;
  }

  async egress(resource: any, ctx: Ctx) {
    const byUser = await this.directory(ctx.organizationId);
    const roleGroups = await this.roleProjection(ctx.organizationId);

    if (resource.id) {
      if (isRoleGroupId(resource.id)) {
        const found = roleGroups.find((g) => g.id === resource.id);
        if (!found) throw ScimError(404, null, `Group ${resource.id} not found`);
        return found;
      }
      if (!UUID.test(String(resource.id))) {
        throw ScimError(404, null, `Group ${resource.id} not found`);
      }
      const group = await this.prisma.scimGroup.findFirst({
        where: { id: resource.id, organizationId: ctx.organizationId }
      });
      if (!group) throw ScimError(404, null, `Group ${resource.id} not found`);
      const links = await this.prisma.scimGroupMember.findMany({
        where: { groupId: group.id, organizationId: ctx.organizationId }
      });
      return this.project(group, links, byUser);
    }

    const groups = await this.prisma.scimGroup.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: 'asc' }
    });
    const links = groups.length
      ? await this.prisma.scimGroupMember.findMany({
          where: { organizationId: ctx.organizationId }
        })
      : [];
    const custom = groups.map((g: any) =>
      this.project(
        g,
        links.filter((l: any) => l.groupId === g.id),
        byUser
      )
    );
    const all = [...roleGroups, ...custom];
    return resource.filter ? resource.filter.match(all) : all;
  }

  private async roleProjection(organizationId: string) {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId },
      include: { user: true }
    });
    return ['owner', 'admin', 'member', 'guest'].map((role) => ({
      id: `${ROLE_GROUP_PREFIX}${role}`,
      displayName: role.charAt(0).toUpperCase() + role.slice(1),
      members: members
        .filter((m: any) => m.role === role)
        .map((m: any) => ({ value: m.id, display: m.user.email, type: 'User' })),
      meta: { resourceType: 'Group' }
    }));
  }

  private project(
    group: any,
    links: Array<{ userId: string }>,
    byUser: Map<string, { id: string; email: string }>
  ) {
    return {
      id: group.id,
      ...(group.externalId ? { externalId: group.externalId } : {}),
      displayName: group.displayName,
      members: links
        .map((l) => byUser.get(l.userId))
        .filter((m): m is { id: string; email: string } => Boolean(m))
        .map((m) => ({ value: m.id, display: m.email, type: 'User' })),
      meta: {
        resourceType: 'Group',
        created: group.createdAt,
        lastModified: group.updatedAt
      }
    };
  }

  private async resolveMembers(instance: any, ctx: Ctx): Promise<string[]> {
    const raw = Array.isArray(instance?.members) ? instance.members : [];
    if (raw.length > MAX_SCIM_GROUP_MEMBERS) {
      throw ScimError(
        400,
        'invalidValue',
        `A group can hold at most ${MAX_SCIM_GROUP_MEMBERS} members`
      );
    }
    const ids = new Set<string>();
    for (const m of raw) {
      const value = typeof m?.value === 'string' ? m.value.trim() : '';
      if (!UUID.test(value)) {
        throw ScimError(
          400,
          'invalidValue',
          `Group member "${m?.value}" is not a user of this directory`
        );
      }
      ids.add(value);
    }
    if (ids.size === 0) return [];
    const wanted = [...ids];
    const [members, tombstones] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId: ctx.organizationId, id: { in: wanted } },
        select: { id: true, userId: true }
      }),
      this.prisma.scimDeprovisionedMember.findMany({
        where: { organizationId: ctx.organizationId, id: { in: wanted } },
        select: { id: true, userId: true }
      })
    ]);
    const known = new Map<string, string>();
    for (const row of [...tombstones, ...members]) known.set(row.id, row.userId);
    for (const id of wanted) {
      if (!known.has(id)) {
        throw ScimError(
          400,
          'invalidValue',
          `Group member "${id}" is not a user of this directory`
        );
      }
    }
    return [...new Set(wanted.map((id) => known.get(id)!))];
  }

  private async namesFor(
    organizationId: string,
    userIds: string[]
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>(userIds.map((u) => [u, new Set<string>()]));
    if (userIds.length === 0) return out;
    const links = await this.prisma.scimGroupMember.findMany({
      where: { organizationId, userId: { in: userIds } }
    });
    if (links.length === 0) return out;
    const groups = await this.prisma.scimGroup.findMany({ where: { organizationId } });
    const names = new Map<string, string>(groups.map((g: any) => [g.id, g.displayName]));
    for (const link of links) {
      const name = normalizeGroup(names.get(link.groupId));
      if (name) out.get(link.userId)?.add(name);
    }
    return out;
  }

  private async propagate(
    organizationId: string,
    userIds: string[],
    before: Map<string, Set<string>>
  ): Promise<number> {
    const after = await this.namesFor(organizationId, userIds);
    return this.mapping.syncDirectoryChanges(
      organizationId,
      userIds.map((userId) => ({
        userId,
        before: before.get(userId) ?? new Set<string>(),
        after: after.get(userId) ?? new Set<string>()
      }))
    );
  }

  async ingress(resource: any, instance: any, ctx: Ctx) {
    if (isRoleGroupId(resource.id)) readOnlyRoleGroup();

    const displayName = displayNameOf(instance);
    const wanted = await this.resolveMembers(instance, ctx);
    const externalId =
      typeof instance?.externalId === 'string' && instance.externalId.trim()
        ? instance.externalId.trim().slice(0, 255)
        : null;

    let existing: any = null;
    let previous: string[] = [];
    if (resource.id) {
      if (!UUID.test(String(resource.id))) {
        throw ScimError(404, null, `Group ${resource.id} not found`);
      }
      existing = await this.prisma.scimGroup.findFirst({
        where: { id: resource.id, organizationId: ctx.organizationId }
      });
      if (!existing) throw ScimError(404, null, `Group ${resource.id} not found`);
      const links = await this.prisma.scimGroupMember.findMany({
        where: { groupId: existing.id, organizationId: ctx.organizationId }
      });
      previous = links.map((l: any) => l.userId);
    } else {
      const count = await this.prisma.scimGroup.count({
        where: { organizationId: ctx.organizationId }
      });
      if (count >= MAX_SCIM_GROUPS_PER_ORG) {
        throw ScimError(
          400,
          'invalidValue',
          `An organization can hold at most ${MAX_SCIM_GROUPS_PER_ORG} groups`
        );
      }
    }

    const clash = await this.prisma.scimGroup.findFirst({
      where: { organizationId: ctx.organizationId, displayName }
    });
    if (clash && clash.id !== existing?.id) {
      throw ScimError(409, 'uniqueness', `A group named "${displayName}" already exists`);
    }

    const affected = [...new Set([...previous, ...wanted])];
    const before = await this.namesFor(ctx.organizationId, affected);

    const saved: any = await this.prisma
      .$transaction(async (tx: any) => {
        const group = existing
          ? await tx.scimGroup.update({
              where: { id: existing.id },
              data: { displayName, externalId }
            })
          : await tx.scimGroup.create({
              data: { organizationId: ctx.organizationId, displayName, externalId }
            });
        const drop = previous.filter((u) => !wanted.includes(u));
        if (drop.length) {
          await tx.scimGroupMember.deleteMany({
            where: { groupId: group.id, organizationId: ctx.organizationId, userId: { in: drop } }
          });
        }
        for (const userId of wanted.filter((u) => !previous.includes(u))) {
          await tx.scimGroupMember.create({
            data: { groupId: group.id, organizationId: ctx.organizationId, userId }
          });
        }
        return group;
      })
      .catch((err: any) => {
        if (err?.code === 'P2002') {
          throw ScimError(409, 'uniqueness', `A group named "${displayName}" already exists`);
        }
        throw err;
      });

    const synced = await this.propagate(ctx.organizationId, affected, before);

    void this.audit.log({
      action: existing ? 'scim.group.updated' : 'scim.group.created',
      organizationId: ctx.organizationId,
      targetType: 'scim_group',
      targetId: saved.id,
      targetLabel: displayName,
      metadata: {
        members: wanted.length,
        added: wanted.filter((u) => !previous.includes(u)).length,
        removed: previous.filter((u) => !wanted.includes(u)).length,
        role_evaluations: synced
      }
    });

    const byUser = await this.directory(ctx.organizationId);
    return this.project(
      saved,
      wanted.map((userId) => ({ userId })),
      byUser
    );
  }

  async degress(resource: any, ctx: Ctx) {
    if (!resource.id) throw ScimError(400, 'invalidValue', 'DELETE requires a resource id');
    if (isRoleGroupId(resource.id)) readOnlyRoleGroup();
    if (!UUID.test(String(resource.id))) {
      throw ScimError(404, null, `Group ${resource.id} not found`);
    }
    const group = await this.prisma.scimGroup.findFirst({
      where: { id: resource.id, organizationId: ctx.organizationId }
    });
    if (!group) throw ScimError(404, null, `Group ${resource.id} not found`);

    const links = await this.prisma.scimGroupMember.findMany({
      where: { groupId: group.id, organizationId: ctx.organizationId }
    });
    const affected: string[] = links.map((l: any) => l.userId);
    const before = await this.namesFor(ctx.organizationId, affected);

    await this.prisma.$transaction(async (tx: any) => {
      await tx.scimGroupMember.deleteMany({
        where: { groupId: group.id, organizationId: ctx.organizationId }
      });
      await tx.scimGroup.deleteMany({
        where: { id: group.id, organizationId: ctx.organizationId }
      });
    });

    const synced = await this.propagate(ctx.organizationId, affected, before);

    void this.audit.log({
      action: 'scim.group.deleted',
      organizationId: ctx.organizationId,
      targetType: 'scim_group',
      targetId: group.id,
      targetLabel: group.displayName,
      metadata: { members: affected.length, role_evaluations: synced }
    });
  }

  async dropUser(organizationId: string, userId: string): Promise<void> {
    await this.prisma.scimGroupMember.deleteMany({ where: { organizationId, userId } });
  }

  async regrant(organizationId: string, userId: string): Promise<void> {
    const after = await this.namesFor(organizationId, [userId]);
    await this.mapping.syncDirectoryChanges(organizationId, [
      { userId, before: new Set<string>(), after: after.get(userId) ?? new Set<string>() }
    ]);
  }
}
