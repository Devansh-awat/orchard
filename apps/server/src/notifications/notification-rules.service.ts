import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../auth/authorization.service';
import {
  NOTIFICATION_EVENTS,
  NotificationEventName,
  RULE_SCOPE_TYPES,
  RuleScopeType,
  eventsForScopeType
} from './notification-events';
import type { ResolvedScope } from './notification-scope';
import { isChannelVisibleAt, ownsChannel, scopeChain } from './notification-scope';

const MAX_RULES_PER_SCOPE = 25;

export interface RuleInput {
  channelId?: string;
  scopeType?: string;
  scopeId?: string | null;
  events?: string[];
  mode?: string;
  enabled?: boolean;
}

interface Actor {
  id: string;
  email?: string | null;
}

export type { ResolvedScope };

// Team routing. Everything here is org-visible state: who else on the team gets
// told about what. Personal preference lives in UserNotificationsService and the
// two never write to each other.
@Injectable()
export class NotificationRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService
  ) {}

  // Lists the rules that actually apply at a scope, including the ones
  // inherited from above, because "why did this fire" is unanswerable if the UI
  // only shows the rules attached at the current level.
  async listRules(organizationId: string, scopeType?: string, scopeId?: string) {
    if (!scopeType) {
      const all = await this.prisma.notificationRule.findMany({
        where: { organizationId },
        orderBy: [{ scopeType: 'asc' }, { createdAt: 'asc' }],
        include: { channel: { select: { id: true, name: true, type: true, enabled: true } } }
      });
      return all.map((r) => ({ ...r, inherited: false }));
    }

    const scope = await this.resolveScope(organizationId, scopeType, scopeId ?? null);
    const chain = scopeChain(scope);

    const rules = await this.prisma.notificationRule.findMany({
      where: {
        organizationId,
        OR: chain.map((c) => ({ scopeType: c.scopeType, scopeId: c.scopeId }))
      },
      orderBy: [{ createdAt: 'asc' }],
      include: { channel: { select: { id: true, name: true, type: true, enabled: true } } }
    });

    return rules.map((r) => ({
      ...r,
      inherited: !(r.scopeType === scope.scopeType && r.scopeId === scope.scopeId)
    }));
  }

  async createRule(organizationId: string, input: RuleInput, actor: Actor) {
    const scope = await this.resolveScope(organizationId, input.scopeType, input.scopeId ?? null);
    await this.assertCanEditScope(organizationId, scope, actor);

    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id: input.channelId ?? '', organizationId },
      select: { id: true, name: true, scopeType: true, scopeId: true }
    });
    if (!channel) throw new NotFoundException('Notification channel not found');
    // A destination owned by one project is not a thing another project's admin
    // may route to, so an unreachable channel is a 404 rather than a hint that
    // it exists somewhere else in the org.
    if (!isChannelVisibleAt(scope, channel)) {
      throw new NotFoundException('Notification channel not found');
    }

    const events = this.validateEvents(input.events, scope.scopeType);
    const mode = input.mode === 'mute' ? 'mute' : 'deliver';

    const existing = await this.prisma.notificationRule.count({
      where: { organizationId, scopeType: scope.scopeType, scopeId: scope.scopeId }
    });
    if (existing >= MAX_RULES_PER_SCOPE) {
      throw new BadRequestException(`A scope is limited to ${MAX_RULES_PER_SCOPE} rules`);
    }

    const rule = await this.prisma.notificationRule.create({
      data: {
        organizationId,
        channelId: channel.id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        events,
        mode,
        enabled: input.enabled !== false,
        createdById: actor.id
      },
      include: { channel: { select: { id: true, name: true, type: true, enabled: true } } }
    });
    void this.audit.log({
      action: 'notification_rule.created',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      targetType: 'notification_rule',
      targetId: rule.id,
      targetLabel: `${channel.name} @ ${scope.label}`,
      metadata: { scopeType: scope.scopeType, scopeId: scope.scopeId, mode, events }
    });
    return rule;
  }

  async updateRule(organizationId: string, ruleId: string, input: RuleInput, actor: Actor) {
    const existing = await this.prisma.notificationRule.findFirst({
      where: { id: ruleId, organizationId },
      include: { channel: { select: { name: true } } }
    });
    if (!existing) throw new NotFoundException('Notification rule not found');
    const scope = await this.resolveScope(organizationId, existing.scopeType, existing.scopeId);
    await this.assertCanEditScope(organizationId, scope, actor);

    const data: Record<string, unknown> = {};
    if (input.events !== undefined) {
      data.events = this.validateEvents(input.events, scope.scopeType);
    }
    if (input.mode !== undefined) data.mode = input.mode === 'mute' ? 'mute' : 'deliver';
    if (input.enabled !== undefined) data.enabled = Boolean(input.enabled);

    const rule = await this.prisma.notificationRule.update({
      where: { id: ruleId },
      data,
      include: { channel: { select: { id: true, name: true, type: true, enabled: true } } }
    });
    void this.audit.log({
      action: 'notification_rule.updated',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      targetType: 'notification_rule',
      targetId: rule.id,
      targetLabel: `${existing.channel.name} @ ${scope.label}`,
      metadata: { scopeType: scope.scopeType, scopeId: scope.scopeId }
    });
    return rule;
  }

  async deleteRule(organizationId: string, ruleId: string, actor: Actor) {
    const existing = await this.prisma.notificationRule.findFirst({
      where: { id: ruleId, organizationId },
      include: { channel: { select: { name: true, scopeType: true, scopeId: true } } }
    });
    if (!existing) throw new NotFoundException('Notification rule not found');
    const scope = await this.resolveScope(organizationId, existing.scopeType, existing.scopeId);
    await this.assertCanEditScope(organizationId, scope, actor);

    await this.prisma.notificationRule.delete({ where: { id: ruleId } });
    // A destination this scope owns exists only to serve its rules, and with the
    // last one gone it is invisible in the UI while still counting against the
    // scope's allowance. Shared destinations from the org or the project are
    // never touched.
    const orphaned =
      ownsChannel(scope, existing.channel) &&
      (await this.prisma.notificationRule.count({ where: { channelId: existing.channelId } })) ===
        0;
    if (orphaned) {
      await this.prisma.notificationChannel.delete({ where: { id: existing.channelId } });
    }
    void this.audit.log({
      action: 'notification_rule.deleted',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      targetType: 'notification_rule',
      targetId: ruleId,
      targetLabel: `${existing.channel.name} @ ${scope.label}`,
      metadata: {
        scopeType: existing.scopeType,
        scopeId: existing.scopeId,
        removedChannel: orphaned
      }
    });
    return { success: true };
  }

  private validateEvents(events: unknown, scopeType: RuleScopeType): NotificationEventName[] {
    const list = Array.isArray(events) ? [...new Set(events.map(String))] : [];
    if (list.length === 0) throw new BadRequestException('Select at least one event');
    const invalid = list.filter((e) => !(NOTIFICATION_EVENTS as readonly string[]).includes(e));
    if (invalid.length > 0) throw new BadRequestException(`Unknown events: ${invalid.join(', ')}`);
    // A deployment cannot emit a backup event, so a rule that subscribes to one
    // there is a mistake worth surfacing at save time rather than a silent no-op.
    const allowed = new Set<string>(eventsForScopeType(scopeType));
    const outOfScope = list.filter((e) => !allowed.has(e));
    if (outOfScope.length > 0) {
      throw new BadRequestException(
        `These events never happen on a ${scopeType}: ${outOfScope.join(', ')}`
      );
    }
    return list as NotificationEventName[];
  }

  async resolveScope(
    organizationId: string,
    scopeType: string | undefined,
    scopeId: string | null
  ): Promise<ResolvedScope> {
    if (!scopeType || !(RULE_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
      throw new BadRequestException(`Scope must be one of: ${RULE_SCOPE_TYPES.join(', ')}`);
    }
    if (scopeType === 'org') {
      return { scopeType: 'org', scopeId: null, projectId: null, label: 'organization' };
    }
    if (!scopeId) throw new BadRequestException(`A ${scopeType} scope needs an id`);

    if (scopeType === 'project') {
      const project = await this.prisma.project.findFirst({
        where: { id: scopeId, organizationId },
        select: { id: true, name: true }
      });
      if (!project) throw new NotFoundException('Project not found');
      return {
        scopeType: 'project',
        scopeId: project.id,
        projectId: project.id,
        label: project.name
      };
    }
    if (scopeType === 'deployment') {
      const dep = await this.prisma.deployment.findFirst({
        where: { id: scopeId, project: { organizationId } },
        select: { id: true, name: true, displayName: true, projectId: true }
      });
      if (!dep) throw new NotFoundException('Deployment not found');
      return {
        scopeType: 'deployment',
        scopeId: dep.id,
        projectId: dep.projectId,
        label: dep.displayName || dep.name
      };
    }
    if (scopeType === 'database') {
      const db = await this.prisma.database.findFirst({
        where: { id: scopeId, project: { organizationId } },
        select: { id: true, name: true, projectId: true }
      });
      if (!db) throw new NotFoundException('Database not found');
      return { scopeType: 'database', scopeId: db.id, projectId: db.projectId, label: db.name };
    }
    const job = await this.prisma.job.findFirst({
      where: { id: scopeId, project: { organizationId } },
      select: { id: true, name: true, projectId: true }
    });
    if (!job) throw new NotFoundException('Job not found');
    return { scopeType: 'job', scopeId: job.id, projectId: job.projectId, label: job.name };
  }

  // Org scope needs an org admin; anything narrower is enough to be an admin of
  // the owning project. Destinations owned by a scope are gated the same way,
  // which is what lets a project admin point their own app at their own webhook.
  async assertCanEditScope(organizationId: string, scope: ResolvedScope, actor: Actor) {
    const access = await this.authz.getOrgAccess(organizationId, actor.id);
    if (access?.isAdmin) return;
    if (scope.scopeType === 'org' || !scope.projectId) {
      throw new ForbiddenException(
        'Only organization admins can manage org-wide notification rules'
      );
    }
    const project = await this.prisma.project.findFirst({
      where: { id: scope.projectId, organizationId },
      select: { ownerId: true, createdBy: true }
    });
    if (project?.ownerId === actor.id || project?.createdBy === actor.id) return;
    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId: scope.projectId, userId: actor.id },
      select: { role: { select: { name: true } } }
    });
    const role = membership?.role?.name?.toLowerCase();
    if (role === 'admin' || role === 'owner' || role === 'maintainer') return;
    throw new ForbiddenException(
      'You need admin access to this project to change its notification rules'
    );
  }
}
