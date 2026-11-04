import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException
} from '@nestjs/common';
import { CronTime } from 'cron';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrgEventsService } from '../events/org-events.service';
import { SCRIPT_RUNTIMES, ScriptRuntime } from './script-runtimes';
import { NotificationsService } from '../notifications/notifications.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { applyEnvKeepRules } from '../projects/env-write-rules';
import { assertImageOwnedByProject } from '../projects/image-ownership';

export const JOB_STEP_TYPES = ['app', 'image', 'script'] as const;
export type JobStepType = (typeof JOB_STEP_TYPES)[number];

export const RUN_ACTIVE_STATUSES = ['pending', 'running'] as const;
export const RUN_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'canceled',
  'skipped',
  'timed_out'
] as const;

export type RunStatus =
  | (typeof RUN_ACTIVE_STATUSES)[number]
  | (typeof RUN_TERMINAL_STATUSES)[number];

const MAX_STEPS = 10;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_STEP_TIMEOUT = 21600;
const MIN_STEP_TIMEOUT = 30;
const MAX_RETRIES = 3;
const MAX_RUN_TIMEOUT = 21600;
const MIN_RUN_TIMEOUT = 60;

export interface JobStepInput {
  name: string;
  type: JobStepType;
  deploymentId?: string | null;
  image?: string | null;
  command?: string | null;
  script?: string | null;
  scriptRuntime?: ScriptRuntime | null;
  envVars?: { key: string; value?: string | null; secret?: boolean | null }[];
  cpuRequestMilli?: number | null;
  memoryRequestBytes?: number | string | null;
  timeoutSeconds?: number | null;
  retries?: number | null;
}

export interface JobInput {
  name: string;
  description?: string | null;
  scheduleCron?: string | null;
  timeZone?: string | null;
  enabled?: boolean;
  concurrencyPolicy?: 'allow' | 'forbid';
  runTimeoutSeconds?: number | null;
  nodePoolId?: string | null;
  placementOverride?: unknown;
  steps: JobStepInput[];
}

export interface JobPatchInput {
  name?: string;
  description?: string | null;
  scheduleCron?: string | null;
  timeZone?: string | null;
  enabled?: boolean;
  concurrencyPolicy?: 'allow' | 'forbid';
  runTimeoutSeconds?: number | null;
  nodePoolId?: string | null;
  placementOverride?: unknown;
}

export function isValidK8sCron(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.startsWith('@')) return false;
  if (trimmed.split(/\s+/).length !== 5) return false;
  try {
    void new CronTime(trimmed, 'UTC');
    return true;
  } catch {
    return false;
  }
}

export function isSupportedTimeZone(timeZone: string): boolean {
  const supported = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
  return !supported || supported.includes(timeZone);
}

export function nextCronRun(expr: string, timeZone?: string | null): Date | null {
  try {
    return new CronTime(expr, timeZone || 'UTC').sendAt().toJSDate();
  } catch {
    return null;
  }
}

const IMAGE_REF_PATTERN = /^[a-z0-9]+(?:[._\-/:@][a-z0-9]+)*$/i;

type StoredStepEnv = { key: string; value: string; secret: boolean };

export function storedStepEnv(raw: unknown): StoredStepEnv[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e.key === 'string')
    .map((e) => ({ key: e.key, value: String(e.value ?? ''), secret: Boolean(e.secret) }));
}

