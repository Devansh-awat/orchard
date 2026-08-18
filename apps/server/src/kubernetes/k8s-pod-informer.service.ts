import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from './kubernetes.service';
import { computePodStatus, latestTermination } from '../mirror/pod-status';
import { PrismaService } from '../prisma/prisma.service';
import { OrgEventsService } from '../events/org-events.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PodLogCaptureService } from './pod-log-capture.service';

const ORCHARD_SELECTOR = 'app.kubernetes.io/managed-by=orchard';
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
export class K8sPodInformerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(K8sPodInformerService.name);

  private informer?: k8s.Informer<k8s.V1Pod> & k8s.ObjectCache<k8s.V1Pod>;

  private backoffMs = 1000;

  private stopped = false;

  private restartTimer?: ReturnType<typeof setTimeout>;

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  private readonly crashTracks = new Map<string, CrashTrack>();

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly leader: LeaderElectionService,
    private readonly logCapture: PodLogCaptureService,
    private readonly notifications: NotificationsService,
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
    for (const t of this.crashTracks.values()) {
      if (t.confirmTimer) clearTimeout(t.confirmTimer);
    }
    this.crashTracks.clear();
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
    void this.trackCrashState(type, ctx);

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

  private async trackCrashState(type: 'add' | 'update' | 'delete', ctx: Ctx) {
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
    if (this.stopped || !this.leader.isLeader()) return;
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


