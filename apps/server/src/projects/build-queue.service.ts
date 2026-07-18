import { forwardRef, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentsService } from './deployments.service';

@Injectable()
export class BuildQueueService implements OnModuleInit {
  private readonly logger = new Logger(BuildQueueService.name);
  private readonly workerId = `${hostname()}-${process.pid}`;
  private readonly maxConcurrent = Math.max(
    1,
    parseInt(process.env.MAX_CONCURRENT_BUILDS || '15', 10) || 15,
  );
  private readonly LOCK_KEY = 528491;
  private draining = false;
  private drainAgain = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DeploymentsService))
    private readonly deployments: DeploymentsService,
  ) {}

  onModuleInit() {
    setInterval(() => {
      this.reclaim().catch((e) => this.logger.warn(`reclaim failed: ${e?.message ?? e}`));
      this.kick();
    }, 30_000).unref?.();
    setTimeout(() => {
      this.reclaim().catch(() => {});
      this.kick();
    }, 4_000);
  }

  async enqueue(opts: {
    deploymentId: string;
    triggerType: 'auto' | 'manual' | 'initial';
    commitSha?: string | null;
    commitMessage?: string | null;
    commitAuthorName?: string | null;
    commitAuthorUsername?: string | null;
    branch?: string | null;
    triggeredById?: string | null;
  }): Promise<{ startNow: boolean; runId: string }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${this.LOCK_KEY})`;

      await tx.buildRun.updateMany({
        where: { deploymentId: opts.deploymentId, status: 'scheduled' },
        data: { status: 'skipped', detail: 'Superseded by a newer build', finishedAt: new Date() },
      });

      const dep = await tx.deployment.findUnique({
        where: { id: opts.deploymentId },
        select: { buildStatus: true },
      });
      const buildingForDep = await tx.buildRun.count({
        where: { deploymentId: opts.deploymentId, status: 'building' },
      });
      const buildingGlobal = await tx.buildRun.count({ where: { status: 'building' } });
      const startNow =
        buildingForDep === 0 &&
        dep?.buildStatus !== 'building' &&
        buildingGlobal < this.maxConcurrent;

      const now = new Date();
      const run = await tx.buildRun.create({
        data: {
          deploymentId: opts.deploymentId,
          status: startNow ? 'building' : 'scheduled',
          triggerType: opts.triggerType,
          commitSha: opts.commitSha ?? null,
          commitMessage: opts.commitMessage ?? null,
          commitAuthorName: opts.commitAuthorName ?? null,
          commitAuthorUsername: opts.commitAuthorUsername ?? null,
          branch: opts.branch ?? null,
          triggeredById: opts.triggeredById ?? null,
          workerId: startNow ? this.workerId : null,
          startedAt: startNow ? now : null,
          heartbeatAt: startNow ? now : null,
        },
      });
      return { startNow, runId: run.id };
    });
  }

  async recordActiveBuild(opts: {
    deploymentId: string;
    triggerType: 'auto' | 'manual' | 'initial';
    commitSha?: string | null;
    commitMessage?: string | null;
    branch?: string | null;
    triggeredById?: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.buildRun.create({
      data: {
        deploymentId: opts.deploymentId,
        status: 'building',
        triggerType: opts.triggerType,
        commitSha: opts.commitSha ?? null,
        commitMessage: opts.commitMessage ?? null,
        branch: opts.branch ?? null,
        triggeredById: opts.triggeredById ?? null,
        workerId: this.workerId,
        startedAt: now,
        heartbeatAt: now,
      },
    });
  }

  async onBuildFinished(deploymentId: string) {
    try {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStatus: true },
      });
      const ok = dep?.buildStatus === 'succeeded';
      await this.prisma.buildRun.updateMany({
        where: { deploymentId, status: 'building' },
        data: {
          status: ok ? 'succeeded' : 'failed',
          finishedAt: new Date(),
          workerId: null,
        },
      });
    } catch (e) {
      this.logger.warn(`onBuildFinished(${deploymentId}) failed: ${(e as Error)?.message ?? e}`);
    }
    this.kick();
  }

  kick() {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
      if (this.drainAgain) {
        this.drainAgain = false;
        this.kick();
      }
    });
  }

  private async drain() {
    for (let i = 0; i < this.maxConcurrent + 4; i++) {
      const run = await this.claimOne().catch((e) => {
        this.logger.warn(`claim failed: ${e?.message ?? e}`);
        return null;
      });
      if (!run) break;
      this.execute(run).catch((e) =>
        this.logger.error(`execute run ${run.id} failed: ${e?.message ?? e}`),
      );
    }
  }

  private async claimOne() {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${this.LOCK_KEY})`;
      const buildingGlobal = await tx.buildRun.count({ where: { status: 'building' } });
      if (buildingGlobal >= this.maxConcurrent) return null;

      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT br.id
        FROM build_runs br
        WHERE br.status = 'scheduled'
          AND NOT EXISTS (
            SELECT 1 FROM build_runs b2
            WHERE b2.deployment_id = br.deployment_id AND b2.status = 'building'
          )
          AND NOT EXISTS (
            SELECT 1 FROM deployments d
            WHERE d.id = br.deployment_id AND d.build_status = 'building'
          )
        ORDER BY br.scheduled_at ASC
        FOR UPDATE OF br SKIP LOCKED
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const id = rows[0].id;
      const now = new Date();
      return tx.buildRun.update({
        where: { id },
        data: { status: 'building', workerId: this.workerId, startedAt: now, heartbeatAt: now },
      });
    });
  }

  private async execute(run: {
    id: string;
    deploymentId: string;
    triggerType: string;
    commitSha: string | null;
    commitMessage: string | null;
    commitAuthorName: string | null;
    commitAuthorUsername: string | null;
    triggeredById: string | null;
  }) {
    try {
      await this.deployments.runQueuedBuild(run);
    } catch (e) {
      this.logger.error(`queued build ${run.id} threw: ${(e as Error)?.message ?? e}`);
      await this.prisma.buildRun
        .updateMany({
          where: { id: run.id, status: 'building' },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            detail: (e as Error)?.message ?? 'Build failed to start',
            workerId: null,
          },
        })
        .catch(() => {});
      this.kick();
    }
  }

  private async reclaim() {
    const building = await this.prisma.buildRun.findMany({
      where: { status: 'building' },
      select: { id: true, deploymentId: true, startedAt: true },
    });
    if (building.length === 0) return;
    const STUCK_MS = 45 * 60 * 1000;
    const now = Date.now();
    for (const run of building) {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: run.deploymentId },
        select: { buildStatus: true },
      });
      if (!dep || dep.buildStatus === 'succeeded' || dep.buildStatus === 'failed') {
        await this.prisma.buildRun.updateMany({
          where: { id: run.id, status: 'building' },
          data: {
            status: dep?.buildStatus === 'succeeded' ? 'succeeded' : 'failed',
            finishedAt: new Date(),
            workerId: null,
          },
        });
      } else if (run.startedAt && now - run.startedAt.getTime() > STUCK_MS) {
        await this.prisma.buildRun.updateMany({
          where: { id: run.id, status: 'building' },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            detail: 'Build exceeded the maximum runtime',
            workerId: null,
          },
        });
      }
    }
  }
}
