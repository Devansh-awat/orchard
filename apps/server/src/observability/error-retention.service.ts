import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { LeaseService } from '../coordination/lease.service';

export const ERROR_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
export const ERROR_RETENTION_BATCH = 500;
export const ERROR_RETENTION_MAX_BATCHES = 40;
export const DEFAULT_ERROR_RETENTION_DAYS = 90;

export function errorRetentionDays(): number {
  const raw = Number(process.env.ERROR_GROUP_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_ERROR_RETENTION_DAYS;
}

@Injectable()
export class ErrorRetentionService {
  private readonly logger = new Logger(ErrorRetentionService.name);

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
    private readonly lease: LeaseService
  ) {}

  @Interval(ERROR_RETENTION_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!this.lease.canCoordinate || !this.leader.isLeader() || this.running) return;
    this.running = true;
    try {
      const removed = await this.prune();
      if (removed) this.logger.log(`pruned ${removed} stale error groups`);
    } catch (err) {
      this.logger.warn(`error group retention failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async prune(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - errorRetentionDays() * 24 * 60 * 60 * 1000);
    let total = 0;
    for (let i = 0; i < ERROR_RETENTION_MAX_BATCHES; i++) {
      const stale = await this.prisma.errorGroup.findMany({
        where: { lastSeenAt: { lt: cutoff } },
        select: { id: true },
        take: ERROR_RETENTION_BATCH
      });
      if (stale.length === 0) break;
      const result = await this.prisma.errorGroup.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } }
      });
      total += result.count;
      if (stale.length < ERROR_RETENTION_BATCH) break;
    }
    return total;
  }
}
