import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentsService } from './deployments.service';
import { GitHubService } from '../github/github.service';

@Injectable()
export class BuildQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildQueueService.name);
  private readonly workerId = `${hostname()}-${process.pid}`;
  private readonly maxConcurrent = Math.max(
    1,
    parseInt(process.env.MAX_CONCURRENT_BUILDS || '15', 10) || 15,
  );
  private readonly LOCK_KEY = 528491;
  private readonly txOpts = { maxWait: 10_000, timeout: 20_000 };
  private draining = false;
  private drainAgain = false;
  private drainInterval: NodeJS.Timeout | null = null;
  private bootTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    this.drainInterval = setInterval(() => {
      this.heartbeat().catch(() => {});
      this.reclaim().catch((e) => this.logger.warn(`reclaim failed: ${e?.message ?? e}`));
      this.kick();
    }, 30_000);
    this.drainInterval.unref?.();
    this.bootTimeout = setTimeout(() => {
      this.reclaim().catch(() => {});
      this.kick();
    }, 4_000);
    this.bootTimeout.unref?.();
  }

  onModuleDestroy() {
    if (this.drainInterval) clearInterval(this.drainInterval);
    if (this.bootTimeout) clearTimeout(this.bootTimeout);
    this.drainInterval = null;
    this.bootTimeout = null;
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.LOCK_KEY})`;

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
    }, this.txOpts);
  }

  // Stamp the GitHub artifacts (check run, installation, repo) onto the run
  // that owns this deployment's in-flight build, so the reclaim sweep can
  // conclude them if the owning process dies before the finalizers run.
  async attachGitHubContext(
    deploymentId: string,
    ctx: { checkRunId: number; installationId: bigint; repoFullName: string },
  ): Promise<void> {
    await this.prisma.buildRun
      .updateMany({
        where: { deploymentId, status: 'building', checkRunId: null },
        data: {
          checkRunId: BigInt(ctx.checkRunId),
          githubInstallationId: ctx.installationId,
          repoFullName: ctx.repoFullName,
        },
      })
      .catch(() => {});
  }

  private async heartbeat(): Promise<void> {
    await this.prisma.buildRun.updateMany({
      where: { workerId: this.workerId, status: 'building' },
      data: { heartbeatAt: new Date() },
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
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${this.LOCK_KEY}) AS locked
      `;
      if (!locked) return null;
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
    }, this.txOpts);
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
      const deployments = this.moduleRef.get(DeploymentsService, { strict: false });
      await deployments.runQueuedBuild(run);
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
      select: {
        id: true,
        deploymentId: true,
        startedAt: true,
        heartbeatAt: true,
        workerId: true,
        checkRunId: true,
        githubInstallationId: true,
        repoFullName: true,
      },
    });
    if (building.length === 0) return;
    const STUCK_MS = 45 * 60 * 1000;
    // Owning workers bump heartbeatAt every 30s; a run whose heartbeat is
    // minutes old belongs to a process that died mid-build (restart, OOM).
    const DEAD_MS = 3 * 60 * 1000;
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
        continue;
      }
      const lastSeen = run.heartbeatAt?.getTime() ?? run.startedAt?.getTime() ?? 0;
      const workerDead = run.workerId !== this.workerId && lastSeen > 0 && now - lastSeen > DEAD_MS;
      const overRuntime = run.startedAt && now - run.startedAt.getTime() > STUCK_MS;
      if (!workerDead && !overRuntime) continue;
      const detail = workerDead
        ? 'Build interrupted by a platform restart'
        : 'Build exceeded the maximum runtime';
      const claimed = await this.prisma.buildRun.updateMany({
        where: { id: run.id, status: 'building' },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          detail,
          workerId: null,
        },
      });
      if (claimed.count === 0) continue;
      await this.prisma.deployment.updateMany({
        where: { id: run.deploymentId, buildStatus: 'building' },
        data: { buildStatus: 'failed', buildError: detail, status: 'running' },
      });
      await this.closeGitHubArtifacts(run, detail).catch((e) =>
        this.logger.warn(`failed to close github artifacts for run ${run.id}: ${e?.message ?? e}`),
      );
      this.logger.warn(`reclaimed run ${run.id} (${detail})`);
    }
  }

  private async closeGitHubArtifacts(
    run: {
      deploymentId: string;
      checkRunId: bigint | null;
      githubInstallationId: bigint | null;
      repoFullName: string | null;
    },
    detail: string,
  ) {
    if (!run.githubInstallationId || !run.repoFullName) return;
    const [owner, repo] = run.repoFullName.split('/');
    if (!owner || !repo) return;
    const github = this.moduleRef.get(GitHubService, { strict: false });
    if (run.checkRunId) {
      await github
        .updateCheckRun(run.githubInstallationId, owner, repo, Number(run.checkRunId), {
          status: 'completed',
          conclusion: 'cancelled',
          output: {
            title: 'Build interrupted',
            summary: detail,
          },
        })
        .catch((e: any) => this.logger.warn(`check run close failed: ${e?.message ?? e}`));
    }
    const marker = await this.prisma.gitHubDeployment.findFirst({
      where: {
        deploymentId: run.deploymentId,
        status: { in: ['pending', 'in_progress'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (marker) {
      await github
        .updateDeploymentStatusWithApp(
          run.githubInstallationId,
          marker.owner,
          marker.repo,
          Number(marker.githubDeploymentId),
          'error',
          { description: detail, logUrl: marker.logUrl ?? undefined },
        )
        .catch((e: any) => this.logger.warn(`deployment marker close failed: ${e?.message ?? e}`));
      await this.prisma.gitHubDeployment
        .update({ where: { id: marker.id }, data: { status: 'error' } })
        .catch(() => {});
    }
  }
}
