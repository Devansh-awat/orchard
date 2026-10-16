import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { JobsService, isSupportedTimeZone, isValidK8sCron } from '../../jobs/jobs.service';
import {
  JobsOrchestratorService,
  LABEL_JOB_ID,
  cronJobNameFor
} from '../../jobs/jobs-orchestrator.service';
import {
  ScheduleField,
  ScheduleState,
  externalScheduleEdits,
  jobScheduleState,
  readAppliedSchedule,
  scheduleStateOf
} from '../../jobs/cronjob-drift';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { EngineEventType, EngineRefs } from '../core/informer';
import { K8S_DELETED_REASON, RemovalPending } from './workload.consumer';

export const K8S_SCHEDULE_ADOPTED_REASON = 'schedule edited in k8s';

const CONFIRM_AFTER_MS = 90 * 1000;
const REMOVAL_WINDOW_MS = 10 * 60 * 1000;
const MAX_REMOVALS_PER_WINDOW = 5;

type LiveState = 'present' | 'absent' | 'unknown';

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AdoptionDeferred extends Error {}

export interface CronJobOwner {
  id: string;
  projectId: string;
  name: string;
  scheduleCron: string | null;
  timeZone: string | null;
  enabled: boolean;
  concurrencyPolicy: string;
  cronJobName: string | null;
  project: { namespace: string; organizationId: string };
}

@Injectable()
export class CronJobConsumer {
  private readonly logger = new Logger(CronJobConsumer.name);

  private readonly refused = new Map<string, string>();

  private readonly absentSince = new Map<string, number>();

  private removals: number[] = [];

