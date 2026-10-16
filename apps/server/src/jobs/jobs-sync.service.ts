import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { LeaderElectionService } from '../events/leader-election.service';
import {
  JobsOrchestratorService,
  RunContext,
  LABEL_JOB_ID,
  runEnvSecretName,
  runScriptsConfigMapName
} from './jobs-orchestrator.service';
import { JobConsumer, jobTerminalOutcome } from '../engine/consumers/job.consumer';
import { RUN_ACTIVE_STATUSES } from './jobs.service';

const SWEEP_INTERVAL_MS = 60_000;
const NEVER_STARTED_GRACE_MS = 10 * 60 * 1000;
const MISSING_JOB_GRACE_MS = 10 * 60 * 1000;
const QUOTA_CHECK_AGE_MS = 2 * 60 * 1000;

@Injectable()
export class JobsSyncService {
  private readonly logger = new Logger(JobsSyncService.name);

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly leader: LeaderElectionService,
    private readonly orchestrator: JobsOrchestratorService,
    private readonly informer: JobConsumer
  ) {}

  private batchApi() {
    this.kubernetes.ensureKubeConfig();
    return this.kubernetes.kc!.makeApiClient(k8s.BatchV1Api);
  }

  private coreApi() {
    this.kubernetes.ensureKubeConfig();
    return this.kubernetes.kc!.makeApiClient(k8s.CoreV1Api);
  }

  @Interval(SWEEP_INTERVAL_MS)
  async sweep() {
    if (!this.leader.isLeader()) return;
    if (this.ticking) return;
    if (!this.kubernetes.kc) return;
    this.ticking = true;
    try {
      await this.reconcileActiveRuns();
      await this.adoptUnmappedJobs();
      await this.resyncCronJobs();
      await this.gcFinished();
    } catch (err) {
      this.logger.warn(`jobs sweep failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileActiveRuns() {
    const runs = await this.prisma.jobRun.findMany({
      where: { status: { in: [...RUN_ACTIVE_STATUSES] } },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        job: {
          select: {
            id: true,
            runTimeoutSeconds: true,
            project: { select: { id: true, namespace: true, organizationId: true } }
          }
        }
      }
    });

    const batch = this.batchApi();
    const now = Date.now();

    for (const run of runs) {
      const ctx: RunContext = {
        jobId: run.job.id,
        projectId: run.job.project.id,
        organizationId: run.job.project.organizationId,
        namespace: run.job.project.namespace
      };

      const startedAt = run.startedAt ?? run.createdAt;
      if (now - startedAt.getTime() > run.job.runTimeoutSeconds * 1000) {
        this.logger.warn(
          `Run ${run.id} exceeded ${run.job.runTimeoutSeconds}s wall clock; timing out`
        );
        for (const step of run.steps) {
          if (step.status === 'running' && step.k8sJobName) {
            await this.orchestrator.deleteK8sJob(ctx.namespace, step.k8sJobName);
          }
        }
        await this.prisma.jobRunStep.updateMany({
          where: { runId: run.id, status: { in: ['pending', 'running'] } },
          data: { status: 'skipped', finishedAt: new Date() }
        });
        await this.orchestrator.finishRun(
          ctx,
          run.id,
          'timed_out',
          'Run exceeded its total timeout'
        );
        continue;
      }

      const current = run.steps.find((s) => s.status === 'running');
      if (!current) {
        if (now - run.createdAt.getTime() > NEVER_STARTED_GRACE_MS) {
          await this.prisma.jobRunStep.updateMany({
            where: { runId: run.id, status: 'pending' },
            data: { status: 'skipped' }
          });
          await this.orchestrator.finishRun(ctx, run.id, 'failed', 'Run never started');
        }
        continue;
      }
      if (!current.k8sJobName) continue;

      let k8sJob: k8s.V1Job | null = null;
      try {
        const res = await batch.readNamespacedJob(current.k8sJobName, ctx.namespace);
        k8sJob = res.body;
      } catch (err: any) {
        const code = err?.statusCode ?? err?.response?.statusCode;
        if (code !== 404) {
          this.logger.warn(`readNamespacedJob(${current.k8sJobName}) failed: ${err?.message}`);
          continue;
        }
      }

      if (!k8sJob) {
        const stepStarted = current.startedAt ?? run.createdAt;
        if (now - stepStarted.getTime() > MISSING_JOB_GRACE_MS) {
          await this.prisma.jobRunStep.updateMany({
            where: {
              runId: run.id,
              stepOrder: current.stepOrder,
              status: { in: ['pending', 'running'] }
            },
            data: {
              status: 'failed',
              reason: 'JobMissing (logs unavailable)',
              finishedAt: new Date()
            }
          });
          await this.prisma.jobRunStep.updateMany({
            where: { runId: run.id, stepOrder: { gt: current.stepOrder }, status: 'pending' },
            data: { status: 'skipped' }
          });
          await this.orchestrator.finishRun(
            ctx,
            run.id,
            'failed',
            `Step ${current.stepOrder}: Kubernetes job disappeared before completion`,
            current.stepOrder
          );
        }
        continue;
      }

      const outcome = jobTerminalOutcome(k8sJob);
      if (outcome.terminal) {
        await this.orchestrator.handleStepTerminal(
          ctx,
          run.id,
          current.stepOrder,
          { succeeded: outcome.succeeded, reason: outcome.reason },
          k8sJob
        );
        continue;
      }

      const jobAge = k8sJob.metadata?.creationTimestamp
        ? now - new Date(k8sJob.metadata.creationTimestamp).getTime()
        : 0;
      const activePods = k8sJob.status?.active ?? 0;
      const anyProgress = (k8sJob.status?.succeeded ?? 0) + (k8sJob.status?.failed ?? 0);
      if (jobAge > QUOTA_CHECK_AGE_MS && activePods === 0 && anyProgress === 0) {
        const failure = await this.findCreateFailure(ctx.namespace, current.k8sJobName);
        if (failure) {
          await this.orchestrator.deleteK8sJob(ctx.namespace, current.k8sJobName);
          await this.prisma.jobRunStep.updateMany({
            where: {
              runId: run.id,
              stepOrder: current.stepOrder,
              status: { in: ['pending', 'running'] }
            },
            data: { status: 'failed', reason: 'QuotaExceeded', finishedAt: new Date() }
          });
          await this.prisma.jobRunStep.updateMany({
            where: { runId: run.id, stepOrder: { gt: current.stepOrder }, status: 'pending' },
            data: { status: 'skipped' }
          });
          await this.orchestrator.finishRun(ctx, run.id, 'failed', failure, current.stepOrder);
        }
      }
    }
  }

  private async findCreateFailure(namespace: string, jobName: string): Promise<string | null> {
    try {
      const events = await this.coreApi().listNamespacedEvent(
        namespace,
        undefined,
        undefined,
        undefined,
        `involvedObject.name=${jobName},involvedObject.kind=Job,reason=FailedCreate`
      );
      const item = (events.body.items ?? []).find((e) =>
        /exceeded quota|forbidden/i.test(e.message ?? '')
      );
      return item?.message ? `Pod creation failed: ${item.message.slice(0, 500)}` : null;
    } catch {
      return null;
    }
  }

  private async adoptUnmappedJobs() {
    const batch = this.batchApi();
    let items: k8s.V1Job[] = [];
    try {
      const res = await batch.listJobForAllNamespaces(
        undefined,
        undefined,
        undefined,
        LABEL_JOB_ID
      );
      items = res.body.items ?? [];
    } catch (err: any) {
      this.logger.warn(`listJobForAllNamespaces failed: ${err?.message}`);
      return;
    }

    for (const item of items) {
      const uid = item.metadata?.uid;
      if (!uid) continue;
      const mapped = await this.prisma.jobRunStep.findUnique({
        where: { k8sJobUid: uid },
        select: { id: true }
      });
      if (mapped) continue;

      const jobId = item.metadata?.labels?.[LABEL_JOB_ID];
      const jobExists = jobId
        ? await this.prisma.job.findUnique({ where: { id: jobId }, select: { id: true } })
        : null;
      if (!jobExists) {
        if (item.metadata?.name && item.metadata.namespace) {
          await this.orchestrator.deleteK8sJob(item.metadata.namespace, item.metadata.name);
        }
        continue;
      }

      await this.informer
        .processJob('update', item)
        .catch((err) => this.logger.warn(`adopt processJob failed: ${err?.message}`));
    }
  }

  private async resyncCronJobs() {
    const jobs = await this.prisma.job.findMany({
      where: { OR: [{ scheduleCron: { not: null } }, { cronJobName: { not: null } }] },
      select: { id: true }
    });
    for (const job of jobs) {
      await this.orchestrator
        .syncCronJob(job.id)
        .catch((err) => this.logger.warn(`resync cronjob ${job.id} failed: ${err?.message}`));
    }
  }

  private async gcFinished() {
    const batch = this.batchApi();
    const core = this.coreApi();
    let items: k8s.V1Job[] = [];
    try {
      const res = await batch.listJobForAllNamespaces(
        undefined,
        undefined,
        undefined,
        LABEL_JOB_ID
      );
      items = res.body.items ?? [];
    } catch {
      return;
    }

    for (const item of items) {
      const uid = item.metadata?.uid;
      const name = item.metadata?.name;
      const namespace = item.metadata?.namespace;
      if (!uid || !name || !namespace) continue;
      if (!jobTerminalOutcome(item).terminal) continue;

      const step = await this.prisma.jobRunStep.findUnique({
        where: { k8sJobUid: uid },
        select: {
          status: true,
          run: { select: { id: true, status: true } }
        }
      });
      if (!step) continue;
      if (RUN_ACTIVE_STATUSES.includes(step.run.status as any)) continue;
      if (['pending', 'running'].includes(step.status)) continue;

      await this.orchestrator.deleteK8sJob(namespace, name);
      await core
        .deleteNamespacedConfigMap(runScriptsConfigMapName(step.run.id), namespace)
        .catch(() => {});
      await core.deleteNamespacedSecret(runEnvSecretName(step.run.id), namespace).catch(() => {});
    }
  }
}
