import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { gauge } from '../analytics/datadog';
import { DatabaseOperationsService } from './database-operations.service';

export const DRILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DRILL_CONCURRENCY = 2;

export function drillDue(lastDrillAt: Date | null, now = Date.now()): boolean {
  return !lastDrillAt || now - lastDrillAt.getTime() >= DRILL_INTERVAL_MS;
}

@Injectable()
export class DatabaseDrillsService {
  private readonly logger = new Logger(DatabaseDrillsService.name);

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
    private readonly settings: InstanceSettingsService,
    private readonly operations: DatabaseOperationsService,
    private readonly notifications: NotificationsService
  ) {}

  async run(databaseId: string, requestedBy?: string | null) {
    const running = await this.prisma.databaseOperation.findFirst({
      where: { databaseId, kind: 'drill', status: { in: ['pending', 'running'] } },
      select: { id: true }
    });
    if (running) return this.operations.get(running.id);
    const source = await this.operations.sourceFromDatabase(databaseId);
    return this.operations.enqueue({
      kind: 'drill',
      databaseId,
      source,
      target: { type: 'latest' },
      requestedBy: requestedBy ?? null
    });
  }

  list(databaseId: string, take = 20) {
    return this.prisma.databaseOperation.findMany({
      where: { databaseId, kind: 'drill' },
      orderBy: { createdAt: 'desc' },
      take
    });
  }

  @Interval(15 * 60 * 1000)
  async tick() {
    if (!this.leader.isLeader() || this.ticking) return;
    this.ticking = true;
    try {
      await this.notifyFinished();
      await this.emitGauges();
      if (!(await this.settings.isDatabaseToggleOn('restoreDrills'))) return;
      const running = await this.prisma.databaseOperation.count({
        where: { kind: 'drill', status: { in: ['pending', 'running'] } }
      });
      if (running >= DRILL_CONCURRENCY) return;
      const candidates = await this.prisma.database.findMany({
        where: {
          mode: 'cnpg',
          status: 'ready',
          restoreTests: true,
          namespace: { not: null },
          clusterName: { not: null },
          backups: { some: { status: 'completed' } }
        },
        select: { id: true }
      });
      const last = await this.lastDrills(candidates.map((c) => c.id));
      const due = candidates
        .filter((c) => drillDue(last.get(c.id) ?? null))
        .sort((a, b) => (last.get(a.id)?.getTime() ?? 0) - (last.get(b.id)?.getTime() ?? 0));
      for (const c of due.slice(0, DRILL_CONCURRENCY - running)) {
        await this.run(c.id).catch((e) =>
          this.logger.warn(`drill for ${c.id} not started: ${e?.message ?? e}`)
        );
      }
    } catch (e: any) {
      this.logger.warn(`drill tick failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
    }
  }

  private async lastDrills(ids: string[]): Promise<Map<string, Date>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.databaseOperation.groupBy({
      by: ['databaseId'],
      where: { kind: 'drill', databaseId: { in: ids } },
      _max: { createdAt: true }
    });
    return new Map(
      rows
        .filter((r) => r.databaseId && r._max.createdAt)
        .map((r) => [r.databaseId!, r._max.createdAt!])
    );
  }

  private async notifyFinished() {
    const failed = await this.prisma.databaseOperation.findMany({
      where: {
        kind: 'drill',
        status: 'failed',
        finishedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      },
      take: 50
    });
    for (const op of failed) {
      const result = (op.result ?? {}) as Record<string, any>;
      if (result.notified || !op.databaseId) continue;
      await this.notifications
        .notifyRestoreTestFailed(op.databaseId, op.error || 'The restore check failed')
        .catch(() => {});
      await this.prisma.databaseOperation.update({
        where: { id: op.id },
        data: { result: { ...result, notified: true } as Prisma.InputJsonValue }
      });
    }
  }

  private async emitGauges() {
    const latest = await this.prisma.databaseOperation.findMany({
      where: { kind: 'drill', status: { in: ['succeeded', 'failed'] } },
      orderBy: { finishedAt: 'desc' },
      distinct: ['databaseId'],
      select: {
        databaseId: true,
        status: true,
        finishedAt: true,
        targetNamespace: true,
        source: true
      },
      take: 1000
    });
    for (const op of latest) {
      const src = op.source as Record<string, any>;
      const tags = [`kube_namespace:${src.namespace}`, `cnpg_cluster:${src.clusterName}`];
      gauge('orchard.cnpg.restore_test_failing', op.status === 'failed' ? 1 : 0, tags);
      if (op.finishedAt) {
        gauge(
          'orchard.cnpg.days_since_restore_test',
          (Date.now() - op.finishedAt.getTime()) / 86_400_000,
          tags
        );
      }
    }
  }
}
