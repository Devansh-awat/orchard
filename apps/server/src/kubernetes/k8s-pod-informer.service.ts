import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from './kubernetes.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrgEventsService } from '../events/org-events.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { PodLogCaptureService } from './pod-log-capture.service';

const ORCHARD_SELECTOR = 'app.kubernetes.io/managed-by=orchard';
const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const EMIT_COALESCE_MS = 250;

interface Ctx {
  deploymentId: string;
  orgId: string;
  projectId: string;
}

interface PendingEmit {
  ctx: Ctx;
  payload: unknown;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class K8sPodInformerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(K8sPodInformerService.name);
  private informer?: k8s.Informer<k8s.V1Pod> & k8s.ObjectCache<k8s.V1Pod>;
  private backoffMs = 1000;
  private stopped = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();
  private readonly lastEmit = new Map<string, number>();
  private readonly pending = new Map<string, PendingEmit>();

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly leader: LeaderElectionService,
    private readonly logCapture: PodLogCaptureService,
  ) {}

  async onModuleInit() {
    const kc = this.kubernetes.kc;
    if (!kc) {
      this.logger.warn('No kubeconfig; pod informer disabled');
      return;
    }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const listFn = () =>
      coreApi.listPodForAllNamespaces(undefined, undefined, undefined, ORCHARD_SELECTOR);

    this.informer = k8s.makeInformer(kc, '/api/v1/pods', listFn, ORCHARD_SELECTOR);
    this.informer.on('add', (pod) => this.onPodEvent('add', pod));
    this.informer.on('update', (pod) => this.onPodEvent('update', pod));
    this.informer.on('delete', (pod) => this.onPodEvent('delete', pod));
    this.informer.on('connect', () => {
      this.backoffMs = 1000;
    });
    this.informer.on('error', (err) => {
      this.logger.warn(
        `pod informer error: ${(err as Error)?.message ?? err}; restarting in ${this.backoffMs}ms`,
      );
      this.scheduleRestart();
    });
    await this.start();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    try {
      await this.informer?.stop();
    } catch {}
  }

  private async start() {
    if (this.stopped || !this.informer) return;
    try {
      await this.informer.start();
      this.logger.log('pod informer started');
    } catch (err) {
      this.logger.warn(`pod informer start failed: ${(err as Error)?.message ?? err}`);
      this.scheduleRestart();
    }
  }

  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, delay);
  }

  private async onPodEvent(type: 'add' | 'update' | 'delete', pod: k8s.V1Pod) {
    if (!this.leader.isLeader()) return;

    const ns = pod.metadata?.namespace;
    const depName = pod.metadata?.labels?.['app.kubernetes.io/name'];
    if (!ns || !depName) return;
    const ctx = await this.resolveCtx(ns, depName);
    if (!ctx) return;

    await this.syncPod(type, ctx.deploymentId, pod);

    if (type !== 'delete') {
      void this.logCapture.capture(ctx.deploymentId, ns, pod);
    }

    const payload = this.buildPayload(type, pod);
    this.scheduleEmit(ctx, payload);
  }

  private scheduleEmit(ctx: Ctx, payload: unknown) {
    const key = ctx.deploymentId;
    const now = Date.now();
    const last = this.lastEmit.get(key) ?? 0;

    if (now - last >= EMIT_COALESCE_MS) {
      this.lastEmit.set(key, now);
      this.emit(ctx, payload);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.payload = payload;
      return;
    }
    const delay = EMIT_COALESCE_MS - (now - last);
    const timer = setTimeout(() => {
      const p = this.pending.get(key);
      this.pending.delete(key);
      this.lastEmit.set(key, Date.now());
      if (p) this.emit(p.ctx, p.payload);
    }, delay);
    this.pending.set(key, { ctx, payload, timer });
  }

  private emit(ctx: Ctx, payload: unknown) {
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'pod.changed',
      id: ctx.deploymentId,
      projectId: ctx.projectId,
      payload,
    });
  }

  private buildPayload(type: 'add' | 'update' | 'delete', pod: k8s.V1Pod) {
    const name = pod.metadata?.name;
    if (type === 'delete') return { deleted: true, name };
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const term = latestTermination(containerStatuses);
    return {
      name,
      status: computePodStatus(pod),
      ready: pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
      restartCount: containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
      lastTermination: term?.reason
        ? { reason: term.reason, exitCode: term.exitCode, finishedAt: term.finishedAt }
        : null,
    };
  }

  private async syncPod(
    type: 'add' | 'update' | 'delete',
    deploymentId: string,
    pod: k8s.V1Pod,
  ) {
    const name = pod.metadata?.name;
    if (!name) return;

    try {
      if (type === 'delete') {
        await this.prisma.pod.deleteMany({ where: { deploymentId, name } });
        return;
      }

      const containerStatuses = pod.status?.containerStatuses ?? [];
      const restartCount = containerStatuses.reduce(
        (sum, c) => sum + (c.restartCount ?? 0),
        0,
      );
      const ready =
        pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? null;
      const term = latestTermination(containerStatuses);
      const data = {
        podIp: pod.status?.podIP ?? null,
        nodeName: pod.spec?.nodeName ?? null,
        status: computePodStatus(pod),
        restartCount,
        ready,
        lastTerminationReason: term?.reason ?? null,
        lastExitCode: term?.exitCode ?? null,
        lastTerminatedAt: term?.finishedAt ?? null,
      };

      await this.prisma.pod.upsert({
        where: { deploymentId_name: { deploymentId, name } },
        create: { deploymentId, name, ...data },
        update: data,
      });
    } catch (err) {
      this.logger.warn(
        `syncPod(${deploymentId}/${name}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async resolveCtx(ns: string, depName: string): Promise<Ctx | null> {
    const key = `${ns}/${depName}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    let ctx: Ctx | null = null;
    try {
      const dep = await this.prisma.deployment.findFirst({
        where: { namespace: ns, name: depName },
        select: {
          id: true,
          projectId: true,
          project: { select: { organizationId: true } },
        },
      });
      if (dep) {
        ctx = { deploymentId: dep.id, orgId: dep.project.organizationId, projectId: dep.projectId };
      }
    } catch (err) {
      this.logger.warn(`resolveCtx(${key}) failed: ${(err as Error)?.message ?? err}`);
      return null;
    }

    this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return ctx;
  }
}

function latestTermination(
  containerStatuses: k8s.V1ContainerStatus[],
): { reason: string | null; exitCode: number | null; finishedAt: Date | null } | null {
  let best: { reason: string | null; exitCode: number | null; finishedAt: Date | null } | null =
    null;
  for (const cs of containerStatuses) {
    const t = cs.state?.terminated ?? cs.lastState?.terminated;
    if (!t) continue;
    const finishedAt = t.finishedAt ? new Date(t.finishedAt) : null;
    if (best && best.finishedAt && finishedAt && finishedAt <= best.finishedAt) continue;
    best = {
      reason: t.reason ?? null,
      exitCode: t.exitCode ?? null,
      finishedAt,
    };
  }
  return best;
}

const BACKOFF_REASONS = new Set([
  'crashloopbackoff',
  'imagepullbackoff',
  'errimagepull',
  'createcontainererror',
]);

// Mirrors k8s-workload.service getDeploymentPods status derivation so the
// stored `pods` table matches what the live pod path reports.
function computePodStatus(pod: k8s.V1Pod): string {
  const containerStatuses = pod.status?.containerStatuses ?? [];
  const phase = pod.status?.phase?.toLowerCase() || 'pending';
  const conditions = pod.status?.conditions ?? [];
  const isScheduled = conditions.some((c) => c.type === 'PodScheduled' && c.status === 'True');
  const isReady = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  const allContainersReady =
    containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);

  let status = phase;
  if (phase === 'running') {
    status = isReady && allContainersReady ? 'ready' : isScheduled ? 'scheduled' : 'pending';
  } else if (phase === 'pending' && isScheduled) {
    status = 'scheduled';
  }

  for (const c of containerStatuses) {
    const reason = c?.state?.waiting?.reason;
    if (reason && BACKOFF_REASONS.has(String(reason).toLowerCase())) {
      status = 'crashing';
      break;
    }
  }

  return status;
}
