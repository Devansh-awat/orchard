import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentsService } from './deployments.service';
import { GitHubService } from '../github/github.service';
import { canTrustDeploymentStatus } from './build-recovery';
import { LeaseService } from '../coordination/lease.service';
import { BuildBackendRouter, BuilderKind } from '../docker/fc/build-backend-router';
import { Prisma } from '@prisma/client';

export interface QueueSnapshot {
  running: number;
  limit: number;
  waiting: number;
  blockedByOwnBuild: boolean;
  blockedByOrgCap: boolean;
  pool: 'depot' | 'cluster' | 'firecracker';
}

function poolWhere(pool: BuilderKind, status: 'building' | 'scheduled'): Prisma.BuildRunWhereInput {
  if (pool === 'firecracker') return { status, builder: 'firecracker' };
  return {
    status,
    OR: [{ builder: pool }, { builder: null, deployment: { buildWithDepot: pool === 'depot' } }]
  };
}

export function orgBuildLimit(
  poolLimit: number,
  override = process.env.MAX_CONCURRENT_BUILDS_PER_ORG
) {
  const raw = override?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return poolLimit <= 4 ? 0 : Math.ceil(poolLimit / 2);
}

const NO_ORG_LIMIT = 2147483647;

export function claimFairnessLimits(limits: { local: number; depot: number; fc: number }) {
  const pick = (value: number) => (value > 0 ? value : NO_ORG_LIMIT);
  return {
    local: pick(orgBuildLimit(limits.local)),
    depot: pick(orgBuildLimit(limits.depot)),
    fc: pick(orgBuildLimit(limits.fc))
  };
}

function snapshotPool(pool: BuilderKind): QueueSnapshot['pool'] {
  return pool === 'kubernetes' ? 'cluster' : pool;
}

/**
 * Flip a deployment to `building` in the same transaction that claims its run.
 *
 * Written apart, these two rows can be as much as a minute out of step: the run
 * goes `building` at claim, and the deployment only follows once the build path
 * has resolved a GitHub installation, minted an installation token and opened a
 * check run. Everything that reads one of them to judge the other (the reclaim
 * sweep below, the recovery sweep, this file's own "is a build already running"
 * test) is wrong for the length of that gap. The reclaim sweep sees a run in
 * `building` whose deployment still reads `succeeded` from the *previous* build,
 * concludes the run, and leaves the deployment `building` with no run to own it;
 * the recovery sweep then fails the live build.
 *
 * Clearing `buildStepTimestamps` matters as much as the status. It carries the
 * last build's `__jobName` and `__image`, and a sweep landing in this window
 * would otherwise adopt the previous build's job and deploy its image.
 */
async function markDeploymentBuilding(
  tx: Pick<PrismaService, 'deployment'>,
  deploymentId: string
): Promise<void> {
  // updateMany, not update: a deployment deleted between being read and its
  // run being claimed must not abort the claim transaction.
  await tx.deployment.updateMany({
    where: { id: deploymentId },
    data: {
      buildStatus: 'building',
      buildStep: null,
      buildStepTimestamps: { __start: Date.now() },
      buildError: null
    }
  });
}