  protected confirmAfterMs = CONFIRM_AFTER_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly orchestrator: JobsOrchestratorService
  ) {}

  async mapRefs(cronJob: k8s.V1CronJob): Promise<EngineRefs> {
    const jobId = cronJob.metadata?.labels?.[LABEL_JOB_ID];
    return jobId ? { jobId } : {};
  }

  async onEvent(type: EngineEventType, cronJob: k8s.V1CronJob): Promise<void> {
    const owner = await this.ownerOf(cronJob);
    if (!owner) {
      const jobId = cronJob.metadata?.labels?.[LABEL_JOB_ID];
      if (jobId) this.absentSince.delete(jobId);
      return;
    }
    if (type === 'delete') {
      await this.confirmRemoval(owner, cronJob);
      return;
    }
    this.absentSince.delete(owner.id);
    await this.adoptSchedule(owner, cronJob);
  }

  private async confirmRemoval(owner: CronJobOwner, cronJob: k8s.V1CronJob): Promise<void> {
    const namespace = owner.project.namespace;
    const name = cronJob.metadata?.name ?? '';
    if (owner.cronJobName !== name || !owner.enabled) {
      this.absentSince.delete(owner.id);
      return;
    }

    const namespaceState = await this.liveNamespace(namespace);
    if (namespaceState !== 'present') {
      this.absentSince.delete(owner.id);
      if (namespaceState === 'unknown') {
        throw new RemovalPending(`removal of ${namespace}/${name} deferred: namespace unreadable`);
      }
      return;
    }

    const state = await this.liveCronJob(namespace, name);
    if (state === 'present') {
      if (this.absentSince.has(owner.id)) {
        this.logger.warn(
          `cronjob ${namespace}/${name} looked deleted but the apiserver still has it; false alarm, job ${owner.id} left enabled`
        );
      }
      this.absentSince.delete(owner.id);
      return;
    }
    if (state === 'unknown') {
      throw new RemovalPending(
        `removal of ${namespace}/${name} deferred: the apiserver could not confirm the delete`
      );
    }

    const now = Date.now();
    const first = this.absentSince.get(owner.id);
    if (first === undefined) {
      this.absentSince.set(owner.id, now);
      this.logger.warn(
        `cronjob ${namespace}/${name} is gone from the cluster; job ${owner.id} will be disabled if it is still gone in ${Math.round(this.confirmAfterMs / 1000)}s`
      );
      throw new RemovalPending(`removal of ${namespace}/${name} awaiting confirmation`);
    }
    if (now - first < this.confirmAfterMs) {
      throw new RemovalPending(`removal of ${namespace}/${name} awaiting confirmation`);
    }

    this.removals = this.removals.filter((at) => now - at < REMOVAL_WINDOW_MS);
    if (this.removals.length >= MAX_REMOVALS_PER_WINDOW) {
      this.logger.error(
        `${this.removals.length} jobs were disabled after cluster deletes in the last ${REMOVAL_WINDOW_MS / 60000} minutes; holding ${namespace}/${name} back. That is not what a manual delete looks like. It is retried once the window passes.`
      );
      throw new RemovalPending(`removal of ${namespace}/${name} held by the breaker`);
    }

    this.absentSince.delete(owner.id);
    const result = await this.prisma.job.updateMany({
      where: { id: owner.id, cronJobName: name, enabled: true },
      data: { enabled: false, cronJobName: null }
    });
    if (result.count === 0) return;
    this.removals.push(now);

    this.logger.warn(
      `cronjob ${namespace}/${name} confirmed deleted in the cluster; job ${owner.id} disabled, its runs kept`
    );
    void this.audit.log({
      action: 'job.updated',
      organizationId: owner.project.organizationId,
      projectId: owner.projectId,
      targetType: 'job',
      targetId: owner.id,
      targetLabel: owner.name,
      metadata: {
        reason: K8S_DELETED_REASON,
        source: 'engine.batch',
        cronJob: `${namespace}/${name}`,
        enabled: [true, false],
        firstAbsentAt: new Date(first).toISOString(),
        confirmedAbsentAt: new Date(now).toISOString()
      }
    });
    this.jobs.emitJobChanged(owner.project.organizationId, owner.id, owner.projectId);
  }

  protected async liveCronJob(namespace: string, name: string): Promise<LiveState> {
    try {
      this.kubernetes.ensureKubeConfig();
      await this.kubernetes
        .kc!.makeApiClient(k8s.BatchV1Api)
        .readNamespacedCronJob(name, namespace);
      return 'present';
    } catch (err: any) {
      const code = err?.response?.statusCode ?? err?.statusCode;
      if (code === 404) return 'absent';
      this.logger.warn(
        `could not read cronjob ${namespace}/${name} from the apiserver (${code ?? 'no status'}): ${err?.message ?? err}`
      );
      return 'unknown';
    }
  }

  protected async liveNamespace(namespace: string): Promise<LiveState> {
    try {
      this.kubernetes.ensureKubeConfig();
      const { body } = await this.kubernetes
        .kc!.makeApiClient(k8s.CoreV1Api)
        .readNamespace(namespace);
      if (body?.status?.phase === 'Terminating' || body?.metadata?.deletionTimestamp) {
        return 'absent';
      }
      return 'present';
    } catch (err: any) {
      const code = err?.response?.statusCode ?? err?.statusCode;
      return code === 404 ? 'absent' : 'unknown';
    }
  }

  private async ownerOf(cronJob: k8s.V1CronJob): Promise<CronJobOwner | null> {
    const jobId = cronJob.metadata?.labels?.[LABEL_JOB_ID];
    const name = cronJob.metadata?.name;
    const namespace = cronJob.metadata?.namespace;
    if (!jobId || !name || !namespace || !JOB_ID_PATTERN.test(jobId)) return null;
    if (name !== cronJobNameFor(jobId)) return null;
    const owner = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        projectId: true,
        name: true,
        scheduleCron: true,
        timeZone: true,
        enabled: true,
        concurrencyPolicy: true,
        cronJobName: true,
        project: { select: { namespace: true, organizationId: true } }
      }
    });
    if (!owner || owner.project.namespace !== namespace) return null;
    return owner;
  }

  private async adoptSchedule(owner: CronJobOwner, cronJob: k8s.V1CronJob): Promise<void> {
    const applied = readAppliedSchedule(cronJob.metadata);
    if (!applied) return;
    const live = scheduleStateOf(cronJob.spec);
    const edited = externalScheduleEdits(live, applied, jobScheduleState(owner));
    if (edited.length === 0) {
      this.refused.delete(owner.id);
      return;
    }

    if (this.orchestrator.isSyncingCronJob(owner.id)) {
      throw new AdoptionDeferred(
        `adoption deferred for job ${owner.id}: orchard is writing its cronjob`
      );
    }

    const { data, diff, refused } = scheduleChanges(owner, live, edited);
    const where = `${cronJob.metadata?.namespace}/${cronJob.metadata?.name}`;
    const refusedKey = refused.join(', ');
    if (refused.length > 0 && this.refused.get(owner.id) !== refusedKey) {
      this.logger.warn(
        `cronjob ${where} carries ${refusedKey}, which orchard cannot represent; it is left as is in the cluster and not adopted`
      );
    }
    if (refused.length > 0) this.refused.set(owner.id, refusedKey);
    else this.refused.delete(owner.id);
    if (Object.keys(data).length === 0) return;

    const result = await this.prisma.job.updateMany({
      where: {
        id: owner.id,
        scheduleCron: owner.scheduleCron,
        timeZone: owner.timeZone,
        enabled: owner.enabled,
        concurrencyPolicy: owner.concurrencyPolicy
      },
      data
    });
    if (result.count === 0) {
      throw new AdoptionDeferred(
        `adoption deferred for job ${owner.id}: the job changed while it was being read`
      );
    }

    this.logger.log(
      `adopted cronjob edits from ${where} into job ${owner.id}: ${Object.keys(diff).join(', ')}`
    );
    void this.audit.log({
      action: 'job.updated',
      organizationId: owner.project.organizationId,
      projectId: owner.projectId,
      targetType: 'job',
      targetId: owner.id,
      targetLabel: owner.name,
      metadata: {
        reason: K8S_SCHEDULE_ADOPTED_REASON,
        source: 'engine.batch',
        cronJob: where,
        ...diff
      }
    });
    this.jobs.emitJobChanged(owner.project.organizationId, owner.id, owner.projectId);
  }
}

