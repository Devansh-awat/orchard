import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PodLogCaptureService } from '../../kubernetes/pod-log-capture.service';
import { EngineEventType, EngineObjectKey, EngineRefs } from '../core/informer';
import { computePodStatus, latestTermination, podRecord } from '../pod-status';
import { rowMayBePending } from './row-pending';

export { computePodStatus, latestTermination } from '../pod-status';

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const EMIT_COALESCE_MS = 250;

// A container in CrashLoopBackOff briefly leaves the backoff state every time
// it restarts, so both edges are debounced: a deployment must hold a crashing
// pod this long before it is announced, and must hold none for the recovery
// window before it is called recovered. The UI's own pod warnings are derived
// straight from the mirrored rows and are not debounced: this only governs
// outbound notifications.
const CRASH_CONFIRM_MS = 30_000;
const RECOVER_CONFIRM_MS = 60_000;

interface Ctx {
  deploymentId: string;
  orgId: string;
  projectId: string;
}

type PodPayload = { name?: string; deleted?: boolean; [key: string]: unknown };

interface PendingEmit {
  ctx: Ctx;
  pods: Map<string, PodPayload>;
  timer: ReturnType<typeof setTimeout>;
}

function appNameOf(pod: k8s.V1Pod): string | undefined {
  const labels = pod.metadata?.labels;
  return labels?.['orchard.my/app'] ?? labels?.['app.kubernetes.io/name'];
}

function isGreen(pod: k8s.V1Pod): boolean {
  return pod.metadata?.labels?.['orchard.my/slot'] === 'green';
}

