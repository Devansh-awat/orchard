import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import {
  JobsOrchestratorService,
  RunContext,
  LABEL_JOB_ID,
  LABEL_RUN_ID,
  LABEL_STEP_ORDER
} from '../../jobs/jobs-orchestrator.service';
import { MirrorEventType, MirrorRefs } from '../mirror-informer';

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
export class JobMirrorConsumer {
  private readonly logger = new Logger(JobMirrorConsumer.name);

  private readonly processing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: JobsOrchestratorService
  ) {}

  async mapRefs(job: k8s.V1Job): Promise<MirrorRefs> {
    const jobId = job.metadata?.labels?.[LABEL_JOB_ID];
    return jobId ? { jobId } : {};
  }

  async onEvent(type: MirrorEventType, job: k8s.V1Job): Promise<void> {
    const uid = job.metadata?.uid;
    if (!uid || this.processing.has(uid)) return;
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