export function redactStepEnv(
  raw: unknown
): { key: string; value: string | null; secret: boolean }[] {
  return storedStepEnv(raw).map((e) => ({
    key: e.key,
    value: e.secret ? null : e.value,
    secret: e.secret
  }));
}

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly notifications: NotificationsService,
    private readonly crypto: SecretCryptoService
  ) {}

  async getJobOrThrow(jobId: string) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        project: {
          select: { id: true, name: true, slug: true, namespace: true, organizationId: true }
        }
      }
    });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  async getRunOrThrow(runId: string) {
    const run = await this.prisma.jobRun.findUnique({
      where: { id: runId },
      include: {
        job: {
          include: {
            project: {
              select: { id: true, name: true, slug: true, namespace: true, organizationId: true }
            }
          }
        }
      }
    });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    return run;
  }

  private readonly listRunsInclude = {
    orderBy: { createdAt: 'desc' as const },
    take: 10,
    select: {
      id: true,
      number: true,
      status: true,
      trigger: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true
    }
  };

  async listOrgJobs(organizationId: string, projectFilter: any) {
    const jobs = await this.prisma.job.findMany({
      where: { project: { ...projectFilter, organizationId } },
      include: {
        project: { select: { id: true, name: true, slug: true } },
        steps: {
          orderBy: { stepOrder: 'asc' },
          select: { id: true, name: true, type: true, stepOrder: true }
        },
        runs: this.listRunsInclude
      },
      orderBy: { createdAt: 'desc' }
    });
    return jobs.map((job) => this.serializeJob(job));
  }

  async listProjectJobs(projectId: string) {
    const jobs = await this.prisma.job.findMany({
      where: { projectId },
      include: {
        project: { select: { id: true, name: true, slug: true } },
        steps: {
          orderBy: { stepOrder: 'asc' },
          select: { id: true, name: true, type: true, stepOrder: true }
        },
        runs: this.listRunsInclude
      },
      orderBy: { createdAt: 'desc' }
    });
    return jobs.map((job) => this.serializeJob(job));
  }

  async getJobDetail(jobId: string, opts: { redact?: boolean } = {}) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        project: { select: { id: true, name: true, slug: true, organizationId: true } },
        steps: { orderBy: { stepOrder: 'asc' } },
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            number: true,
            status: true,
            trigger: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true
          }
        }
      }
    });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return {
      ...this.serializeJob(job),
      steps: job.steps.map((s) =>
        opts.redact ? this.redactStep(this.serializeStep(s)) : this.serializeStep(s)
      )
    };
  }

  private redactStep(step: ReturnType<JobsService['serializeStep']>) {
    return {
      ...step,
      script: null,
      envVars: step.envVars.map(({ key, secret }) => ({ key, value: null, secret }))
    };
  }

  async createJob(projectId: string, input: JobInput, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true, namespace: true }
    });
    if (!project) throw new NotFoundException('Project not found');

    const data = await this.validateJobInput(input, projectId);
    const steps = await this.validateSteps(input.steps, projectId, []);

    const defaultEnv = await this.prisma.environment.findFirst({
      where: { projectId, isDefault: true },
      select: { id: true }
    });

    const existing = await this.prisma.job.findFirst({
      where: { projectId, name: data.name },
      select: { id: true }
    });
    if (existing) {
      throw new ConflictException(`A job named "${data.name}" already exists in this project`);
    }

    const job = await this.prisma.job.create({
      data: {
        projectId,
        environmentId: defaultEnv?.id ?? null,
        name: data.name,
        description: data.description,
        scheduleCron: data.scheduleCron,
        timeZone: data.timeZone,
        enabled: data.enabled ?? true,
        concurrencyPolicy: data.concurrencyPolicy ?? 'forbid',
        runTimeoutSeconds: data.runTimeoutSeconds ?? MAX_RUN_TIMEOUT,
        nodePoolId: input.nodePoolId ?? null,
        placementOverride: (input.placementOverride ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        createdBy: userId,
        steps: { create: steps }
      },
      include: {
        project: { select: { id: true, name: true, slug: true, organizationId: true } },
        steps: { orderBy: { stepOrder: 'asc' } }
      }
    });

    this.emitJobChanged(job.project.organizationId, job.id, projectId);
    return { ...this.serializeJob(job), steps: job.steps.map((s) => this.serializeStep(s)) };
  }

  async updateJob(jobId: string, input: JobPatchInput) {
    const job = await this.getJobOrThrow(jobId);
    const data = await this.validateJobInput(
      { ...input, name: input.name ?? job.name, steps: [] },
      job.projectId,
      true
    );

    if (input.name !== undefined && data.name !== job.name) {
      const clash = await this.prisma.job.findFirst({
        where: { projectId: job.projectId, name: data.name },
        select: { id: true }
      });
      if (clash) {
        throw new ConflictException(`A job named "${data.name}" already exists in this project`);
      }
    }

    const updated = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        ...(input.name !== undefined ? { name: data.name } : {}),
        ...(input.description !== undefined ? { description: data.description } : {}),
        ...(input.scheduleCron !== undefined ? { scheduleCron: data.scheduleCron } : {}),
        ...(input.timeZone !== undefined ? { timeZone: data.timeZone } : {}),
        ...(input.enabled !== undefined
          ? { enabled: input.enabled, removedInClusterAt: null }
          : {}),
        ...(input.concurrencyPolicy !== undefined
          ? { concurrencyPolicy: input.concurrencyPolicy }
          : {}),
        ...(input.runTimeoutSeconds !== undefined
          ? { runTimeoutSeconds: data.runTimeoutSeconds ?? MAX_RUN_TIMEOUT }
          : {}),
        ...(input.nodePoolId !== undefined ? { nodePoolId: input.nodePoolId ?? null } : {}),
        ...(input.placementOverride !== undefined
          ? {
              placementOverride: (input.placementOverride ?? Prisma.DbNull) as
                | Prisma.InputJsonValue
                | typeof Prisma.DbNull
            }
          : {})
      },
      include: {
        project: { select: { id: true, name: true, slug: true, organizationId: true } },
        steps: { orderBy: { stepOrder: 'asc' } }
      }
    });

    this.emitJobChanged(updated.project.organizationId, jobId, job.projectId);
    return {
      ...this.serializeJob(updated),
      steps: updated.steps.map((s) => this.serializeStep(s))
    };
  }

  async replaceSteps(jobId: string, stepInputs: JobStepInput[]) {
    const job = await this.getJobOrThrow(jobId);
    const previous = await this.prisma.jobStep.findMany({
      where: { jobId },
      select: { name: true, stepOrder: true, envVars: true }
    });
    const steps = await this.validateSteps(stepInputs, job.projectId, previous);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.jobStep.deleteMany({ where: { jobId } });
      return tx.job.update({
        where: { id: jobId },
        data: { steps: { create: steps } },
        include: {
          project: { select: { id: true, name: true, slug: true, organizationId: true } },
          steps: { orderBy: { stepOrder: 'asc' } }
        }
      });
    });

    this.emitJobChanged(updated.project.organizationId, jobId, job.projectId);
    return {
      ...this.serializeJob(updated),
      steps: updated.steps.map((s) => this.serializeStep(s))
    };
  }

  async deleteJob(jobId: string) {
    const job = await this.getJobOrThrow(jobId);
    await this.prisma.job.delete({ where: { id: jobId } });
    this.notifications
      .purgeScope('job', jobId)
      .catch((err) =>
        console.error(`[Jobs] Failed to purge notification scope for ${jobId}:`, err)
      );
    this.emitJobChanged(job.project.organizationId, jobId, job.projectId);
    return job;
  }

  async listRuns(jobId: string, cursor?: string, limit = 25) {
    const take = Math.min(Math.max(limit, 1), 100);
    const runs = await this.prisma.jobRun.findMany({
      where: { jobId },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        triggerer: { select: { id: true, username: true, firstName: true, lastName: true } },
        steps: {
          orderBy: { stepOrder: 'asc' },
          select: { stepOrder: true, name: true, status: true }
        }
      }
    });
    const hasMore = runs.length > take;
    const page = hasMore ? runs.slice(0, take) : runs;
    return {
      runs: page.map((r) => this.serializeRun(r)),
      nextCursor: hasMore ? page[page.length - 1].id : null
    };
  }

  async getRunDetail(runId: string) {
    const run = await this.prisma.jobRun.findUnique({
      where: { id: runId },
      include: {
        job: { select: { id: true, name: true, projectId: true } },
        triggerer: { select: { id: true, username: true, firstName: true, lastName: true } },
        steps: {
          orderBy: { stepOrder: 'asc' },
          select: {
            id: true,
            stepOrder: true,
            name: true,
            type: true,
            resolvedImage: true,
            command: true,
            status: true,
            exitCode: true,
            reason: true,
            logsTruncated: true,
            startedAt: true,
            finishedAt: true
          }
        }
      }
    });
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    return this.serializeRun(run);
  }

  async getRunStepLogs(runId: string, stepOrder: number) {
    const step = await this.prisma.jobRunStep.findUnique({
      where: { runId_stepOrder: { runId, stepOrder } },
      select: { logs: true, logsTruncated: true, status: true, k8sJobName: true }
    });
    if (!step) throw new NotFoundException('Step not found');
    return step;
  }

  serializeJob(job: any) {
    const lastRun = job.runs?.[0] ?? null;
    return {
      id: job.id,
      name: job.name,
      description: job.description,
      projectId: job.projectId,
      projectName: job.project?.name,
      projectSlug: job.project?.slug,
      organizationId: job.project?.organizationId,
      scheduleCron: job.scheduleCron,
      timeZone: job.timeZone,
      enabled: job.enabled,
      concurrencyPolicy: job.concurrencyPolicy,
      runTimeoutSeconds: job.runTimeoutSeconds,
      stepCount: job.steps?.length,
      stepSummaries: job.steps?.map((s: any) => ({ name: s.name, type: s.type })) ?? undefined,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            number: lastRun.number,
            status: lastRun.status,
            trigger: lastRun.trigger,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            createdAt: lastRun.createdAt
          }
        : null,
      recentRuns: (job.runs ?? []).map((r: any) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt
      })),
      nextRunAt:
        job.enabled && job.scheduleCron ? nextCronRun(job.scheduleCron, job.timeZone) : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  serializeStep(step: any) {
    return {
      id: step.id,
      stepOrder: step.stepOrder,
      name: step.name,
      type: step.type,
      deploymentId: step.deploymentId,
      image: step.image,
      command: (step.command as any)?.shell ?? null,
      script: step.script,
      scriptRuntime: step.scriptRuntime,
      envVars: redactStepEnv(step.envVars),
      cpuRequestMilli: step.cpuRequestMilli,
      memoryRequestBytes:
        step.memoryRequestBytes != null ? step.memoryRequestBytes.toString() : null,
      timeoutSeconds: step.timeoutSeconds,
      retries: step.retries
    };
  }

  serializeRun(run: any) {
    return {
      id: run.id,
      jobId: run.jobId,
      jobName: run.job?.name,
      number: run.number,
      trigger: run.trigger,
      status: run.status,
      currentStepOrder: run.currentStepOrder,
      errorMessage: run.errorMessage,
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      triggeredBy: run.triggerer
        ? {
            id: run.triggerer.id,
            username: run.triggerer.username,
            name:
              [run.triggerer.firstName, run.triggerer.lastName].filter(Boolean).join(' ') ||
              run.triggerer.username
          }
        : null,
      steps: run.steps?.map((s: any) => ({
        id: s.id,
        stepOrder: s.stepOrder,
        name: s.name,
        type: s.type,
        resolvedImage: s.resolvedImage,
        command: (s.command as any)?.shell ?? null,
        status: s.status,
        exitCode: s.exitCode,
        reason: s.reason,
        logsTruncated: s.logsTruncated,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt
      }))
    };
  }

  emitJobChanged(organizationId: string, jobId: string, projectId: string) {
    this.orgEvents.emit({
      organizationId,
      type: 'job.changed',
      id: jobId,
      projectId
    });
  }

  emitRunChanged(
    organizationId: string,
    projectId: string,
    jobId: string,
    run: { id: string; number: number; status: string; currentStepOrder?: number | null }
  ) {
    this.orgEvents.emit({
      organizationId,
      type: 'jobrun.changed',
      id: run.id,
      projectId,
      payload: {
        jobId,
        runId: run.id,
        number: run.number,
        status: run.status,
        currentStepOrder: run.currentStepOrder ?? null
      }
    });
  }

  private async validateJobInput(
    input: JobInput | (JobPatchInput & { name: string; steps: JobStepInput[] }),
    projectId: string,
    isPatch = false
  ) {
    const name = String(input.name ?? '').trim();
    if (!isPatch || input.name !== undefined) {
      if (!name) throw new BadRequestException('Job name is required');
      if (name.length > 255) throw new BadRequestException('Job name is too long');
    }

    let scheduleCron: string | null = null;
    if (input.scheduleCron != null && String(input.scheduleCron).trim() !== '') {
      scheduleCron = String(input.scheduleCron).trim();
      if (!isValidK8sCron(scheduleCron)) {
        throw new BadRequestException(
          'Invalid cron expression. Use 5 fields: minute hour day-of-month month day-of-week'
        );
      }
    }

    let timeZone: string | null = null;
    if (input.timeZone != null && String(input.timeZone).trim() !== '') {
      timeZone = String(input.timeZone).trim();
      if (!isSupportedTimeZone(timeZone)) {
        throw new BadRequestException(`Unknown time zone: ${timeZone}`);
      }
    }

    if (
      input.concurrencyPolicy !== undefined &&
      !['allow', 'forbid'].includes(input.concurrencyPolicy)
    ) {
      throw new BadRequestException('concurrencyPolicy must be "allow" or "forbid"');
    }

    let runTimeoutSeconds: number | null = null;
    if (input.runTimeoutSeconds != null) {
      runTimeoutSeconds = Math.floor(Number(input.runTimeoutSeconds));
      if (
        !Number.isFinite(runTimeoutSeconds) ||
        runTimeoutSeconds < MIN_RUN_TIMEOUT ||
        runTimeoutSeconds > MAX_RUN_TIMEOUT
      ) {
        throw new BadRequestException(
          `runTimeoutSeconds must be between ${MIN_RUN_TIMEOUT} and ${MAX_RUN_TIMEOUT}`
        );
      }
    }

    return {
      name,
      description: input.description != null ? String(input.description).slice(0, 2000) : null,
      scheduleCron,
      timeZone,
      enabled: input.enabled,
      concurrencyPolicy: input.concurrencyPolicy,
      runTimeoutSeconds
    };
  }

  private async validateSteps(
    stepInputs: JobStepInput[],
    projectId: string,
    previous: { name: string; stepOrder: number; envVars: unknown }[]
  ) {
    if (!Array.isArray(stepInputs) || stepInputs.length === 0) {
      throw new BadRequestException('At least one step is required');
    }
    if (stepInputs.length > MAX_STEPS) {
      throw new BadRequestException(`A job can have at most ${MAX_STEPS} steps`);
    }

    const deploymentIds = stepInputs
      .filter((s) => s.type === 'app' && s.deploymentId)
      .map((s) => s.deploymentId as string);
    const deployments = deploymentIds.length
      ? await this.prisma.deployment.findMany({
          where: { id: { in: deploymentIds }, projectId },
          select: { id: true }
        })
      : [];
    const validDeployments = new Set(deployments.map((d) => d.id));

    const project = stepInputs.some((s) => s.type === 'image')
      ? await this.prisma.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { id: true, namespace: true }
        })
      : null;

    return Promise.all(
      stepInputs.map(async (raw, i) => {
        const order = i + 1;
        const name = String(raw.name ?? '').trim() || `Step ${order}`;
        if (name.length > 255) throw new BadRequestException(`Step ${order}: name is too long`);
        if (!JOB_STEP_TYPES.includes(raw.type)) {
          throw new BadRequestException(`Step ${order}: invalid type "${raw.type}"`);
        }

        const prior =
          previous.find((p) => p.name === name) ?? previous.find((p) => p.stepOrder === order);
        const before = new Map(
          storedStepEnv(prior?.envVars).map((e) => {
            const plain = this.crypto.maybeDecrypt(e);
            return [plain.key, plain] as const;
          })
        );
        const kept = applyEnvKeepRules(
          Array.isArray(raw.envVars)
            ? raw.envVars.filter((e) => e && typeof e.key === 'string' && e.key.trim())
            : [],
          before
        );
        if (kept.length > 64) throw new BadRequestException(`Step ${order}: too many env vars`);
        for (const e of kept) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key)) {
            throw new BadRequestException(`Step ${order}: invalid env var name "${e.key}"`);
          }
        }
        const envVars = kept.map((e) => ({
          key: e.key,
          value: this.crypto.encryptIfSecret(e.value, e.secret),
          secret: e.secret
        }));

        let timeoutSeconds =
          raw.timeoutSeconds != null ? Math.floor(Number(raw.timeoutSeconds)) : 1800;
        if (!Number.isFinite(timeoutSeconds)) timeoutSeconds = 1800;
        if (timeoutSeconds < MIN_STEP_TIMEOUT || timeoutSeconds > MAX_STEP_TIMEOUT) {
          throw new BadRequestException(
            `Step ${order}: timeout must be between ${MIN_STEP_TIMEOUT} and ${MAX_STEP_TIMEOUT} seconds`
          );
        }

        let retries = raw.retries != null ? Math.floor(Number(raw.retries)) : 0;
        if (!Number.isFinite(retries) || retries < 0) retries = 0;
        if (retries > MAX_RETRIES) {
          throw new BadRequestException(`Step ${order}: retries must be at most ${MAX_RETRIES}`);
        }

        let cpuRequestMilli: number | null = null;
        if (raw.cpuRequestMilli != null) {
          cpuRequestMilli = Math.floor(Number(raw.cpuRequestMilli));
          if (!Number.isFinite(cpuRequestMilli) || cpuRequestMilli < 50 || cpuRequestMilli > 8000) {
            throw new BadRequestException(
              `Step ${order}: cpuRequestMilli must be between 50 and 8000`
            );
          }
        }

        let memoryRequestBytes: bigint | null = null;
        if (raw.memoryRequestBytes != null) {
          try {
            memoryRequestBytes = BigInt(raw.memoryRequestBytes);
          } catch {
            throw new BadRequestException(`Step ${order}: invalid memoryRequestBytes`);
          }
          if (
            memoryRequestBytes < 64n * 1024n * 1024n ||
            memoryRequestBytes > 16n * 1024n * 1024n * 1024n
          ) {
            throw new BadRequestException(`Step ${order}: memory must be between 64Mi and 16Gi`);
          }
        }

        const command =
          raw.command != null && String(raw.command).trim() !== ''
            ? { shell: String(raw.command).trim() }
            : null;
        if (command && command.shell.length > 4096) {
          throw new BadRequestException(`Step ${order}: command is too long`);
        }

        const base = {
          stepOrder: order,
          name,
          type: raw.type,
          envVars,
          cpuRequestMilli,
          memoryRequestBytes,
          timeoutSeconds,
          retries
        };

        if (raw.type === 'script') {
          const script = String(raw.script ?? '');
          if (!script.trim()) throw new BadRequestException(`Step ${order}: script is empty`);
          if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) {
            throw new BadRequestException(`Step ${order}: script exceeds 64KB`);
          }
          const runtime = raw.scriptRuntime as ScriptRuntime;
          if (!SCRIPT_RUNTIMES.includes(runtime)) {
            throw new BadRequestException(
              `Step ${order}: scriptRuntime must be one of ${SCRIPT_RUNTIMES.join(', ')}`
            );
          }
          return { ...base, script, scriptRuntime: runtime };
        }

        if (raw.type === 'image') {
          const image = String(raw.image ?? '').trim();
          if (!image) throw new BadRequestException(`Step ${order}: image is required`);
          if (image.length > 500 || !IMAGE_REF_PATTERN.test(image)) {
            throw new BadRequestException(
              `Step ${order}: "${image}" isn't a valid image reference`
            );
          }
          await assertImageOwnedByProject(this.prisma, image, project!);
          return { ...base, image, command };
        }

        if (!raw.deploymentId || !validDeployments.has(raw.deploymentId)) {
          throw new BadRequestException(`Step ${order}: select a deployment from this project`);
        }
        if (!command) {
          throw new BadRequestException(`Step ${order}: command is required for app steps`);
        }
        return { ...base, deploymentId: raw.deploymentId, command };
      })
    );
  }
}