@Injectable()
export class PodConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(PodConsumer.name);

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly logCapture: PodLogCaptureService,
    private readonly notifications: NotificationsService
  ) {}

  onModuleDestroy() {
    this.stopped = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async pruneStalePods(seen: EngineObjectKey[]): Promise<void> {
    // One pod whose owner could not be resolved means this pass does not know
    // which deployment that pod belongs to, and pruning against a partial
    // picture would delete a live pod's row. The next pass prunes instead.
    if (seen.some((s) => s.refs === null)) {
      this.logger.warn('skipping pod prune: this pass could not resolve every pod');
      return;
    }
    const liveDeploymentIds: string[] = [];
    const liveNames: string[] = [];
    for (const key of seen) {
      const deploymentId = key.refs?.deploymentId;
      if (!deploymentId || !key.name) continue;
      liveDeploymentIds.push(deploymentId);
      liveNames.push(key.name);
    }
    // Keyed on the (deployment, pod name) pair rather than the name alone: pod
    // names are only unique within a namespace, so a bare name match keeps a
    // dead row alive whenever some other deployment happens to run a pod with
    // the same name, and drops a live one when it doesn't.
    //
    // `unnest` binds the pairs as two array parameters. An `IN (...)` list
    // binds one parameter per pod and blows the statement's parameter budget on
    // a large cluster.
    const removed = await this.prisma.$queryRaw<{ deployment_id: string }[]>`
      DELETE FROM "pods" AS p
      WHERE NOT EXISTS (
        SELECT 1
        FROM unnest(${liveDeploymentIds}::uuid[], ${liveNames}::varchar[])
          AS live("deployment_id", "name")
        WHERE live."deployment_id" = p."deployment_id" AND live."name" = p."name"
      )
      RETURNING p."deployment_id"
    `;
    if (removed.length === 0) return;
    this.logger.log(`pruned ${removed.length} stale pod rows not present in the cluster`);
    // Dropping the last crashing pod of a deployment has to clear its alert.
    for (const deploymentId of new Set(removed.map((r) => r.deployment_id))) {
      await this.reconcileCrashState(deploymentId);
    }
  }

  async mapRefs(pod: k8s.V1Pod): Promise<EngineRefs> {
    const ns = pod.metadata?.namespace;
    const depName = appNameOf(pod);
    if (!ns || !depName) return {};
    const ctx = await this.resolveCtx(ns, depName, pod.metadata?.creationTimestamp);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  async onEvent(type: EngineEventType, pod: k8s.V1Pod): Promise<void> {
    const ns = pod.metadata?.namespace;
    const depName = appNameOf(pod);
    if (!ns || !depName) return;
    const ctx = await this.resolveCtx(ns, depName, pod.metadata?.creationTimestamp);
    if (!ctx) return;

    if (isGreen(pod)) {
      this.scheduleEmit(ctx, this.buildPayload(type, pod));
      return;
    }

    const statusChanged = await this.syncPod(type, ctx.deploymentId, pod);

    // Only a pod whose own status moved can move the deployment's aggregate
    // crash state. Most watch events are resourceVersion churn, and those cost
    // nothing beyond the row write.
    if (statusChanged) await this.reconcileCrashState(ctx.deploymentId);

    if (type !== 'delete') {
      void this.logCapture.capture(ctx.deploymentId, ns, pod);
    }

    this.scheduleEmit(ctx, this.buildPayload(type, pod));
  }

  private scheduleEmit(ctx: Ctx, payload: PodPayload) {
    const key = ctx.deploymentId;
    const now = Date.now();
    const last = this.lastEmit.get(key) ?? 0;
    const podKey = String(payload.name ?? '');

    const existing = this.pending.get(key);
    if (existing) {
      existing.pods.set(podKey, payload);
      return;
    }
    if (now - last >= EMIT_COALESCE_MS) {
      this.lastEmit.set(key, now);
      this.emit(ctx, [payload]);
      return;
    }
    const delay = EMIT_COALESCE_MS - (now - last);
    const timer = setTimeout(() => {
      const p = this.pending.get(key);
      this.pending.delete(key);
      this.lastEmit.set(key, Date.now());
      if (p) this.emit(p.ctx, [...p.pods.values()]);
    }, delay);
    this.pending.set(key, { ctx, pods: new Map([[podKey, payload]]), timer });
  }

  private emit(ctx: Ctx, pods: PodPayload[]) {
    const last = pods[pods.length - 1];
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'pod.changed',
      id: ctx.deploymentId,
      projectId: ctx.projectId,
      payload: { ...last, pods }
    });
  }

  private buildPayload(type: EngineEventType, pod: k8s.V1Pod): PodPayload {
    const name = pod.metadata?.name;
    if (type === 'delete') return { deleted: true, name };
    const containerStatuses = pod.status?.containerStatuses ?? [];
    const term = latestTermination(containerStatuses);
    return {
      ...podRecord(pod),
      ready:
        pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
      lastTermination: term?.reason
        ? { reason: term.reason, exitCode: term.exitCode, finishedAt: term.finishedAt }
        : null
    };
  }

  /** Returns whether the pod's derived status changed (or the row appeared/vanished). */
  private async syncPod(
    type: EngineEventType,
    deploymentId: string,
    pod: k8s.V1Pod
  ): Promise<boolean> {
    const name = pod.metadata?.name;
    if (!name) return false;

    // Deliberately not wrapped in a catch. A pod row that failed to write has
    // to be visible to the informer, which holds the object's derived_version
    // back and comes round again: swallowing it here is what let a pod that
    // never changes again sit missing from this table indefinitely.
    const existing = await this.prisma.pod.findUnique({
      where: { deploymentId_name: { deploymentId, name } },
      select: { status: true }
    });

    if (type === 'delete') {
      if (!existing) return false;
      await this.prisma.pod.deleteMany({ where: { deploymentId, name } });
      await this.recordTransition(deploymentId, name, existing.status, 'deleted', null, null);
      return true;
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
      lastTerminatedAt: term?.finishedAt ?? null
    };

    await this.prisma.pod.upsert({
      where: { deploymentId_name: { deploymentId, name } },
      create: { deploymentId, name, ...data },
      update: data
    });

    if (existing && existing.status === status) return false;
    await this.recordTransition(
      deploymentId,
      name,
      existing?.status ?? null,
      status,
      term?.reason ?? null,
      term?.exitCode ?? null
    );
    return true;
  }

  private async recordTransition(
    deploymentId: string,
    podName: string,
    fromStatus: string | null,
    toStatus: string,
    reason: string | null,
    exitCode: number | null
  ) {
    await this.prisma.podTransition
      .create({ data: { deploymentId, podName, fromStatus, toStatus, reason, exitCode } })
      .catch(() => {});
  }

  /**
   * Bring one deployment's persisted crash state in line with its mirrored pod
   * rows. Safe to call from anywhere and as often as you like: it reads the
   * current cluster picture rather than accumulating in-process state, so a
   * shard failover mid-crash neither loses nor duplicates a notification.
   */
  async reconcileCrashState(deploymentId: string): Promise<void> {
    if (this.stopped) return;
    try {
      const [crashing, total] = await this.prisma.$transaction([
        this.prisma.pod.count({ where: { deploymentId, status: 'crashing' } }),
        this.prisma.pod.count({ where: { deploymentId } })
      ]);
      await this.applyCrashState(deploymentId, crashing, total);
    } catch (err) {
      this.logger.warn(
        `reconcileCrashState(${deploymentId}) failed: ${(err as Error)?.message ?? err}`
      );
    }
  }

  private async applyCrashState(
    deploymentId: string,
    crashingPods: number,
    totalPods: number
  ): Promise<void> {
    const state = await this.prisma.deploymentCrashState.findUnique({ where: { deploymentId } });
    const now = new Date();

    if (crashingPods > 0) {
      if (!state || !state.crashingSince) {
        await this.prisma.deploymentCrashState.upsert({
          where: { deploymentId },
          create: { deploymentId, crashingSince: now, healthySince: null, notifiedAt: null },
          update: { crashingSince: now, healthySince: null, notifiedAt: null }
        });
        return;
      }
      if (state.healthySince) {
        await this.prisma.deploymentCrashState.updateMany({
          where: { deploymentId },
          data: { healthySince: null }
        });
      }
      if (state.notifiedAt) return;
      if (now.getTime() - state.crashingSince.getTime() < CRASH_CONFIRM_MS) return;

      // Claim the notification with a conditional write so the shard holder and
      // the sweeper can't both send it.
      const claimed = await this.prisma.deploymentCrashState.updateMany({
        where: { deploymentId, notifiedAt: null },
        data: { notifiedAt: now }
      });
      if (claimed.count === 0) return;

      const pod = await this.prisma.pod.findFirst({
        where: { deploymentId, status: 'crashing' },
        select: { lastTerminationReason: true, lastExitCode: true }
      });
      const detail = pod?.lastTerminationReason
        ? `${pod.lastTerminationReason}${pod.lastExitCode != null ? ` (exit code ${pod.lastExitCode})` : ''}`
        : undefined;
      await this.notifications.notifyPodState(deploymentId, 'crashing', detail);
      return;
    }

    if (!state) return;

    if (!state.healthySince) {
      await this.prisma.deploymentCrashState.updateMany({
        where: { deploymentId },
        data: { healthySince: now, crashingSince: state.notifiedAt ? state.crashingSince : null }
      });
      return;
    }
    if (now.getTime() - state.healthySince.getTime() < RECOVER_CONFIRM_MS) return;

    if (!state.notifiedAt) {
      // The crash cleared before it was ever announced: drop the episode.
      await this.prisma.deploymentCrashState.deleteMany({
        where: { deploymentId, notifiedAt: null }
      });
      return;
    }

    const claimed = await this.prisma.deploymentCrashState.deleteMany({
      where: { deploymentId, notifiedAt: { not: null } }
    });
    if (claimed.count === 0) return;
    // No pods at all means the app was scaled down or torn down, not recovered.
    if (totalPods > 0) await this.notifications.notifyPodState(deploymentId, 'recovered');
  }

  /**
   * Level-triggered pass over every deployment that either holds crash state or
   * currently has a crashing pod. This is what fires the debounced transitions
   * (nothing schedules an in-process timer for them) and what heals state that
   * drifted while no replica held the pods shard.
   */
  async sweepCrashStates(): Promise<void> {
    if (this.stopped) return;
    try {
      const [tracked, crashing] = await this.prisma.$transaction([
        this.prisma.deploymentCrashState.findMany({ select: { deploymentId: true } }),
        this.prisma.pod.findMany({
          where: { status: 'crashing' },
          select: { deploymentId: true },
          distinct: ['deploymentId']
        })
      ]);
      const ids = new Set([
        ...tracked.map((t) => t.deploymentId),
        ...crashing.map((c) => c.deploymentId)
      ]);
      for (const id of ids) {
        await this.reconcileCrashState(id);
      }
    } catch (err) {
      this.logger.warn(`crash state sweep failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private async resolveCtx(
    ns: string,
    depName: string,
    createdAt: Date | undefined
  ): Promise<Ctx | null> {
    const key = `${ns}/${depName}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    // A lookup that throws is left to propagate: `null` here means "no such
    // deployment", which callers store as a real answer, and a database blip
    // must never be mistaken for one. Nothing is cached on that path either.
    const dep = await this.prisma.deployment.findFirst({
      where: { namespace: ns, name: depName },
      select: {
        id: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    const ctx: Ctx | null = dep
      ? { deploymentId: dep.id, orgId: dep.project.organizationId, projectId: dep.projectId }
      : null;

    if (ctx || !rowMayBePending(createdAt)) {
      this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    }
    return ctx;
  }
}
