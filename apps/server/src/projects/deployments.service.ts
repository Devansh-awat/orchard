import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma, ServiceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService, CreateDeploymentOptions } from '../kubernetes/kubernetes.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { snapshotPublicPortState, publicPortKey } from '../kubernetes/port-utils';
import { UsersService } from '../users/users.service';
import { DockerService } from '../docker/docker.service';
import { GitHubService } from '../github/github.service';
import { QuotasService } from '../quotas/quotas.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectAccessService } from './project-access.service';
import { EnvironmentsService } from './environments.service';
import { BuildQueueService } from './build-queue.service';
import { resolveEnvVars, EnvVar } from '../env/env-resolver';
import { normalizeRootDirectory } from '../docker/build-config';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { NodesService } from '../nodes/nodes.service';
import { StorageService } from '../organizations/storage.service';
import { formatSlug, scrubIngress } from './projects.utils';
import { startBuildTrace } from '../analytics/datadog';
import { createHash, randomUUID } from 'crypto';

@Injectable()
export class DeploymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeploymentsService.name);

  private buildReconcileInterval: NodeJS.Timeout | null = null;

  private activeRecoveries = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly k8sNetwork: K8sNetworkService,
    private readonly usersService: UsersService,
    private readonly dockerService: DockerService,
    @Inject(forwardRef(() => GitHubService))
    private readonly githubService: GitHubService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotasService: QuotasService,
    private readonly tailscaleService: TailscaleService,
    private readonly membershipCache: MembershipCacheService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly access: ProjectAccessService,
    @Inject(forwardRef(() => NodesService))
    private readonly nodesService: NodesService,
    private readonly leaderElection: LeaderElectionService,
    private readonly notifications: NotificationsService,
    @Inject(forwardRef(() => EnvironmentsService))
    private readonly environments: EnvironmentsService,
    private readonly crypto: SecretCryptoService,
    @Inject(forwardRef(() => BuildQueueService))
    private readonly buildQueue: BuildQueueService,
    private readonly storage: StorageService,
  ) {}

  async runQueuedBuild(run: {
    id: string;
    deploymentId: string;
    triggerType: string;
    commitSha: string | null;
    commitMessage: string | null;
    commitAuthorName: string | null;
    commitAuthorUsername: string | null;
    triggeredById: string | null;
  }) {
    if (run.triggerType === 'manual') {
      await this.rebuildFromQueue(run.deploymentId, run.triggeredById, run.id);
    } else {
      await this.triggerAutoDeploy(
        run.deploymentId,
        run.commitSha ?? '',
        run.commitMessage ?? 'Queued deploy',
        run.commitAuthorName ?? undefined,
        run.commitAuthorUsername ?? undefined,
        run.id,
      );
    }
  }

  onModuleInit() {
    setTimeout(() => this.recoverStuckBuilds(), 5_000);
    this.buildReconcileInterval = setInterval(() => this.recoverStuckBuilds(), 15_000);
  }

  onModuleDestroy() {
    if (this.buildReconcileInterval) {
      clearInterval(this.buildReconcileInterval);
      this.buildReconcileInterval = null;
    }
  }

  private async recoverStuckBuilds() {
    if (!this.leaderElection.isLeader()) return;
    try {
      const stuckBuilds = await this.prisma.deployment.findMany({
        where: {
          buildStatus: 'building',
          updatedAt: { lt: new Date(Date.now() - 15_000) },
        },
        select: {
          id: true,
          name: true,
          namespace: true,
          image: true,
          replicas: true,
          buildStep: true,
          buildStepTimestamps: true,
          projectId: true,
        },
      });

      if (stuckBuilds.length === 0) return;
      this.logger.log(`[BuildRecovery] Found ${stuckBuilds.length} stuck build(s), attempting recovery`);

      for (const deployment of stuckBuilds) {
        try {
          await this.recoverStuckBuild(deployment);
        } catch (error) {
          this.logger.error(`[BuildRecovery] Failed to recover deployment ${deployment.id}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`[BuildRecovery] Recovery scan failed: ${error.message}`);
    }
  }

  private async recoverStuckBuild(deployment: {
    id: string; name: string; namespace: string; image: string | null;
    replicas: number; buildStep: string | null; buildStepTimestamps: any; projectId: string;
  }) {
    if (this.activeRecoveries.has(deployment.id)) return;

    const staleCutoff = new Date(Date.now() - 15_000);
    const claimed: number = await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "updated_at" = NOW()
      WHERE "id" = ${deployment.id}::uuid
        AND "build_status" = 'building'
        AND "updated_at" < ${staleCutoff}
    `;
    if (claimed === 0) return;

    this.activeRecoveries.add(deployment.id);

    try {
      await this.doRecoverStuckBuild(deployment);
    } catch (error) {
      this.logger.error(`[BuildRecovery] Unexpected error recovering ${deployment.id}: ${error.message}`);
      this.activeRecoveries.delete(deployment.id);
    }
  }

  private async doRecoverStuckBuild(deployment: {
    id: string; name: string; namespace: string; image: string | null;
    replicas: number; buildStep: string | null; buildStepTimestamps: any; projectId: string;
  }) {
    const metadata = (deployment.buildStepTimestamps as Record<string, any>) || {};

    const activeRun = await this.prisma.buildRun.findFirst({
      where: { deploymentId: deployment.id, status: 'building' },
      orderBy: { startedAt: 'desc' },
      select: { workerId: true, heartbeatAt: true },
    });
    if (
      activeRun?.workerId &&
      activeRun.heartbeatAt &&
      Date.now() - activeRun.heartbeatAt.getTime() < 30_000
    ) {
      const workerAlive = await this.isWorkerPodAlive(activeRun.workerId);
      if (workerAlive !== false) {
        this.activeRecoveries.delete(deployment.id);
        return;
      }
      this.logger.log(`[BuildRecovery] Worker pod for ${deployment.id} is gone; adopting immediately`);
    }

    this.logger.log(`[BuildRecovery] Recovering deployment ${deployment.id} (step: ${deployment.buildStep})`);

    if (deployment.buildStep === 'deploying' && deployment.image) {
      await this.finishRecoveredBuild(deployment, deployment.image);
      this.activeRecoveries.delete(deployment.id);
      return;
    }

    const jobs = await this.dockerService.findBuildJobsForDeployment(deployment.id);
    if (jobs === null) {
      this.logger.warn(`[BuildRecovery] Could not list build jobs for ${deployment.id}; retrying next scan`);
      this.activeRecoveries.delete(deployment.id);
      return;
    }
    const jobName = metadata.__jobName as string | undefined;
    let foundJob: { name: string; image: string | null; status: string } | null = null;

    if (jobName) {
      const fromLabel = jobs.find(j => j.name === jobName);
      if (fromLabel) {
        foundJob = fromLabel;
      } else {
        const status = await this.dockerService.getBuildJobStatus(jobName);
        if (status) {
          foundJob = { name: jobName, image: null, status: status.status };
        }
      }
    }

    if (!foundJob && jobs.length > 0) {
      foundJob = jobs[0];
    }

    const expectedImage = (metadata.__image as string | undefined) || null;

    if (!foundJob) {
      if (expectedImage) {
        const pushed = await this.dockerService.imageExistsInRegistry(expectedImage);
        if (pushed === true) {
          this.logger.log(`[BuildRecovery] Build job for ${deployment.id} is gone but ${expectedImage} exists in the registry; finishing deploy`);
          await this.finishRecoveredBuild(deployment, expectedImage);
          this.activeRecoveries.delete(deployment.id);
          return;
        }
        if (pushed === null) {
          this.logger.warn(`[BuildRecovery] Could not check registry for ${deployment.id}; retrying next scan`);
          this.activeRecoveries.delete(deployment.id);
          return;
        }
      }
      const requeued = await this.requeueOrphanedBuild(deployment.id);
      if (requeued) {
        this.logger.log(`[BuildRecovery] No build job or pushed image found for ${deployment.id}; requeued the build`);
      } else {
        await this.markBuildFailed(deployment.id, 'Build job not found after server restart');
      }
      this.activeRecoveries.delete(deployment.id);
      return;
    }

    if (foundJob.status === 'succeeded') {
      const image = foundJob.image || expectedImage;
      if (!image) {
        await this.markBuildFailed(deployment.id, 'Build succeeded but image path unknown');
      } else {
        await this.finishRecoveredBuild(deployment, image);
      }
      this.dockerService.deleteBuildJob(foundJob.name).catch(() => {});
      this.activeRecoveries.delete(deployment.id);
    } else if (foundJob.status === 'failed') {
      await this.markBuildFailed(deployment.id, 'Build job failed');
      this.dockerService.deleteBuildJob(foundJob.name).catch(() => {});
      this.activeRecoveries.delete(deployment.id);
    } else if (foundJob.status === 'running' || foundJob.status === 'pending') {
      await this.buildQueue.adoptRun(deployment.id);
      this.resumeBuildWatch(deployment, foundJob.name, foundJob.image || expectedImage);
    }
  }

  private async isWorkerPodAlive(workerId: string): Promise<boolean | null> {
    if (!process.env.KUBERNETES_SERVICE_HOST) return null;
    const podName = workerId.replace(/-\d+$/, '');
    if (!podName || podName === workerId) return null;
    const namespace =
      process.env.ORCHARD_SERVER_NAMESPACE || process.env.POD_NAMESPACE || 'orchard';
    try {
      await this.k8sWorkload.getPod(podName, namespace);
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      return null;
    }
  }

  private async finishRecoveredBuild(
    deployment: { id: string; name: string; namespace: string },
    image: string,
  ) {
    try {
      const k8sExists = await this.k8sWorkload.getKubernetesDeployment(deployment.name, deployment.namespace)
        .then(d => d !== null).catch(() => false);
      if (k8sExists) {
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: { image, buildStep: 'deploying' },
        });
        await this.k8sWorkload.updateDeploymentImage(deployment.name, deployment.namespace, image);
        await this.recordRecoveredImageHistory(deployment.id, image).catch((error) => {
          this.logger.warn(`[BuildRecovery] Failed to record image history for ${deployment.id}: ${error.message}`);
        });
        await this.markBuildSucceeded(deployment.id, 'Build recovered after server restart.');
        this.logger.log(`[BuildRecovery] Completed succeeded build for ${deployment.id}`);
      } else {
        await this.markBuildFailed(deployment.id, 'Build succeeded but k8s deployment not found. Please redeploy.');
      }
    } catch (error) {
      await this.markBuildFailed(deployment.id, `Recovery failed: ${error.message}`);
    }
  }

  private async recordRecoveredImageHistory(deploymentId: string, image: string) {
    const run = await this.prisma.buildRun.findFirst({
      where: { deploymentId, status: 'building' },
      orderBy: { startedAt: 'desc' },
      select: {
        commitSha: true,
        commitMessage: true,
        commitAuthorName: true,
        commitAuthorUsername: true,
        branch: true,
        triggerType: true,
        triggeredById: true,
        startedAt: true,
      },
    });
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { buildLogs: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.imageHistory.findFirst({
        where: { deploymentId, image },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        await tx.imageHistory.updateMany({
          where: { deploymentId, isActive: true, id: { not: existing.id } },
          data: { isActive: false },
        });
        await tx.imageHistory.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            buildLogs: existing.buildLogs ?? dep?.buildLogs ?? null,
            buildCompletedAt: existing.buildCompletedAt ?? new Date(),
          },
        });
        return;
      }
      await tx.imageHistory.updateMany({
        where: { deploymentId, isActive: true },
        data: { isActive: false },
      });
      await tx.imageHistory.create({
        data: {
          deploymentId,
          image,
          tag: image.split(':').pop() || 'latest',
          commitSha: run?.commitSha ?? null,
          commitMessage: run?.commitMessage ?? null,
          commitAuthorName: run?.commitAuthorName ?? null,
          commitAuthorUsername: run?.commitAuthorUsername ?? null,
          branch: run?.branch ?? null,
          buildLogs: dep?.buildLogs ?? null,
          buildStartedAt: run?.startedAt ?? null,
          buildCompletedAt: new Date(),
          triggerType: run?.triggerType ?? null,
          triggeredById: run?.triggeredById ?? null,
          isActive: true,
        },
      });
    });
  }

  private resumeBuildWatch(
    deployment: { id: string; name: string; namespace: string; image: string | null; replicas: number },
    jobName: string,
    expectedImage: string | null,
  ) {
    this.logger.log(`[BuildRecovery] Resuming watch for ${deployment.id} (job: ${jobName})`);
    (async () => {
      try {
        const status = await this.dockerService.waitForBuildJob(jobName, deployment.id);
        if (!status || status.status !== 'succeeded') {
          await this.markBuildFailed(deployment.id, status?.logs || 'Build failed');
          return;
        }
        let resolvedImage = expectedImage;
        if (!resolvedImage) {
          const jobs = await this.dockerService.findBuildJobsForDeployment(deployment.id);
          resolvedImage = jobs?.find(j => j.name === jobName)?.image || null;
        }
        if (!resolvedImage) {
          await this.markBuildFailed(deployment.id, 'Build succeeded but image path unknown');
          return;
        }

        await this.finishRecoveredBuild(deployment, resolvedImage);
      } catch (error) {
        await this.markBuildFailed(deployment.id, `Build failed after resume: ${error.message}`).catch(() => {});
        this.logger.error(`[BuildRecovery] Resumed build failed for ${deployment.id}: ${error.message}`);
      } finally {
        this.dockerService.deleteBuildJob(jobName).catch(() => {});
        this.activeRecoveries.delete(deployment.id);
      }
    })();
  }

  // Recovery finalizer companion: conclude the GitHub check run and
  // deployment marker that the dead process left open. The ids live on the
  // BuildRun row (persisted at check creation) precisely so a different
  // process can close them.
  private async closeGitHubCheckForDeployment(deploymentId: string, ok: boolean, detail: string) {
    try {
      const run = await this.prisma.buildRun.findFirst({
        where: { deploymentId, checkRunId: { not: null } },
        orderBy: { scheduledAt: 'desc' },
        select: { checkRunId: true, githubInstallationId: true, repoFullName: true },
      });
      if (!run?.checkRunId || !run.githubInstallationId || !run.repoFullName) return;
      const [owner, repo] = run.repoFullName.split('/');
      if (!owner || !repo) return;
      const logUrl = await this.getDeploymentProgressUrl(deploymentId);
      await this.githubService.updateCheckRun(
        run.githubInstallationId, owner, repo, Number(run.checkRunId),
        {
          status: 'completed',
          conclusion: ok ? 'success' : 'failure',
          output: {
            title: ok ? 'Deployment Successful' : 'Deployment Failed',
            summary: detail,
            text: logUrl ? `[View the full build log in Orchard](${logUrl})` : undefined,
          },
        },
      );
      const marker = await this.prisma.gitHubDeployment.findFirst({
        where: { deploymentId, status: { in: ['pending', 'in_progress'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (marker) {
        await this.githubService.updateDeploymentStatusWithApp(
          run.githubInstallationId, marker.owner, marker.repo,
          Number(marker.githubDeploymentId), ok ? 'success' : 'failure',
          { description: detail.substring(0, 130), logUrl: logUrl ?? undefined },
        );
        await this.prisma.gitHubDeployment.update({
          where: { id: marker.id },
          data: { status: ok ? 'success' : 'failure' },
        }).catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(`[BuildRecovery] Failed to close GitHub check for ${deploymentId}: ${e?.message || e}`);
    }
  }

  private static readonly REQUEUE_DETAIL = 'Requeued after server restart';

  private async requeueOrphanedBuild(deploymentId: string): Promise<boolean> {
    const run = await this.prisma.buildRun.findFirst({
      where: { deploymentId, status: 'building' },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return false;
    if (run.detail === DeploymentsService.REQUEUE_DETAIL) return false;
    if (run.triggerType !== 'auto' && run.triggerType !== 'manual') return false;

    await this.prisma.buildRun.update({
      where: { id: run.id },
      data: {
        status: 'scheduled',
        detail: DeploymentsService.REQUEUE_DETAIL,
        workerId: null,
        startedAt: null,
        heartbeatAt: null,
        checkRunId: null,
        githubInstallationId: null,
        repoFullName: null,
      },
    });
    await this.prisma.deployment.updateMany({
      where: { id: deploymentId, buildStatus: 'building' },
      data: { buildStatus: 'pending' },
    });
    await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "build_logs" = COALESCE("build_logs", '') || ${`\n[INFO] Server restarted before the build job was created; the build was requeued automatically.\n`}
      WHERE "id" = ${deploymentId}::uuid
    `.catch(() => {});
    this.buildQueue.kick();
    return true;
  }

  private async markBuildFailed(deploymentId: string, reason: string) {
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { buildStatus: 'failed', buildStep: 'failed', buildError: reason },
    });
    await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "build_logs" = COALESCE("build_logs", '') || ${`\n[ERROR] ${reason}\n`}
      WHERE "id" = ${deploymentId}::uuid
    `.catch(() => {});
    this.buildQueue.onBuildFinished(deploymentId).catch(() => {});
    void this.closeGitHubCheckForDeployment(deploymentId, false, reason);
  }

  private async markBuildSucceeded(deploymentId: string, logMessage: string) {
    const data = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { buildStepTimestamps: true },
    });
    const timestamps = (data?.buildStepTimestamps as Record<string, any> | null) || {};
    timestamps['complete'] = Date.now();
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'running',
        buildStatus: 'succeeded',
        buildStep: 'complete',
        buildStepTimestamps: timestamps,
      },
    });
    await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "build_logs" = COALESCE("build_logs", '') || ${`\n${logMessage}\n`}
      WHERE "id" = ${deploymentId}::uuid
    `.catch(() => {});
    this.buildQueue.onBuildFinished(deploymentId).catch(() => {});
    void this.closeGitHubCheckForDeployment(deploymentId, true, logMessage);
  }

  async listDeploymentsSummary(userId: string, orgId?: string) {
    const projectFilter = await this.access.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return [];

    const deployments = await this.prisma.deployment.findMany({
      where: { project: projectFilter },
      select: {
        id: true,
        name: true,
        displayName: true,
        namespace: true,
        status: true,
        buildStatus: true,
        image: true,
        githubRepo: true,
        githubBranch: true,
        updatedAt: true,
        replicas: true,
        ingresses: {
          select: {
            id: true,
            host: true,
          },
        },
        services: {
          select: {
            ingresses: {
              select: {
                id: true,
                host: true,
              },
            },
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // Reconcile DB status with live pod state so the home page doesn't show
    // "running" while every pod is still Scheduled / not Ready. Previously this
    // fired 2 K8s API calls per deployment (readNamespacedDeployment +
    // listNamespacedPod via getDeploymentPods → 2*N round-trips). Now we list
    // pods ONCE per namespace and bucket by the app.kubernetes.io/name label,
    // collapsing it to M (unique namespaces) calls.
    const uniqueNamespaces = Array.from(
      new Set(deployments.map((d) => d.namespace).filter((n): n is string => !!n)),
    );
    const namespacePodMaps = new Map<
      string,
      Map<string, { pods: { status: string; restartCount: number }[]; warnings: { message: string }[] }>
    >();
    await Promise.all(
      uniqueNamespaces.map(async (ns) => {
        const m = await this.k8sWorkload.listPodStatusesByDeploymentInNamespace(ns);
        namespacePodMaps.set(ns, m);
      }),
    );

    const computedStatuses = await Promise.all(
      deployments.map((d) => {
        const bucket = d.namespace
          ? namespacePodMaps.get(d.namespace)?.get(d.name) ?? { pods: [], warnings: [] }
          : { pods: [], warnings: [] };
        return this.computeDeploymentStatus(d, bucket);
      }),
    );

    // Merge direct ingresses and service-linked ingresses, deduplicating by id
    return deployments.map(({ services, ingresses, namespace: _namespace, ...rest }, i) => {
      const serviceIngresses = services.flatMap((s) => s.ingresses);
      const allIngresses = [...ingresses, ...serviceIngresses];
      const seen = new Set<string>();
      const uniqueIngresses = allIngresses.filter((ing) => {
        if (seen.has(ing.id)) return false;
        seen.add(ing.id);
        return true;
      });
      return { ...rest, status: computedStatuses[i], ingresses: uniqueIngresses };
    });
  }

  async listRecentBuilds(
    userId: string,
    orgId?: string,
    opts: { scope?: 'mine' | 'all'; activeLimit?: number; recentLimit?: number } = {},
  ) {
    const { scope = 'all', activeLimit = 5, recentLimit = 5 } = opts;
    let projectFilter = await this.access.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return { active: [], recent: [] };

    if (scope === 'mine') {
      const memberUserId = (await this.access.resolveMemberUserId(userId)) ?? userId;
      const mineCount = await this.prisma.project.count({
        where: {
          ...(orgId ? { organizationId: orgId } : {}),
          members: { some: { userId: memberUserId } },
        },
      });
      if (mineCount > 0) {
        projectFilter = { AND: [projectFilter, { members: { some: { userId: memberUserId } } }] };
      }
    }

    // Currently building deployments
    const activeBuilds = await this.prisma.deployment.findMany({
      where: {
        project: projectFilter,
        buildStatus: { in: ['building', 'pending'] },
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        image: true,
        status: true,
        buildStatus: true,
        buildStep: true,
        updatedAt: true,
        githubRepo: true,
        githubBranch: true,
        ingresses: { select: { host: true }, take: 1 },
        project: { select: { name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: activeLimit,
    });

    // Recent completed builds from image history
    const recentBuilds = await this.prisma.imageHistory.findMany({
      where: { deployment: { project: projectFilter } },
      select: {
        id: true,
        commitSha: true,
        branch: true,
        triggerType: true,
        isActive: true,
        createdAt: true,
        deployment: {
          select: {
            id: true,
            name: true,
            displayName: true,
            image: true,
            buildStatus: true,
            ingresses: { select: { host: true }, take: 1 },
            project: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: recentLimit,
    });

    return { active: activeBuilds, recent: recentBuilds };
  }

  async getProjectDeployments(projectId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const access = await this.authz.requireProjectView(projectId, user.id);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const deployments = await this.prisma.deployment.findMany({
      where: { projectId },
      include: {
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        pods: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    const deploymentsWithComputedStatus = await Promise.all(
      deployments.map(async (deployment) => {
        let pods: any = deployment.pods;
        let warnings: any[] = [];

        if (deployment.name && deployment.namespace) {
          try {
            const livePods = await this.k8sWorkload.getDeploymentPods(
              deployment.name,
              deployment.namespace
            );
            pods = this.formatLivePods(livePods?.pods);
            warnings = livePods?.warnings || [];
          } catch (error) {
            console.error(
              `[ProjectsService] Failed to fetch live pods for deployment ${deployment.id}:`,
              error instanceof Error ? error.message : error
            );
          }
        }

        // Hand the already-fetched pods to computeDeploymentStatus so it doesn't
        // re-issue the same readNamespacedDeployment + listNamespacedPod calls
        // we just made above — that doubled the K8s round-trips per deployment.
        const computedStatus = await this.computeDeploymentStatus(deployment, {
          pods,
          warnings,
        });

        const merged = {
          ...deployment,
          ingresses: deployment.ingresses.map((ing) => scrubIngress(ing)),
          pods,
          status: computedStatus,
          warnings,
        };
        return access.canEdit ? merged : this.scrubDeploymentForViewer(merged as any);
      })
    );

    return deploymentsWithComputedStatus;
  }

  async getDeployment(deploymentId: string, canEdit = true, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        environment: {
          select: { id: true, name: true, slug: true, isDefault: true },
        },
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        volumes: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        imageHistory: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            image: true,
            tag: true,
            commitSha: true,
            commitMessage: true,
            commitAuthorName: true,
            commitAuthorUsername: true,
            branch: true,
            buildStartedAt: true,
            buildCompletedAt: true,
            isActive: true,
            createdAt: true,
            triggerType: true,
            triggeredBy: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(deployment.projectId, userId);
    }

    let pods: any = [];
    let availableReplicas = 0;
    let warnings: any[] = [];
    let totalCpuUsage: number | null = null;
    let totalMemoryUsage: number | null = null;

    if (deployment.name && deployment.namespace) {
      try {
        const livePods = await this.k8sWorkload.getDeploymentPods(
          deployment.name,
          deployment.namespace
        );
        pods = this.formatLivePods(livePods?.pods);
        warnings = livePods?.warnings || [];
        totalCpuUsage = livePods?.totalCpuUsage ?? null;
        totalMemoryUsage = livePods?.totalMemoryUsage ?? null;

        try {
          const k8sDeployment = await this.k8sWorkload.getKubernetesDeployment(
            deployment.name,
            deployment.namespace
          );
          availableReplicas = k8sDeployment?.status?.availableReplicas ?? 0;
        } catch (k8sError) {
          console.error(
            `[ProjectsService] Failed to fetch deployment status for ${deploymentId}:`,
            k8sError instanceof Error ? k8sError.message : k8sError
          );
          availableReplicas = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'ready').length ?? 0;
        }
      } catch (error) {
        console.error(
          `[ProjectsService] Failed to fetch live pods for deployment ${deploymentId}:`,
          error instanceof Error ? error.message : error
        );
        availableReplicas = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'running').length ?? 0;
      }
    } else {
      availableReplicas = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'running').length ?? 0;
    }

    const deploymentWithInternalUrls = this.addInternalUrlsToDeployment(deployment);

    // Discover project-level ingresses that route to this deployment's services,
    // and enrich every ingress with K8s routes — all in a single parallel pass.
    // Each unique ingress name is read from K8s exactly once.
    if (deployment.namespace) {
      const namespace = deployment.namespace;
      const directIngresses: any[] = deploymentWithInternalUrls.ingresses ?? [];
      const existingIds = new Set(directIngresses.map((i: any) => i.id));

      const projectIngresses = deployment.projectId
        ? await this.prisma.ingress.findMany({
            where: { projectId: deployment.projectId, id: { notIn: Array.from(existingIds) } },
            include: { service: true },
          })
        : [];

      const candidateIngresses = [...directIngresses, ...projectIngresses];
      const k8sByName = new Map<string, any>();
      await Promise.all(
        candidateIngresses.map(async (ing: any) => {
          if (k8sByName.has(ing.name)) return;
          try {
            const k8sIngress = await this.k8sNetwork.readIngress(namespace, ing.name);
            k8sByName.set(ing.name, k8sIngress);
          } catch {
            k8sByName.set(ing.name, null);
          }
        }),
      );

      const serviceNames = new Set((deployment.services ?? []).map((s: any) => s.name));
      const enrich = (ing: any) => {
        const k8sIngress = k8sByName.get(ing.name);
        const rules = k8sIngress?.spec?.rules ?? [];
        const k8sPaths = rules.length > 0 && rules[0].http?.paths ? rules[0].http.paths : [];
        const routes = k8sPaths.length
          ? k8sPaths.map((p: any) => ({
              path: p.path || '/',
              serviceName: p.backend?.service?.name || '',
              servicePort: p.backend?.service?.port?.number || 0,
            }))
          : [
              {
                path: ing.path,
                serviceName: ing.service?.name || '',
                servicePort: ing.service?.port || 0,
              },
            ];
        return { ingress: scrubIngress({ ...ing, routes }), k8sPaths };
      };

      const directEnriched = directIngresses.map((ing) => enrich(ing).ingress);
      const projectExtras = projectIngresses
        .map((pi: any) => {
          const { ingress, k8sPaths } = enrich(pi);
          const hasRouteForDeployment = k8sPaths.some((p: any) =>
            serviceNames.has(p.backend?.service?.name || ''),
          );
          return hasRouteForDeployment ? ingress : null;
        })
        .filter((i): i is any => !!i);

      deploymentWithInternalUrls.ingresses = [...directEnriched, ...projectExtras];
    }

    const computedStatus = await this.computeDeploymentStatus(deployment);

    const result: any = {
      ...deploymentWithInternalUrls,
      pods,
      availableReplicas,
      warnings,
      totalCpuUsage,
      totalMemoryUsage,
      status: computedStatus,
      buildStatus: deployment.buildStatus,
    };
    return canEdit ? result : this.scrubDeploymentForViewer(result);
  }

  async getDeploymentPods(deploymentId: string, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(deployment.projectId, userId);
    }

    if (deployment.name && deployment.namespace) {
      try {
        const livePods = await this.k8sWorkload.getDeploymentPods(
          deployment.name,
          deployment.namespace
        );
        return this.formatLivePods(livePods?.pods);
      } catch (error) {
        console.error(
          `[ProjectsService] Failed to fetch live pods for deployment ${deploymentId}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    const storedPods = await this.prisma.pod.findMany({
      where: { deploymentId },
    });

    return storedPods.map((pod) => ({
      id: pod.id,
      name: pod.name,
      status: pod.status,
      ip: pod.podIp,
      podIp: pod.podIp,
      nodeName: pod.nodeName,
      restartCount: pod.restartCount,
      startTime: pod.createdAt,
      createdAt: pod.createdAt,
      containers: [],
    }));
  }

  async getDeploymentPodsLive(deploymentId: string, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (userId) {
      await this.authz.requireProjectView(deployment.projectId, userId);
    }

    let pods: any[] = [];
    let warnings: any[] = [];
    let availableReplicas = 0;
    let totalCpuUsage: number | null = null;
    let totalMemoryUsage: number | null = null;

    if (deployment.name && deployment.namespace) {
      try {
        const livePods = await this.k8sWorkload.getDeploymentPods(
          deployment.name,
          deployment.namespace
        );
        pods = this.formatLivePods(livePods?.pods);
        warnings = livePods?.warnings || [];
        totalCpuUsage = livePods?.totalCpuUsage ?? null;
        totalMemoryUsage = livePods?.totalMemoryUsage ?? null;

        try {
          const k8sDeployment = await this.k8sWorkload.getKubernetesDeployment(
            deployment.name,
            deployment.namespace
          );
          availableReplicas = k8sDeployment?.status?.availableReplicas ?? 0;
        } catch {
          availableReplicas =
            pods?.filter((pod: any) => pod.status?.toLowerCase() === 'ready').length ?? 0;
        }
      } catch (error) {
        console.error(
          `[ProjectsService] Failed to fetch live pods for deployment ${deploymentId}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    return { pods, warnings, availableReplicas, totalCpuUsage, totalMemoryUsage };
  }

  async cancelDeploymentBuild(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'cancel deployments');

    if (deployment.buildStatus !== 'building') {
      throw new BadRequestException('Deployment is not in a buildable state');
    }

    try {
      console.log(`[Projects] Cancelling build jobs for deployment ${deploymentId}`);
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
      console.log(`[Projects] Successfully cancelled build jobs for deployment ${deploymentId}`);
    } catch (error) {
      console.error(`[Projects] Error cancelling build jobs for deployment ${deploymentId}:`, error);
    }

    const currentLogs = deployment.buildLogs || '';
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'failed',
        buildStep: null,
        buildError: 'Build cancelled by user',
        buildLogs: `${currentLogs  }[${Date.now()}] [INFO] Build cancelled by user\n`,
      },
    });

    void this.audit.log({
      action: 'deployment.build_cancelled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
    });

    return {
      success: true,
      deploymentId,
      message: 'Build cancelled successfully',
    };
  }

  async deleteDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    options?: { fromComposeStack?: boolean }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (deployment.composeStackId && !options?.fromComposeStack) {
      throw new BadRequestException(
        'This deployment is managed by a Compose file. Delete it via its parent compose stack.',
      );
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'delete deployments');

    // Fetch all related resources before deleting
    const [ingresses, services, volumes, imageHistoryEntries] = await Promise.all([
      this.prisma.ingress.findMany({ where: { deploymentId } }),
      this.prisma.service.findMany({ where: { deploymentId } }),
      this.prisma.deploymentVolume.findMany({ where: { deploymentId } }),
      this.prisma.imageHistory.findMany({ where: { deploymentId }, select: { image: true } }),
    ]);

    // Delete all ingresses from Kubernetes
    for (const ingress of ingresses) {
      try {
        await this.k8sNetwork.deleteIngress(ingress.namespace, ingress.name);
      } catch (error) {
        console.error(`Failed to delete ingress ${ingress.name} from Kubernetes:`, error);
      }
    }

    // Delete all services from Kubernetes
    for (const service of services) {
      try {
        await this.k8sNetwork.deleteService(deployment.namespace, service.name);
      } catch (error) {
        console.error(`Failed to delete service ${service.name} from Kubernetes:`, error);
      }
    }

    // Delete all PVCs from Kubernetes
    for (const volume of volumes) {
      if (volume.type === 'pvc' && volume.pvcName) {
        try {
          await this.kubernetesService.deletePVC(deployment.namespace, volume.pvcName);
        } catch (error) {
          console.error(`Failed to delete PVC ${volume.pvcName} from Kubernetes:`, error);
        }
      }
    }

    try {
      await this.k8sNetwork.unexposeAllDeploymentPortsPublic(deployment.namespace, deployment.name);
    } catch (error) {
      console.error(`Failed to unexpose public ports for ${deployment.name}:`, error);
    }
    try {
      await this.k8sNetwork.deletePublicDeploymentNetworkPolicy(deployment.namespace, deployment.name);
    } catch (error) {
      console.error(`Failed to delete public NetworkPolicy for ${deployment.name}:`, error);
    }

    // Clean up Tailscale sidecar if exposed
    try {
      await this.tailscaleService.cleanupDeployment(deployment);
    } catch (error) {
      console.error(`[Projects] Failed to clean up Tailscale for deployment ${deployment.name}:`, error);
    }

    // Delete the K8s deployment itself
    await this.k8sWorkload.deleteDeployment(deployment.name, deployment.namespace);

    if (deployment.buildContextKey) {
      this.storage.deleteBuildContext(deployment.buildContextKey).catch(() => {});
    }

    // Delete the DB record (cascades to pods, services, envVars, ingresses, volumes, imageHistory).
    // ingresses only started cascading in 20260808060000; before that the FK was
    // SET NULL and every delete left a protected orphan row behind.
    await this.prisma.deployment.delete({
      where: { id: deploymentId },
    });

    // Delete all associated repositories from Harbor in the background
    if (imageHistoryEntries.length > 0) {
      const imageRefs = imageHistoryEntries.map((entry) => entry.image);
      this.dockerService.deleteRepositoriesFromRegistry(imageRefs).catch((err) => {
        console.error(`[Projects] Failed to delete repositories from registry for deployment ${deploymentId}:`, err);
      });
    }

    void this.audit.log({
      action: 'deployment.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
    });

    return {
      success: true,
      deploymentId,
      projectId: deployment.projectId,
    };
  }

  async scaleDeployment(
    deploymentId: string,
    replicas: number,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    this.assertNotComposeManaged(deployment, 'Scale');

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'scale deployments');

    // Enforce resource quotas when scaling up — N replicas of this deployment
    // each consume the same per-pod CPU/memory, so a scale to R+Δ adds Δ pods'
    // worth of usage to the org cap and the project owner's member allowance.
    // Scaling down or staying flat is always permitted.
    const currentReplicas = deployment.replicas || 0;
    const delta = replicas - currentReplicas;
    if (delta > 0) {
      const perPod = await this.quotasService.resolvePodResources(deployment.projectId, {
        cpuRequestMilli: deployment.cpuRequestMilli ?? null,
        memoryRequestBytes:
          deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null,
      }, deployment.image);
      const requested = {
        cpuMilli: perPod.cpuMilli * delta,
        memoryBytes: perPod.memoryBytes * delta,
      };
      await this.quotasService.enforceOrgCapForNewPod(
        deployment.project.organizationId,
        requested,
      );
      await this.quotasService.enforceMemberAllowanceForNewPod(
        deployment.project.organizationId,
        deployment.project.ownerId,
        requested,
      );
    }

    // Only push to K8s if the deployment exists in the cluster.
    const k8sExistsScale = await this.k8sWorkload.getKubernetesDeployment(
      deployment.name, deployment.namespace,
    ).then((d) => d !== null).catch(() => false);

    if (k8sExistsScale) {
      await this.k8sWorkload.scaleDeployment(
        deployment.name,
        deployment.namespace,
        replicas
      );
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { replicas },
    });

    void this.audit.log({
      action: 'deployment.scaled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { replicas: [deployment.replicas, replicas] },
    });

    return {
      success: true,
      deploymentId,
      projectId: deployment.projectId,
      replicas,
    };
  }

  async restartDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'restart deployments');

    const desiredReplicas = deployment.replicas || 1;
    const k8sDeploy = await this.k8sWorkload.getKubernetesDeployment(deployment.name, deployment.namespace);
    if (k8sDeploy && k8sDeploy.status.replicas !== desiredReplicas) {
      await this.k8sWorkload.patchDeploymentReplicas(deployment.name, deployment.namespace, desiredReplicas);
    }

    const result = await this.k8sWorkload.restartDeployment(deployment.name, deployment.namespace);

    void this.audit.log({
      action: 'deployment.restarted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
    });

    return result;
  }

  async updateDeploymentEnvVars(
    deploymentId: string,
    env: { key: string; value: string; secret?: boolean }[],
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    const envEntries = Array.isArray(env)
      ? env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
            secret: Boolean(entry.secret),
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    // Env keys get interpolated into Dockerfile ARG/ENV directives and shell
    // commands in the builder; a key with a newline or shell metachar would
    // inject arbitrary instructions. Reject anything that isn't a POSIX-style
    // identifier before it reaches the build pipeline.
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const entry of envEntries) {
      if (!ENV_KEY_RE.test(entry.key)) {
        throw new BadRequestException(`Invalid environment variable key: ${entry.key}`);
      }
    }

    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }

    const envList = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret,
    }));

    // Only push to K8s if the deployment actually exists in the cluster.
    // If the build hasn't succeeded yet, just persist to DB — the env vars
    // will be applied when the build completes and creates the K8s deployment.
    const k8sExists = await this.k8sWorkload.getKubernetesDeployment(
      deployment.name, deployment.namespace,
    ).then((d) => d !== null).catch(() => false);

    if (k8sExists) {
      // Resolve ${{shared.KEY}} against the environment's shared vars, then
      // push the resolved values (secrets routed to a k8s Secret) to the pod.
      const sharedVars = await this.loadSharedVarsForDeployment(deployment.id, deployment.environmentId);
      const { resolved } = resolveEnvVars(envList, sharedVars);
      await this.k8sWorkload.updateDeploymentEnv({
        namespace: deployment.namespace,
        deploymentName: deployment.name,
        env: resolved,
      });
    }

    const previousEnvVars = await this.prisma.deploymentEnvVar.findMany({
      where: { deploymentId: deployment.id },
      select: { key: true, value: true },
    });
    const prevMap = new Map(previousEnvVars.map((e) => [e.key, e.value]));
    const newMap = new Map(envList.map((e) => [e.key, e.value]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [k, v] of newMap) {
      if (!prevMap.has(k)) added.push(k);
      else if (prevMap.get(k) !== v) changed.push(k);
    }
    for (const k of prevMap.keys()) if (!newMap.has(k)) removed.push(k);

    const updatedDeployment = await this.prisma.$transaction(async (tx) => {
      await tx.deploymentEnvVar.deleteMany({
        where: {
          deploymentId: deployment.id,
        },
      });

      if (envList.length > 0) {
        await tx.deploymentEnvVar.createMany({
          data: envList.map((entry) => ({
            deploymentId: deployment.id,
            key: entry.key,
            value: entry.value,
            secret: entry.secret,
          })),
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          project: {
            include: {
              organization: true,
            },
          },
          pods: true,
          services: {
            include: {
              ports: true,
            },
          },
          envVars: true,
          ingresses: {
            include: {
              service: true,
            },
          },
        },
      });
    });

    if (added.length || removed.length || changed.length) {
      void this.audit.log({
        action: 'deployment.env.updated',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        targetType: 'deployment',
        targetId: deployment.id,
        targetLabel: deployment.name,
        // Keys only — never values.
        metadata: { added: added.join(',') || null, removed: removed.join(',') || null, changed: changed.join(',') || null },
      });
    }

    return this.addInternalUrlsToDeployment(updatedDeployment);
  }

  /**
   * Update a deployment's build settings.
   *
   * Every field is optional and only applied when present, so a caller can
   * change one setting without restating the rest. The zero-config commands
   * additionally accept an explicit null, which clears the override and hands
   * the decision back to Railpack's own detection — that is a different
   * intent from "leave unchanged", hence the `in body` checks.
   */
  async updateDeploymentBuildConfig(
    deploymentId: string,
    body: {
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      persistentBuildCache?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    const { buildWithDepot, persistentBuildCache, buildFromRoot } = body;

    const changesSuperAdminFlags =
      (buildWithDepot !== undefined && buildWithDepot !== (deployment.buildWithDepot ?? false)) ||
      (persistentBuildCache !== undefined && persistentBuildCache !== (deployment.persistentBuildCache ?? false));
    if (changesSuperAdminFlags && !(await this.authz.isSuperAdmin(user.id))) {
      throw new ForbiddenException('Super builds and persistent build cache are superadmin-only settings');
    }

    // Super builds cannot execute a Railpack plan, so refuse the combination
    // here rather than letting the next build fail inside the builder.
    const nextBuildType = body.buildType ?? deployment.buildType;
    const nextDepot = buildWithDepot ?? deployment.buildWithDepot ?? false;
    if (nextBuildType === 'railpack' && nextDepot) {
      throw new BadRequestException(
        'Super builds do not support automatic (Railpack) builds. Turn off super builds, or use a Dockerfile build.',
      );
    }

    const rootDirectory = 'rootDirectory' in body
      ? normalizeRootDirectory(body.rootDirectory)
      : undefined;
    if ('rootDirectory' in body && body.rootDirectory && rootDirectory === null && body.rootDirectory.trim() !== '') {
      throw new BadRequestException(
        'Root directory must be a path inside the repository, without ".." segments.',
      );
    }

    /** Trim, and treat an emptied input as clearing the override. */
    const override = (key: keyof typeof body) =>
      (key in body ? { [key]: (body[key] as string | null)?.trim() || null } : {});

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        ...(buildFromRoot !== undefined && { buildFromRoot }),
        ...(buildWithDepot !== undefined && { buildWithDepot }),
        ...(persistentBuildCache !== undefined && { persistentBuildCache }),
        ...(body.buildType !== undefined && { buildType: body.buildType }),
        ...(rootDirectory !== undefined && { rootDirectory }),
        ...override('framework'),
        ...override('installCommand'),
        ...override('buildCommand'),
        ...override('startCommand'),
        ...override('outputDirectory'),
      },
    });

    const changed = (key: string, before: unknown, after: unknown) =>
      (after !== undefined && after !== before ? { [key]: [before, after] } : {});

    void this.audit.log({
      action: 'deployment.build_options.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        ...changed('buildFromRoot', deployment.buildFromRoot, buildFromRoot),
        ...changed('buildWithDepot', deployment.buildWithDepot, buildWithDepot),
        ...changed('persistentBuildCache', deployment.persistentBuildCache, persistentBuildCache),
        ...changed('buildType', deployment.buildType, body.buildType),
        ...changed('rootDirectory', deployment.rootDirectory, rootDirectory),
        ...changed('installCommand', deployment.installCommand, body.installCommand),
        ...changed('buildCommand', deployment.buildCommand, body.buildCommand),
        ...changed('startCommand', deployment.startCommand, body.startCommand),
        ...changed('outputDirectory', deployment.outputDirectory, body.outputDirectory),
      },
    });

    return this.getDeployment(deploymentId);
  }

  async renameDeployment(
    deploymentId: string,
    name: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'rename deployments');

    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    // The internal name is frozen (it is baked into the k8s object names),
    // so a rename only touches displayName. Renaming back to the internal
    // name clears the override.
    const nextDisplayName = trimmed === deployment.name ? null : trimmed;

    if (nextDisplayName) {
      const conflict = await this.prisma.deployment.findFirst({
        where: {
          environmentId: deployment.environmentId,
          id: { not: deploymentId },
          OR: [{ name: nextDisplayName }, { displayName: nextDisplayName }],
        },
        select: { id: true },
      });
      if (conflict) {
        throw new BadRequestException('A deployment with this name already exists in this environment');
      }
    }

    const previousEffective = deployment.displayName ?? deployment.name;
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { displayName: nextDisplayName },
    });

    void this.audit.log({
      action: 'deployment.renamed',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: trimmed,
      metadata: { displayName: [previousEffective, trimmed] },
    });

    return this.getDeployment(deploymentId);
  }

  async updateDeploymentGitHubRepo(
    deploymentId: string,
    data: {
      repoUrl: string;
      branch: string;
      dockerfilePath?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo) {
      throw new BadRequestException('This deployment was not created from GitHub');
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    let repoUrl = String(data.repoUrl || '').trim();
    if (repoUrl && !repoUrl.startsWith('http')) {
      repoUrl = `https://github.com/${repoUrl}`;
    }
    repoUrl = repoUrl.replace(/\.git$/, '');
    const branch = String(data.branch || '').trim();
    const dockerfilePath = String(data.dockerfilePath ?? deployment.dockerfilePath ?? '').trim();

    if (!repoUrl) {
      throw new BadRequestException('Repository URL is required');
    }

    if (!branch) {
      throw new BadRequestException('Branch is required');
    }

    // Same boundary checks as createDeploymentFromGitHub; DockerService
    // re-validates on clone as defence in depth.
    const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;
    if (branch.length > 200 || branch.startsWith('-') || branch.includes('..') || !GIT_REF_RE.test(branch)) {
      throw new BadRequestException('Invalid branch name');
    }
    if (dockerfilePath) {
      if (
        dockerfilePath.length > 500 ||
        dockerfilePath.startsWith('/') ||
        dockerfilePath.startsWith('\\') ||
        dockerfilePath.includes('..') ||
        dockerfilePath.includes('\0') ||
        !/^[A-Za-z0-9._/\- ]+$/.test(dockerfilePath)
      ) {
        throw new BadRequestException('Invalid Dockerfile path');
      }
    }

    if (deployment.buildType === 'dockerfile' && !dockerfilePath) {
      throw new BadRequestException('Dockerfile path is required for Dockerfile builds');
    }

    const parsed = this.githubService.parseRepoUrl(repoUrl);
    if (!parsed) {
      throw new BadRequestException('Could not parse repository URL');
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, parsed.owner, parsed.repo);
    if (!canAccess) {
      const isPublic = await this.githubService.isRepoPublic(parsed.owner, parsed.repo);
      if (!isPublic) {
        throw new ForbiddenException(
          'You do not have access to this repository on GitHub. Connect your GitHub account or request access to the repo.'
        );
      }
    }

    const repoInstallation = await this.githubService.findInstallationForRepo(parsed.owner, parsed.repo);

    const repoChanged = repoUrl !== deployment.githubRepo;
    // Auto-deploy webhooks are matched on githubInstallationId, so it must be
    // re-pinned to the new repo's installation. If the app has no access to
    // the new repo, auto-deploy can't fire and gets disabled.
    const keepAutoDeploy = deployment.autoDeployEnabled && !!repoInstallation;
    let autoDeployBranch: string | null = null;
    if (keepAutoDeploy) {
      autoDeployBranch = repoChanged ? branch : deployment.autoDeployBranch;
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        githubRepo: repoUrl,
        githubBranch: branch,
        dockerfilePath: dockerfilePath || null,
        githubInstallationId: repoInstallation?.installationId ?? null,
        autoDeployEnabled: keepAutoDeploy,
        autoDeployBranch,
        ...(repoChanged
          ? {
              queuedCommitSha: null,
              queuedCommitMessage: null,
              queuedCommitAuthorName: null,
              queuedCommitAuthorUsername: null,
              queuedAt: null,
            }
          : {}),
      },
    });

    void this.audit.log({
      action: 'deployment.github_repo.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        githubRepo: [deployment.githubRepo, repoUrl],
        githubBranch: [deployment.githubBranch, branch],
        ...(dockerfilePath !== (deployment.dockerfilePath ?? '')
          ? { dockerfilePath: [deployment.dockerfilePath, dockerfilePath || null] }
          : {}),
        ...(deployment.autoDeployEnabled && !keepAutoDeploy ? { autoDeployEnabled: [true, false] } : {}),
      },
    });

    return this.getDeployment(deploymentId);
  }

  async updateDeploymentHealthCheck(
    deploymentId: string,
    healthCheck: {
      healthCheckEnabled: boolean;
      healthCheckType: string;
      healthCheckPath?: string;
      healthCheckPort?: number;
      healthCheckCommand?: string;
      livenessEnabled: boolean;
      readinessEnabled: boolean;
      startupEnabled: boolean;
      healthCheckInterval: number;
      healthCheckTimeout: number;
      healthCheckRetries: number;
      startupFailureThreshold: number;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    this.assertNotComposeManaged(deployment, 'Update health checks');

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        healthCheckEnabled: healthCheck.healthCheckEnabled,
        healthCheckType: healthCheck.healthCheckType,
        healthCheckPath: healthCheck.healthCheckPath || null,
        healthCheckPort: healthCheck.healthCheckPort || null,
        healthCheckCommand: healthCheck.healthCheckCommand || null,
        livenessEnabled: healthCheck.livenessEnabled,
        readinessEnabled: healthCheck.readinessEnabled,
        startupEnabled: healthCheck.startupEnabled,
        healthCheckInterval: healthCheck.healthCheckInterval,
        healthCheckTimeout: healthCheck.healthCheckTimeout,
        healthCheckRetries: healthCheck.healthCheckRetries,
        startupFailureThreshold: healthCheck.startupFailureThreshold,
      },
    });

    // Apply to the live Kubernetes deployment
    try {
      await this.k8sWorkload.updateDeploymentHealthCheck({
        namespace: deployment.namespace,
        deploymentName: deployment.name,
        enabled: healthCheck.healthCheckEnabled,
        type: healthCheck.healthCheckType,
        path: healthCheck.healthCheckPath,
        port: healthCheck.healthCheckPort,
        command: healthCheck.healthCheckCommand,
        livenessEnabled: healthCheck.livenessEnabled,
        readinessEnabled: healthCheck.readinessEnabled,
        startupEnabled: healthCheck.startupEnabled,
        interval: healthCheck.healthCheckInterval,
        timeout: healthCheck.healthCheckTimeout,
        retries: healthCheck.healthCheckRetries,
        startupFailureThreshold: healthCheck.startupFailureThreshold,
      });
    } catch (error) {
      // Log but don't fail - the DB is updated, K8s will sync on next restart/rebuild
      console.error('Failed to apply health check to Kubernetes deployment:', error.message);
    }

    void this.audit.log({
      action: 'deployment.health_check.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        enabled: [deployment.healthCheckEnabled, healthCheck.healthCheckEnabled],
        type: [deployment.healthCheckType, healthCheck.healthCheckType],
        path: [deployment.healthCheckPath, healthCheck.healthCheckPath ?? null],
      },
    });

    return this.getDeployment(deploymentId);
  }

  // Render path is the source of truth: any full (re)create of the workload
  // must re-apply the stored health-check config, otherwise the probes the
  // save button patched in get wiped on the next rebuild.
  private async loadHealthCheckOptions(
    deploymentId: string,
  ): Promise<CreateDeploymentOptions['healthCheck'] | undefined> {
    const hc = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        healthCheckEnabled: true,
        healthCheckType: true,
        healthCheckPath: true,
        healthCheckPort: true,
        healthCheckCommand: true,
        livenessEnabled: true,
        readinessEnabled: true,
        startupEnabled: true,
        healthCheckInterval: true,
        healthCheckTimeout: true,
        healthCheckRetries: true,
        startupFailureThreshold: true,
      },
    });
    if (!hc || !hc.healthCheckEnabled) return undefined;
    return {
      enabled: hc.healthCheckEnabled,
      type: hc.healthCheckType,
      path: hc.healthCheckPath,
      port: hc.healthCheckPort,
      command: hc.healthCheckCommand,
      livenessEnabled: hc.livenessEnabled,
      readinessEnabled: hc.readinessEnabled,
      startupEnabled: hc.startupEnabled,
      interval: hc.healthCheckInterval,
      timeout: hc.healthCheckTimeout,
      retries: hc.healthCheckRetries,
      startupFailureThreshold: hc.startupFailureThreshold,
    };
  }

  async updateDeploymentVolumes(
    deploymentId: string,
    volumes: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string;
      storageSize?: string;
      hostPath?: string;
      readOnly?: boolean;
    }[],
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    this.assertNotComposeManaged(deployment, 'Update volumes');

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    if (Array.isArray(volumes) && volumes.some((v) => v && v.type === 'hostPath')) {
      void this.audit.log({
        action: 'deployment.volume.rejected',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        deploymentId,
        targetType: 'deployment',
        targetId: deploymentId,
        targetLabel: deployment.name,
        metadata: { reason: 'hostPath_volume' },
      });
      throw new ForbiddenException('hostPath volumes are not permitted');
    }

    const volumesList: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string | null;
      storageSize?: string | null;
      hostPath?: string | null;
      readOnly?: boolean;
    }[] = Array.isArray(volumes)
      ? volumes
          .filter((vol) => vol && vol.name && vol.mountPath)
          .map((vol) => {
            let volType: 'pvc' | 'hostPath' | 'emptyDir' = 'emptyDir';
            if (vol.type === 'pvc') volType = 'pvc';
            else if (vol.type === 'hostPath') volType = 'hostPath';
            return {
              name: vol.name.trim(),
              type: volType,
              mountPath: vol.mountPath.trim(),
              pvcName: vol.type === 'pvc' ? (vol.pvcName?.trim() || vol.name.trim()) : null,
              storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
              hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
              readOnly: Boolean(vol.readOnly),
            };
          })
          .filter((vol) => {
            if (vol.type === 'pvc' && !vol.pvcName) return false;
            if (vol.type === 'hostPath' && !vol.hostPath) return false;
            return true;
          })
      : [];

    // Validate the values that flow into the PVC manifest and pod spec before
    // touching Kubernetes. The API rejects bad names/quantities with a 422 the
    // client library flattens into an opaque "HTTP request failed", so catching
    // them here is the only way the user gets an actionable message.
    const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    const K8S_QUANTITY = /^\d+(\.\d+)?(Ei|Pi|Ti|Gi|Mi|Ki|E|P|T|G|M|k)?$/;
    for (const vol of volumesList) {
      if (!DNS1123.test(vol.name) || vol.name.length > 63) {
        throw new BadRequestException(
          `Volume name "${vol.name}" must be 1-63 lowercase letters, numbers, or hyphens`,
        );
      }
      if (!vol.mountPath.startsWith('/')) {
        throw new BadRequestException(
          `Mount path "${vol.mountPath}" must be an absolute path starting with /`,
        );
      }
      if (vol.type === 'pvc') {
        if (!DNS1123.test(vol.pvcName!) || vol.pvcName!.length > 63) {
          throw new BadRequestException(
            `Volume name "${vol.pvcName}" must be 1-63 lowercase letters, numbers, or hyphens`,
          );
        }
        if (vol.storageSize && !K8S_QUANTITY.test(vol.storageSize)) {
          throw new BadRequestException(
            `Storage size "${vol.storageSize}" is not valid, use a size like 1Gi or 500Mi`,
          );
        }
      }
    }

    // Compute the effective strategy: PVC forces Recreate, otherwise keep
    // whatever the deployment was previously set to. The persisted
    // `deployStrategy` is also auto-reverted to rollingUpdate when the last
    // PVC is removed only if the user had it set explicitly; we conservatively
    // keep the existing value (the k8s patch will apply it).
    const hasPvcVolume = volumesList.some((v) => v.type === 'pvc');
    const effectiveStrategy: 'rollingUpdate' | 'recreate' = hasPvcVolume
      ? 'recreate'
      : (deployment.deployStrategy as 'rollingUpdate' | 'recreate');

    // Only push to K8s if the deployment exists in the cluster.
    const k8sExistsVol = await this.k8sWorkload.getKubernetesDeployment(
      deployment.name, deployment.namespace,
    ).then((d) => d !== null).catch(() => false);

    if (k8sExistsVol) {
      await this.k8sWorkload.updateDeploymentVolumes({
        namespace: deployment.namespace,
        deploymentName: deployment.name,
        volumes: volumesList,
        deployStrategy: effectiveStrategy,
      });
    }

    const updatedDeployment = await this.prisma.$transaction(async (tx) => {
      // Persist auto-Recreate when PVC was added, so the UI reflects reality.
      if (hasPvcVolume && deployment.deployStrategy !== 'recreate') {
        await tx.deployment.update({
          where: { id: deployment.id },
          data: { deployStrategy: 'recreate' },
        });
      }

      await tx.deploymentVolume.deleteMany({
        where: {
          deploymentId: deployment.id,
        },
      });

      if (volumesList.length > 0) {
        await tx.deploymentVolume.createMany({
          data: volumesList.map((vol) => ({
            deploymentId: deployment.id,
            name: vol.name,
            type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
            mountPath: vol.mountPath,
            pvcName: vol.pvcName,
            storageSize: vol.storageSize,
            hostPath: vol.hostPath,
            readOnly: vol.readOnly,
          })),
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          project: {
            include: {
              organization: true,
            },
          },
          pods: true,
          services: {
            include: {
              ports: true,
            },
          },
          envVars: true,
          volumes: true,
          ingresses: {
            include: {
              service: true,
            },
          },
        },
      });
    });

    void this.audit.log({
      action: 'deployment.volumes.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { count: volumesList.length, names: volumesList.map((v) => v.name).join(',') || null },
    });

    return this.addInternalUrlsToDeployment(updatedDeployment);
  }

  async createDeploymentService(
    deploymentId: string,
    data: {
      name: string;
      ports: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      exposePublic?: boolean;
      domain?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        services: {
          include: {
            ports: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage services');

    const rawName = String(data.name || '').trim();
    if (!rawName) {
      throw new BadRequestException('Service name is required');
    }

    const normalizedName = formatSlug(rawName);
    if (!normalizedName) {
      throw new BadRequestException('Service name is invalid');
    }

    const existingServiceWithName = await this.prisma.service.findFirst({
      where: {
        name: normalizedName,
        deployment: {
          projectId: deployment.projectId,
        },
      },
    });

    if (existingServiceWithName) {
      throw new BadRequestException('A service with this name already exists in the project namespace');
    }

    const portsPayload = this.normalizeServicePortInputs(data.ports, {
      requireAtLeastOne: true,
    });

    const domainProvided = Object.hasOwn(data ?? {}, 'domain');
    let normalizedDomain: string | null = null;

    if (domainProvided) {
      const rawDomain =
        data.domain === null || data.domain === undefined
          ? ''
          : String(data.domain).trim().toLowerCase();

      if (!rawDomain) {
        normalizedDomain = null;
      } else if (!/^[a-z0-9.-]+$/.test(rawDomain)) {
        throw new BadRequestException('Domain can only contain letters, numbers, dots, or hyphens');
      } else if (rawDomain.length > 253) {
        throw new BadRequestException('Domain is too long');
      } else {
        normalizedDomain = rawDomain;
      }
    }

    const exposePublic = data.exposePublic === true;
    const requestedType = exposePublic ? 'NodePort' : 'ClusterIP';
    const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;

    const creationResult = await this.k8sNetwork.createDeploymentService({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      serviceName: normalizedName,
      type: requestedType,
      ports: portsPayload,
    });

    const resolvedPorts =
      creationResult.ports && creationResult.ports.length > 0
        ? creationResult.ports
        : portsPayload;

    const primaryPort = resolvedPorts[0];

    await this.prisma.$transaction(async (tx) => {
      const serviceRecord = await tx.service.create({
        data: {
          deploymentId: deployment.id,
          name: normalizedName,
          type: serviceType,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          nodePort: primaryPort.nodePort ?? null,
          externalIp: creationResult.externalIp ?? null,
          domain: normalizedDomain,
        },
      });

      if (resolvedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: resolvedPorts.map((port) => ({
            serviceId: serviceRecord.id,
            name: port.name,
            port: port.servicePort,
            targetPort: port.containerPort,
            protocol: port.protocol,
            nodePort: port.nodePort ?? null,
          })),
        });
      }
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    return this.addInternalUrlsToDeployment(result);
  }

  async updateServiceConfiguration(
    deploymentId: string,
    serviceId: string,
    changes: {
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      domain?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
          },
        },
        ports: true,
      },
    });

    if (!service) {
      throw new NotFoundException(`Service ${serviceId} not found`);
    }

    if (service.deploymentId !== deploymentId) {
      throw new BadRequestException('Service does not belong to deployment');
    }

    await this.authz.requireProjectEdit(service.deployment.project.id, user.id, 'update services');

    const domainProvided = Object.hasOwn(changes ?? {}, 'domain');
    let normalizedDomain: string | null = null;

    if (domainProvided) {
      const rawDomain =
        changes.domain === null || changes.domain === undefined
          ? ''
          : String(changes.domain).trim().toLowerCase();

      if (!rawDomain) {
        normalizedDomain = null;
      } else if (!/^[a-z0-9.-]+$/.test(rawDomain)) {
        throw new BadRequestException('Domain can only contain letters, numbers, dots, or hyphens');
      } else if (rawDomain.length > 253) {
        throw new BadRequestException('Domain is too long');
      } else {
        normalizedDomain = rawDomain;
      }
    }

    let portsPayload: {
      name?: string;
      containerPort?: number;
      servicePort?: number;
      protocol?: string;
      nodePort?: number;
    }[] | null = null;

    if (Array.isArray(changes?.ports)) {
      portsPayload = this.normalizeServicePortInputs(changes.ports, {
        requireAtLeastOne: true,
      });
    }

    if (!domainProvided && portsPayload === null) {
      throw new BadRequestException('No changes provided for service update');
    }

    let updateResult:
      | {
          type: string;
          ports: {
            name: string;
            containerPort: number;
            servicePort: number;
            protocol: string;
            nodePort?: number;
          }[];
          externalIp: string | null;
        }
      | null = null;

    if (portsPayload) {
      updateResult = await this.k8sNetwork.updateServicePorts({
        namespace: service.deployment.namespace,
        deploymentName: service.deployment.name,
        serviceName: service.name,
        ports: portsPayload,
      });
    }

    let resolvedPorts;
    if (updateResult) {
      resolvedPorts = updateResult.ports.map((port) => ({
        name: port.name,
        servicePort: port.servicePort,
        containerPort: port.containerPort,
        protocol: port.protocol,
        nodePort: port.nodePort ?? null,
      }));
    } else if (service.ports.length > 0) {
      resolvedPorts = service.ports.map((port) => ({
        name: port.name || `${service.name}`,
        servicePort: port.port,
        containerPort: port.targetPort,
        protocol: port.protocol,
        nodePort: port.nodePort ?? null,
      }));
    } else {
      resolvedPorts = [
        {
          name: service.name,
          servicePort: service.port,
          containerPort: service.targetPort,
          protocol: service.protocol,
          nodePort: service.nodePort ?? null,
        },
      ];
    }

    const primaryPort =
      resolvedPorts[0] || {
        name: service.name,
        servicePort: service.port,
        containerPort: service.targetPort,
        protocol: service.protocol,
        nodePort: service.nodePort ?? null,
      };

    let resolvedType = service.type;
    if (updateResult) {
      resolvedType = updateResult.type === 'ClusterIP' ? ServiceType.internal : ServiceType.external;
    }

    const resolvedExternalIp =
      updateResult && Object.hasOwn(updateResult, 'externalIp')
        ? updateResult.externalIp
        : service.externalIp;

    const priorPublic = new Map<
      string,
      { publicEnabled: boolean; publicPort: number | null; targetPort: number; protocol: string }
    >();
    if (portsPayload) {
      for (const p of service.ports) {
        if (p.publicEnabled && p.publicPort) {
          priorPublic.set(`${p.port}:${p.protocol.toUpperCase()}`, {
            publicEnabled: true,
            publicPort: p.publicPort,
            targetPort: p.targetPort,
            protocol: p.protocol,
          });
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ServiceUpdateInput = {};

      if (portsPayload) {
        data.type = resolvedType;
        data.externalIp = resolvedExternalIp ?? null;
        data.port = primaryPort.servicePort;
        data.targetPort = primaryPort.containerPort;
        data.protocol = primaryPort.protocol;
        data.nodePort = primaryPort.nodePort ?? null;
      }

      if (domainProvided) {
        data.domain = normalizedDomain;
      }

      if (Object.keys(data).length > 0) {
        await tx.service.update({
          where: { id: service.id },
          data,
        });
      }

      if (portsPayload) {
        await tx.servicePort.deleteMany({
          where: { serviceId: service.id },
        });

        if (resolvedPorts.length > 0) {
          await tx.servicePort.createMany({
            data: resolvedPorts.map((port) => {
              const key = `${port.servicePort}:${port.protocol.toUpperCase()}`;
              const prior = priorPublic.get(key);
              return {
                serviceId: service.id,
                name: port.name,
                port: port.servicePort,
                targetPort: port.containerPort,
                protocol: port.protocol,
                nodePort: port.nodePort,
                publicEnabled: prior ? prior.publicEnabled : false,
                publicPort: prior ? prior.publicPort : null,
              };
            }),
          });
        }
      }
    });

    if (portsPayload && priorPublic.size > 0) {
      const keptKeys = new Set(
        resolvedPorts.map((p) => `${p.servicePort}:${p.protocol.toUpperCase()}`),
      );
      for (const [key, prior] of priorPublic) {
        if (keptKeys.has(key)) {
          if (prior.publicPort) {
            const kept = resolvedPorts.find(
              (p) => `${p.servicePort}:${p.protocol.toUpperCase()}` === key,
            );
            if (kept && kept.containerPort !== prior.targetPort) {
              try {
                const org = await this.prisma.organization.findUnique({
                  where: { id: service.deployment.project.organizationId },
                });
                const ip = (org?.databasePublicIp || '').trim();
                if (ip) {
                  await this.k8sNetwork.exposeDeploymentPortPublic({
                    namespace: service.deployment.namespace,
                    deploymentName: service.deployment.name,
                    loadBalancerIp: ip,
                    publicPort: prior.publicPort,
                    targetPort: kept.containerPort,
                    protocol: prior.protocol,
                  });
                }
              } catch (e: any) {
                console.error(`[Deployment/public] Failed to re-expose port on update: ${e?.message}`);
              }
            }
          }
        } else if (prior.publicPort) {
          try {
            await this.k8sNetwork.unexposeDeploymentPortPublic({
              namespace: service.deployment.namespace,
              deploymentName: service.deployment.name,
              publicPort: prior.publicPort,
              protocol: prior.protocol,
            });
          } catch (e: any) {
            console.error(`[Deployment/public] Failed to unexpose removed port: ${e?.message}`);
          }
        }
      }
      await this.syncPublicDeploymentNetworkPolicy(
        service.deployment.namespace,
        service.deployment.name,
        service.deployment.id,
      );
    }

    if (portsPayload) {
      const affectedIngresses = await this.prisma.ingress.findMany({
        where: { serviceId: service.id },
      });
      for (const ing of affectedIngresses) {
        try {
          await this.k8sNetwork.patchIngressPathPort(
            ing.namespace,
            ing.name,
            ing.path,
            primaryPort.servicePort,
          );
        } catch (e: any) {
          console.error(`[Deployment] Failed to sync ingress ${ing.name} path ${ing.path} port: ${e?.message}`);
        }
      }
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async deleteDeploymentService(
    deploymentId: string,
    serviceId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
            services: {
              include: {
                ports: true,
              },
            },
          },
        },
        ports: true,
        ingresses: true,
      },
    });

    if (!service) {
      throw new NotFoundException(`Service ${serviceId} not found`);
    }

    if (service.deploymentId !== deploymentId) {
      throw new BadRequestException('Service does not belong to deployment');
    }

    if (service.ingresses.length > 0) {
      throw new BadRequestException('Delete associated ingresses before removing the service');
    }

    await this.authz.requireProjectEdit(service.deployment.project.id, user.id, 'update services');

    const otherServices = service.deployment.services.filter(
      (entry) => entry.id !== service.id
    );

    const remainingPortsInput: {
      name?: string;
      containerPort: number;
      servicePort: number;
      protocol: string;
      nodePort?: number;
    }[] = [];

    for (const entry of otherServices) {
      const servicePorts =
        entry.ports.length > 0
          ? entry.ports.map((port) => ({
              name: port.name || entry.name,
              containerPort: port.targetPort,
              servicePort: port.port,
              protocol: port.protocol,
              nodePort: port.nodePort ?? undefined,
            }))
          : [
              {
                name: entry.name,
                containerPort: entry.targetPort,
                servicePort: entry.port,
                protocol: entry.protocol,
                nodePort: entry.nodePort ?? undefined,
              },
            ];

      remainingPortsInput.push(...servicePorts);
    }

    for (const p of service.ports) {
      if (p.publicEnabled && p.publicPort) {
        try {
          await this.k8sNetwork.unexposeDeploymentPortPublic({
            namespace: service.deployment.namespace,
            deploymentName: service.deployment.name,
            publicPort: p.publicPort,
            protocol: p.protocol,
          });
        } catch (e: any) {
          console.error(`[Deployment/public] Failed to unexpose port on service delete: ${e?.message}`);
        }
      }
    }

    await this.k8sNetwork.deleteDeploymentService({
      namespace: service.deployment.namespace,
      deploymentName: service.deployment.name,
      serviceName: service.name,
      remainingPorts: remainingPortsInput,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.servicePort.deleteMany({
        where: { serviceId: service.id },
      });

      await tx.service.delete({
        where: { id: service.id },
      });
    });

    await this.syncPublicDeploymentNetworkPolicy(
      service.deployment.namespace,
      service.deployment.name,
      service.deployment.id,
    );

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async updateServiceExposure(
    deploymentId: string,
    serviceId: string,
    exposePublic: boolean,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true,
              },
            },
          },
        },
        ports: true,
      },
    });

    if (!service) {
      throw new NotFoundException(`Service ${serviceId} not found`);
    }

    if (service.deploymentId !== deploymentId) {
      throw new BadRequestException('Service does not belong to deployment');
    }

    await this.authz.requireProjectEdit(service.deployment.project.id, user.id, 'update services');

    const desiredType = exposePublic ? 'NodePort' : 'ClusterIP';

    const exposureResult = await this.k8sNetwork.updateServiceExposure({
      namespace: service.deployment.namespace,
      serviceName: service.name,
      type: desiredType,
    });

    const normalizedPorts = Array.isArray(exposureResult.ports) && exposureResult.ports.length > 0
      ? exposureResult.ports.map((port) => ({
          name: port.name,
          servicePort: port.servicePort,
          containerPort: port.containerPort,
          protocol: port.protocol,
          nodePort:
            port.nodePort !== undefined && port.nodePort !== null ? port.nodePort : null,
        }))
      : service.ports.map((port) => ({
          name: port.name || `port-${port.port}`,
          servicePort: port.port,
          containerPort: port.targetPort,
          protocol: port.protocol,
          nodePort: port.nodePort ?? null,
        }));

    const primaryPort = normalizedPorts[0] || {
      name: service.name,
      servicePort: service.port,
      containerPort: service.targetPort,
      protocol: service.protocol,
      nodePort: service.nodePort ?? null,
    };

    const priorPublic = snapshotPublicPortState(service.ports);

    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: service.id },
        data: {
          type: exposePublic ? ServiceType.external : ServiceType.internal,
          externalIp: exposureResult.externalIp || null,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          nodePort: primaryPort.nodePort,
        },
      });

      await tx.servicePort.deleteMany({
        where: { serviceId: service.id },
      });

      if (normalizedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: normalizedPorts.map((port) => {
            const prior = priorPublic.get(publicPortKey(port.servicePort, port.protocol));
            return {
              serviceId: service.id,
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
              nodePort: port.nodePort,
              publicEnabled: prior ? prior.publicEnabled : false,
              publicPort: prior ? prior.publicPort : null,
            };
          }),
        });
      }
    });

    const keptKeys = new Set(
      normalizedPorts.map((port) => publicPortKey(port.servicePort, port.protocol)),
    );
    for (const [key, prior] of priorPublic) {
      if (keptKeys.has(key) || !prior.publicPort) continue;
      try {
        await this.k8sNetwork.unexposeDeploymentPortPublic({
          namespace: service.deployment.namespace,
          deploymentName: service.deployment.name,
          publicPort: prior.publicPort,
          protocol: key.split(':')[1],
        });
      } catch (e: any) {
        console.error(`[Deployment/public] Failed to unexpose dropped port: ${e?.message}`);
      }
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    void this.audit.log({
      action: exposePublic ? 'service.exposure.enabled' : 'service.exposure.disabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: service.deployment.project.organizationId,
      projectId: service.deployment.projectId,
      deploymentId,
      targetType: 'service',
      targetId: serviceId,
      targetLabel: service.name,
      metadata: { type: [service.type, exposePublic ? 'external' : 'internal'] },
    });

    return this.addInternalUrlsToDeployment(result);
  }

  // Auto-deploy methods

  async enableAutoDeploy(
    deploymentId: string,
    branch: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo) {
      throw new BadRequestException('This deployment was not created from GitHub');
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'configure auto-deploy');

    // Parse the repo URL to get owner and repo
    const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);
    if (!repoInfo) {
      throw new BadRequestException('Invalid GitHub repository URL');
    }

    // Check if the GitHub App has access to this repository
    const installation = await this.githubService.findInstallationForRepo(repoInfo.owner, repoInfo.repo);
    if (!installation) {
      throw new BadRequestException(
        'The GitHub App is not installed on this repository. Please install the app first.'
      );
    }

    const previousBranch = deployment.autoDeployBranch;
    const previouslyEnabled = deployment.autoDeployEnabled;

    // Update the deployment with auto-deploy settings. Also pin the
    // installation id so subsequent webhook deliveries are bound to this
    // specific GitHub App installation (legacy rows whose
    // githubInstallationId is null are picked up here).
    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        autoDeployEnabled: true,
        autoDeployBranch: branch,
        githubInstallationId: installation.installationId,
      },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    void this.audit.log({
      action: 'deployment.autodeploy.enabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        repo: deployment.githubRepo,
        branch: [previousBranch ?? null, branch],
        wasEnabled: previouslyEnabled,
      },
    });

    return this.addInternalUrlsToDeployment(updated);
  }

  async disableAutoDeploy(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'configure auto-deploy');

    const previousBranch = deployment.autoDeployBranch;
    const previouslyEnabled = deployment.autoDeployEnabled;

    // Update the deployment
    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        autoDeployEnabled: false,
      },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
      },
    });

    void this.audit.log({
      action: 'deployment.autodeploy.disabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        repo: deployment.githubRepo,
        branch: [previousBranch ?? null, null],
        wasEnabled: previouslyEnabled,
      },
    });

    return this.addInternalUrlsToDeployment(updated);
  }

  async triggerAutoDeploy(
    deploymentId: string,
    commitSha: string,
    commitMessage: string,
    commitAuthorName?: string,
    commitAuthorUsername?: string,
    fromQueueRunId?: string,
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        envVars: true,
        volumes: true,
        services: {
          include: {
            ports: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo || !deployment.githubBranch) {
      throw new BadRequestException('This deployment was not created from GitHub');
    }

    if (!fromQueueRunId) {
      const { startNow } = await this.buildQueue.enqueue({
        deploymentId,
        triggerType: 'auto',
        commitSha,
        commitMessage,
        commitAuthorName,
        commitAuthorUsername,
        branch: deployment.autoDeployBranch || deployment.githubBranch,
      });
      if (!startNow) {
        console.log(`[Projects] Queued auto-deploy for ${deploymentId} (commit ${commitSha?.substring(0, 7)})`);
        return { queued: true, commitSha };
      }
    }

    // Parse repo info for GitHub API calls
    const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);

    // Find GitHub App installation for this repo (uses app token, not user token)
    let installationId: bigint | null = null;
    let checkRunId: number | null = null;
    let installationAccessToken: string | null = null;
    let logUrl: string | null = null;

    if (repoInfo) {
      try {
        const installation = await this.githubService.findInstallationForRepo(repoInfo.owner, repoInfo.repo);
        if (installation) {
          installationId = installation.installationId;

          // Get installation access token for cloning the repo
          installationAccessToken = await this.githubService.getOrRefreshInstallationToken(installationId);

          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          const orgSlug = deployment.project?.organization?.slug;
          logUrl = orgSlug
            ? `${frontendUrl}/${orgSlug}/deployments/${deploymentId}/progress`
            : `${frontendUrl}/deployments/${deploymentId}/progress`;

          // Create a GitHub Check Run (appears under "Checks" on the commit, authored by the app)
          const checkRun = await this.githubService.createCheckRun(
            installationId,
            repoInfo.owner,
            repoInfo.repo,
            {
              name: 'Orchard Deployment',
              headSha: commitSha,
              status: 'in_progress',
              detailsUrl: logUrl,
              externalId: deploymentId,
              output: {
                title: 'Building...',
                summary: `Deploying \`${deployment.name}\` from commit \`${commitSha.substring(0, 7)}\``,
                text: `**Commit:** ${commitMessage.split('\n')[0]}\n\n**Branch:** ${deployment.autoDeployBranch || deployment.githubBranch}\n\n---\n\nBuilding...`,
              },
            }
          );

          checkRunId = checkRun.id;
          console.log(`[Projects] Created GitHub check run ${checkRunId} for deployment ${deploymentId}`);
          await this.buildQueue.attachGitHubContext(deploymentId, {
            checkRunId,
            installationId,
            repoFullName: `${repoInfo.owner}/${repoInfo.repo}`,
          });

          // Also create a GitHub Deployment (appears under "Deployments" section)
          try {
            const ghDeployment = await this.githubService.createGitHubDeploymentWithApp(
              installationId,
              repoInfo.owner,
              repoInfo.repo,
              commitSha,
              deployment.name,
              `Deploying ${deployment.name} from commit ${commitSha.substring(0, 7)}`
            );

            // Update deployment status to in_progress
            await this.githubService.updateDeploymentStatusWithApp(
              installationId,
              repoInfo.owner,
              repoInfo.repo,
              ghDeployment.id,
              'in_progress',
              { logUrl, description: 'Building...' }
            );

            // Store the GitHub deployment record
            await this.prisma.gitHubDeployment.create({
              data: {
                deploymentId,
                githubDeploymentId: BigInt(ghDeployment.id),
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                ref: deployment.autoDeployBranch || deployment.githubBranch,
                commitSha,
                environment: deployment.name,
                status: 'in_progress',
                logUrl,
              },
            });

            console.log(`[Projects] Created GitHub deployment ${ghDeployment.id} for ${deploymentId}`);
          } catch (ghErr) {
            console.error(`[Projects] Failed to create GitHub deployment: ${ghErr.message}`);
          }
        }
      } catch (err) {
        console.error(`[Projects] Failed to create GitHub check run: ${err.message}`);
      }
    }

    // Reset build status to building. Clear any queued commit: this build is
    // starting now, so a commit that was parked for "next build" is being
    // consumed here (or a fresh push is taking priority).
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'building',
        buildStepTimestamps: { __start: Date.now() },
        buildLogs: `Auto-deploy triggered by push to ${deployment.autoDeployBranch || deployment.githubBranch}\nCommit: ${commitSha?.substring(0, 7)} - ${commitMessage.split('\n')[0]}\n\n`,
        buildError: null,
        queuedCommitSha: null,
        queuedCommitMessage: null,
        queuedCommitAuthorName: null,
        queuedCommitAuthorUsername: null,
        queuedAt: null,
      },
    });

    // Extract image name from current image
    const imageParts = deployment.image?.split('/') || [];
    const imageNameWithTag = imageParts[imageParts.length - 1] || `${deployment.project.namespace}-${deployment.name}`;
    const [imageName] = imageNameWithTag.split(':');

    // Generate unique tag based on timestamp
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
    const uniqueTag = `v${timestamp}`;

    // Get service configuration
    const service = deployment.services[0];
    const rawPorts = service?.ports.map(port => ({
      name: port.name,
      containerPort: port.targetPort,
      servicePort: port.port,
      protocol: port.protocol,
      nodePort: port.nodePort || undefined,
    })) || [];

    const { resolved: env } = resolveEnvVars(
      deployment.envVars.map((ev) => ({ key: ev.key, value: ev.value, secret: ev.secret })),
      await this.loadSharedVarsForDeployment(deployment.id, deployment.environmentId),
    );

    const volumes = (deployment.volumes || []).map(vol => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName || undefined,
      storageSize: vol.storageSize || undefined,
      hostPath: vol.hostPath || undefined,
      readOnly: vol.readOnly,
    }));

    // Start build process with GitHub check run info
    this.buildAndDeployAsync(
      deploymentId,
      {
        repoUrl: deployment.githubRepo,
        branch: deployment.autoDeployBranch || deployment.githubBranch,
        dockerfilePath: deployment.dockerfilePath,
        buildFromRoot: deployment.buildFromRoot ?? false,
        buildWithDepot: deployment.buildWithDepot ?? false,
        persistentBuildCache: deployment.persistentBuildCache ?? false,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env,
        exposePublic: service?.type === 'external',
        volumes,
        isRebuild: true,
        commitSha,
        commitMessage: commitMessage.split('\n')[0],
        commitAuthorName,
        commitAuthorUsername,
        // GitHub Check Run info (uses App, not user)
        checkRunId,
        checkLogUrl: logUrl,
        installationId: installationId ? installationId.toString() : null,
        repoInfo,
        triggerType: 'auto',
      },
      installationAccessToken, // Use GitHub App installation token for cloning
    ).catch((error) => {
      console.error(`[Projects] Auto-deploy failed for deployment ${deploymentId}:`, error);
    });
  }

  async listBuildRuns(deploymentId: string, limit = 20) {
    const runs = await this.prisma.buildRun.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: { triggeredBy: { select: { username: true, imageUrl: true } } },
    });
    return runs.map((r) => ({
      id: r.id,
      status: r.status,
      triggerType: r.triggerType,
      commitSha: r.commitSha,
      commitMessage: r.commitMessage,
      commitAuthorUsername: r.commitAuthorUsername ?? r.triggeredBy?.username ?? null,
      branch: r.branch,
      detail: r.detail,
      scheduledAt: r.scheduledAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      createdAt: r.createdAt,
    }));
  }

  async getBuildRunLogs(deploymentId: string, runId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      throw new NotFoundException(`Build run ${runId} not found`);
    }
    const run = await this.prisma.buildRun.findFirst({
      where: { id: runId, deploymentId },
      select: { logs: true, status: true },
    });
    if (!run) {
      throw new NotFoundException(`Build run ${runId} not found`);
    }
    if (run.logs !== null) {
      return { logs: run.logs, live: false };
    }
    if (run.status === 'building') {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildLogs: true },
      });
      return { logs: deployment?.buildLogs ?? null, live: true };
    }
    return { logs: null, live: false };
  }

  async getAutoDeployStatus(deploymentId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        autoDeployEnabled: true,
        autoDeployBranch: true,
        githubRepo: true,
        githubBranch: true,
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    // Check if GitHub App has access to this repo
    let appInstalled = false;
    if (deployment.githubRepo) {
      const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);
      if (repoInfo) {
        try {
          const installation = await this.githubService.findInstallationForRepo(repoInfo.owner, repoInfo.repo);
          appInstalled = !!installation;
        } catch {
          appInstalled = false;
        }
      }
    }

    return {
      enabled: deployment.autoDeployEnabled,
      branch: deployment.autoDeployBranch || deployment.githubBranch,
      appInstalled,
    };
  }

  async getGitHubDeployments(deploymentId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    return this.prisma.gitHubDeployment.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
  // ── Public deployment-port exposure ──

  private async pickFreePublicDeploymentPort(ip: string): Promise<number> {
    const dbPortsRaw = await this.prisma.database.findMany({
      where: { publicIp: ip, publicPort: { not: null } },
      select: { publicPort: true },
    });
    const svcPortsRaw = await this.prisma.servicePort.findMany({
      where: { publicEnabled: true, publicPort: { not: null } },
      select: { publicPort: true },
    });
    const taken = new Set<number>();
    for (const r of dbPortsRaw) if (typeof r.publicPort === 'number') taken.add(r.publicPort);
    for (const r of svcPortsRaw) if (typeof r.publicPort === 'number') taken.add(r.publicPort);

    try {
      const live = await this.k8sNetwork.listInUsePortsOnIp(ip);
      for (const p of live) taken.add(p);
    } catch (e: any) {
      console.error(`[Deployment/public] Failed to list in-use ports on ${ip}: ${e?.message}`);
    }

    const MIN = 30000;
    const MAX = 32767;
    for (let i = 0; i < 200; i++) {
      const port = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
      if (!taken.has(port)) return port;
    }
    throw new BadRequestException('Could not find a free public port after 200 attempts');
  }

  private async syncPublicDeploymentNetworkPolicy(namespace: string, deploymentName: string, deploymentId: string) {
    const publicPorts = await this.prisma.servicePort.findMany({
      where: {
        publicEnabled: true,
        service: { deploymentId },
      },
      select: { targetPort: true, protocol: true },
    });
    const deduped = new Map<string, { port: number; protocol: string }>();
    for (const p of publicPorts) {
      const proto = p.protocol?.toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
      deduped.set(`${proto}:${p.targetPort}`, { port: p.targetPort, protocol: proto });
    }
    try {
      await this.k8sNetwork.upsertPublicDeploymentNetworkPolicy(
        namespace,
        deploymentName,
        Array.from(deduped.values()),
      );
    } catch (e: any) {
      console.error(`[Deployment/public] Failed to sync NetworkPolicy: ${e?.message}`);
    }
  }

  async enableServicePortPublic(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any,
  ) {
    const { user, port, deployment } = await this.access.assertServicePortEditor(deploymentId, serviceId, portId, clerkId, userData);

    const org = await this.prisma.organization.findUnique({ where: { id: deployment.project.organizationId } });
    const ip = (org?.databasePublicIp || '').trim();
    if (!ip) {
      throw new BadRequestException('This organization does not have a public IP configured. Set one in organization settings.');
    }

    if (port.publicEnabled && port.publicPort) {
      const host = this.k8sNetwork.publicDeploymentBaseDomain();
      return { enabled: true, host, ip, port: port.publicPort, protocol: port.protocol };
    }

    const publicPort = await this.pickFreePublicDeploymentPort(ip);

    await this.k8sNetwork.exposeDeploymentPortPublic({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      loadBalancerIp: ip,
      publicPort,
      targetPort: port.targetPort,
      protocol: port.protocol,
    });

    await this.prisma.servicePort.update({
      where: { id: port.id },
      data: { publicEnabled: true, publicPort },
    });

    await this.syncPublicDeploymentNetworkPolicy(deployment.namespace, deployment.name, deployment.id);

    void this.audit.log({
      action: 'service.port.public_enabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      targetType: 'service_port',
      targetId: port.id,
      targetLabel: `${deployment.name}:${port.targetPort}`,
      metadata: { publicPort, protocol: port.protocol, ip },
    });

    const host = this.k8sNetwork.publicDeploymentBaseDomain();
    return { enabled: true, host, ip, port: publicPort, protocol: port.protocol };
  }

  async disableServicePortPublic(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any,
  ) {
    const { user, port, deployment } = await this.access.assertServicePortEditor(deploymentId, serviceId, portId, clerkId, userData);
    const previousPublicPort = port.publicPort;

    if (port.publicEnabled && port.publicPort) {
      try {
        await this.k8sNetwork.unexposeDeploymentPortPublic({
          namespace: deployment.namespace,
          deploymentName: deployment.name,
          publicPort: port.publicPort,
          protocol: port.protocol,
        });
      } catch (e: any) {
        console.error(`[Deployment/public] Failed to delete public Service: ${e?.message}`);
      }
    }

    await this.prisma.servicePort.update({
      where: { id: port.id },
      data: { publicEnabled: false, publicPort: null },
    });

    await this.syncPublicDeploymentNetworkPolicy(deployment.namespace, deployment.name, deployment.id);

    void this.audit.log({
      action: 'service.port.public_disabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      targetType: 'service_port',
      targetId: port.id,
      targetLabel: `${deployment.name}:${port.targetPort}`,
      metadata: { previousPublicPort, protocol: port.protocol },
    });

    return { enabled: false };
  }

  /** Load the shared vars of a deployment's environment (empty if none). */
  async loadSharedVarsForDeployment(
    deploymentId: string,
    environmentId: string | null,
  ): Promise<EnvVar[]> {
    if (!environmentId) return [];
    const vars = await this.prisma.environmentSharedVar.findMany({
      where: { environmentId },
      select: { key: true, value: true, secret: true },
    });
    // Secret values are stored encrypted at rest — decrypt before they feed the
    // resolver so plaintext reaches the pod/build.
    return vars.map((v) => this.crypto.maybeDecrypt(v));
  }

  /**
   * Load a deployment's own env vars + its environment's shared vars, resolve
   * ${{shared.KEY}} references, and return the injectable list. Used by both
   * the runtime (pod env) and build (build args) paths so they never diverge.
   */
  async loadResolvedEnvForDeployment(
    deploymentId: string,
    environmentId: string | null,
  ): Promise<{ resolved: EnvVar[]; errors: { key: string; missingRef: string }[] }> {
    const own = await this.prisma.deploymentEnvVar.findMany({
      where: { deploymentId },
      select: { key: true, value: true, secret: true },
    });
    const shared = await this.loadSharedVarsForDeployment(deploymentId, environmentId);
    return resolveEnvVars(own, shared);
  }

  scrubDeploymentForViewer<
    T extends {
      envVars?: { key: string; value: string | null }[] | null;
      buildLogs?: string | null;
      buildError?: string | null;
      ingresses?: any[] | null;
    },
  >(d: T): T {
    return {
      ...d,
      envVars: d.envVars
        ? d.envVars.map((ev) => ({ ...ev, value: null }))
        : d.envVars,
      ingresses: d.ingresses
        ? d.ingresses.map((ing) => scrubIngress(ing))
        : d.ingresses,
      buildLogs: null,
      buildError: null,
    } as T;
  }

  /**
   * Nullify member emails (project + adder) when the requester is a viewer.
   */
  private scrubMembersForViewer<
    M extends {
      user?: { email?: string | null } | null;
      adder?: { email?: string | null } | null;
    },
  >(members: M[] | null | undefined): M[] {
    if (!members) return [] as M[];
    return members.map((m) => ({
      ...m,
      user: m.user ? { ...m.user, email: null } : m.user,
      adder: m.adder ? { ...m.adder, email: null } : m.adder,
    }));
  }

  // Assign/clear a deployment's node pool (or superadmin raw override). Persists
  // only; the new placement lands on the next deploy/rebuild since scheduling
  // changes require pod recreation.
  async updateDeploymentPlacement(
    deploymentId: string,
    data: { nodePoolId?: string | null; placementOverride?: unknown },
    clerkId: string,
    userData?: { email?: string; username?: string; firstName?: string; lastName?: string; imageUrl?: string },
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });
    if (!deployment) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployment placement');
    await this.nodesService.assertPoolAssignable({
      nodePoolId: data.nodePoolId,
      placementOverride: data.placementOverride,
      userId: user.id,
    });
    return this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        nodePoolId: data.nodePoolId ?? null,
        placementOverride: (data.placementOverride ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
      },
    });
  }

  async resolvePlacementForProject(projectId: string): Promise<{
    allowedNodes: string[] | null;
    deniedNodes: string[];
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    });
    if (!project) return { allowedNodes: null, deniedNodes: [] };
    const placement = await this.nodesService.getPlacementForOrg(project.organizationId);
    return { allowedNodes: placement.allowedNodes, deniedNodes: placement.deniedNodes };
  }

  assertNotComposeManaged(deployment: { composeStackId?: string | null } | null | undefined, action: string) {
    if (deployment?.composeStackId) {
      throw new BadRequestException(
        `This deployment is managed by a Compose file. ${action} via its parent compose stack.`,
      );
    }
  }

  formatLivePods(pods: any[] = []) {
    return pods.map((pod) => ({
      id: pod.name,
      name: pod.name,
      status: pod.status,
      ip: pod.podIp,
      podIp: pod.podIp,
      nodeName: pod.nodeName,
      restartCount: typeof pod.restartCount === 'number' ? pod.restartCount : 0,
      startTime: pod.createdAt,
      createdAt: pod.createdAt,
      cpuUsage: pod.cpuUsage ?? null,
      memoryUsage: pod.memoryUsage ?? null,
      containers:
        pod.containers?.map((container) => ({
          name: container.name,
          image: container.image,
          ready: container.ready ?? false,
          restartCount: typeof container.restartCount === 'number' ? container.restartCount : 0,
          lastTermination: container.lastTerminationReason
            ? {
                reason: container.lastTerminationReason,
                exitCode: container.lastExitCode ?? null,
                finishedAt: container.lastTerminatedAt ?? null,
              }
            : null,
        })) ?? [],
    }));
  }

  /**
   * Compute the runtime deployment status from Kubernetes state.
   * Possible values: 'running' | 'restarting' | 'scaling' | 'failed' | 'stopped' | 'unhealthy' | 'pending'
   */
  async computeDeploymentStatus(
    deployment: any,
    prefetched?: { pods: any[]; warnings: any[] },
  ): Promise<string> {
    if (deployment.replicas === 0) {
      return 'stopped';
    }

    if (!deployment.name || !deployment.namespace) {
      return deployment.status;
    }

    try {
      let pods: any[];
      let warnings: any[];
      if (prefetched) {
        pods = prefetched.pods ?? [];
        warnings = prefetched.warnings ?? [];
      } else {
        const livePods = await this.k8sWorkload.getDeploymentPods(
          deployment.name,
          deployment.namespace,
        );
        pods = this.formatLivePods(livePods?.pods) ?? [];
        warnings = livePods?.warnings || [];
      }

      const readyPods = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'ready') ?? [];
      const allPods = (pods ?? []).filter((pod: any) => pod.status?.toLowerCase() !== 'succeeded');
      const desiredReplicas = deployment.replicas || 1;

      if (allPods.length === 0) {
        return 'pending';
      }

      const hasBackOffWarning = warnings.some(warning =>
        warning.message?.toLowerCase().includes('back-off') ||
        warning.message?.toLowerCase().includes('backoff') ||
        warning.message?.toLowerCase().includes('crashloop')
      );

      const hasCrashingPods = allPods.some((pod: any) => {
        const restartCount = typeof pod.restartCount === 'number' ? pod.restartCount : 0;
        return (
          pod.status?.toLowerCase() === 'crashing' ||
          (restartCount > 5 && pod.status?.toLowerCase() !== 'ready')
        );
      });

      const hasAnyRestarts = allPods.some((pod: any) => {
        const restartCount = typeof pod.restartCount === 'number' ? pod.restartCount : 0;
        return restartCount > 0;
      });

      // No ready pods at all
      if (readyPods.length === 0) {
        if (hasBackOffWarning || hasCrashingPods) {
          return 'failed';
        }
        // Pods exist but none ready and no crash loops — starting up or restarting
        return hasAnyRestarts ? 'restarting' : 'pending';
      }

      // Some pods ready, some not
      if (readyPods.length < desiredReplicas) {
        if (hasBackOffWarning || hasCrashingPods) {
          return 'unhealthy';
        }
        // Pods cycling with restarts = rolling restart, otherwise scaling up
        return hasAnyRestarts ? 'restarting' : 'scaling';
      }

      // More total pods than desired = scaling down or rolling restart in progress
      if (allPods.length > desiredReplicas) {
        return hasAnyRestarts ? 'restarting' : 'scaling';
      }

      // All desired replicas are ready
      if (hasBackOffWarning) {
        return 'unhealthy';
      }

      return 'running';
    } catch (error) {
      console.error(
        `[ProjectsService] Failed to compute status for deployment ${deployment.id}:`,
        error instanceof Error ? error.message : error
      );
      return deployment.status;
    }
  }

  addInternalUrlsToServices(services: any[], namespace: string) {
    if (!Array.isArray(services) || !namespace) {
      return services;
    }

    return services.map((service) => {
      const serviceName = service.name;
      const ports = service.ports || [];
      
      const internalUrls = ports.map((port: any) => {
        const portNumber = port.port || service.port || 80;
        return `${serviceName}.${namespace}.svc.cluster.local:${portNumber}`;
      });

      return {
        ...service,
        internalUrl: internalUrls.length > 0 ? internalUrls[0] : `${serviceName}.${namespace}.svc.cluster.local:${service.port || 80}`,
        internalUrls: internalUrls.length > 0 ? internalUrls : [`${serviceName}.${namespace}.svc.cluster.local:${service.port || 80}`],
      };
    });
  }

  addInternalUrlsToDeployment(deployment: any) {
    if (!deployment) {
      return deployment;
    }

    const result = { ...deployment };

    if (result.namespace && result.services && Array.isArray(result.services)) {
      result.services = this.addInternalUrlsToServices(result.services, result.namespace);
    }

    if (result.ingresses && Array.isArray(result.ingresses)) {
      result.ingresses = result.ingresses.map((ing: any) => scrubIngress(ing));
    }

    return result;
  }

  normalizeServicePortInputs(
    ports?: {
      name?: string;
      containerPort?: number;
      servicePort?: number;
      protocol?: string;
      nodePort?: number;
    }[],
    options: { requireAtLeastOne?: boolean } = {}
  ) {
    const mapped: {
      name?: string;
      containerPort: number;
      servicePort: number;
      protocol: string;
      nodePort?: number;
    }[] = [];

    if (!Array.isArray(ports)) {
      if (options.requireAtLeastOne) {
        throw new BadRequestException('At least one valid port is required');
      }
      return mapped;
    }

    for (const entry of ports) {
      if (!entry) {
        continue;
      }

      const containerPort = Number(entry.containerPort ?? entry.servicePort ?? 0);
      const servicePort = Number(entry.servicePort ?? entry.containerPort ?? 0);

      if (!Number.isInteger(containerPort) || containerPort <= 0) {
        continue;
      }

      if (!Number.isInteger(servicePort) || servicePort <= 0) {
        continue;
      }

      const protocol =
        typeof entry.protocol === 'string' && entry.protocol.trim().length > 0
          ? entry.protocol.trim().toUpperCase()
          : 'TCP';

      const nodePortValue =
        entry.nodePort === undefined || entry.nodePort === null
          ? undefined
          : Number(entry.nodePort);

      const nodePort =
        nodePortValue !== undefined && Number.isInteger(nodePortValue) && nodePortValue > 0
          ? nodePortValue
          : undefined;

      const name =
        typeof entry.name === 'string' && entry.name.trim().length > 0
          ? entry.name.trim()
          : undefined;

      mapped.push({
        name,
        containerPort,
        servicePort,
        protocol,
        nodePort,
      });
    }

    if (mapped.length === 0 && options.requireAtLeastOne) {
      throw new BadRequestException('At least one valid port is required');
    }

    return mapped;
  }

  async updateDeploymentStrategy(
    deploymentId: string,
    strategy: 'rollingUpdate' | 'recreate',
    userId?: string,
  ) {
    if (strategy !== 'rollingUpdate' && strategy !== 'recreate') {
      throw new BadRequestException('Invalid deploy strategy');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { volumes: true },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertNotComposeManaged(deployment, 'Change deploy strategy');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(deployment.projectId, userId, 'change deploy strategy');
    }

    // PVC volumes pin the strategy to Recreate — ReadWriteOnce can't satisfy
    // a rolling cutover.
    const hasPvc = deployment.volumes.some((v) => v.type === 'pvc');
    if (hasPvc && strategy === 'rollingUpdate') {
      throw new BadRequestException(
        'This deployment has a PVC volume — rolling updates are not supported. Remove the PVC to switch back to rolling updates.',
      );
    }

    await this.k8sWorkload.updateDeploymentStrategy(
      deployment.name,
      deployment.namespace,
      strategy,
    );

    return this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { deployStrategy: strategy },
    });
  }

  async updateDeploymentImage(deploymentId: string, image: string, userId?: string) {
    const trimmed = (image ?? '').toString().trim();
    if (!trimmed) {
      throw new BadRequestException('Image cannot be empty');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertNotComposeManaged(deployment, 'Change the image');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(deployment.projectId, userId, 'change deployment image');
    }

    // Image-source deployments only — anything tied to a repo is rebuilt from
    // source by the GitHub flow, so a manual image change would just be
    // overwritten by the next build.
    if (deployment.githubRepo) {
      throw new BadRequestException(
        'This deployment is built from a GitHub repository. Use Redeploy to rebuild from source.',
      );
    }

    // updateDeploymentImage patches k8s AND writes deployment.image in Prisma.
    await this.k8sWorkload.updateDeploymentImage(
      deployment.name,
      deployment.namespace,
      trimmed,
    );

    return this.prisma.deployment.findUnique({ where: { id: deploymentId } });
  }

  async updateDeploymentResources(
    deploymentId: string,
    data: { cpuRequestMilli: number | null; memoryRequestBytes: number | null },
    userId?: string,
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertNotComposeManaged(deployment, 'Update resources');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(deployment.projectId, userId, 'update deployment resources');
    }

    // Unlimited mode: cpuRequestMilli === 0 means remove all resource constraints.
    const isUnlimited = data.cpuRequestMilli === 0 && data.memoryRequestBytes === 0;

    // Only push to K8s if the deployment exists in the cluster.
    const k8sExistsRes = await this.k8sWorkload.getKubernetesDeployment(
      deployment.name, deployment.namespace,
    ).then((d) => d !== null).catch(() => false);

    if (isUnlimited) {
      if (k8sExistsRes) {
        await this.k8sWorkload.removeDeploymentResources(
          deployment.namespace,
          deployment.name,
        );
      }
    } else {
      const resolved = await this.quotasService.resolvePodResources(deployment.projectId, {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes: data.memoryRequestBytes,
      }, deployment.image);

      // The deployment's current footprint is already counted in org/member
      // usage, so only the increase is additive — charging the full new
      // footprint would double-count the running pods. Previously-unlimited
      // deployments contribute nothing to counted usage, so their whole new
      // footprint is the increase.
      const wasUnlimited = deployment.cpuRequestMilli === 0 &&
        (deployment.memoryRequestBytes === null || deployment.memoryRequestBytes === BigInt(0));
      const current = wasUnlimited
        ? { cpuMilli: 0, memoryBytes: 0 }
        : await this.quotasService.resolvePodResources(deployment.projectId, {
            cpuRequestMilli: deployment.cpuRequestMilli,
            memoryRequestBytes:
              deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null,
          }, deployment.image);
      const replicasRes = deployment.replicas || 1;
      const increase = {
        cpuMilli: Math.max(0, (resolved.cpuMilli - current.cpuMilli) * replicasRes),
        memoryBytes: Math.max(0, (resolved.memoryBytes - current.memoryBytes) * replicasRes),
      };

      if (increase.cpuMilli > 0 || increase.memoryBytes > 0) {
        // Org-wide delta check.
        await this.quotasService.enforceOrgCapForNewPod(
          deployment.project.organizationId,
          increase,
        );
        // Per-user allowance check (charged to project owner).
        await this.quotasService.enforceMemberAllowanceForNewPod(
          deployment.project.organizationId,
          deployment.project.ownerId,
          increase,
        );
      }

      if (k8sExistsRes) {
        await this.k8sWorkload.updateDeploymentResources(
          deployment.namespace,
          deployment.name,
          resolved,
        );
      }
    }

    return this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
      },
    });
  }

  async createDeployment(
    projectId: string,
    data: {
      name: string;
      image: string;
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      templateInstanceId?: string;
      composeStackId?: string;
      composeServiceName?: string;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      environmentId?: string;
      nodePoolId?: string | null;
      placementOverride?: unknown;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectEdit(project.id, user.id, 'create deployments');

    // Resolve the target environment (explicit id or the project default).
    // The environment owns the namespace the resource deploys into.
    const environment = await this.environments.resolveEnvironment(project.id, data.environmentId);

    if (Array.isArray(data.volumes) && data.volumes.some((v) => v && v.type === 'hostPath')) {
      throw new ForbiddenException('hostPath volumes are not permitted');
    }

    const nameInput = String(data.name || '').trim();
    const image = String(data.image || '').trim();
    const replicas = data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;

    if (!nameInput) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!image) {
      throw new BadRequestException('Image is required');
    }

    const name = formatSlug(nameInput);

    if (!name) {
      throw new BadRequestException('Deployment name cannot be empty');
    }

    const existingDeployment = await this.prisma.deployment.findFirst({
      where: { environmentId: environment.id, name },
    });

    if (existingDeployment) {
      throw new BadRequestException('A deployment with this name already exists in this environment');
    }

    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
            secret: Boolean((entry as any).secret),
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }

    // Stored form keeps the literal ${{shared.KEY}} + secret flag.
    const env = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret,
    }));

    // Injected form resolves shared references against the environment's shared
    // vars (secrets — own or inherited — route to a k8s Secret downstream).
    const sharedVars = await this.loadSharedVarsForDeployment('', environment.id);
    const { resolved: resolvedEnv } = resolveEnvVars(env, sharedVars);

    const exposePublic = Boolean(data.exposePublic);

    const rawPorts = Array.isArray(data.ports) && data.ports.length > 0
      ? data.ports
      : [
          {
            name: 'http',
            containerPort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
            servicePort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
            protocol: 'TCP',
          },
        ];

    const volumes = Array.isArray(data.volumes) ? data.volumes : [];

    // Resolve per-pod resources (explicit override → org default → fallback).
    const podResources = await this.quotasService.resolvePodResources(project.id, {
      cpuRequestMilli: data.cpuRequestMilli ?? null,
      memoryRequestBytes: data.memoryRequestBytes ?? null,
    }, image);

    await this.quotasService.enforceOrgCapForNewPod(project.organizationId, {
      cpuMilli: podResources.cpuMilli * replicas,
      memoryBytes: podResources.memoryBytes * replicas,
    });
    await this.quotasService.enforceMemberAllowanceForNewPod(
      project.organizationId,
      project.ownerId,
      {
        cpuMilli: podResources.cpuMilli * replicas,
        memoryBytes: podResources.memoryBytes * replicas,
      },
    );
    // Make sure the namespace ResourceQuota/LimitRange reflect current caps.
    await this.quotasService.applyProjectQuota(project.id).catch((err) => {
      console.error('[Projects] applyProjectQuota failed:', err);
    });

    await this.nodesService.assertPoolAssignable({
      nodePoolId: data.nodePoolId,
      placementOverride: data.placementOverride,
      userId: user.id,
    });
    const placement = await this.resolvePlacementForProject(project.id);
    const pool = await this.nodesService.resolvePool(data.nodePoolId ?? null);
    const placementOverride = this.nodesService.toPlacementOverride(data.placementOverride ?? null);
    // PVC volumes force the Recreate update strategy on k8s; mirror that in
    // the DB so the UI shows the truth from the moment the deployment exists.
    const hasPvcOnCreate = (volumes ?? []).some((v) => v.type === 'pvc');
    const initialStrategy: 'rollingUpdate' | 'recreate' = hasPvcOnCreate ? 'recreate' : 'rollingUpdate';
    const deploymentResult = await this.k8sWorkload.createDeployment({
      namespace: environment.namespace,
      name,
      image,
      replicas,
      ports: rawPorts,
      env: resolvedEnv,
      serviceType: exposePublic ? 'NodePort' : 'ClusterIP',
      volumes,
      allowedNodes: placement.allowedNodes,
      deniedNodes: placement.deniedNodes,
      pool,
      placementOverride,
      resources: podResources,
      deployStrategy: initialStrategy,
    });

    let createdDeployment;
    try {
      createdDeployment = await this.prisma.$transaction(async (tx) => {
      const deployment = await tx.deployment.create({
        data: {
          projectId: project.id,
          environmentId: environment.id,
          name,
          namespace: environment.namespace,
          image,
          replicas,
          status: 'running',
          createdBy: user.id,
          templateInstanceId: data.templateInstanceId ?? null,
          composeStackId: data.composeStackId ?? null,
          composeServiceName: data.composeServiceName ?? null,
          deployStrategy: initialStrategy,
          nodePoolId: data.nodePoolId ?? null,
          placementOverride: (placementOverride ?? undefined) as Prisma.InputJsonValue | undefined,
          cpuRequestMilli: data.cpuRequestMilli ?? null,
          memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
        },
      });

      if (env.length > 0) {
        await tx.deploymentEnvVar.createMany({
          data: env.map((entry) => ({
            deploymentId: deployment.id,
            key: entry.key,
            value: entry.value,
            secret: entry.secret,
          })),
        });
      }

      if (volumes.length > 0) {
        await tx.deploymentVolume.createMany({
          data: volumes.map((vol) => {
            let volType: 'pvc' | 'hostPath' | 'emptyDir' = 'emptyDir';
            if (vol.type === 'pvc') volType = 'pvc';
            else if (vol.type === 'hostPath') volType = 'hostPath';
            return {
              deploymentId: deployment.id,
              name: vol.name.trim(),
              type: volType,
              mountPath: vol.mountPath.trim(),
              pvcName: vol.type === 'pvc' ? (vol.pvcName?.trim() || vol.name.trim()) : null,
              storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
              hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
              readOnly: Boolean(vol.readOnly),
            };
          }),
        });
      }

      const normalizedPorts = deploymentResult.ports || [];
      const primaryPort = normalizedPorts[0] || {
        name: 'http',
        containerPort: 80,
        servicePort: 80,
        protocol: 'TCP',
        nodePort: null,
      };
      const primaryNodePort =
        primaryPort.nodePort !== undefined && primaryPort.nodePort !== null
          ? primaryPort.nodePort
          : null;

      const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;
      const externalIp = deploymentResult.externalIp || null;

      const service = await tx.service.create({
        data: {
          deploymentId: deployment.id,
          name,
          type: serviceType,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          externalIp,
          nodePort: primaryNodePort,
        },
      });

      if (normalizedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: normalizedPorts.map((portEntry) => ({
            serviceId: service.id,
            name: portEntry.name,
            port: portEntry.servicePort,
            targetPort: portEntry.containerPort,
            protocol: portEntry.protocol,
            nodePort:
              portEntry.nodePort !== undefined && portEntry.nodePort !== null
                ? portEntry.nodePort
                : null,
          })),
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          pods: true,
          services: {
            include: {
              ports: true,
            },
          },
          envVars: true,
          volumes: true,
          ingresses: {
            include: {
              service: true,
            },
          },
          project: {
            include: {
              organization: true,
            },
          },
        },
      });
      });
    } catch (e) {
      try { await this.k8sWorkload.deleteDeployment(name, environment.namespace); } catch { /* ignore */ }
      try { await this.k8sNetwork.deleteService(environment.namespace, name); } catch { /* ignore */ }
      throw e;
    }

    if (createdDeployment) {
      void this.audit.log({
        action: 'deployment.created',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: project.organizationId,
        projectId: project.id,
        deploymentId: createdDeployment.id,
        targetType: 'deployment',
        targetId: createdDeployment.id,
        targetLabel: createdDeployment.name,
        metadata: { image, replicas, source: 'image' },
      });
    }

    return this.addInternalUrlsToDeployment(createdDeployment);
  }

  async createDeploymentFromGitHub(
    projectId: string,
    data: {
      name: string;
      repoUrl?: string;
      githubRepo?: string;
      branch?: string;
      dockerfilePath?: string;
      target?: string;
      tag?: string;
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      persistentBuildCache?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      composeStackId?: string;
      composeServiceName?: string;
      autoDeployEnabled?: boolean;
      autoDeployBranch?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectEdit(project.id, user.id, 'create deployments');

    const environment = await this.environments.resolveEnvironment(project.id, (data as any).environmentId);

    if (Array.isArray(data.volumes) && data.volumes.some((v) => v && v.type === 'hostPath')) {
      throw new ForbiddenException('hostPath volumes are not permitted');
    }

    if ((data.buildWithDepot || data.persistentBuildCache) && !(await this.authz.isSuperAdmin(user.id))) {
      throw new ForbiddenException('Super builds and persistent build cache are superadmin-only settings');
    }

    const nameInput = String(data.name || '').trim();
    const replicas = data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;
    let repoUrl = String(data.repoUrl || data['githubRepo'] || '').trim();
    // Accept owner/repo shorthand and convert to full URL
    if (repoUrl && !repoUrl.startsWith('http')) {
      repoUrl = `https://github.com/${repoUrl}`;
    }
    repoUrl = repoUrl.replace(/\.git$/, '');
    const branch = String(data.branch || 'main').trim();
    const dockerfilePath = String(data.dockerfilePath || '').trim();
    const tag = data.tag ? String(data.tag).trim() : 'latest';
    const buildType = data.buildType === 'railpack' ? 'railpack' : 'dockerfile';

    // Validate refs and paths at the boundary. The same checks are
    // enforced again inside DockerService.cloneRepository as defence in
    // depth — see isSafeGitRef / isSafeRelativePath there.
    const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;
    if (branch.length > 200 || branch.startsWith('-') || branch.includes('..') || !GIT_REF_RE.test(branch)) {
      throw new BadRequestException('Invalid branch name');
    }
    if (tag.length > 200 || tag.startsWith('-') || tag.includes('..') || !GIT_REF_RE.test(tag)) {
      throw new BadRequestException('Invalid tag');
    }
    if (dockerfilePath) {
      if (
        dockerfilePath.length > 500 ||
        dockerfilePath.startsWith('/') ||
        dockerfilePath.startsWith('\\') ||
        dockerfilePath.includes('..') ||
        dockerfilePath.includes('\0') ||
        !/^[A-Za-z0-9._/\- ]+$/.test(dockerfilePath)
      ) {
        throw new BadRequestException('Invalid Dockerfile path');
      }
    }

    if (!nameInput) {
      throw new BadRequestException('Deployment name is required');
    }

    if (!repoUrl) {
      throw new BadRequestException('Repository URL is required');
    }

    if (!branch) {
      throw new BadRequestException('Branch is required');
    }

    // Verify the requesting user can actually access this repo on GitHub.
    const parsed = this.githubService.parseRepoUrl(repoUrl);
    if (!parsed) {
      throw new BadRequestException('Could not parse repository URL');
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, parsed.owner, parsed.repo);
    if (!canAccess) {
      // If the user can't access via their token, check if the repo is public
      const isPublic = await this.githubService.isRepoPublic(parsed.owner, parsed.repo);
      if (!isPublic) {
        throw new ForbiddenException(
          'You do not have access to this repository on GitHub. Connect your GitHub account or request access to the repo.'
        );
      }
    }

    // Bind the deployment to the specific GitHub App installation that owns
    // the repo. Auto-deploy webhooks will refuse to fire unless the incoming
    // installation id matches this one, preventing impersonation by another
    // installation with a colliding repo full_name.
    // For public repos without the app installed, installationId will be null
    // (auto-deploy won't work, but manual builds can clone without auth).
    const repoInstallation = await this.githubService.findInstallationForRepo(parsed.owner, parsed.repo);

    // Dockerfile path is only required for dockerfile builds
    if (buildType === 'dockerfile' && !dockerfilePath) {
      throw new BadRequestException('Dockerfile path is required for Dockerfile builds');
    }

    const name = formatSlug(nameInput);

    if (!name) {
      throw new BadRequestException('Deployment name cannot be empty');
    }

    const existingDeployment = await this.prisma.deployment.findFirst({
      where: { environmentId: environment.id, name },
    });

    if (existingDeployment) {
      throw new BadRequestException('A deployment with this name already exists in this environment');
    }

    const imageName = `${project.namespace}-${name}`;
    
    // Generate unique tag based on timestamp
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
    const uniqueTag = `v${timestamp}`;
    
    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
            secret: Boolean((entry as any).secret),
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }

    // Stored form keeps the literal ${{shared.KEY}} + secret flag.
    const env = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret,
    }));

    // Injected form resolves shared references against the environment's shared
    // vars (secrets — own or inherited — route to a k8s Secret downstream).
    const sharedVars = await this.loadSharedVarsForDeployment('', environment.id);
    const { resolved: resolvedEnv } = resolveEnvVars(env, sharedVars);

    const exposePublic = Boolean(data.exposePublic);

    // Auto-detect port from Dockerfile EXPOSE directive if no port specified
    let detectedPort: number | null = null;
    const hasExplicitPort = (data.port && Number.isInteger(data.port) && data.port > 0) ||
      (Array.isArray(data.ports) && data.ports.length > 0);

    if (!hasExplicitPort && repoUrl && dockerfilePath) {
      try {
        const repoInfo = this.githubService.parseRepoUrl(repoUrl);
        const userToken = repoInfo ? await this.githubService.getValidUserToken(user.id) : null;
        if (repoInfo && userToken) {
          const dockerfileContent = await this.githubService.getFileContent(
            userToken,
            repoInfo.owner,
            repoInfo.repo,
            dockerfilePath,
            branch,
          );
          detectedPort = this.githubService.parseExposedPort(dockerfileContent);
          if (detectedPort) {
            console.log(`[Projects] Auto-detected EXPOSE port ${detectedPort} from ${dockerfilePath}`);
          }
        }
      } catch (error) {
        console.warn(`[Projects] Failed to auto-detect port from Dockerfile:`, error.message);
      }
    }

    const defaultPort = detectedPort || 80;

    const rawPorts = Array.isArray(data.ports) && data.ports.length > 0
      ? data.ports
      : [
          {
            name: 'http',
            containerPort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : defaultPort,
            servicePort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : defaultPort,
            protocol: 'TCP',
          },
        ];

    // Create deployment record with buildStatus='building' and status='pending'
    const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name,
        namespace: environment.namespace,
        image: `${this.dockerService.getImagePath(imageName, uniqueTag)}`, // Placeholder, will be updated
        replicas,
        status: 'pending',
        buildStatus: 'building',
        buildType,
        githubRepo: repoUrl,
        githubBranch: branch,
        githubInstallationId: repoInstallation?.installationId ?? null,
        dockerfilePath: buildType === 'dockerfile' ? dockerfilePath : null,
        buildFromRoot: data.buildFromRoot ?? false,
        buildWithDepot: data.buildWithDepot ?? false,
        persistentBuildCache: data.persistentBuildCache ?? false,
        // Only meaningful for Railpack builds; null everywhere means "detect".
        rootDirectory: buildType === 'railpack' ? normalizeRootDirectory(data.rootDirectory) : null,
        framework: data.framework?.trim() || null,
        installCommand: data.installCommand?.trim() || null,
        buildCommand: data.buildCommand?.trim() || null,
        startCommand: data.startCommand?.trim() || null,
        outputDirectory: data.outputDirectory?.trim() || null,
        createdBy: user.id,
        buildLogs: `[INFO] Starting ${buildMethodLabel} build for ${repoUrl}@${branch}\n`,
        buildStepTimestamps: { __start: Date.now() },
        cpuRequestMilli: data.cpuRequestMilli ?? null,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
        composeStackId: data.composeStackId ?? null,
        composeServiceName: data.composeServiceName ?? null,
        // Auto-deploy defaults ON when the GitHub App installation covers the
        // repo (push webhooks can actually fire); without one the toggle
        // would be dead weight, so it stays off unless explicitly requested.
        autoDeployEnabled: data.autoDeployEnabled ?? repoInstallation != null,
        autoDeployBranch: data.autoDeployBranch ?? null,
      },
    });

    // Add environment variables
    if (env.length > 0) {
      await this.prisma.deploymentEnvVar.createMany({
        data: env.map((entry) => ({
          deploymentId: deployment.id,
          key: entry.key,
          value: entry.value,
          secret: entry.secret,
        })),
      });
    }

    // Add volumes
    const volumes = Array.isArray(data.volumes) ? data.volumes : [];
    if (volumes.length > 0) {
      await this.prisma.deploymentVolume.createMany({
        data: volumes.map((vol) => {
          let volType: 'pvc' | 'hostPath' | 'emptyDir' = 'emptyDir';
          if (vol.type === 'pvc') volType = 'pvc';
          else if (vol.type === 'hostPath') volType = 'hostPath';
          return {
            deploymentId: deployment.id,
            name: vol.name.trim(),
            type: volType,
            mountPath: vol.mountPath.trim(),
            pvcName: vol.type === 'pvc' ? (vol.pvcName?.trim() || vol.name.trim()) : null,
            storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
            hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
            readOnly: Boolean(vol.readOnly),
          };
        }),
      });
    }

    // Persist ports/service config upfront so they survive build failures.
    // The actual K8s Service is created after a successful build, but the DB
    // records are needed so rebuilds and the UI can read the port config back.
    if (rawPorts.length > 0) {
      const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;
      const primaryPort = rawPorts[0];
      const service = await this.prisma.service.create({
        data: {
          deploymentId: deployment.id,
          name,
          type: serviceType,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol || 'TCP',
          externalIp: null,
          nodePort: null,
        },
      });

      await this.prisma.servicePort.createMany({
        data: rawPorts.map((portEntry) => ({
          serviceId: service.id,
          name: portEntry.name,
          port: portEntry.servicePort,
          targetPort: portEntry.containerPort,
          protocol: portEntry.protocol || 'TCP',
          nodePort: null,
        })),
      });
    }

    console.log(`[Projects] Created deployment record ${deployment.id}, starting async build`);

    await this.buildQueue
      .recordActiveBuild({
        deploymentId: deployment.id,
        triggerType: 'initial',
        branch,
        triggeredById: user.id,
      })
      .catch((err) => this.logger.warn(`recordActiveBuild failed for ${deployment.id}: ${err?.message ?? err}`));

    void this.audit.log({
      action: 'deployment.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId: project.id,
      deploymentId: deployment.id,
      targetType: 'deployment',
      targetId: deployment.id,
      targetLabel: deployment.name,
      metadata: { source: 'github', repoUrl, branch, buildType },
    });

    // Start build process asynchronously - don't await!
    this.buildAndDeployAsync(
      deployment.id,
      {
        repoUrl,
        branch,
        dockerfilePath,
        target: data.target,
        buildFromRoot: data.buildFromRoot,
        buildWithDepot: data.buildWithDepot,
        persistentBuildCache: data.persistentBuildCache,
        buildType,
        imageName,
        tag: uniqueTag,
        namespace: environment.namespace,
        name,
        replicas,
        rawPorts,
        env: resolvedEnv,
        exposePublic,
        volumes,
        isRebuild: false,
        triggerType: 'manual',
        triggeredById: user.id,
      },
      await this.githubService.getValidUserToken(user.id),
    ).catch((error) => {
      console.error(`[Projects] Async build failed for deployment ${deployment.id}:`, error);
    });

    // Return deployment immediately so frontend can poll for logs
    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  /**
   * Record-only creation for "orchard up": the deployment exists (name, build
   * config, env, service/port rows) but nothing builds until a context tarball
   * is uploaded. Gated on the private build-context bucket being configured.
   */
  async createDeploymentFromLocal(
    projectId: string,
    data: {
      name: string;
      buildType?: 'dockerfile' | 'railpack';
      dockerfilePath?: string;
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
      port?: number;
      ports?: { name?: string; containerPort?: number; servicePort?: number; protocol?: string }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      environmentId?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
  ) {
    if (!this.storage.buildContextEnabled()) {
      throw new BadRequestException('Local deploys are disabled on this server (set LOCAL_DEPLOYS_ENABLED=true and configure R2_BUILD_CONTEXT_BUCKET)');
    }

    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectEdit(project.id, user.id, 'create deployments');
    const environment = await this.environments.resolveEnvironment(project.id, data.environmentId);

    const nameInput = String(data.name || '').trim();
    if (!nameInput) {
      throw new BadRequestException('Deployment name is required');
    }
    const name = formatSlug(nameInput);
    if (!name) {
      throw new BadRequestException('Deployment name cannot be empty');
    }

    const buildType = data.buildType === 'railpack' ? 'railpack' : 'dockerfile';
    const dockerfilePath = String(data.dockerfilePath || '').trim();
    if (buildType === 'dockerfile' && !dockerfilePath) {
      throw new BadRequestException('Dockerfile path is required for Dockerfile builds');
    }
    if (dockerfilePath) {
      if (
        dockerfilePath.length > 500 ||
        dockerfilePath.startsWith('/') ||
        dockerfilePath.startsWith('\\') ||
        dockerfilePath.includes('..') ||
        dockerfilePath.includes('\0') ||
        !/^[A-Za-z0-9._/\- ]+$/.test(dockerfilePath)
      ) {
        throw new BadRequestException('Invalid Dockerfile path');
      }
    }

    const existingDeployment = await this.prisma.deployment.findFirst({
      where: { environmentId: environment.id, name },
    });
    if (existingDeployment) {
      throw new BadRequestException('A deployment with this name already exists in this environment');
    }

    const replicas = data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;

    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
            secret: Boolean((entry as any).secret),
          }))
          .filter((entry) => entry.key.length > 0)
      : [];
    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }
    const env = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret,
    }));

    const rawPorts = Array.isArray(data.ports) && data.ports.length > 0
      ? data.ports
      : [
          {
            name: 'http',
            containerPort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
            servicePort: data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
            protocol: 'TCP',
          },
        ];

    const imageName = `${project.namespace}-${name}`;
    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name,
        namespace: environment.namespace,
        image: `${this.dockerService.getImagePath(imageName, 'pending')}`,
        replicas,
        status: 'pending',
        buildStatus: 'none',
        buildType,
        dockerfilePath: buildType === 'dockerfile' ? dockerfilePath : null,
        rootDirectory: buildType === 'railpack' ? normalizeRootDirectory(data.rootDirectory) : null,
        framework: data.framework?.trim() || null,
        installCommand: data.installCommand?.trim() || null,
        buildCommand: data.buildCommand?.trim() || null,
        startCommand: data.startCommand?.trim() || null,
        outputDirectory: data.outputDirectory?.trim() || null,
        createdBy: user.id,
        buildLogs: `[INFO] Created local deployment ${name}; waiting for a build context upload (orchard up)\n`,
        cpuRequestMilli: data.cpuRequestMilli ?? null,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
      },
    });

    if (env.length > 0) {
      await this.prisma.deploymentEnvVar.createMany({
        data: env.map((entry) => ({
          deploymentId: deployment.id,
          key: entry.key,
          value: entry.value,
          secret: entry.secret,
        })),
      });
    }

    const service = await this.prisma.service.create({
      data: {
        deploymentId: deployment.id,
        name,
        type: ServiceType.internal,
        port: rawPorts[0].servicePort,
        targetPort: rawPorts[0].containerPort,
        protocol: rawPorts[0].protocol || 'TCP',
        externalIp: null,
        nodePort: null,
      },
    });
    await this.prisma.servicePort.createMany({
      data: rawPorts.map((portEntry) => ({
        serviceId: service.id,
        name: portEntry.name,
        port: portEntry.servicePort,
        targetPort: portEntry.containerPort,
        protocol: portEntry.protocol || 'TCP',
        nodePort: null,
      })),
    });

    void this.audit.log({
      action: 'deployment.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId: project.id,
      deploymentId: deployment.id,
      targetType: 'deployment',
      targetId: deployment.id,
      targetLabel: deployment.name,
      metadata: { source: 'local', buildType },
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: { include: { ports: true } },
        envVars: true,
        ingresses: { include: { service: true } },
        project: { include: { organization: true } },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  /**
   * Store an uploaded build-context tarball in the private bucket and kick
   * off the standard in-cluster build with it. Replaces (and deletes) the
   * previous context so each deployment holds at most one object.
   */
  async uploadBuildContextAndBuild(
    deploymentId: string,
    file: { buffer: Buffer; size: number },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
  ) {
    if (!this.storage.buildContextEnabled()) {
      throw new BadRequestException('Local deploys are disabled on this server (set LOCAL_DEPLOYS_ENABLED=true and configure R2_BUILD_CONTEXT_BUCKET)');
    }

    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: { include: { organization: true } },
        services: { include: { ports: true } },
        volumes: true,
      },
    });
    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.projectId, user.id, 'deploy from a local build context');

    if (deployment.githubRepo) {
      throw new BadRequestException('This deployment builds from GitHub; push to the repository instead');
    }
    if (!file?.buffer?.length) {
      throw new BadRequestException('Build context is empty');
    }
    if (file.size > 100 * 1024 * 1024) {
      throw new BadRequestException('Build context exceeds the 100MB limit');
    }
    if (file.buffer[0] !== 0x1f || file.buffer[1] !== 0x8b) {
      throw new BadRequestException('Build context must be a gzipped tarball');
    }

    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const key = `build-contexts/${deployment.project.organizationId}/${deployment.id}/${randomUUID()}.tar.gz`;
    await this.storage.putBuildContext(key, file.buffer);
    const previousKey = deployment.buildContextKey;

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
    const uniqueTag = `v${timestamp}`;
    const imageName = `${deployment.project.namespace}-${deployment.name}`;
    const buildMethodLabel = deployment.buildType === 'railpack' ? 'Railpack' : 'Dockerfile';

    await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        buildContextKey: key,
        buildContextSha: sha,
        status: 'pending',
        buildStatus: 'building',
        buildError: null,
        buildLogs: `[INFO] Starting ${buildMethodLabel} build from uploaded context (${(file.size / 1024 / 1024).toFixed(1)}MB, sha256 ${sha.slice(0, 12)})\n`,
        buildStepTimestamps: { __start: Date.now() },
      },
    });

    if (previousKey && previousKey !== key) {
      this.storage.deleteBuildContext(previousKey).catch(() => {});
    }

    await this.buildQueue
      .recordActiveBuild({
        deploymentId: deployment.id,
        triggerType: 'manual',
        branch: 'local',
        triggeredById: user.id,
      })
      .catch((err) => this.logger.warn(`recordActiveBuild failed for ${deployment.id}: ${err?.message ?? err}`));

    const targetService = deployment.services?.[0];
    const rawPorts = targetService?.ports?.length
      ? targetService.ports.map((p) => ({
          name: p.name ?? undefined,
          containerPort: p.targetPort,
          servicePort: p.port,
          protocol: p.protocol,
        }))
      : [{ name: 'http', containerPort: 80, servicePort: 80, protocol: 'TCP' }];

    const storedEnv = await this.prisma.deploymentEnvVar.findMany({
      where: { deploymentId: deployment.id },
    });
    const sharedVars = await this.loadSharedVarsForDeployment('', deployment.environmentId);
    const { resolved: resolvedEnv } = resolveEnvVars(
      storedEnv.map((e) => ({ key: e.key, value: e.value, secret: e.secret })),
      sharedVars,
    );

    const volumes = (deployment.volumes ?? []).map((vol) => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName ?? undefined,
      storageSize: vol.storageSize ?? undefined,
      hostPath: vol.hostPath ?? undefined,
      readOnly: vol.readOnly,
    }));

    this.buildAndDeployAsync(
      deployment.id,
      {
        repoUrl: '',
        localContextKey: key,
        branch: 'local',
        dockerfilePath: deployment.dockerfilePath ?? undefined,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env: resolvedEnv,
        exposePublic: targetService?.type === ServiceType.external,
        volumes,
        isRebuild: Boolean(previousKey),
        triggerType: 'manual',
        triggeredById: user.id,
      },
      null,
    ).catch((error) => {
      console.error(`[Projects] Async local build failed for deployment ${deployment.id}:`, error);
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: { include: { ports: true } },
        envVars: true,
        ingresses: { include: { service: true } },
        project: { include: { organization: true } },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  private async getDeploymentProgressUrl(deploymentId: string): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { project: { select: { organization: { select: { slug: true } } } } },
    });
    const orgSlug = deployment?.project?.organization?.slug;
    return orgSlug
      ? `${frontendUrl}/${orgSlug}/deployments/${deploymentId}/progress`
      : `${frontendUrl}/deployments/${deploymentId}/progress`;
  }

  /**
   * Give a Railpack deployment a start command when it has none and we know it.
   *
   * Railpack does not fail when it cannot work out how to start an app — it
   * warns, and buildkit bakes `CMD ["/bin/bash"]` into the image
   * (convert.go:65), which exits 0 the moment it starts and then
   * CrashLoopBackOffs without ever writing a log line. The builder now passes
   * --error-missing-start so that becomes a build failure instead of a silent
   * one, but failing a build we could have completed is no kind of fix: for
   * the frameworks detection recognises, the answer is already known, and a
   * deployment created before detection knew it should not have to be
   * repaired by hand.
   *
   * The command is written to the deployment rather than passed into this one
   * build, so it lands in the build settings as an ordinary editable value
   * instead of materialising out of nowhere on every build. Every failure here
   * is swallowed: this is an improvement to a build, never a precondition for
   * one.
   */
  private async backfillRailpackStartCommand(
    deploymentId: string,
    repoUrl: string,
    branch: string,
    accessToken: string | null | undefined,
  ) {
    if (!accessToken) return;

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { startCommand: true, outputDirectory: true, rootDirectory: true },
      });
      if (!deployment) return;
      // Already answered — by the user, by detection at create time, or by an
      // earlier backfill.
      if (deployment.startCommand) return;
      // A static site is served by Caddy, which supplies its own start command.
      if (deployment.outputDirectory) return;

      const repo = this.githubService.parseRepoUrl(repoUrl);
      if (!repo) return;

      const apps = await this.githubService.detectRepoApps(
        accessToken, repo.owner, repo.repo, branch,
      );
      const app = apps.find((a) => a.dir === (deployment.rootDirectory ?? ''));
      if (!app?.startCommand) return;

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { startCommand: app.startCommand },
      });

      const note = `[${Date.now()}] [WARNING] Railpack cannot detect a start command for a ${app.framework} app, so this build uses \`${app.startCommand}\`. Change it in the deployment's build settings.`;
      await this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || ${`${note}\n`}
        WHERE "id" = ${deploymentId}::uuid
      `.catch(() => {});
    } catch (error) {
      console.warn(`[Projects] Start command backfill failed for ${deploymentId}:`, error.message);
    }
  }

  async buildAndDeployAsync(
    deploymentId: string,
    data: {
      repoUrl: string;
      branch: string;
      dockerfilePath?: string;
      target?: string;
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      persistentBuildCache?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      imageName: string;
      tag: string;
      namespace: string;
      name: string;
      replicas: number;
      rawPorts: any[];
      env: any[];
      exposePublic: boolean;
      volumes?: any[];
      isRebuild?: boolean;
      // GitHub Deployments API support (legacy)
      commitSha?: string;
      commitMessage?: string;
      commitAuthorName?: string;
      commitAuthorUsername?: string;
      githubDeploymentId?: number | null;
      githubAccessToken?: string | null;
      repoInfo?: { owner: string; repo: string } | null;
      // GitHub Checks API support (new - via App)
      checkRunId?: number | null;
      checkLogUrl?: string | null;
      installationId?: string | null;
      // Build trigger info
      triggerType?: string;
      triggeredById?: string;
      // Local-upload builds: R2 key of the uploaded context tarball. A
      // presigned GET is minted just before job creation.
      localContextKey?: string;
    },
    githubAccessToken?: string,
  ) {
    console.log(`[Projects] Starting buildAndDeployAsync for deployment ${deploymentId}`);

    // One Datadog APM trace per build (service: orchard-builds) — duration,
    // start time, outcome, and user-vs-system failure classification.
    const buildTrace = startBuildTrace({
      deploymentId,
      deploymentName: data.name,
      namespace: data.namespace,
      repoUrl: data.repoUrl,
      branch: data.branch,
      commitSha: data.commitSha,
      buildType: data.buildType,
      triggerType: data.triggerType,
      triggeredById: data.triggeredById,
      isRebuild: data.isRebuild,
    });

    try {
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
    } catch (error) {
      console.warn(`[Projects] Failed to cancel existing build jobs:`, error);
    }

    // Build logs never leave Orchard: check run output only carries the
    // current step and a link. On public repos the check output is visible
    // to everyone, and build logs can leak submodule URLs, file listings,
    // and whatever the build prints.
    let logUpdateInterval: NodeJS.Timeout | null = null;
    let lastStep: string | null = null;

    if (data.checkRunId && data.installationId && data.repoInfo) {
      logUpdateInterval = setInterval(async () => {
        try {
          const currentDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildStep: true },
          });

          const step = currentDeployment?.buildStep ?? null;
          if (step === lastStep) return;
          lastStep = step;

          const stepLabels: Record<string, string> = {
            cloning: 'Scheduling builder...',
            building: 'Building image...',
            pushing: 'Pushing to registry...',
            deploying: 'Deploying to cluster...',
          };
          const stepLabel = stepLabels[step ?? ''] || 'Building...';

          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'in_progress',
              output: {
                title: stepLabel,
                summary: `Deploying \`${data.name}\` from commit \`${data.commitSha?.substring(0, 7) || 'unknown'}\``,
                text: data.checkLogUrl ? `[View the full build log in Orchard](${data.checkLogUrl})` : 'Open the deployment in Orchard to view the full build log.',
              },
            }
          );
        } catch (err) {
          console.error(`[Projects] Failed to update check run step: ${err.message}`);
        }
      }, 10000);
    }

    try {
      const buildTypeLabel = data.buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
      console.log(`[Projects] Building image from GitHub using ${buildTypeLabel}: ${data.repoUrl}@${data.branch} -> ${data.imageName}:${data.tag}${data.target ? ` (target: ${data.target})` : ''}`, {
        deploymentId,
        dockerfilePath: data.dockerfilePath,
        buildFromRoot: data.buildFromRoot,
        hasAccessToken: !!githubAccessToken,
        isRebuild: data.isRebuild,
      });

      // Before the builder reads the deployment row, not after: docker.service
      // assembles the RAILPACK_* overrides from that row on every trigger
      // (loadBuildEnv), so writing the start command here is all it takes for
      // this build to use it.
      if (data.buildType === 'railpack' && !data.localContextKey) {
        await this.backfillRailpackStartCommand(
          deploymentId,
          data.repoUrl,
          data.branch,
          githubAccessToken ?? data.githubAccessToken,
        );
      }

      const buildStartTime = Date.now();

      let localContextUrl: string | undefined;
      if (data.localContextKey) {
        localContextUrl = await this.storage.signBuildContextGet(data.localContextKey, 15 * 60);
      }

      const image = await buildTrace.activate(() => this.dockerService.buildAndPushFromGitHub({
        repoUrl: data.repoUrl,
        localContextUrl,
        branch: data.branch,
        dockerfilePath: data.dockerfilePath || 'Dockerfile',
        target: data.target,
        buildFromRoot: data.buildFromRoot,
        buildWithDepot: data.buildWithDepot,
        persistentBuildCache: data.persistentBuildCache,
        buildType: data.buildType,
        imageName: data.imageName,
        tag: data.tag,
        deploymentId,
        accessToken: githubAccessToken,
        // Scope this build's slice of the shared buildkit-cache PVC to the
        // project namespace. Kata's mount surface ⇒ the build VM only sees
        // this directory and can't reach other tenants' cache entries.
        cacheTenantKey: data.namespace,
      }));

      const buildCompletedAt = new Date();
      const buildDuration = Math.floor((buildCompletedAt.getTime() - buildStartTime) / 1000);
      console.log(`[Projects] Built and pushed image: ${image}, ${data.isRebuild ? 'updating' : 'creating'} Kubernetes resources (build took ${buildDuration}s)`);

      const [, k8sDeploymentExists] = await Promise.all([
        (async () => {
          const tsData = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildStepTimestamps: true },
          });
          const ts = (tsData?.buildStepTimestamps as Record<string, any> | null) || {};
          ts['deploying'] = Date.now();
          await this.prisma.deployment.update({
            where: { id: deploymentId },
            data: { image, buildStep: 'deploying', buildStepTimestamps: ts },
          });
        })(),
        this.k8sWorkload.getKubernetesDeployment(
          data.name, data.namespace,
        ).then((d) => d !== null).catch(() => false),
      ]);

      this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || '[INFO] Creating Kubernetes deployment...\n'
        WHERE "id" = ${deploymentId}::uuid
      `.catch(() => {});

      const imageHistoryPromise = this.prisma.$transaction(async (tx) => {
        await tx.imageHistory.updateMany({
          where: { deploymentId, isActive: true },
          data: { isActive: false },
        });

        const deployment = await tx.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildLogs: true },
        });

        await tx.imageHistory.create({
          data: {
            deploymentId,
            image,
            tag: data.tag,
            commitSha: data.commitSha || null,
            commitMessage: data.commitMessage || null,
            commitAuthorName: data.commitAuthorName || null,
            commitAuthorUsername: data.commitAuthorUsername || null,
            branch: data.branch,
            buildLogs: deployment?.buildLogs || null,
            buildStartedAt: new Date(buildStartTime),
            buildCompletedAt,
            triggerType: data.triggerType || null,
            triggeredById: data.triggeredById || null,
            isActive: true,
          },
        });

        const allImages = await tx.imageHistory.findMany({
          where: { deploymentId },
          orderBy: { createdAt: 'desc' },
          select: { id: true, image: true },
        });

        if (allImages.length > 10) {
          const imagesToRemove = allImages.slice(10);
          const idsToRemove = imagesToRemove.map((img) => img.id);

          await tx.imageHistory.deleteMany({
            where: { id: { in: idsToRemove } },
          });

          const imageRefs = imagesToRemove.map((img) => img.image);
          this.dockerService.deleteArtifactsFromRegistry(imageRefs).catch((err) => {
            console.error(`[Projects] Failed to delete old artifacts from registry:`, err);
          });
        }
      }).catch((err) => {
        console.error('[Projects] Image history save failed:', err);
      });

      let deploymentResult: any;
      let shouldCreateNew = false;

      if (data.isRebuild && k8sDeploymentExists) {
        await this.k8sWorkload.updateDeploymentImage(
          data.name,
          data.namespace,
          image,
        );

        const desiredReplicas = data.replicas || 1;
        const k8sDeploy = await this.k8sWorkload.getKubernetesDeployment(data.name, data.namespace);
        if (k8sDeploy && k8sDeploy.status.replicas !== desiredReplicas) {
          await this.k8sWorkload.patchDeploymentReplicas(data.name, data.namespace, desiredReplicas);
        }

        // Image-only rebuild keeps the existing spec, so re-apply the stored
        // env to heal deployments whose pod spec drifted from the config —
        // every removal made before env updates replaced (rather than merged)
        // the container's env list is still sitting on the live object.
        const rebuildDeployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { environmentId: true },
        });
        const { resolved: rebuildEnv } = await this.loadResolvedEnvForDeployment(
          deploymentId,
          rebuildDeployment?.environmentId ?? null,
        );
        await this.k8sWorkload.updateDeploymentEnv({
          namespace: data.namespace,
          deploymentName: data.name,
          env: rebuildEnv,
        }).catch((err) => {
          console.error('[Projects] re-applying env on rebuild failed:', err.message);
        });

        // Same reasoning for probes: heal deployments whose health checks were
        // dropped from the live spec.
        const hc = await this.loadHealthCheckOptions(deploymentId);
        if (hc) {
          await this.k8sWorkload.updateDeploymentHealthCheck({
            namespace: data.namespace,
            deploymentName: data.name,
            enabled: hc.enabled,
            type: hc.type,
            path: hc.path,
            port: hc.port,
            command: hc.command,
            livenessEnabled: hc.livenessEnabled,
            readinessEnabled: hc.readinessEnabled,
            startupEnabled: hc.startupEnabled,
            interval: hc.interval,
            timeout: hc.timeout,
            retries: hc.retries,
            startupFailureThreshold: hc.startupFailureThreshold,
          }).catch((err) => {
            console.error('[Projects] re-applying health check on rebuild failed:', err.message);
          });
        }

        const existingDeploymentDb = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          include: { services: { include: { ports: true } } },
        });
        deploymentResult = {
          ports: existingDeploymentDb?.services[0]?.ports || [],
          externalIp: existingDeploymentDb?.services[0]?.externalIp || null,
        };

        const deploymentRow = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { projectId: true, cpuRequestMilli: true, memoryRequestBytes: true },
        });
        if (deploymentRow) {
          const isUnlimitedDeploy = deploymentRow.cpuRequestMilli === 0 &&
            (deploymentRow.memoryRequestBytes === BigInt(0) || deploymentRow.memoryRequestBytes === null);
          if (!isUnlimitedDeploy) {
            this.quotasService.applyProjectQuota(deploymentRow.projectId).catch((err) => {
              console.error('[Projects] applyProjectQuota failed:', err);
            });
          }
        }
      } else {
        const deploymentRow = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: {
            id: true,
            image: true,
            projectId: true,
            replicas: true,
            cpuRequestMilli: true,
            memoryRequestBytes: true,
            deployStrategy: true,
            nodePoolId: true,
            placementOverride: true,
            project: { select: { organizationId: true, ownerId: true } },
          },
        });
        const buildStrategy: 'rollingUpdate' | 'recreate' =
          (deploymentRow?.deployStrategy as 'rollingUpdate' | 'recreate') ?? 'rollingUpdate';
        const deployPlacement = deploymentRow
          ? await this.resolvePlacementForProject(deploymentRow.projectId)
          : { allowedNodes: null as string[] | null, deniedNodes: [] as string[] };
        const deployPool = await this.nodesService.resolvePool(deploymentRow?.nodePoolId ?? null);
        const deployOverride = this.nodesService.toPlacementOverride(
          deploymentRow?.placementOverride ?? null,
        );

        let rebuildResources: { cpuMilli: number; memoryBytes: number } | undefined;
        const isUnlimitedDeploy = deploymentRow?.cpuRequestMilli === 0 &&
          (deploymentRow?.memoryRequestBytes === BigInt(0) || deploymentRow?.memoryRequestBytes === null);
        if (deploymentRow && !isUnlimitedDeploy) {
          rebuildResources = await this.quotasService.resolvePodResources(deploymentRow.projectId, {
            cpuRequestMilli: deploymentRow.cpuRequestMilli,
            memoryRequestBytes: deploymentRow.memoryRequestBytes ? Number(deploymentRow.memoryRequestBytes) : null,
          }, deploymentRow.image);
          if (!k8sDeploymentExists) {
            await this.quotasService.enforceOrgCapForNewPod(deploymentRow.project.organizationId, {
              cpuMilli: rebuildResources.cpuMilli * (deploymentRow.replicas || 1),
              memoryBytes: rebuildResources.memoryBytes * (deploymentRow.replicas || 1),
            });
            await this.quotasService.enforceMemberAllowanceForNewPod(
              deploymentRow.project.organizationId,
              deploymentRow.project.ownerId,
              {
                cpuMilli: rebuildResources.cpuMilli * (deploymentRow.replicas || 1),
                memoryBytes: rebuildResources.memoryBytes * (deploymentRow.replicas || 1),
              },
              deploymentRow.id,
            );
          }
          await this.quotasService.applyProjectQuota(deploymentRow.projectId).catch((err) => {
            console.error('[Projects] applyProjectQuota failed:', err);
          });
        }

        shouldCreateNew = !data.isRebuild || !k8sDeploymentExists;
        if (data.isRebuild && !k8sDeploymentExists) {
          const existingDeploymentDb = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { services: { include: { ports: true } } },
          });
          const hasServices = existingDeploymentDb?.services && existingDeploymentDb.services.length > 0;
          if (!hasServices) {
            shouldCreateNew = true;
          }
        }

        if (shouldCreateNew) {
          const healthCheck = await this.loadHealthCheckOptions(deploymentId);
          deploymentResult = await this.k8sWorkload.createDeployment({
            namespace: data.namespace,
            name: data.name,
            image,
            replicas: data.replicas,
            ports: data.rawPorts,
            env: data.env,
            serviceType: data.exposePublic ? 'NodePort' : 'ClusterIP',
            volumes: data.volumes || [],
            allowedNodes: deployPlacement.allowedNodes,
            deniedNodes: deployPlacement.deniedNodes,
            pool: deployPool,
            placementOverride: deployOverride,
            resources: rebuildResources,
            deployStrategy: buildStrategy,
            healthCheck,
          });
        } else {
          await this.k8sWorkload.updateDeploymentImage(
            data.name,
            data.namespace,
            image,
          );
          const existingDeploymentDb = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { services: { include: { ports: true } } },
          });
          deploymentResult = {
            ports: existingDeploymentDb?.services[0]?.ports || [],
            externalIp: existingDeploymentDb?.services[0]?.externalIp || null,
          };
        }
      }

      await imageHistoryPromise;

      if (!data.isRebuild || shouldCreateNew) {
        // Update service records with K8s-assigned values (nodePort, externalIp)
        // or create them if they don't exist yet.
        await this.prisma.$transaction(async (tx) => {
          const existingDeployment = await tx.deployment.findUnique({
            where: { id: deploymentId },
            include: { services: { include: { ports: true } } },
          });

          const hasServices = existingDeployment?.services && existingDeployment.services.length > 0;

          if (hasServices) {
            // Services were created upfront — update with K8s-assigned values
            const normalizedPorts = deploymentResult.ports || [];
            const existingService = existingDeployment!.services[0];
            const primaryPort = normalizedPorts[0];
            const primaryNodePort = primaryPort?.nodePort ?? null;
            const externalIp = deploymentResult.externalIp || null;

            await tx.service.update({
              where: { id: existingService.id },
              data: {
                nodePort: primaryNodePort,
                externalIp,
              },
            });

            // Update each port with its K8s-assigned nodePort
            for (const existingPort of existingService.ports) {
              const matchingPort = normalizedPorts.find(
                (p) => p.containerPort === existingPort.targetPort && p.protocol === existingPort.protocol
              );
              if (matchingPort?.nodePort) {
                await tx.servicePort.update({
                  where: { id: existingPort.id },
                  data: { nodePort: matchingPort.nodePort },
                });
              }
            }
          } else {
            // No services exist — create them (legacy path for old deployments)
            const normalizedPorts = deploymentResult.ports || [];
            const primaryPort = normalizedPorts[0] || {
              name: 'http',
              containerPort: 80,
              servicePort: 80,
              protocol: 'TCP',
              nodePort: null,
            };
            const primaryNodePort =
              primaryPort.nodePort !== undefined && primaryPort.nodePort !== null
                ? primaryPort.nodePort
                : null;

            const serviceType = data.exposePublic ? ServiceType.external : ServiceType.internal;
            const externalIp = deploymentResult.externalIp || null;

            const service = await tx.service.create({
              data: {
                deploymentId,
                name: data.name,
                type: serviceType,
                port: primaryPort.servicePort,
                targetPort: primaryPort.containerPort,
                protocol: primaryPort.protocol,
                externalIp,
                nodePort: primaryNodePort,
              },
            });

            if (normalizedPorts.length > 0) {
              await tx.servicePort.createMany({
                data: normalizedPorts.map((portEntry) => ({
                  serviceId: service.id,
                  name: portEntry.name,
                  port: portEntry.servicePort,
                  targetPort: portEntry.containerPort,
                  protocol: portEntry.protocol,
                  nodePort:
                    portEntry.nodePort !== undefined && portEntry.nodePort !== null
                      ? portEntry.nodePort
                      : null,
                })),
              });
            }
          }

          // Update deployment status to success
          const txDeployData = await tx.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true, buildStepTimestamps: true } });
          const txTimestamps = (txDeployData?.buildStepTimestamps as Record<string, number> | null) || {};
          txTimestamps['complete'] = Date.now();
          await tx.deployment.update({
            where: { id: deploymentId },
            data: {
              status: 'running',
              buildStatus: 'succeeded',
              buildStep: 'complete',
              buildLogs: `${txDeployData?.buildLogs || ''  }\nDeployment is live.`,
              buildStepTimestamps: txTimestamps,
            },
          });
        });
      } else {
        // For rebuilds where deployment already existed, just update the status
        const rebuildData = await this.prisma.deployment.findUnique({ where: { id: deploymentId }, select: { buildLogs: true, buildStepTimestamps: true } });
        const rebuildTimestamps = (rebuildData?.buildStepTimestamps as Record<string, number> | null) || {};
        rebuildTimestamps['complete'] = Date.now();
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'running',
            buildStatus: 'succeeded',
            buildStep: 'complete',
            buildLogs: `${rebuildData?.buildLogs || ''  }\nRebuild complete. Deployment is live.`,
            buildStepTimestamps: rebuildTimestamps,
          },
        });
      }

      console.log(`[Projects] Deployment ${deploymentId} completed successfully`);

      this.notifications
        .notifyDeploy(deploymentId, 'succeeded')
        .catch((err) => this.logger.warn(`deploy notification failed for ${deploymentId}: ${err?.message ?? err}`));

      this.buildQueue.onBuildFinished(deploymentId).catch((err) =>
        this.logger.warn(`build queue release failed for ${deploymentId}: ${err?.message ?? err}`),
      );

      // Update GitHub deployment status to success
      if (data.githubDeploymentId && data.repoInfo && data.githubAccessToken) {
        try {

          // Get the environment URL from ingresses if available
          const deploymentWithIngress = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { ingresses: true },
          });
          const environmentUrl = deploymentWithIngress?.ingresses?.[0]?.host
            ? `https://${deploymentWithIngress.ingresses[0].host}`
            : undefined;

          await this.githubService.updateDeploymentStatus(
            data.githubAccessToken,
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.githubDeploymentId,
            'success',
            {
              logUrl: await this.getDeploymentProgressUrl(deploymentId),
              environmentUrl,
              description: 'Deployment successful!',
            }
          );

          // Update our record
          await this.prisma.gitHubDeployment.updateMany({
            where: {
              deploymentId,
              githubDeploymentId: BigInt(data.githubDeploymentId),
            },
            data: {
              status: 'success',
              environmentUrl,
            },
          });
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub deployment status: ${err.message}`);
        }
      }

      // Clear the log update interval
      if (logUpdateInterval) {
        clearInterval(logUpdateInterval);
        logUpdateInterval = null;
      }

      // Update GitHub Check Run to success (via App)
      if (data.checkRunId && data.installationId && data.repoInfo) {
        try {
          const finalDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { ingresses: { select: { host: true } } },
          });

          const environmentUrl = finalDeployment?.ingresses?.[0]?.host
            ? `https://${finalDeployment.ingresses[0].host}`
            : undefined;

          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'completed',
              conclusion: 'success',
              output: {
                title: 'Deployment Successful',
                summary: environmentUrl
                  ? `\`${data.name}\` is live at [${environmentUrl}](${environmentUrl}).`
                  : `\`${data.name}\` deployed successfully.`,
                text: data.checkLogUrl ? `[View the full build log in Orchard](${data.checkLogUrl})` : 'Open the deployment in Orchard to view the full build log.',
              },
            }
          );

          console.log(`[Projects] Updated GitHub check run ${data.checkRunId} to success`);
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub check run: ${err.message}`);
        }
      }

      // Update GitHub Deployment to success (via App)
      if (data.installationId && data.repoInfo) {
        try {
          // Find the GitHub deployment we created
          const ghDeployment = await this.prisma.gitHubDeployment.findFirst({
            where: { deploymentId, status: 'in_progress' },
            orderBy: { createdAt: 'desc' },
          });

          if (ghDeployment) {
            const finalDeploymentData = await this.prisma.deployment.findUnique({
              where: { id: deploymentId },
              include: { ingresses: true },
            });
            const environmentUrl = finalDeploymentData?.ingresses?.[0]?.host
              ? `https://${finalDeploymentData.ingresses[0].host}`
              : undefined;

            await this.githubService.updateDeploymentStatusWithApp(
              BigInt(data.installationId),
              data.repoInfo.owner,
              data.repoInfo.repo,
              Number(ghDeployment.githubDeploymentId),
              'success',
              {
                logUrl: await this.getDeploymentProgressUrl(deploymentId),
                environmentUrl,
                description: 'Deployment successful!',
              }
            );

            await this.prisma.gitHubDeployment.update({
              where: { id: ghDeployment.id },
              data: { status: 'success', environmentUrl },
            });

            console.log(`[Projects] Updated GitHub deployment ${ghDeployment.githubDeploymentId} to success`);
          }
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub deployment: ${err.message}`);
        }
      }

      buildTrace.finishSuccess({ 'build.image_seconds': buildDuration });
    } catch (error) {
      if (logUpdateInterval) {
        clearInterval(logUpdateInterval);
        logUpdateInterval = null;
      }

      const errorDetails = {
        deploymentId,
        imageName: data.imageName,
        tag: data.tag,
        repoUrl: data.repoUrl,
        branch: data.branch,
        buildType: data.buildType,
        errorMessage: error.message,
        errorType: error.constructor.name,
        errorStack: error.stack,
        statusCode: error.statusCode || error.status,
        response: error.response,
        isRebuild: data.isRebuild,
      };

      console.error(`[Projects] Build failed for deployment ${deploymentId}:`, errorDetails);

      try {
        const currentDeployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildLogs: true, buildStep: true, status: true, buildStatus: true },
        });

        buildTrace.finishFailure(error, currentDeployment?.buildStep ?? undefined);

        // Don't overwrite a successful build status from a newer build
        if (currentDeployment?.buildStatus === 'succeeded') {
          console.log(`[Projects] Deployment ${deploymentId} already has a succeeded build (likely from a newer build), skipping error status update`);
          return;
        }

        const errorLogEntry = `\n❌ Build failed at step '${currentDeployment?.buildStep || 'unknown'}'\nError: ${error.message}\nError Type: ${error.constructor.name}\n`;

        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            buildStatus: 'failed',
            buildError: error.message,
            buildLogs: (currentDeployment?.buildLogs || '') + errorLogEntry,
          },
        });

        this.buildQueue.onBuildFinished(deploymentId).catch((relErr) =>
          this.logger.warn(`build queue release failed for ${deploymentId}: ${relErr?.message ?? relErr}`),
        );
      } catch (dbErr) {
        buildTrace.finishFailure(error); // no-op if already finished above
        console.error(`[Projects] Failed to update error status in database:`, {
          deploymentId,
          dbError: dbErr.message,
          originalError: error.message,
        });
      }

      // Update GitHub deployment status to failure (legacy - user token)
      if (data.githubDeploymentId && data.repoInfo && data.githubAccessToken) {
        try {
          await this.githubService.updateDeploymentStatus(
            data.githubAccessToken,
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.githubDeploymentId,
            'failure',
            {
              logUrl: await this.getDeploymentProgressUrl(deploymentId),
              description: `Build failed: ${error.message?.substring(0, 100)}`,
            }
          );

          // Update our record
          await this.prisma.gitHubDeployment.updateMany({
            where: {
              deploymentId,
              githubDeploymentId: BigInt(data.githubDeploymentId),
            },
            data: {
              status: 'failure',
            },
          });
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub deployment status: ${ghErr.message}`);
        }
      }

      // Update GitHub Deployment to failure (via App)
      if (data.installationId && data.repoInfo) {
        try {
          const ghDeployment = await this.prisma.gitHubDeployment.findFirst({
            where: { deploymentId, status: 'in_progress' },
            orderBy: { createdAt: 'desc' },
          });

          if (ghDeployment) {
            await this.githubService.updateDeploymentStatusWithApp(
              BigInt(data.installationId),
              data.repoInfo.owner,
              data.repoInfo.repo,
              Number(ghDeployment.githubDeploymentId),
              'failure',
              {
                logUrl: await this.getDeploymentProgressUrl(deploymentId),
                description: `Build failed: ${error.message?.substring(0, 100)}`,
              }
            );

            await this.prisma.gitHubDeployment.update({
              where: { id: ghDeployment.id },
              data: { status: 'failure' },
            });

            console.log(`[Projects] Updated GitHub deployment ${ghDeployment.githubDeploymentId} to failure`);
          }
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub deployment: ${ghErr.message}`);
        }
      }

      // Update GitHub Check Run to failure (via App)
      if (data.checkRunId && data.installationId && data.repoInfo) {
        try {
          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'completed',
              conclusion: 'failure',
              output: {
                title: 'Deployment Failed',
                summary: `❌ Failed to deploy \`${data.name}\`: ${error.message?.substring(0, 200) || 'Unknown error'}`,
                text: data.checkLogUrl ? `[View the full build log in Orchard](${data.checkLogUrl})` : 'Open the deployment in Orchard to view the full build log.',
              },
            }
          );

          console.log(`[Projects] Updated GitHub check run ${data.checkRunId} to failure`);
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub check run: ${ghErr.message}`);
        }
      }
    }
  }

  async rebuildFromQueue(deploymentId: string, triggeredById: string | null, runId: string) {
    const user = triggeredById ? await this.usersService.findById(triggeredById) : null;
    if (!user) {
      throw new NotFoundException('Triggering user for queued rebuild not found');
    }
    return this.rebuildDeployment(deploymentId, user.externalAuthId ?? user.id, undefined, runId);
  }

  async rebuildDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    fromQueueRunId?: string,
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
        envVars: true,
        volumes: true,
        services: {
          include: {
            ports: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo || !deployment.githubBranch) {
      throw new BadRequestException('This deployment was not created from GitHub');
    }

    // For dockerfile builds, dockerfilePath is required
    if (deployment.buildType === 'dockerfile' && !deployment.dockerfilePath) {
      throw new BadRequestException('Dockerfile path is missing for this deployment');
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'rebuild deployments');

    if (!fromQueueRunId) {
      const { startNow } = await this.buildQueue.enqueue({
        deploymentId,
        triggerType: 'manual',
        branch: deployment.githubBranch,
        triggeredById: user.id,
      });
      if (!startNow) {
        console.log(`[Projects] Queued manual rebuild for ${deploymentId}`);
        return this.getDeployment(deploymentId, true, user.id);
      }
    }

    console.log(`[Projects] Cancelling any existing build jobs for deployment ${deploymentId}`);
    try {
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
    } catch (error) {
      console.error(`[Projects] Error cancelling existing build jobs:`, error);
    }

    // Reset build status to building
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'building',
        buildStep: null,
        buildStepTimestamps: { __start: Date.now() },
        buildLogs: `🔄 Rebuilding deployment from ${deployment.githubRepo}@${deployment.githubBranch}\n`,
        buildError: null,
      },
    });

    // Extract image name from current image
    const imageParts = deployment.image?.split('/') || [];
    const imageNameWithTag = imageParts[imageParts.length - 1] || `${deployment.project.namespace}-${deployment.name}`;
    const [imageName] = imageNameWithTag.split(':');

    // Generate unique tag based on timestamp
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14);
    const uniqueTag = `v${timestamp}`;

    // Get service configuration
    const service = deployment.services[0];
    const rawPorts = service?.ports.map(port => ({
      name: port.name,
      containerPort: port.targetPort,
      servicePort: port.port,
      protocol: port.protocol,
      nodePort: port.nodePort || undefined,
    })) || [];

    const { resolved: env } = resolveEnvVars(
      deployment.envVars.map((ev) => ({ key: ev.key, value: ev.value, secret: ev.secret })),
      await this.loadSharedVarsForDeployment(deployment.id, deployment.environmentId),
    );

    const volumes = (deployment.volumes || []).map(vol => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName || undefined,
      storageSize: vol.storageSize || undefined,
      hostPath: vol.hostPath || undefined,
      readOnly: vol.readOnly,
    }));

    // Start rebuild process asynchronously
    this.buildAndDeployAsync(
      deploymentId,
      {
        repoUrl: deployment.githubRepo,
        branch: deployment.githubBranch,
        dockerfilePath: deployment.dockerfilePath,
        buildFromRoot: deployment.buildFromRoot ?? false,
        buildWithDepot: deployment.buildWithDepot ?? false,
        persistentBuildCache: deployment.persistentBuildCache ?? false,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env,
        exposePublic: service?.type === 'external',
        volumes,
        isRebuild: true,
        triggerType: 'manual',
        triggeredById: user.id,
      },
      await this.githubService.getValidUserToken(user.id),
    ).catch((error) => {
      console.error(`[Projects] Rebuild failed for deployment ${deploymentId}:`, error);
    });

    void this.audit.log({
      action: 'deployment.redeployed',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { repo: deployment.githubRepo, branch: deployment.githubBranch, tag: uniqueTag },
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async getImageHistory(deploymentId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    return this.prisma.imageHistory.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getImageHistoryLogs(deploymentId: string, imageHistoryId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    const entry = await this.prisma.imageHistory.findUnique({
      where: { id: imageHistoryId },
      select: { deploymentId: true, buildLogs: true },
    });

    if (!entry || entry.deploymentId !== deploymentId) {
      throw new NotFoundException(`Image history entry not found`);
    }

    return { logs: entry.buildLogs || '' };
  }

  async rollbackToImage(
    deploymentId: string,
    imageHistoryId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'rollback deployments');

    const imageHistory = await this.prisma.imageHistory.findUnique({
      where: { id: imageHistoryId },
    });

    if (!imageHistory || imageHistory.deploymentId !== deploymentId) {
      throw new NotFoundException('Image history not found');
    }

    // Update Kubernetes deployment with the old image
    await this.k8sWorkload.updateDeploymentImage(
      deployment.name,
      deployment.namespace,
      imageHistory.image,
    );

    // Update database
    await this.prisma.$transaction(async (tx) => {
      // Mark all images as inactive
      await tx.imageHistory.updateMany({
        where: { deploymentId },
        data: { isActive: false },
      });

      // Mark this image as active
      await tx.imageHistory.update({
        where: { id: imageHistoryId },
        data: { isActive: true },
      });

      // Update deployment
      await tx.deployment.update({
        where: { id: deploymentId },
        data: {
          image: imageHistory.image,
          status: 'running',
        },
      });
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true,
          },
        },
        envVars: true,
        ingresses: {
          include: {
            service: true,
          },
        },
        project: {
          include: {
            organization: true,
          },
        },
      },
    });

    void this.audit.log({
      action: 'deployment.rolled_back',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { image: [deployment.image, imageHistory.image] },
    });

    return this.addInternalUrlsToDeployment(result);
  }

}
