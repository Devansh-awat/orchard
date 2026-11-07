import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationTransport, SendOutcome, TransportTarget } from './notification-transport';
import { NotificationRateLimiter } from './rate-limiter';
import { NotificationMessage } from './notification-events';
import { NotificationAccessService, redactForViewer } from './notification-access.service';

const CLAIM_BATCH = 50;
const TICK_MS = 2_000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const RECLAIM_SWEEP_MS = 60 * 1000;
const HEALTH_SWEEP_MS = 15 * 60 * 1000;

// Five attempts spread over roughly eight hours. Long enough to ride out a
// provider incident, short enough that a genuinely dead endpoint stops
// consuming the queue by the end of the working day.
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

const BREAKER_THRESHOLD = 5;
const BREAKER_BASE_MS = 5 * 60 * 1000;
const BREAKER_MAX_MS = 6 * 60 * 60 * 1000;
const AUTO_DISABLE_AFTER_MS = 24 * 60 * 60 * 1000;

// Above this many queued messages for one destination we send a single digest
// instead. Nothing is discarded: the rest are marked coalesced and still show
// up in the delivery log.
const COALESCE_THRESHOLD = 5;
const COALESCE_MAX = 20;

const REPEAT_COOLDOWN_MS = 10 * 60 * 1000;

interface ClaimedDelivery {
  id: string;
  eventId: string;
  destinationKey: string;
  channelId: string | null;
  userDestId: string | null;
  userId: string | null;
  projectId: string | null;
  event: string;
  targetId: string | null;
  attempts: number;
  payload: unknown;
}

interface ResolvedDestination {
  target: TransportTarget;
  bucketType: string;
  circuitOpenUntil: Date | null;
  enabled: boolean;
}

