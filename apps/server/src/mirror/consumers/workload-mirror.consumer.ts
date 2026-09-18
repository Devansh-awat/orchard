import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgEventsService } from '../../events/org-events.service';
import {
  cpuLimitMilliFromResources,
  memoryLimitBytesFromResources
} from '../../kubernetes/quantity';
import { resolvePullPolicy } from '../../kubernetes/trusted-images';
import { disruptionBudgetActive, readMinAvailable } from '../../kubernetes/disruption-budget';
import { ApplyQueueService } from '../../apply/apply-queue.service';
import { MirrorEventType, MirrorRefs } from '../mirror-informer';

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const EMIT_COALESCE_MS = 500;

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
export class WorkloadMirrorConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(WorkloadMirrorConsumer.name);

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly applyQueue: ApplyQueueService
  ) {}

  onModuleDestroy() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async mapRefs(dep: k8s.V1Deployment): Promise<MirrorRefs> {
    const ctx = await this.resolveCtx(dep);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  // A PodDisruptionBudget carries the deployment's name, so it resolves
  // through the same lookup.
  async mapPdbRefs(pdb: k8s.V1PodDisruptionBudget): Promise<MirrorRefs> {
    const ctx = await this.resolveCtx(pdb);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  /**
   * Kubernetes is truth for the budget too: a `kubectl edit` of minAvailable
   * lands back in the deployments row.
   *
   * A delete is deliberately NOT adopted as 0. Orchard deletes the object
   * itself whenever the budget cannot be satisfied (scaling to one replica,
   * say), and treating that as intent would erase the setting the user picked
   * and never restore it on the way back up.
   */
  async onPdbEvent(type: MirrorEventType, pdb: k8s.V1PodDisruptionBudget): Promise<void> {
    if (type === 'delete') return;
    const ctx = await this.resolveCtx(pdb);
    if (!ctx) return;

    const observed = readMinAvailable(pdb.spec);
    if (observed == null) return;

    const row = await this.prisma.deployment.findUnique({
      where: { id: ctx.deploymentId },
      select: { pdbMinAvailable: true }
    });
    if (!row || row.pdbMinAvailable === observed) return;

    const pendingApply = await this.prisma.k8sApplyItem.count({
      where: { deploymentId: ctx.deploymentId, status: { in: ['pending', 'applying'] } }
    });
    if (pendingApply > 0) return;

    await this.prisma.deployment.update({
      where: { id: ctx.deploymentId },
      data: { pdbMinAvailable: observed }
    });
    this.logger.log(
      `adopted external disruption budget for ${ctx.deploymentId}: minAvailable=${observed}`
    );

    // A budget edited by hand can ask for more pods than the app runs, which
    // leaves zero allowed disruptions and stalls any drain that touches it.
    // The value is kept as the user's intent; the object itself is queued for
    // removal until the replica count can satisfy it again.
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: ctx.deploymentId },
      select: { replicas: true }
    });
    if (deployment && !disruptionBudgetActive(observed, deployment.replicas)) {
      await this.queueBudgetReconcile(ctx.deploymentId);
    }
  }

  private async queueBudgetReconcile(deploymentId: string): Promise<void> {
    await this.applyQueue.enqueue({
      dedupeKey: `op:deployment.disruptionBudget:${deploymentId}`,
      opType: 'deployment.disruptionBudget',
      deploymentId
    });
  }

  async onEvent(type: MirrorEventType, dep: k8s.V1Deployment): Promise<void> {
    const ctx = await this.resolveCtx(dep);
    if (!ctx) return;

    // Failures are left to propagate. The informer holds this object's
    // derived_version back when they do and re-derives it on the next pass;
    // catching here would report the replica counts as written when they were
    // not, and the row would sit wrong until the deployment happened to change.
    if (type === 'delete') {
      await this.prisma.k8sWorkload.deleteMany({ where: { deploymentId: ctx.deploymentId } });
      this.scheduleEmit(ctx, { workload: null, deleted: true });
      return;
    }

    const specReplicas = dep.spec?.replicas ?? null;
    const data = {
      specReplicas,
      readyReplicas: dep.status?.readyReplicas ?? 0,
      availableReplicas: dep.status?.availableReplicas ?? 0,
      updatedReplicas: dep.status?.updatedReplicas ?? 0,
      observedImage: dep.spec?.template?.spec?.containers?.[0]?.image ?? null,
      conditions: (dep.status?.conditions ?? []) as object[]
    };

    const existing = await this.prisma.k8sWorkload.findUnique({
      where: { deploymentId: ctx.deploymentId }
    });
    await this.prisma.k8sWorkload.upsert({
      where: { deploymentId: ctx.deploymentId },
      create: { deploymentId: ctx.deploymentId, ...data },
      update: data
    });

    const changed =
      !existing ||
      existing.specReplicas !== data.specReplicas ||
      existing.readyReplicas !== data.readyReplicas ||
      existing.availableReplicas !== data.availableReplicas ||
      existing.updatedReplicas !== data.updatedReplicas ||
      existing.observedImage !== data.observedImage;
    if (changed) {
      this.scheduleEmit(ctx, { workload: data });
    }

    // Last, because it is the only part of this handler allowed to defer. The
    // mirrored row and the event above are correct either way and clients read
    // them; adoption is the slower question of whether Kubernetes has out-voted
    // the stored intent, and it is fine for that to land a pass later.
    await this.adoptWorkloadSpec(ctx.deploymentId, dep);
  }

  // Kubernetes is truth: unambiguous spec fields edited outside Orchard
  // (kubectl scale / set image / resources patch) are adopted into the
  // deployments row. Env is deliberately excluded — Orchard env carries
  // ${{shared.*}} references and encrypted secrets that a raw k8s env list
  // cannot round-trip.
  private async adoptWorkloadSpec(deploymentId: string, dep: k8s.V1Deployment): Promise<void> {
    const row = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        replicas: true,
        stopped: true,
        image: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true,
        deployStrategy: true,
        imagePullPolicy: true,
        buildStatus: true
      }
    });
    if (!row) return;

    // A build or a queued apply is about to rewrite the object, so the spec in
    // hand is not evidence of anything. Thrown rather than returned: the
    // informer only marks an object derived when the handler succeeds, so this
    // leaves it `underived` and runs again on the repair pass. Returning
    // quietly instead drops the adoption for good — the Deployment does not
    // change again, so the next list sees a matching derived_version and skips
    // it. That is how a deployment scaled to zero outside Orchard kept
    // reporting one replica for eleven days.
    if (row.buildStatus === 'building') {
      throw new Error(`adoption deferred for ${deploymentId}: build in flight`);
    }
    const pendingApply = await this.prisma.k8sApplyItem.count({
      where: { deploymentId, status: { in: ['pending', 'applying'] } }
    });
    if (pendingApply > 0) {
      throw new Error(`adoption deferred for ${deploymentId}: ${pendingApply} apply item(s) queued`);
    }

    const changes: Record<string, unknown> = {};
    const adopted: string[] = [];

    const specReplicas = dep.spec?.replicas;
    if (!row.stopped && specReplicas != null && specReplicas !== row.replicas) {
      changes.replicas = specReplicas;
      adopted.push(`replicas=${specReplicas}`);
    }

    const container = dep.spec?.template?.spec?.containers?.[0];
    const image = container?.image;
    if (image && row.image && image !== row.image) {
      changes.image = image;
      adopted.push(`image=${image}`);
    }

    const cpuMilli = cpuLimitMilliFromResources(container?.resources);
    if (cpuMilli > 0 && cpuMilli !== row.cpuRequestMilli) {
      changes.cpuRequestMilli = cpuMilli;
      adopted.push(`cpu=${cpuMilli}m`);
    }
    const memoryBytes = memoryLimitBytesFromResources(container?.resources);
    if (
      memoryBytes > 0 &&
      (row.memoryRequestBytes == null || BigInt(memoryBytes) !== row.memoryRequestBytes)
    ) {
      changes.memoryRequestBytes = BigInt(memoryBytes);
      adopted.push(`memory=${memoryBytes}`);
    }

    const strategy = dep.spec?.strategy?.type === 'Recreate' ? 'recreate' : 'rollingUpdate';
    if (dep.spec?.strategy?.type && strategy !== row.deployStrategy) {
      changes.deployStrategy = strategy;
      adopted.push(`strategy=${strategy}`);
    }

    // Guarded rather than adopted blindly: k8s also allows `Never`, which is not
    // in our enum and would fail the write for every other field in this batch.
    //
    // Compared against the EFFECTIVE policy, not the stored column. A null
    // column means "derive from the tag", and the live object legitimately
    // carries that derived value — adopting it would silently convert every
    // automatic deployment into a pinned one.
    const pullPolicy = container?.imagePullPolicy;
    if (
      (pullPolicy === 'Always' || pullPolicy === 'IfNotPresent') &&
      pullPolicy !== resolvePullPolicy(row.imagePullPolicy, (changes.image as string) ?? row.image)
    ) {
      changes.imagePullPolicy = pullPolicy;
      adopted.push(`pullPolicy=${pullPolicy}`);
    }

    if (Object.keys(changes).length === 0) return;
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: changes
    });
    this.logger.log(`adopted external spec for ${deploymentId}: ${adopted.join(', ')}`);

    // Whether a disruption budget may exist at all is a function of the
    // replica count, so a `kubectl scale` past it has to be answered. Without
    // this, scaling 3 -> 2 under a minAvailable of 2 leaves a budget behind
    // that allows no disruptions and blocks every drain on those pods.
    if (changes.replicas != null) {
      await this.queueBudgetReconcile(deploymentId);
    }
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
      type: 'deployment.changed',
      id: ctx.deploymentId,
      projectId: ctx.projectId,
      payload
    });
  }

  private async resolveCtx(obj: { metadata?: k8s.V1ObjectMeta }): Promise<Ctx | null> {
    const ns = obj.metadata?.namespace;
    const name = obj.metadata?.name;
    if (!ns || !name) return null;
    const key = `${ns}/${name}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    // A lookup that throws is left to propagate: `null` means "no such
    // deployment", which callers store as an answer, and a database blip must
    // not be mistaken for one. Nothing is cached on that path either.
    const row = await this.prisma.deployment.findFirst({
      where: { namespace: ns, name },
      select: {
        id: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    const ctx: Ctx | null = row
      ? { deploymentId: row.id, orgId: row.project.organizationId, projectId: row.projectId }
      : null;

    this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return ctx;
  }
}
