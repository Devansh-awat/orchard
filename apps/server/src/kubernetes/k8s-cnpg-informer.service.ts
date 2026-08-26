import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from './kubernetes.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrgEventsService } from '../events/org-events.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PodLogCaptureService } from './pod-log-capture.service';
import { computePodStatus } from '../mirror/pod-status';

const CNPG_SELECTOR = 'cnpg.io/cluster';
const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const EMIT_COALESCE_MS = 250;
const ARCHIVING_SWEEP_MS = 2 * 60 * 1000;
const FRESH_TRANSITION_MS = 10 * 60 * 1000;
// Same debounce the deployment informer uses. A restarting Postgres flickers
// through crashing on its way back up, and announcing that is noise.
const CRASH_CONFIRM_MS = 30 * 1000;
const CRASH_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

interface Ctx {
  databaseId: string;
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
export class K8sCnpgInformerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(K8sCnpgInformerService.name);

  private informer?: k8s.Informer<k8s.V1Pod> & k8s.ObjectCache<k8s.V1Pod>;

  private backoffMs = 1000;

  private stopped = false;

  private restartTimer?: ReturnType<typeof setTimeout>;

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  private readonly archivingState = new Map<string, boolean>();

  private archivingTimer?: ReturnType<typeof setInterval>;

  private readonly crashTracks = new Map<string, CrashTrack>();

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly leader: LeaderElectionService,
    private readonly notifications: NotificationsService,
    private readonly logCapture: PodLogCaptureService,
  ) {}

  async onModuleInit() {
    const kc = this.kubernetes.kc;
    if (!kc) {
      this.logger.warn('No kubeconfig; cnpg informer disabled');
      return;
    }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const listFn = () =>
      coreApi.listPodForAllNamespaces(undefined, undefined, undefined, CNPG_SELECTOR);

    this.informer = k8s.makeInformer(kc, '/api/v1/pods', listFn, CNPG_SELECTOR);
    this.informer.on('add', (pod) => this.onPodEvent('add', pod));
    this.informer.on('update', (pod) => this.onPodEvent('update', pod));
    this.informer.on('delete', (pod) => this.onPodEvent('delete', pod));
    this.informer.on('connect', () => {
      this.backoffMs = 1000;
    });
    this.informer.on('error', (err) => {
      this.logger.warn(
        `cnpg informer error: ${(err as Error)?.message ?? err}; restarting in ${this.backoffMs}ms`,
      );
      this.scheduleRestart();
    });
    await this.start();

    this.archivingTimer = setInterval(() => {
      void this.sweepArchiving();
    }, ARCHIVING_SWEEP_MS);
    this.archivingTimer.unref?.();
    setTimeout(() => {
      void this.sweepArchiving();
    }, 15_000).unref?.();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.archivingTimer) clearInterval(this.archivingTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const t of this.crashTracks.values()) if (t.confirmTimer) clearTimeout(t.confirmTimer);
    this.crashTracks.clear();
    try {
      await this.informer?.stop();
    } catch {}
  }

  private async start() {
    if (this.stopped || !this.informer) return;
    try {
      await this.informer.start();
      this.logger.log('cnpg informer started');
    } catch (err) {
      this.logger.warn(`cnpg informer start failed: ${(err as Error)?.message ?? err}`);
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
    const clusterName = pod.metadata?.labels?.['cnpg.io/cluster'];
    if (!ns || !clusterName) return;
    const ctx = await this.resolveCtx(ns, clusterName);
    if (!ctx) return;

    await this.syncPod(type, ctx.databaseId, pod);
    void this.trackCrashState(type, ctx);

    // Postgres prints the reason it died into its own stdout, and the pod is
    // gone by the time anyone opens the page. Capture it on the way past.
    if (type !== 'delete') {
      void this.logCapture.capture(ctx.databaseId, ns, pod, 'database');
    }

    this.scheduleEmit(ctx, this.buildPayload(type, pod));
  }

  private async syncPod(type: 'add' | 'update' | 'delete', databaseId: string, pod: k8s.V1Pod) {
    const name = pod.metadata?.name;
    if (!name) return;

    try {
      if (type === 'delete') {
        await this.prisma.databasePod.deleteMany({ where: { databaseId, name } });
        return;
      }

      const containerStatuses = pod.status?.containerStatuses ?? [];
      const term = latestTermination(containerStatuses);
      const data = {
        podIp: pod.status?.podIP ?? null,
        nodeName: pod.spec?.nodeName ?? null,
        status: computePodStatus(pod),
        restartCount: containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
        ready:
          pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? null,
        lastTerminationReason: term?.reason ?? null,
        lastExitCode: term?.exitCode ?? null,
        lastTerminatedAt: term?.finishedAt ?? null,
      };

      await this.prisma.databasePod.upsert({
        where: { databaseId_name: { databaseId, name } },
        create: { databaseId, name, ...data },
        update: data,
      });
    } catch (err) {
      this.logger.warn(`syncPod(${databaseId}/${name}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private async trackCrashState(type: 'add' | 'update' | 'delete', ctx: Ctx) {
    try {
      const pods = await this.prisma.databasePod.findMany({
        where: { databaseId: ctx.databaseId },
        select: { status: true },
      });
      const crashing = pods.some((p) => p.status === 'crashing');
      const track = this.crashTracks.get(ctx.databaseId);

      if (!track) {
        // On the first observation of an existing pod we adopt its state
        // silently. Otherwise every process restart would announce every
        // already-crashing database all over again.
        if (type === 'add') {
          this.crashTracks.set(ctx.databaseId, {
            crashing,
            notifiedCrash: false,
            lastNotifiedAt: 0,
          });
          return;
        }
        this.crashTracks.set(ctx.databaseId, {
          crashing: false,
          notifiedCrash: false,
          lastNotifiedAt: 0,
        });
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
            .notifyDbState(ctx.databaseId, 'recovered')
            .catch((err) =>
              this.logger.warn(
                `db recovery notification failed for ${ctx.databaseId}: ${err?.message ?? err}`,
              ),
            );
        }
      }

      if (pods.length === 0) {
        const remaining = this.crashTracks.get(ctx.databaseId);
        if (remaining?.confirmTimer) clearTimeout(remaining.confirmTimer);
        this.crashTracks.delete(ctx.databaseId);
      }
    } catch (err) {
      this.logger.warn(
        `trackCrashState(${ctx.databaseId}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private scheduleCrashConfirm(ctx: Ctx) {
    const track = this.crashTracks.get(ctx.databaseId);
    if (!track) return;
    track.crashing = true;
    if (track.confirmTimer) return;
    track.confirmTimer = setTimeout(() => {
      track.confirmTimer = undefined;
      void this.confirmCrash(ctx);
    }, CRASH_CONFIRM_MS);
    track.confirmTimer.unref?.();
  }

  private async confirmCrash(ctx: Ctx) {
    if (this.stopped || !this.leader.isLeader()) return;
    const track = this.crashTracks.get(ctx.databaseId);
    if (!track || !track.crashing || track.notifiedCrash) return;
    try {
      const crashingPod = await this.prisma.databasePod.findFirst({
        where: { databaseId: ctx.databaseId, status: 'crashing' },
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
      await this.notifications.notifyDbState(ctx.databaseId, 'crashing', detail);
    } catch (err) {
      this.logger.warn(`confirmCrash(${ctx.databaseId}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private scheduleEmit(ctx: Ctx, payload: unknown) {
    const key = ctx.databaseId;
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
      type: 'database.changed',
      id: ctx.databaseId,
      projectId: ctx.projectId,
      payload,
    });
  }

  private buildPayload(type: 'add' | 'update' | 'delete', pod: k8s.V1Pod) {
    const name = pod.metadata?.name;
    if (type === 'delete') return { deleted: true, pod: name };
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const term = latestTermination(containerStatuses);
    return {
      pod: name,
      phase: pod.status?.phase ?? null,
      ready:
        pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
      restartCount: containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
      lastTermination: term?.reason
        ? { reason: term.reason, exitCode: term.exitCode, finishedAt: term.finishedAt }
        : null,
    };
  }

  private async sweepArchiving() {
    if (this.stopped || !this.leader.isLeader()) return;
    const kc = this.kubernetes.kc;
    if (!kc) return;
    try {
      const api = kc.makeApiClient(k8s.CustomObjectsApi);
      const { body } = await api.listClusterCustomObject('postgresql.cnpg.io', 'v1', 'clusters');
      const items: any[] = (body as any)?.items || [];
      for (const cluster of items) {
        const ns = cluster.metadata?.namespace;
        const name = cluster.metadata?.name;
        if (!ns || !name) continue;
        const cond = (cluster.status?.conditions || []).find(
          (c: any) => c.type === 'ContinuousArchiving',
        );
        if (!cond) continue;
        const ok = cond.status === 'True';
        const key = `${ns}/${name}`;
        const prev = this.archivingState.get(key);
        this.archivingState.set(key, ok);
        if (prev === ok) continue;
        if (prev === undefined) {
          const t = cond.lastTransitionTime ? Date.parse(cond.lastTransitionTime) : NaN;
          const fresh = !Number.isNaN(t) && Date.now() - t < FRESH_TRANSITION_MS;
          if (ok || !fresh) continue;
        }
        const ctx = await this.resolveCtx(ns, name);
        if (!ctx) continue;
        this.scheduleEmit(ctx, { archiving: ok });
        await this.notifications
          .notifyDbArchiving(ctx.databaseId, ok ? 'recovered' : 'failing', cond.message || undefined)
          .catch(() => {});
      }
    } catch (err) {
      this.logger.warn(`archiving sweep failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private async resolveCtx(ns: string, clusterName: string): Promise<Ctx | null> {
    const key = `${ns}/${clusterName}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    let ctx: Ctx | null = null;
    try {
      const db = await this.prisma.database.findFirst({
        where: { namespace: ns, clusterName },
        select: {
          id: true,
          projectId: true,
          project: { select: { organizationId: true } },
        },
      });
      if (db) {
        ctx = { databaseId: db.id, orgId: db.project.organizationId, projectId: db.projectId };
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