// Stage three of three. Claims deliveries, paces them against provider limits,
// sends, and decides what a failure means. Everything durable is a row; the only
// state kept outside Postgres is the token bucket, where losing it costs one
// extra send.
@Injectable()
export class NotificationDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  private readonly workerId = `${hostname()}-${process.pid}`;

  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  private timer: NodeJS.Timeout | null = null;

  private reclaimTimer: NodeJS.Timeout | null = null;

  private healthTimer: NodeJS.Timeout | null = null;

  private running = false;

  private runAgain = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transport: NotificationTransport,
    private readonly limiter: NotificationRateLimiter,
    private readonly email: EmailService,
    private readonly access: NotificationAccessService
  ) {}

  private readonly workerDisabled = process.env.NOTIFICATIONS_WORKER_DISABLED === 'true';

  onModuleInit() {
    if (this.workerDisabled) {
      this.logger.warn(
        'NOTIFICATIONS_WORKER_DISABLED=true; notifications queue here but another replica sends them'
      );
      return;
    }
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.timer.unref?.();
    this.reclaimTimer = setInterval(() => {
      this.reclaim().catch((e) => this.logger.warn(`delivery reclaim failed: ${e?.message ?? e}`));
    }, RECLAIM_SWEEP_MS);
    this.reclaimTimer.unref?.();
    this.healthTimer = setInterval(() => {
      this.sweepDeadChannels().catch((e) =>
        this.logger.warn(`channel health sweep failed: ${e?.message ?? e}`)
      );
    }, HEALTH_SWEEP_MS);
    this.healthTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = null;
    this.reclaimTimer = null;
    this.healthTimer = null;
  }

  kick() {
    if (this.workerDisabled) return;
    if (this.running) {
      this.runAgain = true;
      return;
    }
    this.running = true;
    void this.drain()
      .catch((e) => this.logger.warn(`delivery drain failed: ${e?.message ?? e}`))
      .finally(() => {
        this.running = false;
        if (this.runAgain) {
          this.runAgain = false;
          this.kick();
        }
      });
  }

  private async drain() {
    for (let i = 0; i < 10; i += 1) {
      const claimed = await this.claim();
      if (claimed.length === 0) return;
      const groups = new Map<string, ClaimedDelivery[]>();
      for (const d of claimed) {
        const list = groups.get(d.destinationKey);
        if (list) list.push(d);
        else groups.set(d.destinationKey, [d]);
      }
      await Promise.allSettled(
        [...groups.entries()].map(([key, batch]) => this.processGroup(key, batch))
      );
      if (claimed.length < CLAIM_BATCH) return;
    }
  }

  private async claim(): Promise<ClaimedDelivery[]> {
    return this.prisma.$queryRaw<ClaimedDelivery[]>`
      UPDATE "notification_deliveries" d
      SET "status" = 'sending', "locked_by" = ${this.workerId}, "locked_at" = (NOW() AT TIME ZONE 'UTC')
      FROM "notification_events" e
      WHERE d."id" IN (
        SELECT "id" FROM "notification_deliveries"
        WHERE "status" = 'pending' AND "next_attempt_at" <= (NOW() AT TIME ZONE 'UTC')
        ORDER BY "next_attempt_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${CLAIM_BATCH}
      )
      AND e."id" = d."event_id"
      RETURNING d."id", d."event_id" AS "eventId", d."destination_key" AS "destinationKey",
                d."channel_id" AS "channelId", d."user_destination_id" AS "userDestId",
                d."user_id" AS "userId", e."project_id" AS "projectId", d."event", d."target_id" AS "targetId",
                d."attempts", e."payload"
    `;
  }

  private async reclaim() {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
    await this.prisma.$executeRaw`
      UPDATE "notification_deliveries"
      SET "status" = 'pending', "locked_by" = NULL, "locked_at" = NULL
      WHERE "status" = 'sending' AND "locked_at" < ${cutoff}
    `;
  }

  private async processGroup(destinationKey: string, claimed: ClaimedDelivery[]) {
    const destination = await this.resolveDestination(claimed[0]);
    if (!destination) {
      await this.markAll(claimed, 'failed', 'Destination no longer exists');
      return;
    }
    if (!destination.enabled) {
      await this.markAll(claimed, 'dropped', 'Destination is disabled');
      return;
    }

    const batch = await this.enforceRecipientAccess(claimed);
    if (batch.length === 0) return;

    // A destination whose breaker is open gets its work parked, not attempted.
    // Otherwise one dead webhook keeps every worker busy failing.
    const openUntil = destination.circuitOpenUntil;
    if (openUntil && openUntil.getTime() > Date.now()) {
      await this.park(batch, openUntil);
      return;
    }

    const wait = await this.limiter.take(destinationKey, destination.bucketType);
    if (wait > 0) {
      await this.park(batch, new Date(Date.now() + wait));
      return;
    }

    // Same alert, same resource, said again inside the cooldown. Recorded rather
    // than silently dropped so the log still explains what happened.
    const fresh: ClaimedDelivery[] = [];
    for (const d of batch) {
      const suppressed = await this.limiter.shouldSuppress(
        destinationKey,
        d.event,
        d.targetId,
        REPEAT_COOLDOWN_MS
      );
      if (suppressed) await this.markAll([d], 'suppressed', 'Repeat of a recent alert');
      else fresh.push(d);
    }
    if (fresh.length === 0) return;

    if (fresh.length > COALESCE_THRESHOLD) {
      await this.sendDigest(destination, fresh);
      return;
    }
    for (const d of fresh) {
      const startedAt = Date.now();
      const outcome = await this.transport.send(destination.target, [messageOf(d)]);
      await this.record(d, destination, outcome, undefined, Date.now() - startedAt);
    }
  }

  private async enforceRecipientAccess(batch: ClaimedDelivery[]): Promise<ClaimedDelivery[]> {
    const kept: ClaimedDelivery[] = [];
    for (const d of batch) {
      if (!d.userId || !d.projectId) {
        kept.push(d);
        continue;
      }
      const access = await this.access.resolve(d.projectId, d.userId);
      if (!access?.canView) {
        await this.markAll([d], 'dropped', 'Recipient no longer has access to this project');
        continue;
      }
      kept.push(
        access.canEdit ? d : { ...d, payload: redactForViewer(d.payload as NotificationMessage) }
      );
    }
    return kept;
  }

  private async sendDigest(destination: ResolvedDestination, batch: ClaimedDelivery[]) {
    const carrier = batch[0];
    const rest = batch.slice(1);
    const messages = batch.slice(0, COALESCE_MAX).map(messageOf);
    const startedAt = Date.now();
    const outcome = await this.transport.send(destination.target, messages);
    await this.record(carrier, destination, outcome, batch.length, Date.now() - startedAt);
    if (outcome.ok) {
      await this.prisma.notificationDelivery.updateMany({
        where: { id: { in: rest.map((d) => d.id) } },
        data: {
          status: 'coalesced',
          coalescedInto: carrier.id,
          lockedBy: null,
          lockedAt: null,
          deliveredAt: new Date()
        }
      });
      return;
    }
    // The digest failed, so the followers go back to the queue on their own
    // schedule rather than being written off with it.
    await this.prisma.notificationDelivery.updateMany({
      where: { id: { in: rest.map((d) => d.id) } },
      data: { status: 'pending', lockedBy: null, lockedAt: null }
    });
  }

  private async record(
    delivery: ClaimedDelivery,
    destination: ResolvedDestination,
    outcome: SendOutcome,
    coalescedCount?: number,
    durationMs?: number
  ) {
    const attempts = delivery.attempts + 1;
    const now = new Date();

    if (outcome.ok) {
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'sent',
          attempts,
          httpStatus: outcome.httpStatus ?? null,
          error: null,
          deliveredAt: now,
          durationMs: durationMs ?? null,
          firstAttemptAt: delivery.attempts === 0 ? now : undefined,
          coalescedCount: coalescedCount ?? null,
          lockedBy: null,
          lockedAt: null
        }
      });
      await this.onSuccess(delivery);
      return;
    }

    const exhausted = outcome.permanent || attempts >= MAX_ATTEMPTS;
    const delay = outcome.retryAfterMs ?? jitter(BACKOFF_MS[Math.min(attempts, MAX_ATTEMPTS) - 1]);
    await this.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: exhausted ? 'failed' : 'pending',
        attempts,
        httpStatus: outcome.httpStatus ?? null,
        error: outcome.error ?? 'Delivery failed',
        durationMs: durationMs ?? null,
        firstAttemptAt: delivery.attempts === 0 ? now : undefined,
        nextAttemptAt: exhausted ? now : new Date(Date.now() + delay),
        lockedBy: null,
        lockedAt: null
      }
    });
    await this.onFailure(delivery, outcome, destination);
  }

  private async onSuccess(delivery: ClaimedDelivery) {
    const data = {
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastSuccessAt: new Date(),
      lastError: null
    };
    if (delivery.channelId) {
      await this.prisma.notificationChannel.update({ where: { id: delivery.channelId }, data });
    } else if (delivery.userDestId) {
      await this.prisma.userNotificationDestination.update({
        where: { id: delivery.userDestId },
        data
      });
    }
  }

  // Failures compound: each one past the threshold doubles how long the
  // destination sits out, capped at six hours. A single success clears it.
  private async onFailure(
    delivery: ClaimedDelivery,
    outcome: SendOutcome,
    destination: ResolvedDestination
  ) {
    const failures = await this.bumpFailures(delivery, outcome.error ?? 'Delivery failed');
    if (failures < BREAKER_THRESHOLD) return;
    const openMs = Math.min(BREAKER_BASE_MS * 2 ** (failures - BREAKER_THRESHOLD), BREAKER_MAX_MS);
    const openUntil = new Date(Date.now() + openMs);
    if (delivery.channelId) {
      await this.prisma.notificationChannel.update({
        where: { id: delivery.channelId },
        data: { circuitOpenUntil: openUntil }
      });
    } else if (delivery.userDestId) {
      await this.prisma.userNotificationDestination.update({
        where: { id: delivery.userDestId },
        data: { circuitOpenUntil: openUntil }
      });
    }
    this.logger.warn(
      `${destination.target.label} has failed ${failures} times in a row; pausing until ${openUntil.toISOString()}`
    );
  }

  private async bumpFailures(delivery: ClaimedDelivery, error: string): Promise<number> {
    const data = {
      consecutiveFailures: { increment: 1 },
      lastErrorAt: new Date(),
      lastError: error.slice(0, 2000)
    };
    if (delivery.channelId) {
      const row = await this.prisma.notificationChannel.update({
        where: { id: delivery.channelId },
        data,
        select: { consecutiveFailures: true }
      });
      return row.consecutiveFailures;
    }
    if (delivery.userDestId) {
      const row = await this.prisma.userNotificationDestination.update({
        where: { id: delivery.userDestId },
        data,
        select: { consecutiveFailures: true }
      });
      return row.consecutiveFailures;
    }
    return 0;
  }

  private async resolveDestination(delivery: ClaimedDelivery): Promise<ResolvedDestination | null> {
    if (delivery.channelId) {
      const channel = await this.prisma.notificationChannel.findUnique({
        where: { id: delivery.channelId },
        select: {
          id: true,
          name: true,
          type: true,
          config: true,
          enabled: true,
          circuitOpenUntil: true,
          organizationId: true
        }
      });
      if (!channel) return null;
      return {
        enabled: channel.enabled,
        circuitOpenUntil: channel.circuitOpenUntil,
        bucketType: channel.type,
        target: {
          type: channel.type,
          config: (channel.config ?? {}) as any,
          label: `channel "${channel.name}"`,
          organizationId: channel.organizationId
        }
      };
    }
    if (delivery.userDestId) {
      const dest = await this.prisma.userNotificationDestination.findUnique({
        where: { id: delivery.userDestId },
        select: {
          id: true,
          type: true,
          config: true,
          enabled: true,
          circuitOpenUntil: true,
          user: { select: { email: true, username: true } }
        }
      });
      if (!dest) return null;
      const config = (dest.config ?? {}) as { url?: string };
      return {
        enabled: dest.enabled,
        circuitOpenUntil: dest.circuitOpenUntil,
        bucketType: dest.type,
        target: {
          type: dest.type,
          // A personal email destination always resolves to the account's own
          // address, so it can never be pointed at somebody else.
          config: dest.type === 'email' ? { recipients: [dest.user.email] } : { url: config.url },
          label: `${dest.type} for ${dest.user.username}`
        }
      };
    }
    return null;
  }

  private async park(batch: ClaimedDelivery[], until: Date) {
    await this.prisma.notificationDelivery.updateMany({
      where: { id: { in: batch.map((d) => d.id) } },
      data: { status: 'pending', nextAttemptAt: until, lockedBy: null, lockedAt: null }
    });
  }

  private async markAll(batch: ClaimedDelivery[], status: string, error: string) {
    await this.prisma.notificationDelivery.updateMany({
      where: { id: { in: batch.map((d) => d.id) } },
      data: { status, error, lockedBy: null, lockedAt: null }
    });
  }

  // A channel that has been unreachable for a day is not coming back on its
  // own. Disable it, tell the admins once, and stop generating work.
  private async sweepDeadChannels() {
    const cutoff = new Date(Date.now() - AUTO_DISABLE_AFTER_MS);
    const dead = await this.prisma.notificationChannel.findMany({
      where: {
        enabled: true,
        autoDisabledAt: null,
        consecutiveFailures: { gte: BREAKER_THRESHOLD },
        lastErrorAt: { lt: cutoff },
        OR: [{ lastSuccessAt: null }, { lastSuccessAt: { lt: cutoff } }]
      },
      select: { id: true, name: true, organizationId: true, lastError: true, lastErrorAt: true },
      take: 20
    });

    for (const channel of dead) {
      await this.prisma.notificationChannel.update({
        where: { id: channel.id },
        data: { enabled: false, autoDisabledAt: new Date() }
      });
      await this.prisma.notificationDelivery.updateMany({
        where: { channelId: channel.id, status: 'pending' },
        data: { status: 'dropped', error: 'Channel turned off after 24 hours of failures' }
      });
      await this.notifyAdminsOfDeadChannel(channel).catch((e) =>
        this.logger.warn(`couldn't warn admins about channel ${channel.id}: ${e?.message ?? e}`)
      );
      this.logger.warn(`auto-disabled notification channel ${channel.id} (${channel.name})`);
    }
  }

  private async notifyAdminsOfDeadChannel(channel: {
    id: string;
    name: string;
    organizationId: string;
    lastError: string | null;
    lastErrorAt: Date | null;
  }) {
    const admins = await this.prisma.organizationMember.findMany({
      where: { organizationId: channel.organizationId, role: { in: ['owner', 'admin'] } },
      select: { user: { select: { email: true } } }
    });
    const recipients = admins.map((a) => a.user.email).filter(Boolean);
    if (recipients.length === 0) return;
    const org = await this.prisma.organization.findUnique({
      where: { id: channel.organizationId },
      select: { slug: true }
    });
    await this.email.sendNotificationEmail({
      recipients,
      subject: `Notifications to "${channel.name}" are off`,
      title: `Notifications to "${channel.name}" are off`,
      body: `Orchard couldn't reach this channel for 24 hours, so it turned the channel off. Last error: ${channel.lastError ?? 'unknown'}. Fix the webhook and turn the channel back on, then use Replay to send anything you missed.`,
      contextLine: channel.lastErrorAt ? `Failing since ${channel.lastErrorAt.toISOString()}` : '',
      ctaUrl: org ? `${this.frontendUrl}/${org.slug}/settings` : this.frontendUrl
    });
  }
}

function messageOf(delivery: ClaimedDelivery): NotificationMessage {
  return delivery.payload as NotificationMessage;
}

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}
