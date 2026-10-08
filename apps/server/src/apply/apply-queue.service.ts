import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { ApplyExecutorService } from './apply-executor.service';
import { LeaseService } from '../coordination/lease.service';

const TICK_MS = 2_000;
const RECLAIM_MS = 30_000;
const CLAIM_BATCH = 5;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 10 * 60 * 1000;

interface ClaimedItem {
  id: string;
  dedupeKey: string;
  opType: string;
  manifest: unknown;
  generation: number;
  attempts: number;
  deploymentId: string | null;
  sandboxId: string | null;
}

export interface EnqueueInput {
  dedupeKey: string;
  opType: string;
  manifest?: unknown;
  deploymentId?: string;
  sandboxId?: string;
  requestedById?: string;
}

@Injectable()
export class ApplyQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApplyQueueService.name);

  private readonly workerId = `${hostname()}-${process.pid}`;

  private timers: ReturnType<typeof setInterval>[] = [];

  private draining = false;

  private outsider = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: ApplyExecutorService,
    private readonly lease: LeaseService
  ) {}

  onModuleInit() {
    if (process.env.APPLY_WORKER_DISABLED === 'true') {
      this.logger.log('APPLY_WORKER_DISABLED=true — enqueue-only on this replica');
      return;
    }
    // This queue applies real changes to the cluster, and it is drained by every
    // worker that can reach the database rather than by an elected one. A process
    // that is not a member of the cluster the database describes has no business
    // taking items off it.
    if (!this.lease.canCoordinate) {
      this.outsider = true;
      this.logger.warn(
        'not a member of the cluster this database belongs to (no control namespace); enqueue-only on this replica'
      );
      return;
    }
    this.timers = [
      setInterval(() => {
        void this.drain();
      }, TICK_MS),
      setInterval(() => {
        void this.reclaim();
      }, RECLAIM_MS)
    ];
    for (const t of this.timers) t.unref?.();
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }

  async enqueue(input: EnqueueInput): Promise<void> {
    const manifest = (input.manifest ?? null) as object | null;
    await this.prisma.k8sApplyItem.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
        dedupeKey: input.dedupeKey,
        opType: input.opType,
        manifest: manifest ?? undefined,
        deploymentId: input.deploymentId ?? null,
        sandboxId: input.sandboxId ?? null,
        requestedById: input.requestedById ?? null
      },
      update: {
        manifest: manifest ?? undefined,
        generation: { increment: 1 },
        status: 'pending',
        attempts: 0,
        notBefore: new Date(),
        lastError: null,
        sandboxId: input.sandboxId ?? null,
        requestedById: input.requestedById ?? null
      }
    });
    if (input.deploymentId) {
      await this.prisma.deployment
        .update({
          where: { id: input.deploymentId },
          data: { applyStatus: 'pending', applyError: null }
        })
        .catch(() => {});
    }
    this.kick();
  }

  async retryForDeployment(deploymentId: string): Promise<number> {
    const result = await this.prisma.k8sApplyItem.updateMany({
      where: { deploymentId, status: 'failed' },
      data: {
        status: 'pending',
        attempts: 0,
        notBefore: new Date(),
        lastError: null,
        generation: { increment: 1 }
      }
    });
    if (result.count > 0) {
      await this.prisma.deployment
        .update({
          where: { id: deploymentId },
          data: { applyStatus: 'pending', applyError: null }
        })
        .catch(() => {});
      this.kick();
    }
    return result.count;
  }

  async retryForSandbox(sandboxId: string): Promise<number> {
    const result = await this.prisma.k8sApplyItem.updateMany({
      where: { sandboxId, status: 'failed' },
      data: {
        status: 'pending',
        attempts: 0,
        notBefore: new Date(),
        lastError: null,
        generation: { increment: 1 }
      }
    });
    if (result.count > 0) this.kick();
    return result.count;
  }

  async hasOpenItem(dedupeKey: string): Promise<boolean> {
    const row = await this.prisma.k8sApplyItem.findUnique({
      where: { dedupeKey },
      select: { status: true }
    });
    return row?.status === 'pending' || row?.status === 'applying';
  }

  kick(): void {
    if (process.env.APPLY_WORKER_DISABLED === 'true' || this.outsider) return;
    setImmediate(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let i = 0; i < 10; i += 1) {
        const claimed = await this.claim();
        if (claimed.length === 0) return;
        await Promise.allSettled(claimed.map((item) => this.process(item)));
        if (claimed.length < CLAIM_BATCH) return;
      }
    } catch (err) {
      this.logger.warn(`drain failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.draining = false;
    }
  }

  private async claim(): Promise<ClaimedItem[]> {
    return this.prisma.$queryRaw<ClaimedItem[]>`
      UPDATE "k8s_apply_queue"
      SET "status" = 'applying', "claimed_by" = ${this.workerId}, "claimed_at" = (NOW() AT TIME ZONE 'UTC')
      WHERE "id" IN (
        SELECT "id" FROM "k8s_apply_queue"
        WHERE "status" = 'pending' AND "not_before" <= (NOW() AT TIME ZONE 'UTC')
        ORDER BY "not_before" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${CLAIM_BATCH}
      )
      RETURNING "id", "dedupe_key" AS "dedupeKey", "op_type" AS "opType", "manifest",
                "generation", "attempts", "deployment_id" AS "deploymentId",
                "sandbox_id" AS "sandboxId"
    `;
  }

  private async process(item: ClaimedItem): Promise<void> {
    const result = await this.executor.execute(item);
    const current = await this.prisma.k8sApplyItem.findUnique({
      where: { id: item.id },
      select: { generation: true }
    });
    if (!current) return;

    if (current.generation > item.generation) {
      await this.prisma.k8sApplyItem.update({
        where: { id: item.id },
        data: {
          status: 'pending',
          attempts: 0,
          notBefore: new Date(),
          claimedBy: null,
          claimedAt: null
        }
      });
      this.kick();
      return;
    }

    if (result.ok) {
      await this.prisma.k8sApplyItem.update({
        where: { id: item.id },
        data: { status: 'applied', lastError: null, claimedBy: null, claimedAt: null }
      });
      await this.settleDeployment(item.deploymentId);
      return;
    }

    const attempts = item.attempts + 1;
    if (result.terminal || attempts >= MAX_ATTEMPTS) {
      await this.prisma.k8sApplyItem.update({
        where: { id: item.id },
        data: {
          status: 'failed',
          attempts,
          lastError: result.error ?? 'apply failed',
          claimedBy: null,
          claimedAt: null
        }
      });
      if (item.deploymentId) {
        await this.prisma.deployment
          .update({
            where: { id: item.deploymentId },
            data: { applyStatus: 'error', applyError: result.error ?? 'apply failed' }
          })
          .catch(() => {});
      }
      this.logger.warn(
        `apply ${item.dedupeKey} terminal after ${attempts} attempts: ${result.error}`
      );
      return;
    }

    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
    await this.prisma.k8sApplyItem.update({
      where: { id: item.id },
      data: {
        status: 'pending',
        attempts,
        notBefore: new Date(Date.now() + backoff),
        lastError: result.error ?? null,
        claimedBy: null,
        claimedAt: null
      }
    });
  }

  private async settleDeployment(deploymentId: string | null): Promise<void> {
    if (!deploymentId) return;
    const open = await this.prisma.k8sApplyItem.count({
      where: { deploymentId, status: { in: ['pending', 'applying', 'failed'] } }
    });
    if (open === 0) {
      await this.prisma.deployment
        .update({
          where: { id: deploymentId },
          data: { applyStatus: 'synced', applyError: null }
        })
        .catch(() => {});
    }
  }

  private async reclaim(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
      await this.prisma.$executeRaw`
        UPDATE "k8s_apply_queue"
        SET "status" = 'pending', "claimed_by" = NULL, "claimed_at" = NULL
        WHERE "status" = 'applying' AND "claimed_at" < ${cutoff}
      `;
    } catch (err) {
      this.logger.warn(`reclaim failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
