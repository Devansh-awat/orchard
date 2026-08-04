import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationTransport } from './notification-transport';
import { NotificationDeliveryService } from './notification-delivery.service';
import { assertSafeWebhookUrl } from './webhook-guard';
import { NOTIFICATION_CHANNEL_TYPES, NotificationMessage } from './notification-events';
import { replayKey } from './dedupe-keys';

const MAX_CHANNELS_PER_ORG = 20;
const MAX_EMAIL_RECIPIENTS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REPLAY_HOURS = 72;
const MAX_REPLAY_EVENTS = 200;

export interface ChannelInput {
  name?: string;
  type?: string;
  config?: { url?: string; recipients?: string[] };
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

// Channels are destinations now: a name, a transport, and health. What they
// receive is decided by NotificationRule, which is why nothing here mentions
// events or projects.
@Injectable()
export class NotificationChannelsService {
  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly transport: NotificationTransport,
    private readonly delivery: NotificationDeliveryService,
  ) {}

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
        _count: { select: { rules: true } },
      },
    });
    return channels.map(({ deliveries, _count, ...ch }) => ({
      ...sanitizeChannel(ch),
      ruleCount: _count.rules,
      health: healthOf(ch),
      lastDelivery: deliveries[0] ?? null,
    }));
  }

  async createChannel(organizationId: string, input: ChannelInput, actor: Actor) {
    const existing = await this.prisma.notificationChannel.count({ where: { organizationId } });
    if (existing >= MAX_CHANNELS_PER_ORG) {
      throw new BadRequestException(
        `Organizations are limited to ${MAX_CHANNELS_PER_ORG} notification channels`,
      );
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
    // Re-enabling by hand is the operator saying the endpoint is fixed, so give
    // the breaker a clean slate instead of making them wait out the old window.
    if (input.enabled === true && !existing.enabled) {
      Object.assign(data, {
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        autoDisabledAt: null,
        lastError: null,
      });
    }
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
      take: 50,
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        httpStatus: true,
        error: true,
        nextAttemptAt: true,
        deliveredAt: true,
        coalescedCount: true,
        createdAt: true,
      },
    });
  }

  async testChannel(organizationId: string, channelId: string) {
    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id: channelId, organizationId },
    });
    if (!channel) throw new NotFoundException('Notification channel not found');
    const message: NotificationMessage = {
      event: 'deploy.succeeded',
      title: 'Test notification from Orchard',
      body: `Channel "${channel.name}" is wired up correctly.`,
      url: this.frontendUrl,
    };
    const outcome = await this.transport.send(
      {
        type: channel.type,
        config: (channel.config ?? {}) as ChannelConfig,
        label: `channel "${channel.name}"`,
        organizationId,
      },
      [message],
    );
    return outcome.ok ? { success: true } : { success: false, error: outcome.error };
  }

  // The point of keeping events separate from deliveries: after an outage the
  // payloads are still here, so a channel can be handed everything it missed
  // instead of the operator reconstructing it from memory.
  async replay(organizationId: string, channelId: string, sinceHours: number, actor: Actor) {
    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id: channelId, organizationId },
      select: { id: true, name: true, enabled: true },
    });
    if (!channel) throw new NotFoundException('Notification channel not found');
    if (!channel.enabled) {
      throw new BadRequestException('Re-enable this channel before replaying to it');
    }
    const hours = Math.min(Math.max(Math.floor(sinceHours) || 1, 1), MAX_REPLAY_HOURS);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Only events this channel's rules would have matched anyway. Replay is a
    // do-over, not a way to route around the rules.
    const rules = await this.prisma.notificationRule.findMany({
      where: { channelId, enabled: true, mode: 'deliver' },
      select: { events: true },
    });
    const wanted = new Set(rules.flatMap((r) => (Array.isArray(r.events) ? (r.events as string[]) : [])));
    if (wanted.size === 0) {
      return { queued: 0, message: 'This channel has no rules, so there is nothing to replay' };
    }

    const events = await this.prisma.notificationEvent.findMany({
      where: { organizationId, occurredAt: { gte: since }, event: { in: [...wanted] } },
      orderBy: { occurredAt: 'asc' },
      take: MAX_REPLAY_EVENTS,
      select: { id: true, event: true, payload: true },
    });

    const stamp = Date.now();
    let queued = 0;
    for (const event of events) {
      const payload = event.payload as NotificationMessage;
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO "notification_deliveries" (
          "id", "event_id", "destination_key", "channel_id", "event", "target_id",
          "status", "next_attempt_at", "created_at"
        ) VALUES (
          gen_random_uuid(), ${event.id}::uuid, ${replayKey(event.id, channelId, stamp)},
          ${channelId}::uuid, ${event.event}, ${payload?.targetId ?? null}::uuid,
          'pending', (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')
        )
        ON CONFLICT ("event_id", "destination_key") DO NOTHING
      `;
      queued += inserted;
    }
    void this.audit.log({
      action: 'notification_channel.replayed',
      actorUserId: actor.id,
      actorEmail: actor.email ?? undefined,
      organizationId,
      targetType: 'notification_channel',
      targetId: channelId,
      targetLabel: channel.name,
      metadata: { hours, queued },
    });
    if (queued > 0) this.delivery.kick();
    return {
      queued,
      truncated: events.length === MAX_REPLAY_EVENTS,
      message:
        events.length === MAX_REPLAY_EVENTS
          ? `Queued the most recent ${MAX_REPLAY_EVENTS} events; narrow the window to replay the rest`
          : undefined,
    };
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
      if (!name || name.length > 100) {
        throw new BadRequestException('Channel name must be 1-100 characters');
      }
      out.name = name;
    }

    const type = input.type as (typeof NOTIFICATION_CHANNEL_TYPES)[number];
    if (!NOTIFICATION_CHANNEL_TYPES.includes(type)) {
      throw new BadRequestException(
        `Channel type must be one of: ${NOTIFICATION_CHANNEL_TYPES.join(', ')}`,
      );
    }
    if (isCreate) out.type = type;

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
          await assertSafeWebhookUrl(url);
          out.config = {
            url,
            ...(existingConfig?.secret ? { secret: existingConfig.secret } : {}),
          };
        }
      }
    }

    if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);

    return out;
  }

  private async memberEmails(organizationId: string): Promise<Set<string>> {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId },
      select: { user: { select: { email: true } } },
    });
    return new Set(members.map((m) => m.user.email?.toLowerCase()).filter(Boolean) as string[]);
  }
}

export function sanitizeChannel<T extends { type: string; config: unknown }>(channel: T): T {
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

function healthOf(channel: {
  enabled: boolean;
  autoDisabledAt: Date | null;
  circuitOpenUntil: Date | null;
  consecutiveFailures: number;
  lastErrorAt: Date | null;
}): { state: 'healthy' | 'failing' | 'paused' | 'auto_disabled' | 'disabled'; until?: Date; since?: Date } {
  if (channel.autoDisabledAt) return { state: 'auto_disabled', since: channel.autoDisabledAt };
  if (!channel.enabled) return { state: 'disabled' };
  if (channel.circuitOpenUntil && channel.circuitOpenUntil.getTime() > Date.now()) {
    return { state: 'paused', until: channel.circuitOpenUntil, since: channel.lastErrorAt ?? undefined };
  }
  if (channel.consecutiveFailures > 0) {
    return { state: 'failing', since: channel.lastErrorAt ?? undefined };
  }
  return { state: 'healthy' };
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
