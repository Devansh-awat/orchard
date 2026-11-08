import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import { IdentityProvider, OrganizationRole, SsoProtocol } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AutoCreateRule, InstanceIdentityService } from './instance-identity.service';
import {
  GroupRule,
  GroupsResult,
  MAX_GROUPS,
  MAX_RULES_PER_ORG,
  MappableRole,
  OrgDecision,
  RuleValueError,
  extractGroups,
  isMappableRole,
  normalizeGroup,
  outranks,
  resolveRoles,
  ruleValue,
  validClaimName
} from './group-rules';

export const NOT_MAPPED = 'sso_not_mapped';

const PROJECT_ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2 };

const MAX_SUBJECT_LENGTH = 255;
const AUDIT_LIST_LIMIT = 20;

export interface MappingContext {
  hasRules: boolean;
  rules: GroupRule[];
  groups: GroupsResult | null;
  decisions: Map<string, OrgDecision>;
  allowed: boolean;
  pending: AutoCreateRule[];
}

export interface RuleInput {
  value: string;
  role: string;
  organizationId?: string;
}

export interface RulesInput {
  groupClaim?: string;
  rules: RuleInput[];
}

type Actor = { userId: string; email?: string };

const NO_RULES: MappingContext = {
  hasRules: false,
  rules: [],
  groups: null,
  decisions: new Map(),
  allowed: true,
  pending: []
};

export function cleanSubject(subject: unknown): string | null {
  if (typeof subject !== 'string') return null;
  return subject.length > 0 && subject.length <= MAX_SUBJECT_LENGTH ? subject : null;
}

