import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { IdentityProvider, OrganizationRole, SsoProtocol } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import {
  IDP_SUPERADMIN_GROUP_KEY,
  IDP_SUPERADMIN_PROVIDER_KEY,
  InstanceSettingsService,
  ToggleState
} from '../instance-settings/instance-settings.service';
import { newOrgCaps } from '../quotas/org-limits';
import { RuleValueError, isMappableRole, ruleValue } from './group-rules';

export const MAX_AUTO_CREATE_RULES = 100;

const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'apiv1',
  'auth',
  'cli',
  'dev',
  'invite',
  'login',
  'mcp',
  'oauth',
  'sandboxes',
  'setup',
  'sso',
  'status',
  'user'
]);

type Actor = { userId: string; email?: string };

export interface AutoCreateRule {
  id: string;
  value: string;
  role: string;
  organizationId: string | null;
  createdBy: string | null;
}

export interface AutoCreateInput {
  value: string;
  role: string;
}

export interface SuperadminRule {
  providerId: string;
  value: string;
}

export function slugFor(name: string, suffix = ''): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'org';
  const slug = suffix ? `${base}-${suffix}` : base;
  return RESERVED_SLUGS.has(slug) ? `${slug}-org` : slug;
}

@Injectable()
export class InstanceIdentityService {
  private readonly logger = new Logger(InstanceIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: InstanceSettingsService,
    private readonly sessions: SessionsService
  ) {}

  async getPolicy(): Promise<{
    autoCreateOrgs: ToggleState;
    superadminRule: SuperadminRule | null;
  }> {
    const [autoCreateOrgs, superadminRule] = await Promise.all([
      this.settings.getIdpAutoCreateOrgsState(),
      this.superadminRule()
    ]);
    return { autoCreateOrgs, superadminRule };
  }

  async setAutoCreateOrgs(enabled: boolean, actor: Actor) {
    await this.settings.setIdpAutoCreateOrgs(enabled);
    void this.audit.log({
      action: 'admin.sso.auto_create_orgs_toggled',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: 'instance',
      targetId: 'idp_auto_create_orgs',
      metadata: { enabled }
    });
    return this.getPolicy();
  }

  async superadminRule(): Promise<SuperadminRule | null> {
    const [providerId, value] = await Promise.all([
      this.settings.get(IDP_SUPERADMIN_PROVIDER_KEY),
      this.settings.get(IDP_SUPERADMIN_GROUP_KEY)
    ]);
    return providerId && value ? { providerId, value } : null;
  }

  async setSuperadminRule(rule: SuperadminRule | null, actor: Actor) {
    let clean: SuperadminRule | null = null;
    if (rule) {
      if (typeof rule.providerId !== 'string' || !rule.providerId) {
        throw new BadRequestException('providerId is required');
      }
      const provider = await this.prisma.identityProvider.findFirst({
        where: { id: rule.providerId, organizationId: null }
      });
      if (!provider) throw new BadRequestException('Pick an instance identity provider');
      if (provider.protocol !== SsoProtocol.oidc && provider.protocol !== SsoProtocol.saml) {
        throw new BadRequestException('The superadmin rule needs an OIDC or SAML provider');
      }
      clean = { providerId: provider.id, value: this.cleanValue(rule.value) };
    }

    const before = await this.superadminRule();
    if (clean) {
      await this.settings.set(IDP_SUPERADMIN_PROVIDER_KEY, clean.providerId);
      await this.settings.set(IDP_SUPERADMIN_GROUP_KEY, clean.value);
    } else {
      await this.settings.delete(IDP_SUPERADMIN_PROVIDER_KEY);
      await this.settings.delete(IDP_SUPERADMIN_GROUP_KEY);
    }
    const changed = before?.providerId !== clean?.providerId || before?.value !== clean?.value;
    const demoted = changed ? await this.revokeGranted(actor) : 0;

    void this.audit.log({
      action: 'admin.sso.superadmin_rule_updated',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: 'instance',
      targetId: 'idp_superadmin_rule',
      metadata: {
        enabled: Boolean(clean),
        provider_id: clean?.providerId ?? null,
        group: clean?.value ?? null,
        demoted
      }
    });
    return this.getPolicy();
  }