@Injectable()
export class BuildQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildQueueService.name);
  private readonly workerId = `${hostname()}-${process.pid}`;
  private readonly maxConcurrent = Math.max(
    1,
    parseInt(process.env.MAX_CONCURRENT_BUILDS || '15', 10) || 15
  );

  // Super builds run on Depot's machines, so they don't compete for the local
  // builder's memory the way a BuildKit build does. Their pods do still land on
  // the dedicated builder node, so this stays well under what that node has
  // left over the BuildKit pool rather than being unbounded.
  private readonly maxConcurrentDepot = Math.max(
    1,
    parseInt(process.env.MAX_CONCURRENT_DEPOT_BUILDS || '4', 10) || 4
  );

  private readonly maxConcurrentFc = Math.max(
    1,
    parseInt(process.env.MAX_CONCURRENT_FC_BUILDS || '16', 10) || 16
  );

  private limitFor(pool: BuilderKind): number {
    if (pool === 'depot') return this.maxConcurrentDepot;
    if (pool === 'firecracker') return this.maxConcurrentFc;
    return this.maxConcurrent;
  }

  private async chooseBuilder(deploymentId: string): Promise<BuilderKind> {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        buildWithDepot: true,
        builderOverride: true,
        projectId: true,
        project: {
          select: { slug: true, organizationId: true, organization: { select: { slug: true } } }
        }
      }
    });
    if (!dep) return 'kubernetes';
    if (dep.buildWithDepot) return 'depot';
    try {
      const router = this.moduleRef.get(BuildBackendRouter, { strict: false });
      return await router.pick({
        buildWithDepot: dep.buildWithDepot,
        builderOverride: dep.builderOverride,
        projectId: dep.projectId,
        projectSlug: dep.project.slug,
        organizationId: dep.project.organizationId,
        organizationSlug: dep.project.organization.slug
      });
    } catch (error) {
      this.logger.warn(`builder choice failed for ${deploymentId}: ${(error as Error).message}`);
      return 'kubernetes';
    }
  }

  async setRunBuilder(deploymentId: string, builder: BuilderKind): Promise<void> {
    await this.prisma.buildRun
      .updateMany({ where: { deploymentId, status: 'building' }, data: { builder } })
      .catch(() => {});
  }

  async currentBuilder(deploymentId: string): Promise<BuilderKind | null> {
    const run = await this.prisma.buildRun.findFirst({
      where: { deploymentId, status: 'building' },
      orderBy: { startedAt: 'desc' },
      select: { builder: true }
    });
    const b = run?.builder;
    return b === 'kubernetes' || b === 'depot' || b === 'firecracker' ? b : null;
  }
  private readonly LOCK_KEY = 528491;
  private readonly workerDisabled = process.env.BUILD_WORKER_DISABLED === 'true';

  private outsider = false;
  private readonly txOpts = { maxWait: 10_000, timeout: 20_000 };
  private draining = false;
  private drainAgain = false;
  private drainInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private bootTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly lease: LeaseService
  ) {}

  onModuleInit() {
    if (this.workerDisabled) {
      this.logger.log(
        'BUILD_WORKER_DISABLED=true; this instance will enqueue builds but never claim or run them'
      );
      return;
    }
    // The queue is drained with SKIP LOCKED across every worker that can reach
    // the database, which is the whole cluster plus anything else pointed at it.
    // A process that is not a member of that cluster must not take work off it:
    // it would run somebody else's build on a laptop, against a checkout and a
    // Docker daemon that have nothing to do with the deployment.
    if (!this.lease.canCoordinate) {
      this.outsider = true;
      this.logger.warn(
        'not a member of the cluster this database belongs to (no control namespace); enqueueing builds but never claiming them'
      );
      return;
    }
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat().catch(() => {});
    }, 10_000);
    this.heartbeatInterval.unref?.();
    this.drainInterval = setInterval(() => {
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
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.bootTimeout) clearTimeout(this.bootTimeout);
    this.drainInterval = null;
    this.heartbeatInterval = null;
    this.bootTimeout = null;
  }

  /**
   * Why a build is or is not running right now, in the terms an operator or an
   * agent needs: how many slots exist, how many are busy, and whether this
   * deployment is waiting on the pool or on a build of its own.
   */
  async enqueue(opts: {
    deploymentId: string;
    triggerType: 'auto' | 'manual' | 'initial';
    commitSha?: string | null;
    commitMessage?: string | null;
    commitAuthorName?: string | null;
    commitAuthorUsername?: string | null;
    branch?: string | null;
    triggeredById?: string | null;
  }): Promise<{ startNow: boolean; runId: string; queue: QueueSnapshot }> {
    const builder = await this.chooseBuilder(opts.deploymentId);
    const enqueued = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.LOCK_KEY})`;

      const stale = await tx.buildRun.findMany({
        where: { deploymentId: opts.deploymentId, status: 'scheduled' },
        select: { commitSha: true }
      });

      await tx.buildRun.updateMany({
        where: { deploymentId: opts.deploymentId, status: 'scheduled' },
        data: {
          status: 'skipped',
          detail: opts.commitSha
            ? `Superseded by ${opts.commitSha.substring(0, 7)}`
            : 'Superseded by a newer build',
          finishedAt: new Date()
        }
      });

      const dep = await tx.deployment.findUnique({
        where: { id: opts.deploymentId },
        select: {
          buildStatus: true,
          buildWithDepot: true,
          name: true,
          githubRepo: true,
          githubInstallationId: true,
          project: { select: { organizationId: true, organization: { select: { slug: true } } } }
        }
      });
      const buildingForDep = await tx.buildRun.count({
        where: { deploymentId: opts.deploymentId, status: 'building' }
      });
      const pool: BuilderKind = dep?.buildWithDepot === true ? 'depot' : builder;
      const buildingInPool = await tx.buildRun.count({ where: poolWhere(pool, 'building') });
      const limit = this.limitFor(pool);
      const orgLimit = orgBuildLimit(limit);
      const organizationId = dep?.project?.organizationId;
      const buildingForOrg =
        organizationId && orgLimit > 0
          ? await tx.buildRun.count({
              where: {
                AND: [poolWhere(pool, 'building'), { deployment: { project: { organizationId } } }]
              }
            })
          : 0;
      const orgFull = orgLimit > 0 && buildingForOrg >= orgLimit;
      const startNow =
        buildingForDep === 0 &&
        dep?.buildStatus !== 'building' &&
        buildingInPool < limit &&
        !orgFull;

      // Counted here rather than after the fact so the caller can say why a
      // build has not started. Without it a queued rebuild is indistinguishable
      // from one that silently did nothing, which is what it looked like to
      // every API client.
      const waiting = await tx.buildRun.count({ where: poolWhere(pool, 'scheduled') });

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
          builder: pool,
          workerId: startNow ? this.workerId : null,
          startedAt: startNow ? now : null,
          heartbeatAt: startNow ? now : null
        }
      });
      if (startNow) await markDeploymentBuilding(tx, opts.deploymentId);

      const queue: QueueSnapshot = {
        running: buildingInPool,
        limit,
        waiting: startNow ? waiting : waiting + 1,
        blockedByOwnBuild: buildingForDep > 0 || dep?.buildStatus === 'building',
        blockedByOrgCap: orgFull,
        pool: snapshotPool(pool)
      };
      return { startNow, runId: run.id, superseded: stale, deployment: dep, queue };
    }, this.txOpts);

    if (enqueued.superseded.length > 0) {
      void this.announceSuperseded(enqueued.superseded, enqueued.deployment, opts).catch((e) =>
        this.logger.warn(`superseded announce failed: ${e?.message ?? e}`)
      );
    }

    return { startNow: enqueued.startNow, runId: enqueued.runId, queue: enqueued.queue };
  }

  private async announceSuperseded(
    superseded: { commitSha: string | null }[],
    deployment: {
      name: string;
      githubRepo: string | null;
      githubInstallationId: bigint | null;
      project: { organization: { slug: string } | null } | null;
    } | null,
    opts: { deploymentId: string; commitSha?: string | null }
  ): Promise<void> {
    if (!deployment?.githubRepo || !deployment.githubInstallationId) return;
    const github = this.moduleRef.get(GitHubService, { strict: false });
    const repoInfo = github.parseRepoUrl(deployment.githubRepo);
    if (!repoInfo) return;

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const orgSlug = deployment.project?.organization?.slug;
    const detailsUrl = orgSlug
      ? `${frontendUrl}/${orgSlug}/deployments/${opts.deploymentId}`
      : `${frontendUrl}/deployments/${opts.deploymentId}`;
    const newer = opts.commitSha ? `\`${opts.commitSha.substring(0, 7)}\`` : 'a newer build';

    const announced = new Set<string>();
    for (const run of superseded) {
      const sha = run.commitSha;
      if (!sha || sha === opts.commitSha || announced.has(sha)) continue;
      announced.add(sha);
      await github
        .createCheckRun(deployment.githubInstallationId, repoInfo.owner, repoInfo.repo, {
          name: 'Orchard Deployment',
          headSha: sha,
          status: 'completed',
          conclusion: 'skipped',
          detailsUrl,
          externalId: opts.deploymentId,
          output: {
            title: 'Rolled into a newer build',
            summary: `\`${deployment.name}\` was still waiting for a build slot when ${newer} took over. That build deploys this commit's code too.`
          }
        })
        .catch((e: any) =>
          this.logger.warn(
            `superseded check run for ${sha.substring(0, 7)} failed: ${e?.message ?? e}`
          )
        );
    }
  }

  // Stamp the GitHub artifacts (check run, installation, repo) onto the run
  // that owns this deployment's in-flight build, so the reclaim sweep can
  // conclude them if the owning process dies before the finalizers run.
  async attachGitHubContext(
    deploymentId: string,
    ctx: { checkRunId: number; installationId: bigint; repoFullName: string }
  ): Promise<void> {
    await this.prisma.buildRun
      .updateMany({
        where: { deploymentId, status: 'building', checkRunId: null },
        data: {
          checkRunId: BigInt(ctx.checkRunId),
          githubInstallationId: ctx.installationId,
          repoFullName: ctx.repoFullName
        }
      })
      .catch(() => {});
  }

  /**
   * Put a concluded run's work back on the queue as a fresh scheduled run.
   *
   * Takes the same advisory lock the claim path holds, because the caller
   * reached here precisely because no run was `building`, which is also the
   * moment a claim is most likely to land. Without the lock the insert could
   * race a claim and knock the deployment back to `pending` underneath a build
   * that had just started. Answers `false` when something else already owns
   * this deployment's next build, which is not a failure.
   */
  async scheduleRetryForConcludedRun(
    deploymentId: string,
    source: {
      triggerType: string;
      commitSha: string | null;
      commitMessage: string | null;
      commitAuthorName: string | null;
      commitAuthorUsername: string | null;
      branch: string | null;
      triggeredById: string | null;
    },
    detail: string
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.LOCK_KEY})`;
      const live = await tx.buildRun.count({
        where: { deploymentId, status: { in: ['building', 'scheduled'] } }
      });
      if (live > 0) return false;
      await tx.buildRun.create({
        data: {
          deploymentId,
          status: 'scheduled',
          detail,
          triggerType: source.triggerType,
          commitSha: source.commitSha,
          commitMessage: source.commitMessage,
          commitAuthorName: source.commitAuthorName,
          commitAuthorUsername: source.commitAuthorUsername,
          branch: source.branch,
          triggeredById: source.triggeredById
        }
      });
      await tx.deployment.updateMany({
        where: { id: deploymentId, buildStatus: 'building' },
        data: { buildStatus: 'pending' }
      });
      return true;
    }, this.txOpts);
  }

  async adoptRun(deploymentId: string): Promise<void> {
    await this.prisma.buildRun
      .updateMany({
        where: { deploymentId, status: 'building' },
        data: { workerId: this.workerId, heartbeatAt: new Date() }
      })
      .catch(() => {});
  }

  private async heartbeat(): Promise<void> {
    await this.prisma.buildRun.updateMany({
      where: { workerId: this.workerId, status: 'building' },
      data: { heartbeatAt: new Date() }
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
    const builder = await this.chooseBuilder(opts.deploymentId);
    const now = new Date();
    await this.prisma.buildRun.create({
      data: {
        deploymentId: opts.deploymentId,
        status: 'building',
        builder,
        triggerType: opts.triggerType,
        commitSha: opts.commitSha ?? null,
        commitMessage: opts.commitMessage ?? null,
        branch: opts.branch ?? null,
        triggeredById: opts.triggeredById ?? null,
        workerId: this.workerId,
        startedAt: now,
        heartbeatAt: now
      }
    });
  }

  async onBuildFinished(deploymentId: string) {
    try {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStatus: true }
      });
      const ok = dep?.buildStatus === 'succeeded';
      await this.prisma.$executeRaw`
        UPDATE "build_runs" br
        SET "status" = ${ok ? 'succeeded' : 'failed'},
            "finished_at" = (NOW() AT TIME ZONE 'UTC'),
            "worker_id" = NULL,
            "logs" = d."build_logs",
            "step_timestamps" = d."build_step_timestamps"
        FROM "deployments" d
        WHERE d."id" = br."deployment_id"
          AND br."deployment_id" = ${deploymentId}::uuid
          AND br."status" = 'building'
      `;
    } catch (e) {
      this.logger.warn(`onBuildFinished(${deploymentId}) failed: ${(e as Error)?.message ?? e}`);
    }
    this.kick();
  }

  kick() {
    if (this.workerDisabled || this.outsider) return;
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
    for (
      let i = 0;
      i < this.maxConcurrent + this.maxConcurrentDepot + this.maxConcurrentFc + 4;
      i++
    ) {
      const run = await this.claimOne().catch((e) => {
        this.logger.warn(`claim failed: ${e?.message ?? e}`);
        return null;
      });
      if (!run) break;
      this.execute(run).catch((e) =>
        this.logger.error(`execute run ${run.id} failed: ${e?.message ?? e}`)
      );
    }
  }

  private async claimOne() {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${this.LOCK_KEY}) AS locked
      `;
      if (!locked) return null;
      const buildingLocal = await tx.buildRun.count({ where: poolWhere('kubernetes', 'building') });
      const buildingDepot = await tx.buildRun.count({ where: poolWhere('depot', 'building') });
      const buildingFc = await tx.buildRun.count({ where: poolWhere('firecracker', 'building') });
      const localOpen = buildingLocal < this.maxConcurrent;
      const depotOpen = buildingDepot < this.maxConcurrentDepot;
      const fcOpen = buildingFc < this.maxConcurrentFc;
      if (!localOpen && !depotOpen && !fcOpen) return null;

      const orgCaps = claimFairnessLimits({
        local: this.maxConcurrent,
        depot: this.maxConcurrentDepot,
        fc: this.maxConcurrentFc
      });
      const orgRunning = Prisma.sql`(
        SELECT COUNT(*) FROM build_runs b3
        JOIN deployments d3 ON d3.id = b3.deployment_id
        JOIN projects p3 ON p3.id = d3.project_id
        WHERE b3.status = 'building'
          AND p3.organization_id = pq.organization_id
          AND COALESCE(b3.builder, CASE WHEN d3.build_with_depot THEN 'depot' ELSE 'kubernetes' END)
            = COALESCE(br.builder, CASE WHEN d0.build_with_depot THEN 'depot' ELSE 'kubernetes' END)
      )`;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT br.id
        FROM build_runs br
        JOIN deployments d0 ON d0.id = br.deployment_id
        JOIN projects pq ON pq.id = d0.project_id
        WHERE br.status = 'scheduled'
          AND (
            (${localOpen}::boolean AND COALESCE(br.builder, CASE WHEN d0.build_with_depot THEN 'depot' ELSE 'kubernetes' END) = 'kubernetes' AND ${orgRunning} < ${orgCaps.local}::bigint)
            OR (${depotOpen}::boolean AND COALESCE(br.builder, CASE WHEN d0.build_with_depot THEN 'depot' ELSE 'kubernetes' END) = 'depot' AND ${orgRunning} < ${orgCaps.depot}::bigint)
            OR (${fcOpen}::boolean AND br.builder = 'firecracker' AND ${orgRunning} < ${orgCaps.fc}::bigint)
          )
          AND NOT EXISTS (
            SELECT 1 FROM build_runs b2
            WHERE b2.deployment_id = br.deployment_id AND b2.status = 'building'
          )
          AND NOT EXISTS (
            SELECT 1 FROM deployments d
            WHERE d.id = br.deployment_id AND d.build_status = 'building'
          )
        ORDER BY ${orgRunning} ASC, br.scheduled_at ASC
        FOR UPDATE OF br SKIP LOCKED
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      const id = rows[0].id;
      const now = new Date();
      const claimed = await tx.buildRun.update({
        where: { id },
        data: { status: 'building', workerId: this.workerId, startedAt: now, heartbeatAt: now }
      });
      await markDeploymentBuilding(tx, claimed.deploymentId);
      return claimed;
    }, this.txOpts);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
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
      const deployments = this.moduleRef.get(DeploymentsService, { strict: false });
      await this.withTimeout(
        deployments.runQueuedBuild(run),
        4 * 60_000,
        "Build didn't start within 4 minutes"
      );
    } catch (e) {
      const detail = (e as Error)?.message ?? 'Build failed to start';
      this.logger.error(`queued build ${run.id} threw: ${detail}`);
      const claimed = await this.prisma.buildRun
        .updateMany({
          where: { id: run.id, status: 'building' },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            detail,
            workerId: null
          }
        })
        .catch(() => ({ count: 0 }));
      if (claimed.count > 0) {
        await this.prisma.deployment
          .updateMany({
            where: { id: run.deploymentId, buildStatus: 'building' },
            data: { buildStatus: 'failed', buildError: detail, status: 'running' }
          })
          .catch(() => {});
        const fullRun = await this.prisma.buildRun
          .findUnique({
            where: { id: run.id },
            select: {
              deploymentId: true,
              checkRunId: true,
              githubInstallationId: true,
              repoFullName: true
            }
          })
          .catch(() => null);
        if (fullRun) {
          await this.closeGitHubArtifacts(fullRun, detail).catch((err) =>
            this.logger.warn(
              `failed to close github artifacts for run ${run.id}: ${err?.message ?? err}`
            )
          );
        }
      }
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
        repoFullName: true
      }
    });
    if (building.length === 0) return;
    const STUCK_MS = 45 * 60 * 1000;
    const now = Date.now();
    for (const run of building) {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: run.deploymentId },
        select: { buildStatus: true }
      });
      // A deployment that is gone takes its runs with it, whatever their age.
      if (!dep) {
        await this.prisma.buildRun.updateMany({
          where: { id: run.id, status: 'building' },
          data: { status: 'failed', finishedAt: new Date(), workerId: null }
        });
        continue;
      }
      // Conclude a run from its deployment's status only once the two are
      // describing the same build. Claim writes them together, but a run
      // claimed by an older build of this service, or mid-rollout by a pod
      // that still wrote them apart, has a deployment status left over from
      // the *previous* build, and reading it here would conclude live builds.
      const settled = canTrustDeploymentStatus({
        now,
        startedAt: run.startedAt?.getTime() ?? null
      });
      if (settled && (dep.buildStatus === 'succeeded' || dep.buildStatus === 'failed')) {
        // Copy the build log onto the run as `onBuildFinished` does. A run
        // concluded here is still a run someone will open in the build
        // history, and one concluded without its logs shows up empty.
        await this.prisma.$executeRaw`
          UPDATE "build_runs" br
          SET "status" = ${dep.buildStatus === 'succeeded' ? 'succeeded' : 'failed'},
              "finished_at" = (NOW() AT TIME ZONE 'UTC'),
              "worker_id" = NULL,
              "logs" = COALESCE(br."logs", d."build_logs"),
              "step_timestamps" = COALESCE(br."step_timestamps", d."build_step_timestamps")
          FROM "deployments" d
          WHERE d."id" = br."deployment_id"
            AND br."id" = ${run.id}::uuid
            AND br."status" = 'building'
        `;
        continue;
      }
      // A dead worker's run is NOT failed here: builds run as in-cluster
      // jobs and BuildRecovery (deployments.service) re-adopts them within
      // minutes, finishing the deploy and concluding the GitHub check from
      // the ids persisted on this run. Only the absolute runtime cap kills.
      const overRuntime = run.startedAt && now - run.startedAt.getTime() > STUCK_MS;
      if (!overRuntime) continue;
      const detail = 'Build exceeded the maximum runtime';
      const claimed = await this.prisma.$executeRaw`
        UPDATE "build_runs" br
        SET "status" = 'failed',
            "finished_at" = (NOW() AT TIME ZONE 'UTC'),
            "detail" = ${detail},
            "worker_id" = NULL,
            "logs" = d."build_logs"
        FROM "deployments" d
        WHERE d."id" = br."deployment_id"
          AND br."id" = ${run.id}::uuid
          AND br."status" = 'building'
      `;
      if (claimed === 0) continue;
      await this.prisma.deployment.updateMany({
        where: { id: run.deploymentId, buildStatus: 'building' },
        data: { buildStatus: 'failed', buildError: detail, status: 'running' }
      });
      await this.closeGitHubArtifacts(run, detail).catch((e) =>
        this.logger.warn(`failed to close github artifacts for run ${run.id}: ${e?.message ?? e}`)
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
    detail: string
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
            summary: detail
          }
        })
        .catch((e: any) => this.logger.warn(`check run close failed: ${e?.message ?? e}`));
    }
    const marker = await this.prisma.gitHubDeployment.findFirst({
      where: {
        deploymentId: run.deploymentId,
        status: { in: ['pending', 'in_progress'] }
      },
      orderBy: { createdAt: 'desc' }
    });
    if (marker) {
      await github
        .updateDeploymentStatusWithApp(
          run.githubInstallationId,
          marker.owner,
          marker.repo,
          Number(marker.githubDeploymentId),
          'error',
          { description: detail, logUrl: marker.logUrl ?? undefined }
        )
        .catch((e: any) => this.logger.warn(`deployment marker close failed: ${e?.message ?? e}`));
      await this.prisma.gitHubDeployment
        .update({ where: { id: marker.id }, data: { status: 'error' } })
        .catch(() => {});
    }
  }
}