@Injectable()
export class IdentityMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly membershipCache: MembershipCacheService,
    private readonly orgs: OrganizationsService,
    @Optional() private readonly instanceIdentity?: InstanceIdentityService
  ) {}

  async prepare(
    provider: IdentityProvider,
    claims: Record<string, unknown> | null,
    userId?: string | null
  ): Promise<MappingContext> {
    const all: GroupRule[] = await this.prisma.idpGroupRule.findMany({
      where: { providerId: provider.id },
      select: { id: true, organizationId: true, value: true, role: true }
    });
    const auto = (await this.instanceIdentity?.activeRules(provider)) ?? [];
    const superadmin = this.instanceIdentity ? await this.instanceIdentity.superadminRule() : null;
    const wantsSuperadmin = !provider.organizationId && superadmin?.providerId === provider.id;
    if (all.length === 0 && auto.length === 0 && !wantsSuperadmin) return NO_RULES;

    const rules = provider.organizationId
      ? all.filter((r) => r.organizationId === provider.organizationId)
      : all;
    const groups: GroupsResult = claims
      ? extractGroups(claims, provider.groupClaim)
      : { kind: 'unknown', reason: 'unsupported' };
    const decisions =
      groups.kind === 'groups'
        ? await this.decide(rules, groups.groups, userId ?? null)
        : new Map<string, OrgDecision>();
    const pending =
      groups.kind === 'groups'
        ? auto.filter((r) => !r.organizationId && groups.groups.has(r.value))
        : [];
    const hasRules = all.length > 0 || auto.length > 0;
    const elevated =
      wantsSuperadmin && groups.kind === 'groups' && groups.groups.has(superadmin!.value);
    return {
      hasRules,
      rules,
      groups,
      decisions,
      allowed: !hasRules || decisions.size > 0 || pending.length > 0 || elevated,
      pending
    };
  }

  async materialize(provider: IdentityProvider, ctx: MappingContext): Promise<void> {
    if (!this.instanceIdentity || ctx.pending.length === 0) return;
    const created = await this.instanceIdentity.materialize(provider, ctx.pending);
    for (const c of created) {
      const rule: GroupRule = {
        id: c.ruleId,
        organizationId: c.organizationId,
        value: c.value,
        role: c.role
      };
      ctx.rules.push(rule);
      const decision = resolveRoles([rule], new Set([c.value])).get(c.organizationId);
      if (decision) ctx.decisions.set(c.organizationId, decision);
    }
    ctx.pending = [];
  }

  async syncSuperadmin(
    provider: IdentityProvider,
    user: { id: string; email: string; isSuperAdmin: boolean },
    ctx: MappingContext,
    emailVerified: boolean
  ): Promise<boolean> {
    if (!this.instanceIdentity) return user.isSuperAdmin;
    return this.instanceIdentity.syncSuperadmin(
      provider,
      user,
      ctx.groups?.kind === 'groups' ? ctx.groups.groups : null,
      emailVerified
    );
  }

  private async decide(
    rules: GroupRule[],
    claimGroups: ReadonlySet<string>,
    userId: string | null
  ): Promise<Map<string, OrgDecision>> {
    const orgIds = [...new Set(rules.map((r) => r.organizationId))];
    const directory = userId
      ? await this.directoryGroups(userId, orgIds)
      : new Map<string, Set<string>>();
    const decisions = new Map<string, OrgDecision>();
    for (const organizationId of orgIds) {
      const names = new Set<string>(claimGroups);
      for (const name of directory.get(organizationId) ?? []) names.add(name);
      const decision = resolveRoles(
        rules.filter((r) => r.organizationId === organizationId),
        names
      ).get(organizationId);
      if (decision) decisions.set(organizationId, decision);
    }
    return decisions;
  }

  async directoryGroups(userId: string, organizationIds: string[]) {
    const out = new Map<string, Set<string>>();
    if (organizationIds.length === 0) return out;
    const links: Array<{ groupId: string; organizationId: string }> =
      await this.prisma.scimGroupMember.findMany({
        where: { userId, organizationId: { in: organizationIds } },
        select: { groupId: true, organizationId: true }
      });
    if (links.length === 0) return out;
    const groups: Array<{ id: string; displayName: string }> = await this.prisma.scimGroup.findMany(
      {
        where: { id: { in: links.map((l) => l.groupId) } },
        select: { id: true, displayName: true }
      }
    );
    const names = new Map(groups.map((g) => [g.id, g.displayName]));
    for (const link of links) {
      const name = normalizeGroup(names.get(link.groupId));
      if (!name) continue;
      const set = out.get(link.organizationId) ?? new Set<string>();
      set.add(name);
      out.set(link.organizationId, set);
    }
    return out;
  }

  async syncDirectoryChanges(
    organizationId: string,
    changes: Array<{ userId: string; before: ReadonlySet<string>; after: ReadonlySet<string> }>
  ): Promise<number> {
    if (changes.length === 0) return 0;
    const anchor = await this.prisma.idpGroupRule.findFirst({
      where: { organizationId },
      select: { providerId: true }
    });
    if (!anchor) return 0;
    const provider = await this.prisma.identityProvider.findUnique({
      where: { id: anchor.providerId }
    });
    if (!provider || (provider.organizationId && provider.organizationId !== organizationId)) {
      return 0;
    }
    const rules: GroupRule[] = await this.prisma.idpGroupRule.findMany({
      where: { providerId: provider.id, organizationId },
      select: { id: true, organizationId: true, value: true, role: true }
    });
    let touched = 0;
    for (const change of changes) {
      const before = resolveRoles(rules, change.before).get(organizationId);
      const after = resolveRoles(rules, change.after).get(organizationId);
      if (!before && !after) continue;
      const user = await this.prisma.user.findUnique({
        where: { id: change.userId },
        select: { id: true, email: true, isSuperAdmin: true }
      });
      if (!user || user.isSuperAdmin) continue;
      await this.syncOne(provider, user, organizationId, after, false);
      await this.syncProjects(provider, user.id, change.after, organizationId);
      touched += 1;
    }
    return touched;
  }

  async deny(
    provider: IdentityProvider,
    ctx: MappingContext,
    who: { email: string; userId?: string }
  ): Promise<never> {
    const reason =
      ctx.groups?.kind === 'unknown' ? `groups_${ctx.groups.reason}` : 'no_matching_rule';
    void this.audit.log({
      action: 'sso.login.denied',
      actorUserId: who.userId ?? null,
      actorEmail: who.email,
      organizationId: provider.organizationId,
      targetType: 'identity_provider',
      targetId: provider.id,
      targetLabel: provider.name,
      metadata: { reason, groups_seen: ctx.groups?.kind === 'groups' ? ctx.groups.groups.size : 0 }
    });
    if (who.userId && ctx.groups?.kind === 'groups') {
      await this.apply(provider, { id: who.userId, email: who.email }, ctx);
    }
    throw new UnauthorizedException(NOT_MAPPED);
  }

  async apply(
    provider: IdentityProvider,
    user: { id: string; email: string },
    ctx: MappingContext
  ): Promise<void> {
    if (ctx.groups?.kind !== 'groups') return;
    await this.applyOrgs(provider, user, ctx);
    await this.syncProjects(provider, user.id, ctx.groups.groups);
  }

  private async applyOrgs(
    provider: IdentityProvider,
    user: { id: string; email: string },
    ctx: MappingContext
  ): Promise<void> {
    if (!ctx.hasRules || ctx.groups?.kind !== 'groups') return;
    const managed = await this.prisma.organizationMember.findMany({
      where: { userId: user.id, managedByProviderId: provider.id },
      select: { organizationId: true }
    });
    const orgIds = new Set<string>([
      ...ctx.rules.map((r) => r.organizationId),
      ...managed.map((m) => m.organizationId)
    ]);
    if (provider.organizationId) {
      for (const id of [...orgIds]) if (id !== provider.organizationId) orgIds.delete(id);
    }
    for (const organizationId of orgIds) {
      await this.syncOne(provider, user, organizationId, ctx.decisions.get(organizationId), true);
    }
  }

  private async syncOne(
    provider: IdentityProvider,
    user: { id: string; email: string },
    organizationId: string,
    decision: OrgDecision | undefined,
    mayCreate: boolean
  ): Promise<void> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } }
    });
    const base = {
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email
    };

    if (!member) {
      if (!decision || !mayCreate) return;
      await this.prisma.organizationMember.create({
        data: {
          organizationId,
          userId: user.id,
          role: decision.role as OrganizationRole,
          managedByProviderId: provider.id
        }
      });
      this.membershipCache.invalidateInternalUserId(user.id);
      void this.audit.log({
        ...base,
        action: 'sso.member.provisioned',
        metadata: {
          role: decision.role,
          provider_id: provider.id,
          rule_ids: decision.ruleIds.slice(0, AUDIT_LIST_LIMIT)
        }
      });
      return;
    }

    if (member.role === OrganizationRole.owner) return;

    if (!decision) {
      if (member.managedByProviderId !== provider.id) return;
      await this.orgs.detachMember(member, organizationId);
      await this.revoke(organizationId, user.id);
      void this.audit.log({
        ...base,
        action: 'sso.member.removed',
        metadata: { role: member.role, provider_id: provider.id, reason: 'no_matching_rule' }
      });
      return;
    }

    if (member.role === decision.role && member.managedByProviderId === provider.id) return;
    await this.prisma.organizationMember.update({
      where: { id: member.id },
      data: { role: decision.role as OrganizationRole, managedByProviderId: provider.id }
    });
    if (outranks(member.role as MappableRole, decision.role) || !isMappableRole(member.role)) {
      await this.revoke(organizationId, user.id);
    } else {
      this.membershipCache.invalidateInternalUserId(user.id);
    }
    void this.audit.log({
      ...base,
      action: 'sso.member.role_synced',
      metadata: {
        from: member.role,
        to: decision.role,
        provider_id: provider.id,
        rule_ids: decision.ruleIds.slice(0, AUDIT_LIST_LIMIT)
      }
    });
  }

  async revoke(organizationId: string, userId: string): Promise<void> {
    await this.sessions.revokeSignInSessions({ authMethods: ['sso'], userIds: [userId] });
    await this.prisma.apiToken.deleteMany({
      where: { userId, scopeOrganizationId: organizationId }
    });
    this.membershipCache.revoked(organizationId, userId);
  }

  private async revokeManaged(provider: IdentityProvider): Promise<number> {
    const members = await this.prisma.organizationMember.findMany({
      where: { managedByProviderId: provider.id },
      select: { organizationId: true, userId: true }
    });
    if (members.length === 0) return 0;
    await this.sessions.revokeSignInSessions({
      authMethods: ['sso'],
      userIds: [...new Set(members.map((m) => m.userId))]
    });
    for (const m of members) {
      await this.prisma.apiToken.deleteMany({
        where: { userId: m.userId, scopeOrganizationId: m.organizationId }
      });
      this.membershipCache.revoked(m.organizationId, m.userId);
    }
    return members.length;
  }

  async findBound(provider: IdentityProvider, subject: string | null) {
    if (!subject) return null;
    const row = await this.prisma.federatedIdentity.findUnique({
      where: { providerId_subject: { providerId: provider.id, subject } },
      include: { user: true }
    });
    return row?.user ?? null;
  }

  async bind(
    provider: IdentityProvider,
    subject: string | null,
    user: { id: string; email: string }
  ): Promise<void> {
    if (!subject) return;
    const existing = await this.prisma.federatedIdentity.findUnique({
      where: { providerId_userId: { providerId: provider.id, userId: user.id } }
    });
    if (existing) {
      if (existing.subject !== subject) {
        void this.audit.log({
          action: 'sso.login.denied',
          actorUserId: user.id,
          actorEmail: user.email,
          organizationId: provider.organizationId,
          targetType: 'identity_provider',
          targetId: provider.id,
          targetLabel: provider.name,
          metadata: { reason: 'subject_mismatch' }
        });
        throw new UnauthorizedException('SSO authentication failed');
      }
      await this.prisma.federatedIdentity.update({
        where: { id: existing.id },
        data: { lastLoginAt: new Date() }
      });
      return;
    }
    try {
      await this.prisma.federatedIdentity.create({
        data: { providerId: provider.id, subject, userId: user.id }
      });
    } catch {
      throw new UnauthorizedException('SSO authentication failed');
    }
    void this.audit.log({
      action: 'sso.identity.bound',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: provider.organizationId,
      targetType: 'identity_provider',
      targetId: provider.id,
      targetLabel: provider.name
    });
  }

  /**
   * Project roles from IdP groups. A rule only ever lands inside an org the
   * person is already an active member of, and only ever touches project
   * memberships it created itself: someone added to a project by hand keeps
   * that membership whatever their groups say.
   */
  async syncProjects(
    provider: IdentityProvider,
    userId: string,
    groups: ReadonlySet<string>,
    onlyOrganizationId?: string
  ): Promise<void> {
    const rules = await this.prisma.idpProjectRule.findMany({
      where: {
        providerId: provider.id,
        ...(provider.organizationId ? { organizationId: provider.organizationId } : {}),
        ...(onlyOrganizationId ? { organizationId: onlyOrganizationId } : {})
      },
      select: { projectId: true, organizationId: true, value: true, roleId: true, role: true }
    });
    const managed = await this.prisma.projectMember.findMany({
      where: {
        userId,
        managedByProviderId: provider.id,
        ...(onlyOrganizationId ? { project: { organizationId: onlyOrganizationId } } : {})
      },
      select: { id: true, projectId: true, roleId: true }
    });
    if (rules.length === 0 && managed.length === 0) return;

    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        status: 'active',
        organizationId: { in: rules.map((r) => r.organizationId) }
      },
      select: { organizationId: true }
    });
    const activeOrgs = new Set(memberships.map((m) => m.organizationId));
    const wanted = new Map<string, { roleId: string; rank: number }>();
    for (const rule of rules) {
      if (!groups.has(rule.value) || !activeOrgs.has(rule.organizationId)) continue;
      const rank = PROJECT_ROLE_RANK[rule.role.name] ?? -1;
      const current = wanted.get(rule.projectId);
      if (!current || rank > current.rank)
        wanted.set(rule.projectId, { roleId: rule.roleId, rank });
    }

    for (const [projectId, { roleId }] of wanted) {
      const existing = await this.prisma.projectMember.findFirst({
        where: { projectId, userId },
        select: { id: true, roleId: true, managedByProviderId: true }
      });
      if (!existing) {
        await this.prisma.projectMember.create({
          data: { projectId, userId, roleId, managedByProviderId: provider.id }
        });
      } else if (existing.managedByProviderId === provider.id && existing.roleId !== roleId) {
        await this.prisma.projectMember.update({ where: { id: existing.id }, data: { roleId } });
      }
    }
    const dropped = managed.filter((m) => !wanted.has(m.projectId));
    if (dropped.length) {
      await this.prisma.projectMember.deleteMany({
        where: { id: { in: dropped.map((m) => m.id) } }
      });
    }
    if (dropped.length || wanted.size) this.membershipCache.invalidateInternalUserId(userId);
  }

  async listProjectRules(provider: IdentityProvider) {
    return this.prisma.idpProjectRule.findMany({
      where: { providerId: provider.id },
      orderBy: [{ organizationId: 'asc' }, { value: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        projectId: true,
        value: true,
        roleId: true,
        role: { select: { name: true } },
        project: { select: { name: true, slug: true } }
      }
    });
  }

  async replaceProjectRules(
    provider: IdentityProvider,
    input: { rules: Array<{ value: string; projectId: string; role: string }> },
    actor: Actor
  ) {
    if (provider.protocol !== SsoProtocol.oidc && provider.protocol !== SsoProtocol.saml) {
      throw new BadRequestException('Group rules need an OIDC or SAML provider');
    }
    if (!input || !Array.isArray(input.rules))
      throw new BadRequestException('rules must be a list');
    if (input.rules.length > MAX_RULES_PER_ORG) {
      throw new BadRequestException(`At most ${MAX_RULES_PER_ORG} rules per provider`);
    }
    const roles = await this.prisma.role.findMany({
      where: { name: { in: Object.keys(PROJECT_ROLE_RANK) } },
      select: { id: true, name: true }
    });
    const roleByName = new Map(roles.map((r) => [r.name, r.id]));
    const projectIds = [...new Set(input.rules.map((r) => r?.projectId).filter(Boolean))];
    const projects = await this.prisma.project.findMany({
      where: {
        id: { in: projectIds },
        ...(provider.organizationId ? { organizationId: provider.organizationId } : {})
      },
      select: { id: true, organizationId: true }
    });
    const projectOrg = new Map(projects.map((p) => [p.id, p.organizationId]));

    const wanted = new Map<
      string,
      { value: string; projectId: string; organizationId: string; roleId: string }
    >();
    for (const r of input.rules) {
      if (!r || typeof r !== 'object') throw new BadRequestException('Invalid rule');
      let value: string;
      try {
        value = ruleValue(r.value);
      } catch (err) {
        if (err instanceof RuleValueError) throw new BadRequestException(err.message);
        throw err;
      }
      const organizationId = projectOrg.get(r.projectId);
      if (!organizationId) {
        throw new BadRequestException(
          provider.organizationId
            ? "An organization's provider can only map into that organization's projects"
            : 'Unknown project'
        );
      }
      const roleId = roleByName.get(r.role);
      if (!roleId) throw new BadRequestException('Role must be admin, member or viewer');
      const key = `${r.projectId}\u0000${value}`;
      if (wanted.has(key)) throw new BadRequestException(`Duplicate rule for "${value}"`);
      wanted.set(key, { value, projectId: r.projectId, organizationId, roleId });
    }

    await this.prisma.$transaction([
      this.prisma.idpProjectRule.deleteMany({ where: { providerId: provider.id } }),
      ...(wanted.size
        ? [
            this.prisma.idpProjectRule.createMany({
              data: [...wanted.values()].map((w) => ({
                ...w,
                providerId: provider.id,
                createdBy: actor.userId
              }))
            })
          ]
        : [])
    ]);
    void this.audit.log({
      action: 'sso.project_rules.updated',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId: provider.organizationId,
      targetType: 'identity_provider',
      targetId: provider.id,
      targetLabel: provider.name,
      metadata: { total: wanted.size }
    });
    return this.listProjectRules(provider);
  }

  async requireProvider(providerId: string, organizationId: string | null) {
    const provider = await this.prisma.identityProvider.findFirst({
      where: { id: providerId, organizationId }
    });
    if (!provider) throw new NotFoundException('Identity provider not found');
    return provider;
  }

  async listRules(provider: IdentityProvider) {
    const rules = await this.prisma.idpGroupRule.findMany({
      where: { providerId: provider.id },
      orderBy: [{ organizationId: 'asc' }, { value: 'asc' }],
      select: { id: true, organizationId: true, value: true, role: true }
    });
    return { groupClaim: provider.groupClaim, rules };
  }

  async preview(provider: IdentityProvider, groups: unknown) {
    if (!Array.isArray(groups) || groups.length > MAX_GROUPS) {
      throw new BadRequestException(`groups must be a list of at most ${MAX_GROUPS} names`);
    }
    const names = new Set<string>();
    for (const g of groups) {
      const n = normalizeGroup(g);
      if (n) names.add(n);
    }
    const { rules } = await this.listRules(provider);
    const scoped = provider.organizationId
      ? rules.filter((r) => r.organizationId === provider.organizationId)
      : rules;
    const decisions = resolveRoles(scoped, names);
    return {
      hasRules: rules.length > 0,
      allowed: rules.length === 0 || decisions.size > 0,
      matches: [...decisions].map(([organizationId, d]) => ({ organizationId, ...d }))
    };
  }

  async replaceRules(provider: IdentityProvider, input: RulesInput, actor: Actor) {
    if (provider.protocol !== SsoProtocol.oidc && provider.protocol !== SsoProtocol.saml) {
      throw new BadRequestException('Group rules need an OIDC or SAML provider');
    }
    if (!input || !Array.isArray(input.rules)) {
      throw new BadRequestException('rules must be a list');
    }
    if (input.rules.length > MAX_RULES_PER_ORG) {
      throw new BadRequestException(`At most ${MAX_RULES_PER_ORG} rules per provider`);
    }
    if (input.groupClaim !== undefined && !validClaimName(input.groupClaim)) {
      throw new BadRequestException('groupClaim must be a plain attribute name or dotted path');
    }

    const wanted = new Map<string, { organizationId: string; value: string; role: MappableRole }>();
    for (const r of input.rules) {
      if (!r || typeof r !== 'object') throw new BadRequestException('Invalid rule');
      if (r.role === OrganizationRole.owner) {
        throw new BadRequestException('Rules can grant admin, member or guest, never owner');
      }
      if (!isMappableRole(r.role))
        throw new BadRequestException('Role must be admin, member or guest');
      let value: string;
      try {
        value = ruleValue(r.value);
      } catch (err) {
        if (err instanceof RuleValueError) throw new BadRequestException(err.message);
        throw err;
      }
      const organizationId = provider.organizationId ?? r.organizationId;
      if (!organizationId || typeof organizationId !== 'string') {
        throw new BadRequestException('Each rule needs a target organization');
      }
      if (
        provider.organizationId &&
        r.organizationId !== undefined &&
        r.organizationId !== provider.organizationId
      ) {
        throw new BadRequestException(
          "An organization's provider can only map into that organization"
        );
      }
      const key = `${organizationId}\u0000${value}`;
      if (wanted.has(key)) throw new BadRequestException(`Duplicate rule for "${value}"`);
      wanted.set(key, { organizationId, value, role: r.role });
    }

    const targetOrgs = [...new Set([...wanted.values()].map((r) => r.organizationId))];
    if (!provider.organizationId && targetOrgs.length > 0) {
      const found = await this.prisma.organization.findMany({
        where: { id: { in: targetOrgs } },
        select: { id: true }
      });
      if (found.length !== targetOrgs.length) throw new BadRequestException('Unknown organization');
    }
    if (targetOrgs.length > 0) {
      const clash = await this.prisma.idpGroupRule.findFirst({
        where: { organizationId: { in: targetOrgs }, providerId: { not: provider.id } },
        select: { organizationId: true }
      });
      if (clash) {
        throw new ConflictException(
          'Another identity provider already has group rules for this organization'
        );
      }
    }

    const existing: Array<GroupRule & { providerId: string }> =
      await this.prisma.idpGroupRule.findMany({ where: { providerId: provider.id } });
    const existingByKey = new Map(existing.map((r) => [`${r.organizationId}\u0000${r.value}`, r]));
    const added = [...wanted].filter(([k]) => !existingByKey.has(k)).map(([, v]) => v);
    const removed = existing.filter((r) => !wanted.has(`${r.organizationId}\u0000${r.value}`));
    const changed = [...wanted]
      .filter(([k, v]) => existingByKey.has(k) && existingByKey.get(k)!.role !== v.role)
      .map(([k, v]) => ({ id: existingByKey.get(k)!.id, from: existingByKey.get(k)!.role, ...v }));
    const claimChanged = input.groupClaim !== undefined && input.groupClaim !== provider.groupClaim;

    await this.prisma.$transaction([
      ...(removed.length
        ? [this.prisma.idpGroupRule.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } })]
        : []),
      ...changed.map((c) =>
        this.prisma.idpGroupRule.update({ where: { id: c.id }, data: { role: c.role } })
      ),
      ...(added.length
        ? [
            this.prisma.idpGroupRule.createMany({
              data: added.map((a) => ({ ...a, providerId: provider.id, createdBy: actor.userId }))
            })
          ]
        : []),
      ...(claimChanged
        ? [
            this.prisma.identityProvider.update({
              where: { id: provider.id },
              data: { groupClaim: input.groupClaim }
            })
          ]
        : [])
    ]);

    const lowered = changed.some((c) => outranks(c.from as MappableRole, c.role));
    const revoked =
      removed.length > 0 || lowered || claimChanged ? await this.revokeManaged(provider) : 0;

    const label = (r: { role: string; value: string }) => `${r.role}:${r.value}`.slice(0, 120);
    void this.audit.log({
      action: 'sso.rules.updated',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      organizationId: provider.organizationId,
      targetType: 'identity_provider',
      targetId: provider.id,
      targetLabel: provider.name,
      metadata: {
        added: added.slice(0, AUDIT_LIST_LIMIT).map(label),
        removed: removed.slice(0, AUDIT_LIST_LIMIT).map(label),
        changed: changed.slice(0, AUDIT_LIST_LIMIT).map((c) => `${c.value}:${c.from}>${c.role}`),
        total: wanted.size,
        group_claim_changed: claimChanged,
        revoked_members: revoked
      }
    });

    return this.listRules(claimChanged ? { ...provider, groupClaim: input.groupClaim! } : provider);
  }
}