  private cleanValue(value: unknown): string {
    try {
      return ruleValue(value);
    } catch (err) {
      if (err instanceof RuleValueError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  private async otherSuperadmins(exceptUserId: string): Promise<number> {
    return this.prisma.user.count({ where: { isSuperAdmin: true, id: { not: exceptUserId } } });
  }

  private async revokeGranted(actor: Actor | null): Promise<number> {
    const granted = await this.prisma.federatedIdentity.findMany({
      where: { grantedSuperadmin: true },
      select: { id: true, userId: true }
    });
    let demoted = 0;
    for (const row of granted) {
      if (await this.demote(row, null, actor)) demoted += 1;
    }
    return demoted;
  }

  private async demote(
    row: { id: string; userId: string },
    providerId: string | null,
    actor: Actor | null
  ): Promise<boolean> {
    await this.prisma.federatedIdentity.update({
      where: { id: row.id },
      data: { grantedSuperadmin: false }
    });
    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { id: true, email: true, isSuperAdmin: true }
    });
    if (!user?.isSuperAdmin) return false;
    if ((await this.otherSuperadmins(user.id)) === 0) {
      this.logger.warn(`Kept ${user.id} as superadmin: they are the last one`);
      return false;
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: false } });
    await this.sessions.revokeSignInSessions({ authMethods: ['sso'], userIds: [user.id] });
    void this.audit.log({
      action: 'sso.superadmin.revoked',
      actorUserId: actor?.userId ?? user.id,
      actorEmail: actor?.email ?? user.email,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { provider_id: providerId }
    });
    return true;
  }

  async syncSuperadmin(
    provider: IdentityProvider,
    user: { id: string; email: string; isSuperAdmin: boolean },
    groups: ReadonlySet<string> | null,
    emailVerified: boolean
  ): Promise<boolean> {
    if (provider.organizationId) return user.isSuperAdmin;
    const rule = await this.superadminRule();
    if (!rule || rule.providerId !== provider.id || !groups) return user.isSuperAdmin;

    const identity = await this.prisma.federatedIdentity.findUnique({
      where: { providerId_userId: { providerId: provider.id, userId: user.id } }
    });
    if (groups.has(rule.value)) {
      if (user.isSuperAdmin) return true;
      if (!identity || !emailVerified) return false;
      await this.prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
      await this.prisma.federatedIdentity.update({
        where: { id: identity.id },
        data: { grantedSuperadmin: true }
      });
      void this.audit.log({
        action: 'sso.superadmin.granted',
        actorUserId: user.id,
        actorEmail: user.email,
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email,
        metadata: { provider_id: provider.id, group: rule.value }
      });
      return true;
    }

    if (user.isSuperAdmin && identity?.grantedSuperadmin) {
      return !(await this.demote(identity, provider.id, null));
    }
    return user.isSuperAdmin;
  }

  async listAutoCreateRules(provider: IdentityProvider) {
    const rules = await this.prisma.idpAutoCreateRule.findMany({
      where: { providerId: provider.id },
      orderBy: { value: 'asc' },
      select: { id: true, value: true, role: true, organizationId: true }
    });
    const state = await this.settings.getIdpAutoCreateOrgsState();
    return { enabled: state.enabled, rules };
  }

  async replaceAutoCreateRules(
    provider: IdentityProvider,
    input: { rules: AutoCreateInput[] },
    actor: Actor
  ) {
    if (provider.organizationId) {
      throw new BadRequestException('Only instance identity providers can create organizations');
    }
    if (provider.protocol !== SsoProtocol.oidc && provider.protocol !== SsoProtocol.saml) {
      throw new BadRequestException('Group rules need an OIDC or SAML provider');
    }
    if (!input || !Array.isArray(input.rules)) {
      throw new BadRequestException('rules must be a list');
    }
    if (input.rules.length > MAX_AUTO_CREATE_RULES) {
      throw new BadRequestException(`At most ${MAX_AUTO_CREATE_RULES} auto-create rules`);
    }
    const wanted = new Map<string, { value: string; role: OrganizationRole }>();
    for (const r of input.rules) {
      if (!r || typeof r !== 'object') throw new BadRequestException('Invalid rule');
      if (r.role === OrganizationRole.owner) {
        throw new BadRequestException('Rules can grant admin, member or guest, never owner');
      }
      if (!isMappableRole(r.role)) {
        throw new BadRequestException('Role must be admin, member or guest');
      }
      const value = this.cleanValue(r.value);
      if (wanted.has(value)) throw new BadRequestException(`Duplicate rule for "${value}"`);
      wanted.set(value, { value, role: r.role as OrganizationRole });
    }

    const existing = await this.prisma.idpAutoCreateRule.findMany({
      where: { providerId: provider.id }
    });
    const byValue = new Map(existing.map((r) => [r.value, r]));
    const removed = existing.filter((r) => !wanted.has(r.value));
    const added = [...wanted.values()].filter((w) => !byValue.has(w.value));
    const changed = [...wanted.values()].filter(
      (w) => byValue.has(w.value) && byValue.get(w.value)!.role !== w.role
    );

    await this.prisma.$transaction([
      ...(removed.length
        ? [
            this.prisma.idpAutoCreateRule.deleteMany({
              where: { id: { in: removed.map((r) => r.id) } }
            })
          ]
        : []),
      ...changed.map((c) =>
        this.prisma.idpAutoCreateRule.update({
          where: { id: byValue.get(c.value)!.id },
          data: { role: c.role }
        })
      ),
      ...(added.length
        ? [
            this.prisma.idpAutoCreateRule.createMany({
              data: added.map((a) => ({ ...a, providerId: provider.id, createdBy: actor.userId }))
            })
          ]
        : [])
    ]);

    void this.audit.log({
      action: 'sso.auto_create_rules.updated',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetType: 'identity_provider',
      targetId: provider.id,
      targetLabel: provider.name,
      metadata: {
        added: added.slice(0, 20).map((a) => `${a.role}:${a.value}`.slice(0, 120)),
        removed: removed.slice(0, 20).map((a) => `${a.role}:${a.value}`.slice(0, 120)),
        changed: changed.slice(0, 20).map((a) => `${a.role}:${a.value}`.slice(0, 120)),
        total: wanted.size
      }
    });
    return this.listAutoCreateRules(provider);
  }

  async activeRules(provider: IdentityProvider): Promise<AutoCreateRule[]> {
    if (provider.organizationId) return [];
    if (!(await this.settings.isIdpAutoCreateOrgsEnabled())) return [];
    return this.prisma.idpAutoCreateRule.findMany({
      where: { providerId: provider.id, organizationId: null },
      select: { id: true, value: true, role: true, organizationId: true, createdBy: true }
    });
  }

  async materialize(provider: IdentityProvider, pending: AutoCreateRule[]) {
    const created: Array<{ ruleId: string; organizationId: string; value: string; role: string }> =
      [];
    if (provider.organizationId || pending.length === 0) return created;
    if (!(await this.settings.isIdpAutoCreateOrgsEnabled())) return created;

    for (const rule of pending) {
      const organization = await this.createFor(provider, rule);
      if (!organization) continue;
      created.push({
        ruleId: rule.id,
        organizationId: organization.id,
        value: rule.value,
        role: rule.role
      });
      void this.audit.log({
        action: 'org.created',
        organizationId: organization.id,
        targetType: 'organization',
        targetId: organization.id,
        targetLabel: organization.name,
        metadata: { slug: organization.slug, via: 'idp_auto_create', provider_id: provider.id }
      });
      void this.audit.log({
        action: 'sso.org.auto_created',
        organizationId: organization.id,
        targetType: 'identity_provider',
        targetId: provider.id,
        targetLabel: provider.name,
        metadata: { group: rule.value, role: rule.role, rule_id: rule.id }
      });
    }
    return created;
  }

  private async createFor(provider: IdentityProvider, rule: AutoCreateRule) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = slugFor(rule.value, attempt === 0 ? '' : randomBytes(2).toString('hex'));
      try {
        return await this.prisma.$transaction(async (tx) => {
          const organization = await tx.organization.create({
            data: { name: rule.value.slice(0, 255), slug, ...newOrgCaps() }
          });
          const claimed = await tx.idpAutoCreateRule.updateMany({
            where: { id: rule.id, organizationId: null },
            data: { organizationId: organization.id }
          });
          if (claimed.count !== 1) throw new AlreadyCreated();
          await tx.idpGroupRule.create({
            data: {
              providerId: provider.id,
              organizationId: organization.id,
              value: rule.value,
              role: rule.role as OrganizationRole,
              createdBy: rule.createdBy
            }
          });
          return organization;
        });
      } catch (err) {
        if (err instanceof AlreadyCreated) return null;
        if ((err as { code?: string })?.code === 'P2002') continue;
        throw err;
      }
    }
    return null;
  }
}

class AlreadyCreated extends Error {}
