import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  EVENT_RESOURCE_SCOPE,
  NotificationEventName,
  NotificationMessage,
  ResourceScopeType
} from './notification-events';
import {
  backupKey,
  dbArchivingKey,
  dbStateKey,
  dbWriteGuardKey,
  dbMemoryRaisedKey,
  dbRestoreTestKey,
  dbStorageKey,
  deployKey,
  jobRunKey,
  podKey
} from './dedupe-keys';
import { NotificationFanoutService } from './notification-fanout.service';

interface EmitInput {
  organizationId: string | null;
  message: NotificationMessage;
  scopeType: ResourceScopeType;
  scopeId: string;
  actorUserId?: string | null;
  dedupeKey: string;
}

// Stage one of three. This service does one thing: turn a real-world state
// change into exactly one durable outbox row. Routing lives in the fanout
// worker, sending in the delivery worker. Callers stay fire-and-forget, but the
// event survives a crash, a Slack outage, and a redeploy.
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly fanout: NotificationFanoutService
  ) {}

  // scopeId is not a foreign key, so nothing here goes when the resource does.
  // That mattered little for rules, which simply stop matching, but a
  // destination owned by a deleted app would sit on a webhook URL forever.
  async purgeScope(scopeType: string, scopeId: string) {
    await this.prisma.notificationRule.deleteMany({ where: { scopeType, scopeId } });
    await this.prisma.notificationChannel.deleteMany({ where: { scopeType, scopeId } });
    await this.prisma.userNotificationSetting.deleteMany({ where: { scopeType, scopeId } });
    await this.prisma.metricAlertRule.deleteMany({ where: { scopeType, scopeId } });
  }

  async notifyDeploy(deploymentId: string, status: 'succeeded' | 'failed') {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        displayName: true,
        buildError: true,
        githubBranch: true,
        createdBy: true,
        updatedAt: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!dep) return;

    // The build run is both the natural dedupe identity and the only place that
    // knows who asked for this deploy, which is what 'subscribed' turns on.
    const run = await this.prisma.buildRun.findFirst({
      where: { deploymentId },
      orderBy: { scheduledAt: 'desc' },
      select: { id: true, triggeredById: true }
    });

    const label = dep.displayName || dep.name;
    const succeeded = status === 'succeeded';
    await this.emit({
      organizationId: dep.project.organizationId,
      scopeType: 'deployment',
      scopeId: dep.id,
      actorUserId: run?.triggeredById ?? dep.createdBy ?? null,
      dedupeKey: deployKey(dep.id, status, run?.id ?? null, dep.updatedAt.getTime()),
      message: {
        event: succeeded ? 'deploy.succeeded' : 'deploy.failed',
        title: `Deploy ${status}: ${label}`,
        body: succeeded
          ? `${label} in ${dep.project.name} deployed successfully.`
          : truncate(dep.buildError, 400) || `${label} in ${dep.project.name} failed to build.`,
        url: `${this.frontendUrl}/${dep.project.organization.slug}/deployments/${dep.id}`,
        projectId: dep.project.id,
        projectName: dep.project.name,
        targetId: dep.id,
        targetName: label,
        fields: dep.githubBranch ? [{ name: 'Branch', value: dep.githubBranch }] : undefined
      }
    });
  }

  async notifyDeployRegressed(deploymentId: string, releaseId: string, summary: string) {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        displayName: true,
        createdBy: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!dep) return;
    const label = dep.displayName || dep.name;
    await this.emit({
      organizationId: dep.project.organizationId,
      scopeType: 'deployment',
      scopeId: dep.id,
      actorUserId: dep.createdBy,
      dedupeKey: `deploy.regressed:${releaseId}`,
      message: {
        event: 'deploy.regressed',
        title: `Deploy got worse: ${label}`,
        body: truncate(summary, 400) ?? summary,
        url: `${this.frontendUrl}/${dep.project.organization.slug}/deployments/${dep.id}?tab=deploys`,
        projectId: dep.project.id,
        projectName: dep.project.name,
        targetId: dep.id,
        targetName: label
      }
    });
  }

  async notifyPodState(deploymentId: string, state: 'crashing' | 'recovered', detail?: string) {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        displayName: true,
        createdBy: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!dep) return;
    const label = dep.displayName || dep.name;
    const crashing = state === 'crashing';
    await this.emit({
      organizationId: dep.project.organizationId,
      scopeType: 'deployment',
      scopeId: dep.id,
      actorUserId: dep.createdBy,
      dedupeKey: podKey(dep.id, state),
      message: {
        event: crashing ? 'pod.crashing' : 'pod.recovered',
        title: crashing ? `App crashing: ${label}` : `App recovered: ${label}`,
        body: crashing
          ? `${label} in ${dep.project.name} is failing to start${detail ? `: ${detail}` : '.'}`
          : `${label} in ${dep.project.name} is running again.`,
        url: `${this.frontendUrl}/${dep.project.organization.slug}/deployments/${dep.id}`,
        projectId: dep.project.id,
        projectName: dep.project.name,
        targetId: dep.id,
        targetName: label
      }
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
            createdBy: true,
            project: {
              select: {
                id: true,
                name: true,
                organizationId: true,
                organization: { select: { slug: true } }
              }
            }
          }
        }
      }
    });
    if (!backup) return;
    const db = backup.database;
    const completed = status === 'completed';
    await this.emit({
      organizationId: db.project.organizationId,
      scopeType: 'database',
      scopeId: db.id,
      actorUserId: db.createdBy,
      dedupeKey: backupKey(backup.id, status),
      message: {
        event: completed ? 'backup.completed' : 'backup.failed',
        title: `Backup ${status}: ${db.name}`,
        body: completed
          ? `Backup "${backup.label}" of ${db.name} completed successfully.`
          : `Backup "${backup.label}" of ${db.name} failed${backup.errorMessage ? `: ${truncate(backup.errorMessage, 300)}` : '.'}`,
        url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}`,
        projectId: db.project.id,
        projectName: db.project.name,
        targetId: backup.id,
        targetName: db.name
      }
    });
  }

  async notifyDbArchiving(databaseId: string, state: 'failing' | 'recovered', detail?: string) {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        name: true,
        createdBy: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!db) return;
    const failing = state === 'failing';
    await this.emit({
      organizationId: db.project.organizationId,
      scopeType: 'database',
      scopeId: db.id,
      actorUserId: db.createdBy,
      dedupeKey: dbArchivingKey(db.id, state),
      message: {
        event: failing ? 'db.archiving_failing' : 'db.archiving_recovered',
        title: failing
          ? `Backup archiving failing: ${db.name}`
          : `Backup archiving recovered: ${db.name}`,
        body: failing
          ? `WAL archiving for ${db.name} is failing${detail ? `: ${truncate(detail, 300)}` : '.'} Restores are falling behind and disk usage will grow until it recovers.`
          : `WAL archiving for ${db.name} is healthy again.`,
        url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}`,
        projectId: db.project.id,
        projectName: db.project.name,
        targetId: db.id,
        targetName: db.name
      }
    });
  }

  async notifyDbStorage(databaseId: string, state: 'pressure' | 'recovered', detail?: string) {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        name: true,
        createdBy: true,
        storageSize: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!db) return;
    const pressure = state === 'pressure';
    await this.emit({
      organizationId: db.project.organizationId,
      scopeType: 'database',
      scopeId: db.id,
      actorUserId: db.createdBy,
      dedupeKey: dbStorageKey(db.id, state),
      message: {
        event: pressure ? 'db.storage_pressure' : 'db.storage_recovered',
        title: pressure ? `Storage running out: ${db.name}` : `Storage back to normal: ${db.name}`,
        body: pressure
          ? `${db.name} is running out of disk${detail ? `: ${truncate(detail, 300)}` : '.'} PostgreSQL refuses to start once the volume is full, so expand storage${db.storageSize ? ` (currently ${db.storageSize})` : ''} before that happens.`
          : `${db.name} has disk headroom again.`,
        url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}`,
        projectId: db.project.id,
        projectName: db.project.name,
        targetId: db.id,
        targetName: db.name
      }
    });
  }

  async notifyDbWriteGuard(databaseId: string, state: 'on' | 'off', fillPercent: number) {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        name: true,
        createdBy: true,
        storageSize: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!db) return;
    const on = state === 'on';
    await this.emit({
      organizationId: db.project.organizationId,
      scopeType: 'database',
      scopeId: db.id,
      actorUserId: db.createdBy,
      dedupeKey: dbWriteGuardKey(db.id, state),
      message: {
        event: on ? 'db.read_only' : 'db.writes_resumed',
        title: on ? `Writes paused: ${db.name}` : `Writes resumed: ${db.name}`,
        body: on
          ? `${db.name} is ${fillPercent}% full${db.storageSize ? ` on a ${db.storageSize} volume` : ''}, so Orchard switched it to read-only to keep it alive. Reads and backups continue. Expand storage or free space and writes resume on their own.`
          : `${db.name} has disk headroom again (${fillPercent}% full), so writes are back on.`,
        url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}`,
        projectId: db.project.id,
        projectName: db.project.name,
        targetId: db.id,
        targetName: db.name
      }
    });
  }

  async notifyDbMemoryRaised(namespace: string, clusterName: string, from: string, to: string) {
    const db = await this.prisma.database.findFirst({
      where: { namespace, clusterName },
      select: {
        id: true,
        name: true,
        createdBy: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!db) return;
    await this.emit({
      organizationId: db.project.organizationId,
      scopeType: 'database',
      scopeId: db.id,
      actorUserId: db.createdBy,
      dedupeKey: dbMemoryRaisedKey(db.id, to),
      message: {
        event: 'db.memory_raised',
        title: `Memory raised: ${db.name}`,
        body: `${db.name} kept running out of memory while taking backups on ${from}, so Orchard raised it to ${to}. Without this its backups never finish and it restarts every few minutes.`,
        url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}`,
        projectId: db.project.id,
        projectName: db.project.name,
        targetId: db.id,
        targetName: db.name
      }
    });
  }

  async notifyRestoreTestFailed(databaseId: string, reason: string) {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        name: true,
        createdBy: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!db) return;
    await this.emit({
      organizationId: db.project.organizationId,
      scopeType: 'database',
      scopeId: db.id,
      actorUserId: db.createdBy,
      dedupeKey: dbRestoreTestKey(db.id),
      message: {
        event: 'db.restore_test_failed',
        title: `Restore test failed: ${db.name}`,
        body: `Orchard restored ${db.name} from its backups into a throwaway copy and the check did not pass: ${reason}. Its backups may not bring it back as expected.`,
        url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}?tab=backups`,
        projectId: db.project.id,
        projectName: db.project.name,
        targetId: db.id,
        targetName: db.name
      }
    });
  }

  async notifyDbState(databaseId: string, state: 'crashing' | 'recovered', detail?: string) {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        name: true,
        createdBy: true,
        project: {
          select: {
            id: true,
            name: true,
            organizationId: true,
            organization: { select: { slug: true } }
          }
        }
      }
    });
    if (!db) return;
    const crashing = state === 'crashing';
    await this.emit({
      organizationId: db.project.organizationId,
      scopeType: 'database',
      scopeId: db.id,
      actorUserId: db.createdBy,
      dedupeKey: dbStateKey(db.id, state),
      message: {
        event: crashing ? 'db.crashing' : 'db.recovered',
        title: crashing ? `Database restarting: ${db.name}` : `Database recovered: ${db.name}`,
        body: crashing
          ? `${db.name} keeps restarting${detail ? `: ${truncate(detail, 300)}` : '.'} Until it settles, connections will fail intermittently.`
          : `${db.name} is running normally again.`,
        url: `${this.frontendUrl}/${db.project.organization.slug}/databases/${db.id}`,
        projectId: db.project.id,
        projectName: db.project.name,
        targetId: db.id,
        targetName: db.name
      }
    });
  }

  async notifyJobRun(runId: string, status: 'succeeded' | 'failed') {
    const run = await this.prisma.jobRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        number: true,
        trigger: true,
        triggeredBy: true,
        errorMessage: true,
        job: {
          select: {
            id: true,
            name: true,
            project: {
              select: {
                id: true,
                name: true,
                organizationId: true,
                organization: { select: { slug: true } }
              }
            }
          }
        },
        steps: {
          where: { status: { in: ['failed', 'timed_out'] } },
          orderBy: { stepOrder: 'asc' },
          take: 1,
          select: { name: true, stepOrder: true, reason: true }
        }
      }
    });
    if (!run) return;
    const { job } = run;
    const succeeded = status === 'succeeded';
    const failedStep = run.steps[0];
    await this.emit({
      organizationId: job.project.organizationId,
      scopeType: 'job',
      scopeId: job.id,
      actorUserId: run.triggeredBy,
      dedupeKey: jobRunKey(run.id, status),
      message: {
        event: succeeded ? 'job.succeeded' : 'job.failed',
        title: `Job run ${status}: ${job.name} #${run.number}`,
        body: succeeded
          ? `Run #${run.number} of "${job.name}" completed successfully.`
          : `Run #${run.number} of "${job.name}" failed${failedStep ? ` at step ${failedStep.stepOrder} (${failedStep.name})` : ''}${run.errorMessage ? `: ${truncate(run.errorMessage, 300)}` : '.'}`,
        url: `${this.frontendUrl}/${job.project.organization.slug}/jobs/${job.id}/runs/${run.id}`,
        projectId: job.project.id,
        projectName: job.project.name,
        targetId: run.id,
        targetName: job.name,
        fields: [
          { name: 'Trigger', value: run.trigger },
          ...(failedStep?.reason ? [{ name: 'Reason', value: failedStep.reason }] : [])
        ]
      }
    });
  }

  /**
   * Something happened to an account: a sign-in, an app granted access. Unlike
   * every other event here there is no organization and no team lane: it goes
   * to the one person it is about, through their own destinations, and a
   * channel rule cannot subscribe to it.
   *
   * Not deduped on a time bucket like the resource events are. Two sign-ins a
   * minute apart are two things worth knowing about, and collapsing them would
   * hide the second one, which is the one that matters.
   */
  async notifySecurity(userId: string, message: NotificationMessage) {
    await this.emit({
      organizationId: null,
      scopeType: 'user',
      scopeId: userId,
      actorUserId: userId,
      dedupeKey: `${message.event}:${message.targetId ?? userId}:${randomUUID()}`,
      message: { ...message, targetId: message.targetId ?? userId }
    });
  }

  async notifyAccount(userId: string, message: NotificationMessage, dedupeKey: string) {
    await this.emit({
      organizationId: null,
      scopeType: 'user',
      scopeId: userId,
      actorUserId: null,
      dedupeKey,
      message: { ...message, targetId: message.targetId ?? userId }
    });
  }

  // Generic entry point, kept for callers that build their own message. Scope is
  // derived from the event so nobody has to remember that backups hang off a
  // database rather than a deployment.
  async notify(
    organizationId: string,
    message: NotificationMessage,
    opts?: { scopeId?: string; actorUserId?: string | null; dedupeKey?: string }
  ) {
    const scopeId = opts?.scopeId ?? message.targetId;
    if (!scopeId) {
      this.logger.warn(`notify(${message.event}) dropped: no scope id`);
      return;
    }
    await this.emit({
      organizationId,
      scopeType: EVENT_RESOURCE_SCOPE[message.event],
      scopeId,
      actorUserId: opts?.actorUserId ?? null,
      dedupeKey:
        opts?.dedupeKey ?? `${message.event}:${scopeId}:${Math.floor(Date.now() / 60_000)}`,
      message
    });
  }

  private async emit(input: EmitInput) {
    // Dispatch kill switch. The 'notifications' flag is enrollment-based (early
    // access), so force the enrollment property here: disabling the flag stops
    // all sends; per-user rollout is enforced at the management endpoints. An
    // account-scoped event has no organization to key the flag on, so it is
    // checked against the person it is about.
    const flagSubject = input.organizationId ?? input.scopeId;
    const enabled = await this.analytics.isEarlyAccessEnabled('notifications', flagSubject, {
      personProperties: { '$feature_enrollment/notifications': true }
    });
    if (!enabled) return;

    // ON CONFLICT is the whole dedupe story. Two replicas reacting to the same
    // build write the same key and exactly one row lands.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "notification_events" (
        "id", "organization_id", "event", "scope_type", "scope_id",
        "project_id", "actor_user_id", "payload", "dedupe_key", "status", "occurred_at"
      ) VALUES (
        gen_random_uuid(), ${input.organizationId ?? null}::uuid, ${input.message.event}, ${input.scopeType},
        ${input.scopeId}::uuid, ${input.message.projectId ?? null}::uuid,
        ${input.actorUserId ?? null}::uuid, ${JSON.stringify(input.message)}::jsonb,
        ${input.dedupeKey}, 'pending', (NOW() AT TIME ZONE 'UTC')
      )
      ON CONFLICT ("dedupe_key") DO NOTHING
    `;
    if (inserted === 0) return;
    this.fanout.kick();
  }
}

function truncate(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export type { NotificationEventName };
