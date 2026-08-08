import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PodLogCaptureService } from '../../kubernetes/pod-log-capture.service';
import { MirrorEventType, MirrorRefs } from '../mirror-informer';

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const EMIT_COALESCE_MS = 250;
const CRASH_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;
const CRASH_CONFIRM_MS = 30 * 1000;

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

interface CrashTrack {
  crashing: boolean;
  notifiedCrash: boolean;
  lastNotifiedAt: number;
  confirmTimer?: ReturnType<typeof setTimeout>;
}

@Injectable()
export class PodMirrorConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(PodMirrorConsumer.name);

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  private readonly crashTracks = new Map<string, CrashTrack>();

  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly logCapture: PodLogCaptureService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleDestroy() {
    this.stopped = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const t of this.crashTracks.values()) {
      if (t.confirmTimer) clearTimeout(t.confirmTimer);
    }
    this.crashTracks.clear();
  }

  async pruneStalePods(listed: k8s.V1Pod[]): Promise<void> {
    const liveNames = listed
      .map((pod) => pod.metadata?.name)
      .filter((name): name is string => !!name);
    if (liveNames.length === 0) return;
    const result = await this.prisma.pod.deleteMany({
      where: { name: { notIn: liveNames } },
    });
    if (result.count > 0) {
      this.logger.log(`pruned ${result.count} stale pod rows not present in the cluster`);
    }
  }

  async mapRefs(pod: k8s.V1Pod): Promise<MirrorRefs> {
    const ns = pod.metadata?.namespace;
    const depName = pod.metadata?.labels?.['app.kubernetes.io/name'];
    if (!ns || !depName) return {};
    const ctx = await this.resolveCtx(ns, depName);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  async onEvent(type: MirrorEventType, pod: k8s.V1Pod): Promise<void> {
    const ns = pod.metadata?.namespace;
    const depName = pod.metadata?.labels?.['app.kubernetes.io/name'];
    if (!ns || !depName) return;
    const ctx = await this.resolveCtx(ns, depName);
    if (!ctx) return;

    await this.syncPod(type, ctx.deploymentId, pod);
    void this.trackCrashState(type, ctx);

    if (type !== 'delete') {
      void this.logCapture.capture(ctx.deploymentId, ns, pod);
    }

    this.scheduleEmit(ctx, this.buildPayload(type, pod));
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

  private buildPayload(type: MirrorEventType, pod: k8s.V1Pod) {
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

  private async syncPod(type: MirrorEventType, deploymentId: string, pod: k8s.V1Pod) {
    const name = pod.metadata?.name;
    if (!name) return;

    try {
      const existing = await this.prisma.pod.findUnique({
        where: { deploymentId_name: { deploymentId, name } },
        select: { status: true },
      });

      if (type === 'delete') {
        if (existing) {
          await this.prisma.pod.deleteMany({ where: { deploymentId, name } });
          await this.recordTransition(deploymentId, name, existing.status, 'deleted', null, null);
        }
        return;
      }

      const containerStatuses = pod.status?.containerStatuses ?? [];
      const restartCount = containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
      const ready =
        pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? null;
      const term = latestTermination(containerStatuses);
      const status = computePodStatus(pod);
      const data = {
        podIp: pod.status?.podIP ?? null,
        nodeName: pod.spec?.nodeName ?? null,
        status,
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

      if (!existing || existing.status !== status) {
        await this.recordTransition(
          deploymentId,
          name,
          existing?.status ?? null,
          status,
          term?.reason ?? null,
          term?.exitCode ?? null,
        );
      }
    } catch (err) {
      this.logger.warn(
        `syncPod(${deploymentId}/${name}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async recordTransition(
    deploymentId: string,
    podName: string,
    fromStatus: string | null,
    toStatus: string,
    reason: string | null,
    exitCode: number | null,
  ) {
    await this.prisma.podTransition
      .create({ data: { deploymentId, podName, fromStatus, toStatus, reason, exitCode } })
      .catch(() => {});
  }

  private async trackCrashState(type: MirrorEventType, ctx: Ctx) {
    try {
      const pods = await this.prisma.pod.findMany({
        where: { deploymentId: ctx.deploymentId },
        select: { status: true },
      });
      const crashing = pods.some((p) => p.status === 'crashing');
      const track = this.crashTracks.get(ctx.deploymentId);

      if (!track) {
        if (type === 'add') {
          this.crashTracks.set(ctx.deploymentId, { crashing, notifiedCrash: false, lastNotifiedAt: 0 });
          return;
        }
        this.crashTracks.set(ctx.deploymentId, { crashing: false, notifiedCrash: false, lastNotifiedAt: 0 });
        if (crashing) this.scheduleCrashConfirm(ctx);
        return;
      }

      if (crashing && !track.crashing) {
        this.scheduleCrashConfirm(ctx);
        return;
      }

      if (!crashing && track.crashing) {
        if (track.confirmTimer) {
          clearTimeout(track.confirmTimer);
          track.confirmTimer = undefined;
        }
        track.crashing = false;
        if (track.notifiedCrash) {
          track.notifiedCrash = false;
          this.notifications
            .notifyPodState(ctx.deploymentId, 'recovered')
            .catch((err) => this.logger.warn(`recovery notification failed for ${ctx.deploymentId}: ${err?.message ?? err}`));
        }
      }

      if (pods.length === 0) {
        const remaining = this.crashTracks.get(ctx.deploymentId);
        if (remaining?.confirmTimer) clearTimeout(remaining.confirmTimer);
        this.crashTracks.delete(ctx.deploymentId);
      }
    } catch (err) {
      this.logger.warn(`trackCrashState(${ctx.deploymentId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private scheduleCrashConfirm(ctx: Ctx) {
    const track = this.crashTracks.get(ctx.deploymentId);
    if (!track) return;
    track.crashing = true;
    if (track.confirmTimer) return;
    track.confirmTimer = setTimeout(() => {
      track.confirmTimer = undefined;
      void this.confirmCrash(ctx);
    }, CRASH_CONFIRM_MS);
  }

  private async confirmCrash(ctx: Ctx) {
    if (this.stopped) return;
    const track = this.crashTracks.get(ctx.deploymentId);
    if (!track || !track.crashing || track.notifiedCrash) return;
    try {
      const crashingPod = await this.prisma.pod.findFirst({
        where: { deploymentId: ctx.deploymentId, status: 'crashing' },
        select: { lastTerminationReason: true, lastExitCode: true },
      });
      if (!crashingPod) {
        track.crashing = false;
        return;
      }
      const now = Date.now();
      if (now - track.lastNotifiedAt < CRASH_NOTIFY_COOLDOWN_MS) return;
      track.notifiedCrash = true;
      track.lastNotifiedAt = now;
      const detail = crashingPod.lastTerminationReason
        ? `${crashingPod.lastTerminationReason}${crashingPod.lastExitCode != null ? ` (exit code ${crashingPod.lastExitCode})` : ''}`
        : undefined;
      await this.notifications.notifyPodState(ctx.deploymentId, 'crashing', detail);
    } catch (err) {
      this.logger.warn(`confirmCrash(${ctx.deploymentId}) failed: ${(err as Error)?.message ?? err}`);
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

export function latestTermination(
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
export function computePodStatus(pod: k8s.V1Pod): string {
  const containerStatuses = pod.status?.containerStatuses ?? [];
  const phase = pod.status?.phase?.toLowerCase() || 'pending';
  const conditions = pod.status?.conditions ?? [];
  const isScheduled = conditions.some((c) => c.type === 'PodScheduled' && c.status === 'True');
  const isReady = conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  const allContainersReady =
    containerStatuses.length > 0 && containerStatuses.every((c) => c.ready === true);

  let status = phase;
  if (phase === 'running') {
    if (isReady && allContainersReady) status = 'ready';
    else if (isScheduled) status = 'scheduled';
    else status = 'pending';
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
