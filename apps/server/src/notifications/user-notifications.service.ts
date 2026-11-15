import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { EMAIL_UNAVAILABLE, NotificationTransport } from './notification-transport';
import { NotificationRulesService } from './notification-rules.service';
import { assertSafeWebhookUrl } from './webhook-guard';
import {
  CATEGORY_DEFAULT_VALUE,
  DEFAULT_SETTING_VALUE,
  GLOBAL_SCOPE_ID,
  EXTENSION_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NotificationCategory,
  NotificationMessage,
  SETTING_SCOPE_TYPES,
  SETTING_VALUES,
  SettingValue,
  USER_DESTINATION_TYPES
} from './notification-events';

const MAX_WEBHOOK_DESTINATIONS = 3;

export interface SettingsInput {
  values?: Partial<Record<NotificationCategory, string>>;
}

export interface DestinationInput {
  type?: string;
  url?: string;
}

// A person's own preferences, nobody else's. Nothing in here can add or remove
// a delivery to a shared channel; the worst it can do is silence your own inbox.
@Injectable()
export class UserNotificationsService {
  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly transport: NotificationTransport,
    private readonly rules: NotificationRulesService,
    private readonly authz: AuthorizationService
  ) {}

  // A project, app, database or job that exists in the org but that this member
  // cannot see answers exactly like one that does not exist: otherwise the
  // scope label (its name) and a 200/404 split would reveal it.
  private async resolveVisibleScope(
    userId: string,
    organizationId: string,
    scopeType: string,
    scopeId: string | null
  ) {
    const scope = await this.rules.resolveScope(organizationId, scopeType, scopeId);
    if (scope.projectId) {
      const access = await this.authz.resolveProjectAccess(scope.projectId, organizationId, userId);
      if (!access?.canView) {
        const noun = scope.scopeType.charAt(0).toUpperCase() + scope.scopeType.slice(1);
        throw new NotFoundException(`${noun} not found`);
      }
    }
    return scope;
  }

  async getSettings(userId: string) {
    const rows = await this.prisma.userNotificationSetting.findMany({
      where: { userId },
      orderBy: [{ scopeType: 'asc' }, { createdAt: 'asc' }]
    });

    const global: Record<string, SettingValue> = {};
    for (const category of NOTIFICATION_CATEGORIES)
      global[category] = CATEGORY_DEFAULT_VALUE[category];
    const overrides = new Map<
      string,
      { scopeType: string; scopeId: string; values: Record<string, SettingValue> }
    >();
    for (const row of rows) {
      if (row.scopeType === 'global') {
        global[row.category] = row.value as SettingValue;
        continue;
      }
      const key = `${row.scopeType}:${row.scopeId}`;
      const entry = overrides.get(key) ?? {
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        values: {}
      };
      entry.values[row.category] = row.value as SettingValue;
      overrides.set(key, entry);
    }

    return {
      global,
      defaultValue: DEFAULT_SETTING_VALUE,
      overrides: await this.labelOverrides([...overrides.values()]),
      extensionCategories: EXTENSION_CATEGORIES
    };
  }

  // Resolves what a user would actually get at one scope, and where that answer
  // came from. The UI shows the inherited default next to the control so nobody
  // has to guess whether they are looking at their own choice or a fallback.
  async getScopeSettings(
    userId: string,
    organizationId: string,
    scopeType: string,
    scopeId: string
  ) {
    const scope = await this.resolveVisibleScope(userId, organizationId, scopeType, scopeId);
    const chain: { scopeType: string; scopeId: string }[] = [
      { scopeType: 'global', scopeId: GLOBAL_SCOPE_ID },
      { scopeType: 'org', scopeId: organizationId }
    ];
    if (scope.projectId) chain.push({ scopeType: 'project', scopeId: scope.projectId });
    if (scope.scopeType !== 'project' && scope.scopeId) {
      chain.push({ scopeType: scope.scopeType, scopeId: scope.scopeId });
    }

    const rows = await this.prisma.userNotificationSetting.findMany({
      where: { userId, OR: chain.map((c) => ({ scopeType: c.scopeType, scopeId: c.scopeId })) }
    });

    const rank: Record<string, number> = { global: 0, org: 1, project: 2 };
    const out: Record<string, { value: SettingValue; source: string; own: boolean }> = {};
    for (const category of NOTIFICATION_CATEGORIES) {
      let best: { value: SettingValue; source: string; rank: number } = {
        value: CATEGORY_DEFAULT_VALUE[category],
        source: 'default',
        rank: -1
      };
      for (const row of rows) {
        if (row.category !== category) continue;
        const r = rank[row.scopeType] ?? 3;
        if (r > best.rank)
          best = { value: row.value as SettingValue, source: row.scopeType, rank: r };
      }
      out[category] = {
        value: best.value,
        source: best.source,
        own: best.source === scope.scopeType
      };
    }
    return { scope, categories: out };
  }

  async setSettings(
    userId: string,
    scopeType: string,
    scopeId: string | null,
    input: SettingsInput,
    organizationId?: string
  ) {
    if (!(SETTING_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
      throw new BadRequestException(`Scope must be one of: ${SETTING_SCOPE_TYPES.join(', ')}`);
    }
    if (scopeType !== 'global') {
      if (!organizationId)
        throw new BadRequestException('An organization is required for scoped settings');
      await this.resolveVisibleScope(userId, organizationId, scopeType, scopeId);
    }
    const values = input.values ?? {};
    const writes: { category: NotificationCategory; value: SettingValue | null }[] = [];
    for (const [rawCategory, rawValue] of Object.entries(values)) {
      const category = rawCategory as NotificationCategory;
      if (!NOTIFICATION_CATEGORIES.includes(category)) {
        throw new BadRequestException(`Unknown category: ${rawCategory}`);
      }
      // An explicit null clears the override and hands the category back to the
      // broader scope, which is how you undo a per-project tweak.
      if (rawValue === null || rawValue === 'inherit') {
        writes.push({ category, value: null });
        continue;
      }
      if (!SETTING_VALUES.includes(rawValue as SettingValue)) {
        throw new BadRequestException(`Value must be one of: ${SETTING_VALUES.join(', ')}`);
      }
      writes.push({ category, value: rawValue as SettingValue });
    }

    let resolvedScopeId: string;
    if (scopeType === 'global') resolvedScopeId = GLOBAL_SCOPE_ID;
    else if (scopeType === 'org') resolvedScopeId = organizationId as string;
    else resolvedScopeId = scopeId as string;

    for (const write of writes) {
      if (write.value === null) {
        await this.prisma.userNotificationSetting.deleteMany({
          where: { userId, scopeType, scopeId: resolvedScopeId, category: write.category }
        });
        continue;
      }
      await this.prisma.userNotificationSetting.upsert({
        where: {
          userId_scopeType_scopeId_category: {
            userId,
            scopeType,
            scopeId: resolvedScopeId,
            category: write.category
          }
        },
        create: {
          userId,
          scopeType,
          scopeId: resolvedScopeId,
          category: write.category,
          value: write.value
        },
        update: { value: write.value }
      });
    }
    return scopeType === 'global' ? this.getSettings(userId) : { success: true };
  }

  // Deleting your own overrides needs no organization context: it only ever
  // removes your rows, and it has to keep working after the project it pointed
  // at is gone, which is exactly when a stale override is most annoying.
  async clearScopeSettings(userId: string, scopeType: string, scopeId: string) {
    if (scopeType === 'global') {
      throw new BadRequestException('Set your defaults instead of clearing them');
    }
    const { count } = await this.prisma.userNotificationSetting.deleteMany({
      where: { userId, scopeType, scopeId }
    });
    return { cleared: count };
  }

  async listDestinations(userId: string) {
    await this.ensureEmailDestination(userId);
    const rows = await this.prisma.userNotificationDestination.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        config: true,
        enabled: true,
        consecutiveFailures: true,
        circuitOpenUntil: true,
        lastSuccessAt: true,
        lastErrorAt: true,
        lastError: true,
        createdAt: true
      }
    });
    return rows.map((row) => ({
      ...row,
      config: row.type === 'email' ? {} : { urlConfigured: Boolean((row.config as any)?.url) }
    }));
  }

  // Created disabled, on purpose. This runs from a GET of the settings page, so
  // if it seeded an enabled row then merely looking at the page would sign you
  // up for mail you never asked for. The row exists only to give the UI
  // something to toggle; nothing is delivered until the person turns it on.
  async ensureEmailDestination(userId: string, enabled = false) {
    const existing = await this.prisma.userNotificationDestination.findFirst({
      where: { userId, type: 'email' },
      select: { id: true }
    });
    if (existing) {
      if (enabled) {
        await this.prisma.userNotificationDestination.update({
          where: { id: existing.id },
          data: { enabled: true, consecutiveFailures: 0, circuitOpenUntil: null, lastError: null }
        });
      }
      return existing.id;
    }
    const created = await this.prisma.userNotificationDestination.create({
      data: { userId, type: 'email', config: {}, enabled },
      select: { id: true }
    });
    return created.id;
  }

  async addDestination(userId: string, input: DestinationInput) {
    const type = input.type;
    if (!type || !(USER_DESTINATION_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(`Type must be one of: ${USER_DESTINATION_TYPES.join(', ')}`);
    }
    // Posting here is a deliberate act, unlike the GET above, so this is the one
    // path allowed to switch mail on.
    if (type === 'email') {
      if (!this.transport.canSendEmail()) throw new BadRequestException(EMAIL_UNAVAILABLE);
      const id = await this.ensureEmailDestination(userId, true);
      return { id, type: 'email', enabled: true };
    }
    const url = (input.url ?? '').trim();
    if (!url) throw new BadRequestException('Webhook URL is required');
    await assertSafeWebhookUrl(url);

    const count = await this.prisma.userNotificationDestination.count({
      where: { userId, type: { in: ['slack', 'discord'] } }
    });
    if (count >= MAX_WEBHOOK_DESTINATIONS) {
      throw new BadRequestException(
        `You can have at most ${MAX_WEBHOOK_DESTINATIONS} personal webhooks`
      );
    }
    const created = await this.prisma.userNotificationDestination.create({
      data: { userId, type, config: { url }, enabled: true },
      select: { id: true, type: true, enabled: true, createdAt: true }
    });
    return created;
  }

  async setDestinationEnabled(userId: string, destinationId: string, enabled: boolean) {
    const dest = await this.prisma.userNotificationDestination.findFirst({
      where: { id: destinationId, userId },
      select: { id: true, type: true }
    });
    if (!dest) throw new NotFoundException('Destination not found');
    if (enabled && dest.type === 'email' && !this.transport.canSendEmail()) {
      throw new BadRequestException(EMAIL_UNAVAILABLE);
    }
    await this.prisma.userNotificationDestination.update({
      where: { id: destinationId },
      data: enabled
        ? { enabled: true, consecutiveFailures: 0, circuitOpenUntil: null, lastError: null }
        : { enabled: false }
    });
    return { success: true };
  }

  async deleteDestination(userId: string, destinationId: string) {
    const dest = await this.prisma.userNotificationDestination.findFirst({
      where: { id: destinationId, userId },
      select: { id: true, type: true }
    });
    if (!dest) throw new NotFoundException('Destination not found');
    if (dest.type === 'email') {
      throw new BadRequestException('Turn the email destination off instead of deleting it');
    }
    await this.prisma.userNotificationDestination.delete({ where: { id: destinationId } });
    return { success: true };
  }

  async testDestination(userId: string, destinationId: string) {
    const dest = await this.prisma.userNotificationDestination.findFirst({
      where: { id: destinationId, userId },
      select: {
        id: true,
        type: true,
        config: true,
        user: { select: { email: true, username: true } }
      }
    });
    if (!dest) throw new NotFoundException('Destination not found');
    const message: NotificationMessage = {
      event: 'deploy.succeeded',
      title: 'Test notification from Orchard',
      body: 'Your personal notifications work.',
      url: this.frontendUrl
    };
    const outcome = await this.transport.send(
      {
        type: dest.type,
        config:
          dest.type === 'email'
            ? { recipients: [dest.user.email] }
            : { url: (dest.config as any)?.url },
        label: `${dest.type} for ${dest.user.username}`
      },
      [message]
    );
    return outcome.ok ? { success: true } : { success: false, error: outcome.error };
  }

  // The overrides list is the allowlist made visible. Names come from the
  // referenced rows so a stale override reads as "deleted" rather than a uuid.
  private async labelOverrides(
    entries: { scopeType: string; scopeId: string; values: Record<string, SettingValue> }[]
  ) {
    const byType = (type: string) =>
      entries.filter((e) => e.scopeType === type && e.scopeId).map((e) => e.scopeId);

    const [projects, deployments, databases, jobs, orgs] = await Promise.all([
      this.prisma.project.findMany({
        where: { id: { in: byType('project') } },
        select: { id: true, name: true, organization: { select: { slug: true } } }
      }),
      this.prisma.deployment.findMany({
        where: { id: { in: byType('deployment') } },
        select: {
          id: true,
          name: true,
          displayName: true,
          project: { select: { name: true, organization: { select: { slug: true } } } }
        }
      }),
      this.prisma.database.findMany({
        where: { id: { in: byType('database') } },
        select: {
          id: true,
          name: true,
          project: { select: { name: true, organization: { select: { slug: true } } } }
        }
      }),
      this.prisma.job.findMany({
        where: { id: { in: byType('job') } },
        select: {
          id: true,
          name: true,
          project: { select: { name: true, organization: { select: { slug: true } } } }
        }
      }),
      this.prisma.organization.findMany({
        where: { id: { in: byType('org') } },
        select: { id: true, name: true, slug: true }
      })
    ]);

    const labels = new Map<
      string,
      { label: string; context: string | null; orgSlug: string | null }
    >();
    for (const p of projects) {
      labels.set(`project:${p.id}`, { label: p.name, context: null, orgSlug: p.organization.slug });
    }
    for (const d of deployments) {
      labels.set(`deployment:${d.id}`, {
        label: d.displayName || d.name,
        context: d.project.name,
        orgSlug: d.project.organization.slug
      });
    }
    for (const d of databases) {
      labels.set(`database:${d.id}`, {
        label: d.name,
        context: d.project.name,
        orgSlug: d.project.organization.slug
      });
    }
    for (const j of jobs) {
      labels.set(`job:${j.id}`, {
        label: j.name,
        context: j.project.name,
        orgSlug: j.project.organization.slug
      });
    }
    for (const o of orgs) {
      labels.set(`org:${o.id}`, { label: o.name, context: null, orgSlug: o.slug });
    }

    return entries.map((entry) => {
      const meta = labels.get(`${entry.scopeType}:${entry.scopeId}`);
      return {
        ...entry,
        label: meta?.label ?? '(deleted)',
        context: meta?.context ?? null,
        orgSlug: meta?.orgSlug ?? null,
        missing: !meta
      };
    });
  }
}
