import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { lookup as dnsLookup } from 'dns';
import { lookup as dnsLookupAsync } from 'dns/promises';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { createHmac, randomBytes } from 'crypto';
import { isIP } from 'net';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  EVENT_TONE,
  NOTIFICATION_CHANNEL_TYPES,
  NOTIFICATION_EVENTS,
  NotificationEventName,
  NotificationMessage,
  TONE_COLORS,
} from './notification-events';

const DEDUPE_TTL_MS = 2 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 3_000;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_WINDOW = 60;
const THROTTLE_LOG_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CHANNELS_PER_ORG = 20;
const MAX_EMAIL_RECIPIENTS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOCKED_HOST_SUFFIXES = ['.svc', '.cluster.local', '.internal', '.local', '.localhost'];

export interface ChannelInput {
  name?: string;
  type?: string;
  config?: { url?: string; recipients?: string[] };
  events?: string[];
  projectIds?: string[] | null;
  enabled?: boolean;
}

interface Actor {
  id: string;
  email?: string | null;
}

interface ChannelConfig {
  url?: string;
  recipients?: string[];
  secret?: string;
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  private readonly recentSends = new Map<string, number>();

  private readonly lastThrottleLog = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
  ) {}

  async notifyDeploy(deploymentId: string, status: 'succeeded' | 'failed') {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        buildError: true,
        githubBranch: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } },
          },
        },
      },
    });
    if (!dep) return;
    const succeeded = status === 'succeeded';
    await this.notify(dep.project.organizationId, {
      event: succeeded ? 'deploy.succeeded' : 'deploy.failed',
      title: `Deploy ${status}: ${dep.name}`,
      body: succeeded
        ? `${dep.name} in ${dep.project.name} deployed successfully.`
        : truncate(dep.buildError, 400) || `${dep.name} in ${dep.project.name} failed to build.`,
      url: `${this.frontendUrl}/${dep.project.organization.slug}/deployments/${dep.id}`,
      projectId: dep.project.id,
      projectName: dep.project.name,
      targetId: dep.id,
      targetName: dep.name,
      fields: dep.githubBranch ? [{ name: 'Branch', value: dep.githubBranch }] : undefined,
    });
  }

  async notifyPodState(deploymentId: string, state: 'crashing' | 'recovered', detail?: string) {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } },
          },
        },
      },
    });
    if (!dep) return;
    const crashing = state === 'crashing';
    await this.notify(dep.project.organizationId, {
      event: crashing ? 'pod.crashing' : 'pod.recovered',
      title: crashing ? `App crashing: ${dep.name}` : `App recovered: ${dep.name}`,
      body: crashing
        ? `${dep.name} in ${dep.project.name} is failing to start${detail ? `: ${detail}` : '.'}`
        : `${dep.name} in ${dep.project.name} is running again.`,
      url: `${this.frontendUrl}/${dep.project.organization.slug}/deployments/${dep.id}`,
      projectId: dep.project.id,
      projectName: dep.project.name,
      targetId: dep.id,
      targetName: dep.name,
    });
  }

  async notifyBackup(backupId: string, status: 'completed' | 'failed') {
    const backup = await this.prisma.databaseBackup.findUnique({
      where: { id: backupId },
      select: {
        id: true,
        label: true,
        errorMessage: true,
        database: {
          select: {
            id: true,
            name: true,
            project: {
              select: {
                id: true,
                name: true,
                organizationId: true,
                organization: { select: { slug: true } },
              },
            },
          },
        },
      },
    });
    if (!backup) return;
    const db = backup.database;
    const completed = status === 'completed';
    await this.notify(db.project.organizationId, {
      event: completed ? 'backup.completed' : 'backup.failed',
      title: `Backup ${status}: ${db.name}`,
      body: completed
        ? `Backup "${backup.label}" of ${db.name} completed successfully.`
        : `Backup "${backup.label}" of ${db.name} failed${backup.errorMessage ? `: ${truncate(backup.errorMessage, 300)}` : '.'}`,
      url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}`,
      projectId: db.project.id,
      projectName: db.project.name,
      targetId: backup.id,
      targetName: db.name,
    });
  }

  async notify(organizationId: string, message: NotificationMessage) {
    // Dispatch kill switch. The 'notifications' flag is enrollment-based (early
    // access), so force the enrollment property here: disabling the flag stops
    // all sends; per-user rollout is enforced at the management endpoints.
    const enabled = await this.analytics.isFeatureEnabled('notifications', organizationId, {
      personProperties: { '$feature_enrollment/notifications': true },
    });
    if (!enabled) return;

    const dedupeKey = `${organizationId}:${message.event}:${message.targetId ?? ''}`;
    const now = Date.now();
    const last = this.recentSends.get(dedupeKey);
    if (last && now - last < DEDUPE_TTL_MS) return;
    this.recentSends.set(dedupeKey, now);
    if (this.recentSends.size > 1000) {
      for (const [k, t] of this.recentSends) {
        if (now - t > DEDUPE_TTL_MS) this.recentSends.delete(k);
      }
    }

    const channels = await this.prisma.notificationChannel.findMany({
      where: { organizationId, enabled: true },
    });
    const matching = channels.filter((ch) => {
      const events = Array.isArray(ch.events) ? (ch.events as string[]) : [];
      if (!events.includes(message.event)) return false;
      const projectIds = Array.isArray(ch.projectIds) ? (ch.projectIds as string[]) : null;
      if (projectIds && projectIds.length > 0 && message.projectId && !projectIds.includes(message.projectId)) {
        return false;
      }
      return true;
    });
    if (matching.length === 0) return;
    await Promise.allSettled(matching.map((ch) => this.deliver(ch, message)));
  }

  private async deliver(channel: NotificationChannel, message: NotificationMessage) {
    if (!(await this.underRateLimit(channel.id))) {
      this.recordThrottled(channel.id, message.event, message.targetId ?? null);
      return;
    }
    let error: string | null = null;
    try {
      await this.send(channel, message);
    } catch (e: any) {
      error = truncate(String(e?.message ?? e), 2000);
    }
    await this.recordDelivery(channel.id, message.event, message.targetId ?? null, error ? 'failed' : 'sent', error);
    if (error) {
      this.logger.warn(`delivery failed for channel ${channel.id} (${channel.type}): ${error}`);
    }
  }

  private async underRateLimit(channelId: string): Promise<boolean> {
    try {
      const count = await this.prisma.notificationDelivery.count({
        where: {
          channelId,
          status: { in: ['sent', 'failed'] },
          createdAt: { gt: new Date(Date.now() - RATE_WINDOW_MS) },
        },
      });
      return count < RATE_LIMIT_PER_WINDOW;
    } catch {
      return true;
    }
  }

  private recordThrottled(channelId: string, event: string, targetId: string | null) {
    const now = Date.now();
    const last = this.lastThrottleLog.get(channelId) ?? 0;
    if (now - last < THROTTLE_LOG_INTERVAL_MS) return;
    this.lastThrottleLog.set(channelId, now);
    this.logger.warn(`channel ${channelId} exceeded ${RATE_LIMIT_PER_WINDOW} deliveries/hour; throttling`);
    void this.recordDelivery(channelId, event, targetId, 'throttled', 'Rate limit exceeded');
  }

  private async recordDelivery(
    channelId: string,
    event: string,
    targetId: string | null,
    status: 'sent' | 'failed' | 'throttled',
    error: string | null,
  ) {
    try {
      await this.prisma.notificationDelivery.create({
        data: { channelId, event, targetId, status, error },
      });
      await this.prisma.notificationDelivery.deleteMany({
        where: { channelId, createdAt: { lt: new Date(Date.now() - DELIVERY_RETENTION_MS) } },
      });
    } catch (e: any) {
      this.logger.warn(`failed to record delivery for channel ${channelId}: ${e?.message ?? e}`);
    }
  }

  private async send(channel: NotificationChannel, message: NotificationMessage) {
    const config = (channel.config ?? {}) as ChannelConfig;
    switch (channel.type) {
      case 'discord':
        return this.postJson(config.url, {
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: truncate(message.title, 250),
              description: truncate(message.body, 2000),
              url: message.url,
              color: TONE_COLORS[EVENT_TONE[message.event]],
              fields: (message.fields ?? []).map((f) => ({
                name: truncate(f.name, 250),
                value: truncate(f.value, 1000),
                inline: true,
              })),
              footer: { text: message.projectName ? `Orchard · ${truncate(message.projectName, 100)}` : 'Orchard' },
              timestamp: new Date().toISOString(),
            },
          ],
        });
      case 'slack': {
        const title = slackEscape(truncate(message.title, 250));
        const body = slackEscape(truncate(message.body, 2000));
        const heading = message.url ? `<${message.url}|${title}>` : title;
        const context = [
          ...(message.projectName ? [`*Project:* ${slackEscape(message.projectName)}`] : []),
          ...(message.fields ?? []).map((f) => `*${slackEscape(f.name)}:* ${slackEscape(f.value)}`),
        ];
        return this.postJson(config.url, {
          text: `${title} — ${body}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*${heading}*\n${body}` } },
            ...(context.length
              ? [{ type: 'context', elements: context.map((text) => ({ type: 'mrkdwn', text })) }]
              : []),
          ],
        });
      }
      case 'webhook': {
        const payload = {
          event: message.event,
          title: message.title,
          body: message.body,
          url: message.url ?? null,
          organizationId: channel.organizationId,
          projectId: message.projectId ?? null,
          projectName: message.projectName ?? null,
          targetId: message.targetId ?? null,
          targetName: message.targetName ?? null,
          fields: message.fields ?? [],
          timestamp: new Date().toISOString(),
        };
        const raw = JSON.stringify(payload);
        const headers: Record<string, string> = { 'x-orchard-event': message.event };
        if (config.secret) {
          const ts = Date.now().toString();
          headers['x-orchard-timestamp'] = ts;
          headers['x-orchard-signature'] = `sha256=${createHmac('sha256', config.secret).update(`${ts}.${raw}`).digest('hex')}`;
        }
        return this.postRaw(config.url, raw, headers);
      }
      case 'email': {
        const recipients = await this.allowedRecipients(channel.organizationId, config.recipients ?? []);
        if (recipients.length === 0) {
          throw new Error('No recipients are current organization members');
        }
        const sent = await this.email.sendNotificationEmail({
          recipients,
          subject: message.title,
          title: message.title,
          body: message.body,
          contextLine: message.projectName ? `Project: ${message.projectName}` : '',
          ctaUrl: message.url || this.frontendUrl,
        });
        if (!sent) throw new Error('Email sending failed or SMTP is not configured');
        return undefined;
      }
      default:
        throw new Error(`Unknown channel type: ${channel.type}`);
    }
  }

  private async allowedRecipients(organizationId: string, recipients: string[]): Promise<string[]> {
    const memberEmails = await this.memberEmails(organizationId);
    return recipients.filter((r) => memberEmails.has(r.toLowerCase()));
  }

  private async memberEmails(organizationId: string): Promise<Set<string>> {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId },
      select: { user: { select: { email: true } } },
    });
    return new Set(members.map((m) => m.user.email?.toLowerCase()).filter(Boolean) as string[]);
  }

  private async postJson(rawUrl: string | undefined, body: unknown, headers: Record<string, string> = {}) {
    return this.postRaw(rawUrl, JSON.stringify(body), headers);
  }

  private async postRaw(rawUrl: string | undefined, body: string, headers: Record<string, string> = {}) {
    if (!rawUrl) throw new Error('No webhook URL configured');
    await this.assertSafeWebhookUrl(rawUrl);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.guardedPost(rawUrl, body, headers);
        return;
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((r) => {
          setTimeout(r, RETRY_DELAY_MS);
        });
      }
    }
  }

  private guardedPost(rawUrl: string, body: string, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(rawUrl);
      const isHttps = url.protocol === 'https:';
      const payload = Buffer.from(body);
      const req = (isHttps ? httpsRequest : httpRequest)(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : defaultPort(url.protocol),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length,
            'user-agent': 'Orchard-Notifications/1.0',
            ...headers,
          },
          lookup: guardedLookup,
          timeout: HTTP_TIMEOUT_MS,
          agent: false,
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`HTTP ${status}`));
        },
      );
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  async assertSafeWebhookUrl(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('Invalid webhook URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException('Webhook URL must use http or https');
    }
    const port = url.port ? Number(url.port) : defaultPort(url.protocol);
    if (port !== 80 && port !== 443 && port < 1024) {
      throw new BadRequestException('Webhook URL port must be 80, 443, or 1024+');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      if (!isPublicAddress(host)) {
        throw new BadRequestException('Webhook URL must resolve to a public address');
      }
      return;
    }
    if (!host.includes('.') || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new BadRequestException('Webhook URL must be a public hostname');
    }
    let addresses: { address: string }[];
    try {
      addresses = await dnsLookupAsync(host, { all: true, verbatim: true });
    } catch {
      throw new BadRequestException(`Could not resolve webhook host "${host}"`);
    }
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      throw new BadRequestException('Webhook URL must resolve to a public address');
    }
  }

  async listChannels(organizationId: string) {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: {
        deliveries: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, error: true, event: true, createdAt: true },
        },
      },
    });
    return channels.map(({ deliveries, ...ch }) => ({
      ...sanitizeChannel(ch),
      lastDelivery: deliveries[0] ?? null,
    }));
  }

  async createChannel(organizationId: string, input: ChannelInput, actor: Actor) {
    const existing = await this.prisma.notificationChannel.count({ where: { organizationId } });
    if (existing >= MAX_CHANNELS_PER_ORG) {
      throw new BadRequestException(`Organizations are limited to ${MAX_CHANNELS_PER_ORG} notification channels`);
    }
    const data = await this.validateInput(organizationId, input, { isCreate: true });
    let webhookSecret: string | undefined;
    if (input.type === 'webhook') {
      webhookSecret = randomBytes(24).toString('hex');
      (data.config as ChannelConfig).secret = webhookSecret;
    }
    const channel = await this.prisma.notificationChannel.create({
      data: { organizationId, ...data } as any,
    });
    void this.audit.log({
      action: 'notification_channel.created',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      targetType: 'notification_channel',
      targetId: channel.id,
      targetLabel: channel.name,
      metadata: { type: channel.type },
    });
    return { ...sanitizeChannel(channel), ...(webhookSecret ? { webhookSecret } : {}) };
  }

  async updateChannel(organizationId: string, channelId: string, input: ChannelInput, actor: Actor) {
    const existing = await this.prisma.notificationChannel.findFirst({
      where: { id: channelId, organizationId },
    });
    if (!existing) throw new NotFoundException('Notification channel not found');
    const data = await this.validateInput(
      organizationId,
      { ...input, type: existing.type },
      { isCreate: false, existingConfig: (existing.config ?? {}) as ChannelConfig },
    );
    const channel = await this.prisma.notificationChannel.update({
      where: { id: channelId },
      data: data as any,
    });
    void this.audit.log({
      action: 'notification_channel.updated',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      targetType: 'notification_channel',
      targetId: channel.id,
      targetLabel: channel.name,
      metadata: { type: channel.type },
    });
    return sanitizeChannel(channel);
  }

  async deleteChannel(organizationId: string, channelId: string, actor: Actor) {
    const existing = await this.prisma.notificationChannel.findFirst({
      where: { id: channelId, organizationId },
    });
    if (!existing) throw new NotFoundException('Notification channel not found');
    await this.prisma.notificationChannel.delete({ where: { id: channelId } });
    void this.audit.log({
      action: 'notification_channel.deleted',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      targetType: 'notification_channel',
      targetId: existing.id,
      targetLabel: existing.name,
      metadata: { type: existing.type },
    });
    return { success: true };
  }

  async listDeliveries(organizationId: string, channelId: string) {
    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id: channelId, organizationId },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Notification channel not found');
    return this.prisma.notificationDelivery.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
  }

  async testChannel(organizationId: string, channelId: string) {
    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id: channelId, organizationId },
    });
    if (!channel) throw new NotFoundException('Notification channel not found');
    if (!(await this.underRateLimit(channel.id))) {
      return { success: false, error: 'Rate limit exceeded for this channel. Try again later.' };
    }
    const message: NotificationMessage = {
      event: 'deploy.succeeded',
      title: 'Test notification from Orchard',
      body: `Channel "${channel.name}" is wired up correctly.`,
      url: this.frontendUrl,
    };
    let error: string | null = null;
    try {
      await this.send(channel, message);
    } catch (e: any) {
      error = truncate(String(e?.message ?? e), 2000);
    }
    await this.recordDelivery(channel.id, 'test', null, error ? 'failed' : 'sent', error);
    return error ? { success: false, error } : { success: true };
  }

  private async validateInput(
    organizationId: string,
    input: ChannelInput,
    opts: { isCreate: boolean; existingConfig?: ChannelConfig },
  ) {
    const { isCreate, existingConfig } = opts;
    const out: Record<string, unknown> = {};

    if (isCreate || input.name !== undefined) {
      const name = (input.name ?? '').trim();
      if (!name || name.length > 100) throw new BadRequestException('Channel name must be 1-100 characters');
      out.name = name;
    }

    const type = input.type as (typeof NOTIFICATION_CHANNEL_TYPES)[number];
    if (!NOTIFICATION_CHANNEL_TYPES.includes(type)) {
      throw new BadRequestException(`Channel type must be one of: ${NOTIFICATION_CHANNEL_TYPES.join(', ')}`);
    }
    if (isCreate) out.type = type;

    if (isCreate || input.events !== undefined) {
      const events = Array.isArray(input.events) ? [...new Set(input.events)] : [];
      if (events.length === 0) throw new BadRequestException('Select at least one event');
      const invalid = events.filter((e) => !NOTIFICATION_EVENTS.includes(e as NotificationEventName));
      if (invalid.length > 0) throw new BadRequestException(`Unknown events: ${invalid.join(', ')}`);
      out.events = events;
    }

    if (isCreate || input.config !== undefined) {
      const config = input.config ?? {};
      if (type === 'email') {
        const recipients = Array.isArray(config.recipients)
          ? [...new Set(config.recipients.map((r) => String(r).trim().toLowerCase()).filter(Boolean))]
          : [];
        if (recipients.length === 0 || recipients.length > MAX_EMAIL_RECIPIENTS) {
          throw new BadRequestException(`Provide 1-${MAX_EMAIL_RECIPIENTS} recipient emails`);
        }
        const bad = recipients.filter((r) => !EMAIL_REGEX.test(r));
        if (bad.length > 0) throw new BadRequestException(`Invalid emails: ${bad.join(', ')}`);
        const memberEmails = await this.memberEmails(organizationId);
        const outside = recipients.filter((r) => !memberEmails.has(r));
        if (outside.length > 0) {
          throw new BadRequestException(
            `Recipients must be members of this organization: ${outside.join(', ')}`,
          );
        }
        out.config = { recipients };
      } else {
        const url = (config.url ?? '').trim();
        if (!url && !isCreate && existingConfig?.url) {
          // blank url on update = keep the stored one
        } else {
          if (!url) throw new BadRequestException('Webhook URL is required');
          await this.assertSafeWebhookUrl(url);
          out.config = {
            url,
            ...(existingConfig?.secret ? { secret: existingConfig.secret } : {}),
          };
        }
      }
    }

    if (input.projectIds !== undefined) {
      if (input.projectIds === null || input.projectIds.length === 0) {
        out.projectIds = null;
      } else {
        const ids = [...new Set(input.projectIds)];
        const count = await this.prisma.project.count({
          where: { id: { in: ids }, organizationId },
        });
        if (count !== ids.length) throw new BadRequestException('One or more projects do not belong to this organization');
        out.projectIds = ids;
      }
    }

    if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);

    return out;
  }
}

function sanitizeChannel<T extends { type: string; config: unknown }>(channel: T): T {
  const config = (channel.config ?? {}) as ChannelConfig;
  if (channel.type === 'email') {
    return { ...channel, config: { recipients: config.recipients ?? [] } };
  }
  return {
    ...channel,
    config: {
      urlConfigured: Boolean(config.url),
      urlPreview: config.url ? previewUrl(config.url) : null,
      ...(channel.type === 'webhook' ? { secretConfigured: Boolean(config.secret) } : {}),
    },
  };
}

function previewUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const tail = raw.length > 4 ? raw.slice(-4) : '';
    return `${url.protocol}//${url.host}/…${tail}`;
  } catch {
    return '(configured)';
  }
}

function slackEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function truncate(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function guardedLookup(
  hostname: string,
  options: any,
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      callback(Object.assign(new Error('Destination resolves to a non-public address'), { code: 'EBLOCKED' }));
      return;
    }
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version === 6) return isPublicIpv6(ip);
  return false;
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const groups = expandIpv6(ip.toLowerCase());
  if (!groups) return false;
  const [g0, g1] = groups;

  const embedded = extractEmbeddedIpv4(groups);
  if (embedded) return isPublicIpv4(embedded);

  const allZero = groups.every((g) => g === 0);
  if (allZero) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false;
  if ((g0 & 0xfe00) === 0xfc00) return false;
  if ((g0 & 0xffc0) === 0xfe80) return false;
  if ((g0 & 0xffc0) === 0xfec0) return false;
  if ((g0 & 0xff00) === 0xff00) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x2001 && g1 === 0x0000) return false;
  if (g0 === 0x2002) return false;
  return true;
}

function extractEmbeddedIpv4(groups: number[]): string | null {
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return toV4(groups[6], groups[7]);
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return toV4(groups[6], groups[7]);
  }
  return null;
}

function expandIpv6(ip: string): number[] | null {
  const stripped = ip.replace(/%.+$/, '');
  let head = stripped;
  let tail = '';
  const dc = stripped.indexOf('::');
  if (dc >= 0) {
    head = stripped.slice(0, dc);
    tail = stripped.slice(dc + 2);
  }
  const parse = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(':')) {
      if (part.includes('.')) {
        const v4 = part.split('.').map(Number);
        if (v4.length !== 4 || v4.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        const n = parseInt(part, 16);
        if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
        out.push(n);
      }
    }
    return out;
  };
  const headGroups = parse(head);
  const tailGroups = parse(tail);
  if (!headGroups || !tailGroups) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (dc < 0 && headGroups.length !== 8) return null;
  if (dc >= 0 && missing < 0) return null;
  return [...headGroups, ...(dc >= 0 ? Array(missing).fill(0) : []), ...tailGroups];
}
