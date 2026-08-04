import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import {
  EVENT_CATEGORY,
  GLOBAL_SCOPE_ID,
  NotificationCategory,
  NotificationEventName,
  NotificationMessage,
  isNotificationEvent,
} from './notification-events';
import { InvolvementContext, resolveRuleLane, shouldNotifyUser } from './notification-resolution';

const CLAIM_BATCH = 25;
const TICK_MS = 2_000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;
const RECLAIM_SWEEP_MS = 60 * 1000;
const LOCK_KEY = 528_492;

interface ClaimedEvent {
  id: string;
  organizationId: string;
  event: string;
  scopeType: string;
  scopeId: string | null;
  projectId: string | null;
  actorUserId: string | null;
  payload: unknown;
}

interface ScopeChain {
  organizationId: string;
  projectId: string | null;
  resourceType: string;
  resourceId: string | null;
  projectOwnerId: string | null;
  resourceCreatorId: string | null;
}

interface PendingDelivery {
  destinationKey: string;
  channelId: string | null;
  userDestId: string | null;
  userId: string | null;
}

// Stage two of three. Claims outbox rows and resolves them into delivery rows.
// The two lanes are computed independently and neither can cancel the other: a
// personal 'never' does not silence a team channel, and a team rule does not
// force an email on anyone. That separation is the entire reason this is
// explainable in the UI.
@Injectable()
export class NotificationFanoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationFanoutService.name);

  private readonly workerId = `${hostname()}-${process.pid}`;

  private timer: NodeJS.Timeout | null = null;

  private retentionTimer: NodeJS.Timeout | null = null;

  private reclaimTimer: NodeJS.Timeout | null = null;

  private running = false;

  private runAgain = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.kick(), TICK_MS);
    this.timer.unref?.();
    this.reclaimTimer = setInterval(() => {
      this.reclaim().catch((e) => this.logger.warn(`reclaim failed: ${e?.message ?? e}`));
    }, RECLAIM_SWEEP_MS);
    this.reclaimTimer.unref?.();
    this.retentionTimer = setInterval(() => {
      this.prune().catch((e) => this.logger.warn(`retention sweep failed: ${e?.message ?? e}`));
    }, RETENTION_SWEEP_MS);
    this.retentionTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    this.timer = null;
    this.retentionTimer = null;
    this.reclaimTimer = null;
  }

  kick() {
    if (this.running) {
      this.runAgain = true;
      return;
    }
    this.running = true;
    void this.drain()
      .catch((e) => this.logger.warn(`fanout drain failed: ${e?.message ?? e}`))
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
      const events = await this.claim();
      if (events.length === 0) return;
      for (const event of events) {
        await this.fanOut(event).catch((e) =>
          this.logger.warn(`fanout for event ${event.id} failed: ${e?.message ?? e}`),
        );
      }
      if (events.length < CLAIM_BATCH) return;
    }
  }

  // A single atomic statement, so two replicas can never take the same row.
  // SKIP LOCKED means a busy replica is stepped over rather than waited on.
  private async claim(): Promise<ClaimedEvent[]> {
    return this.prisma.$queryRaw<ClaimedEvent[]>`
      UPDATE "notification_events" e
      SET "status" = 'claimed', "locked_by" = ${this.workerId}, "locked_at" = (NOW() AT TIME ZONE 'UTC')
      WHERE e."id" IN (
        SELECT "id" FROM "notification_events"
        WHERE "status" = 'pending'
        ORDER BY "occurred_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${CLAIM_BATCH}
      )
      RETURNING e."id", e."organization_id" AS "organizationId", e."event",
                e."scope_type" AS "scopeType", e."scope_id" AS "scopeId",
                e."project_id" AS "projectId", e."actor_user_id" AS "actorUserId", e."payload"
    `;
  }

  // A replica that dies between claiming and committing leaves rows stranded in
  // 'claimed'. Nothing was delivered, so handing them back to the pool is
  // always safe.
  private async reclaim() {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
    await this.prisma.$executeRaw`
      UPDATE "notification_events"
      SET "status" = 'pending', "locked_by" = NULL, "locked_at" = NULL
      WHERE "status" = 'claimed' AND "locked_at" < ${cutoff}
    `;
  }

  // Everything below runs in one transaction with the status flip. A crash
  // before commit leaves the event pending and it is simply redone; a crash
  // after commit is a no-op thanks to the unique (event_id, destination_key).
  private async fanOut(event: ClaimedEvent) {
    if (!isNotificationEvent(event.event)) {
      await this.prisma.notificationEvent.update({
        where: { id: event.id },
        data: { status: 'skipped', fannedOutAt: new Date() },
      });
      return;
    }
    const chain = await this.resolveScope(event);
    if (!chain) {
      await this.prisma.notificationEvent.update({
        where: { id: event.id },
        data: { status: 'skipped', fannedOutAt: new Date() },
      });
      return;
    }

    const [channelIds, userDestinations] = await Promise.all([
      this.resolveRuleLane(event, chain),
      this.resolvePersonalLane(event, chain),
    ]);

    const message = event.payload as NotificationMessage;
    const targetId = message?.targetId ?? null;
    const rows: PendingDelivery[] = [
      ...channelIds.map((channelId) => ({
        destinationKey: `channel:${channelId}`,
        channelId,
        userDestId: null,
        userId: null,
      })),
      ...userDestinations.map((d) => ({
        destinationKey: `userdest:${d.id}`,
        channelId: null,
        userDestId: d.id,
        userId: d.userId,
      })),
    ];

    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await tx.$executeRaw`
          INSERT INTO "notification_deliveries" (
            "id", "event_id", "destination_key", "channel_id", "user_destination_id",
            "user_id", "event", "target_id", "status", "next_attempt_at", "created_at"
          ) VALUES (
            gen_random_uuid(), ${event.id}::uuid, ${row.destinationKey}, ${row.channelId}::uuid,
            ${row.userDestId}::uuid, ${row.userId}::uuid, ${event.event}, ${targetId}::uuid,
            'pending', (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC')
          )
          ON CONFLICT ("event_id", "destination_key") DO NOTHING
        `;
      }
      await tx.notificationEvent.update({
        where: { id: event.id },
        data: { status: 'fanned_out', fannedOutAt: new Date() },
      });
    });

    if (rows.length > 0) this.delivery.kick();
  }

  private async resolveScope(event: ClaimedEvent): Promise<ScopeChain | null> {
    if (!event.scopeId) return null;
    if (event.scopeType === 'deployment') {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: event.scopeId },
        select: { id: true, createdBy: true, project: { select: { id: true, ownerId: true, organizationId: true } } },
      });
      if (!dep) return null;
      return {
        organizationId: dep.project.organizationId,
        projectId: dep.project.id,
        resourceType: 'deployment',
        resourceId: dep.id,
        projectOwnerId: dep.project.ownerId,
        resourceCreatorId: dep.createdBy,
      };
    }
    if (event.scopeType === 'database') {
      const db = await this.prisma.database.findUnique({
        where: { id: event.scopeId },
        select: { id: true, createdBy: true, project: { select: { id: true, ownerId: true, organizationId: true } } },
      });
      if (!db) return null;
      return {
        organizationId: db.project.organizationId,
        projectId: db.project.id,
        resourceType: 'database',
        resourceId: db.id,
        projectOwnerId: db.project.ownerId,
        resourceCreatorId: db.createdBy,
      };
    }
    if (event.scopeType === 'job') {
      const job = await this.prisma.job.findUnique({
        where: { id: event.scopeId },
        select: { id: true, createdBy: true, project: { select: { id: true, ownerId: true, organizationId: true } } },
      });
      if (!job) return null;
      return {
        organizationId: job.project.organizationId,
        projectId: job.project.id,
        resourceType: 'job',
        resourceId: job.id,
        projectOwnerId: job.project.ownerId,
        resourceCreatorId: job.createdBy,
      };
    }
    return null;
  }

  // Rules are additive up the chain, with one exception: a mute at a more
  // specific scope beats a deliver at a broader one for the same (channel,
  // event). That is how you silence one flapping deployment on one channel
  // without unpicking the org-wide rule everyone else relies on.
  private async resolveRuleLane(event: ClaimedEvent, chain: ScopeChain): Promise<string[]> {
    const rules = await this.prisma.notificationRule.findMany({
      where: {
        organizationId: chain.organizationId,
        enabled: true,
        channel: { enabled: true },
        OR: [
          { scopeType: 'org' },
          ...(chain.projectId ? [{ scopeType: 'project', scopeId: chain.projectId }] : []),
          ...(chain.resourceId ? [{ scopeType: chain.resourceType, scopeId: chain.resourceId }] : []),
        ],
      },
      select: { channelId: true, scopeType: true, events: true, mode: true },
    });
    return resolveRuleLane(rules, event.event);
  }

  private async resolvePersonalLane(
    event: ClaimedEvent,
    chain: ScopeChain,
  ): Promise<{ id: string; userId: string }[]> {
    const category = EVENT_CATEGORY[event.event as NotificationEventName];
    const candidates = await this.candidateUserIds(chain);
    if (candidates.length === 0) return [];

    const settings = await this.prisma.userNotificationSetting.findMany({
      where: {
        userId: { in: candidates },
        category,
        OR: [
          { scopeType: 'global', scopeId: GLOBAL_SCOPE_ID },
          { scopeType: 'org', scopeId: chain.organizationId },
          ...(chain.projectId ? [{ scopeType: 'project', scopeId: chain.projectId }] : []),
          ...(chain.resourceId ? [{ scopeType: chain.resourceType, scopeId: chain.resourceId }] : []),
        ],
      },
      select: { userId: true, scopeType: true, value: true },
    });

    // 'subscribed' means the thing is mine in some concrete way. Vercel routes
    // deploy failures to whoever owns the deployment for exactly this reason:
    // it is the highest-signal notification in the product and it costs nothing.
    const involvement: InvolvementContext = {
      actorUserId: event.actorUserId,
      resourceCreatorId: chain.resourceCreatorId,
      projectOwnerId: chain.projectOwnerId,
    };
    const wanted = candidates.filter((userId) => shouldNotifyUser(userId, settings, involvement));
    if (wanted.length === 0) return [];

    const destinations = await this.prisma.userNotificationDestination.findMany({
      where: { userId: { in: wanted }, enabled: true },
      select: { id: true, userId: true },
    });
    return destinations;
  }

  private async candidateUserIds(chain: ScopeChain): Promise<string[]> {
    if (!chain.projectId) return [];
    const [members, project, orgAdmins] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId: chain.projectId },
        select: { userId: true },
      }),
      this.prisma.project.findUnique({
        where: { id: chain.projectId },
        select: { ownerId: true, createdBy: true },
      }),
      this.prisma.organizationMember.findMany({
        where: { organizationId: chain.organizationId, role: { in: ['owner', 'admin'] } },
        select: { userId: true },
      }),
    ]);
    const ids = new Set<string>();
    for (const m of members) ids.add(m.userId);
    for (const a of orgAdmins) ids.add(a.userId);
    if (project?.ownerId) ids.add(project.ownerId);
    if (project?.createdBy) ids.add(project.createdBy);
    if (chain.resourceCreatorId) ids.add(chain.resourceCreatorId);
    return [...ids];
  }

  // Retention runs on whichever replica wins the advisory lock, so it costs one
  // sweep per hour cluster-wide rather than one per replica.
  private async prune() {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    await this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked
      `;
      if (!locked) return;
      await tx.$executeRaw`
        DELETE FROM "notification_events"
        WHERE "id" IN (
          SELECT "id" FROM "notification_events" WHERE "occurred_at" < ${cutoff} LIMIT 5000
        )
      `;
    });
  }

  categoryFor(event: NotificationEventName): NotificationCategory {
    return EVENT_CATEGORY[event];
  }
}
