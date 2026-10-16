import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { LiveState, readLive } from './live-object';
import {
  JobsOrchestratorService,
  RunContext,
  LABEL_JOB_ID,
  LABEL_RUN_ID,
  LABEL_STEP_ORDER
} from '../../jobs/jobs-orchestrator.service';
import { EngineEventType, EngineRefs } from '../core/informer';

export function jobTerminalOutcome(job: k8s.V1Job): {
  terminal: boolean;
  succeeded: boolean;
  reason: string | null;
} {
  const conditions = job.status?.conditions ?? [];
  const complete = conditions.find((c) => c.type === 'Complete' && c.status === 'True');
  if (complete) return { terminal: true, succeeded: true, reason: null };
  const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
  if (failed) return { terminal: true, succeeded: false, reason: failed.reason ?? 'Failed' };
  return { terminal: false, succeeded: false, reason: null };
}

@Injectable()
export class JobConsumer {
  private readonly logger = new Logger(JobConsumer.name);

  private readonly processing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: JobsOrchestratorService,
    private readonly kubernetes: KubernetesService
  ) {}

  protected liveJob(namespace: string, name: string): Promise<LiveState> {
    return readLive(this.kubernetes, this.logger, (kc) =>
      kc.makeApiClient(k8s.BatchV1Api).readNamespacedJob(name, namespace)
    );
  }

  async mapRefs(job: k8s.V1Job): Promise<EngineRefs> {
    const jobId = job.metadata?.labels?.[LABEL_JOB_ID];
    return jobId ? { jobId } : {};
  }

  async onEvent(type: EngineEventType, job: k8s.V1Job): Promise<void> {
    const uid = job.metadata?.uid;
    if (!uid || this.processing.has(uid)) return;
    if (type === 'delete' && job.metadata?.namespace && job.metadata?.name) {
      const state = await this.liveJob(job.metadata.namespace, job.metadata.name);
      if (state === 'present') return;
      if (state === 'unknown') {
        throw new Error(
          `job ${job.metadata.namespace}/${job.metadata.name} looks deleted but the apiserver could not confirm it`
        );
      }
    }
    this.processing.add(uid);
    try {
      await this.processJob(type === 'add' ? 'update' : type, job);
    } catch (err) {
      // Logged for context and then rethrown: the informer keeps the object's
      // derived_version behind its resourceVersion so the next pass retries the
      // run rather than assuming it was recorded.
      this.logger.warn(
        `processJob(${job.metadata?.namespace}/${job.metadata?.name}) failed: ${(err as Error)?.message ?? err}`
      );
      throw err;
    } finally {
      this.processing.delete(uid);
    }
  }

  async processJob(type: 'add' | 'update' | 'delete', job: k8s.V1Job): Promise<void> {
    const uid = job.metadata?.uid;
    const jobId = job.metadata?.labels?.[LABEL_JOB_ID];
    const runId = job.metadata?.labels?.[LABEL_RUN_ID];
    if (!uid || !jobId) return;

    if (type === 'delete') {
      await this.onK8sJobDeleted(uid);
      return;
    }

    if (!runId) {
      const known = await this.prisma.jobRunStep.findUnique({
        where: { k8sJobUid: uid },
        select: { id: true }
      });
      if (!known) {
        await this.orchestrator.materializeCronRun(job);
      }
    }

    const outcome = jobTerminalOutcome(job);
    if (!outcome.terminal) return;

    const mapping = await this.resolveRunStep(uid, runId ?? null, job);
    if (!mapping) return;

    await this.orchestrator.handleStepTerminal(
      mapping.ctx,
      mapping.runId,
      mapping.stepOrder,
      { succeeded: outcome.succeeded, reason: outcome.reason },
      job
    );
  }

  private async resolveRunStep(
    uid: string,
    labeledRunId: string | null,
    job: k8s.V1Job
  ): Promise<{ ctx: RunContext; runId: string; stepOrder: number } | null> {
    const step = await this.prisma.jobRunStep.findUnique({
      where: { k8sJobUid: uid },
      select: {
        runId: true,
        stepOrder: true,
        run: {
          select: {
            jobId: true,
            job: {
              select: {
                project: { select: { id: true, namespace: true, organizationId: true } }
              }
            }
          }
        }
      }
    });
    if (step) {
      return {
        runId: step.runId,
        stepOrder: step.stepOrder,
        ctx: {
          jobId: step.run.jobId,
          projectId: step.run.job.project.id,
          organizationId: step.run.job.project.organizationId,
          namespace: step.run.job.project.namespace
        }
      };
    }

    if (!labeledRunId) return null;
    const orderRaw = job.metadata?.labels?.[LABEL_STEP_ORDER];
    const stepOrder = orderRaw ? parseInt(orderRaw, 10) : NaN;
    if (!Number.isFinite(stepOrder)) return null;
    const run = await this.prisma.jobRun.findUnique({
      where: { id: labeledRunId },
      select: {
        id: true,
        jobId: true,
        job: {
          select: {
            project: { select: { id: true, namespace: true, organizationId: true } }
          }
        }
      }
    });
    if (!run) return null;
    await this.prisma.jobRunStep
      .updateMany({
        where: { runId: run.id, stepOrder, k8sJobUid: null },
        data: { k8sJobUid: uid, k8sJobName: job.metadata?.name ?? null }
      })
      .catch(() => {});
    return {
      runId: run.id,
      stepOrder,
      ctx: {
        jobId: run.jobId,
        projectId: run.job.project.id,
        organizationId: run.job.project.organizationId,
        namespace: run.job.project.namespace
      }
    };
  }

  private async onK8sJobDeleted(uid: string): Promise<void> {
    const step = await this.prisma.jobRunStep.findUnique({
      where: { k8sJobUid: uid },
      select: {
        runId: true,
        stepOrder: true,
        status: true,
        run: {
          select: {
            status: true,
            jobId: true,
            job: {
              select: {
                project: { select: { id: true, namespace: true, organizationId: true } }
              }
            }
          }
        }
      }
    });
    if (!step) return;
    if (!['pending', 'running'].includes(step.status)) return;
    if (!['pending', 'running'].includes(step.run.status)) return;

    const ctx: RunContext = {
      jobId: step.run.jobId,
      projectId: step.run.job.project.id,
      organizationId: step.run.job.project.organizationId,
      namespace: step.run.job.project.namespace
    };
    await this.prisma.jobRunStep.updateMany({
      where: {
        runId: step.runId,
        stepOrder: step.stepOrder,
        status: { in: ['pending', 'running'] }
      },
      data: { status: 'failed', reason: 'JobDeleted', finishedAt: new Date() }
    });
    await this.prisma.jobRunStep.updateMany({
      where: { runId: step.runId, stepOrder: { gt: step.stepOrder }, status: 'pending' },
      data: { status: 'skipped' }
    });
    await this.orchestrator.finishRun(
      ctx,
      step.runId,
      'failed',
      'The Kubernetes job was deleted outside Orchard',
      step.stepOrder
    );
  }
}