export function scheduleChanges(
  owner: CronJobOwner,
  live: ScheduleState,
  edited: ScheduleField[]
): {
  data: Prisma.JobUpdateManyMutationInput;
  diff: Record<string, readonly unknown[]>;
  refused: string[];
} {
  const data: Prisma.JobUpdateManyMutationInput = {};
  const diff: Record<string, readonly unknown[]> = {};
  const refused: string[] = [];
  for (const field of edited) {
    if (field === 'schedule') {
      const schedule = live.schedule?.trim() ?? '';
      if (schedule && isValidK8sCron(schedule)) {
        data.scheduleCron = schedule;
        diff.scheduleCron = [owner.scheduleCron, schedule];
      } else {
        refused.push(`schedule "${live.schedule ?? ''}"`);
      }
    } else if (field === 'timeZone') {
      if (live.timeZone === null || isSupportedTimeZone(live.timeZone)) {
        data.timeZone = live.timeZone;
        diff.timeZone = [owner.timeZone, live.timeZone];
      } else {
        refused.push(`timeZone "${live.timeZone}"`);
      }
    } else if (field === 'suspend') {
      data.enabled = !live.suspend;
      diff.enabled = [owner.enabled, !live.suspend];
    } else if (live.concurrencyPolicy === 'Allow' || live.concurrencyPolicy === 'Forbid') {
      const policy = live.concurrencyPolicy === 'Allow' ? 'allow' : 'forbid';
      data.concurrencyPolicy = policy;
      diff.concurrencyPolicy = [owner.concurrencyPolicy, policy];
    } else {
      refused.push(`concurrencyPolicy "${live.concurrencyPolicy}"`);
    }
  }
  return { data, diff, refused };
}
