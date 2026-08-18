import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { PrismaService } from '../prisma/prisma.service';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';
import { OrgEventsService } from '../events/org-events.service';
import { Elector } from '../coordination/lease-elector';
import { MirrorInformer, MirrorRefs } from './mirror-informer';
import { MirrorShardDef, buildMirrorShards } from './mirror-shards';
import { PodMirrorConsumer } from './consumers/pod-mirror.consumer';
import { CnpgMirrorConsumer } from './consumers/cnpg-mirror.consumer';
import { JobMirrorConsumer } from './consumers/job-mirror.consumer';
import { WorkloadMirrorConsumer } from './consumers/workload-mirror.consumer';

const PRESENCE_PREFIX = 'replica:';
const PRESENCE_INTERVAL_MS = 10_000;
const BALANCE_INTERVAL_MS = 15_000;
const FLUSH_INTERVAL_MS = 10_000;
const RESYNC_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CRASH_SWEEP_INTERVAL_MS = 5_000;
const PRESENCE_FRESH_MS = 30_000;
const STALE_MS = 60_000;
const TRANSITION_RETENTION_DAYS = 30;
const NS_REF_TTL_MS = 10 * 60 * 1000;

interface ShardRuntime {
  def: MirrorShardDef;
  elector: Elector;
  informers: MirrorInformer[];
  activity: {
    lastListAt: Date | null;
    lastEventAt: Date | null;
    resourceVersion: string | null;
    // Per-informer watch health. A shard is only healthy when every one of its
    // informers has a live watch.
    unhealthy: Map<string, string>;
  };
  resyncTimer?: ReturnType<typeof setInterval>;
}

export interface ShardHealth {
  shard: string;
  holder: string | null;
  lastListAt: Date | null;
  lastEventAt: Date | null;
  lastResyncAt: Date | null;
  resyncRepairs: number;
  healthy: boolean;
  lastError: string | null;
  stale: boolean;
}

@Injectable()
export class MirrorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MirrorService.name);

  private readonly shards = new Map<string, ShardRuntime>();

  private readonly nsRefCache = new Map<string, { refs: MirrorRefs; exp: number }>();

  private timers: ReturnType<typeof setInterval>[] = [];

  private presentReplicas = 1;

  private lastStale = false;

  private enabled = false;

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly lease: LeaseService,
    private readonly orgEvents: OrgEventsService,
    private readonly podConsumer: PodMirrorConsumer,
    private readonly cnpgConsumer: CnpgMirrorConsumer,
    private readonly jobConsumer: JobMirrorConsumer,
    private readonly workloadConsumer: WorkloadMirrorConsumer,
  ) {}

  async onModuleInit() {
    if (process.env.MIRROR_DISABLED === 'true') {
      this.logger.warn('MIRROR_DISABLED=true — legacy informers stay active, mirror is off');
      return;
    }
    if (!this.kubernetes.kc) {
      this.logger.warn('no kubeconfig; mirror disabled');
      return;
    }
    this.enabled = true;

    const defs = buildMirrorShards({
      pods: this.podConsumer,
      cnpg: this.cnpgConsumer,
      jobs: this.jobConsumer,
      workloads: this.workloadConsumer,
      namespaceRefs: (ns) => this.resolveNamespaceRefs(ns),
    });

    for (const def of defs) {
      const runtime: ShardRuntime = {
        def,
        elector: this.lease.register(def.lease, {
          autoStart: false,
          shouldAcquire: () => this.canAcquireMore(),
        }),
        informers: [],
        activity: {
          lastListAt: null,
          lastEventAt: null,
          resourceVersion: null,
          unhealthy: new Map(),
        },
      };
      runtime.elector.on('acquired', () => {
        void this.startShard(runtime);
      });
      runtime.elector.on('lost', () => {
        void this.stopShard(runtime);
      });
      this.shards.set(def.name, runtime);
    }

    await this.upsertPresence();
    await this.refreshPresence();
    for (const runtime of this.shards.values()) runtime.elector.start();

    this.timers = [
      setInterval(() => {
        void this.upsertPresence();
      }, PRESENCE_INTERVAL_MS),
      setInterval(() => {
        void this.balance();
      }, BALANCE_INTERVAL_MS),
      setInterval(() => {
        void this.flushHeartbeats();
      }, FLUSH_INTERVAL_MS),
      setInterval(() => {
        void this.checkStaleness();
      }, 30_000),
      setInterval(() => {
        void this.retention();
      }, RETENTION_INTERVAL_MS),
      setInterval(() => {
        void this.sweepCrashStates();
      }, CRASH_SWEEP_INTERVAL_MS),
    ];
    for (const t of this.timers) t.unref?.();
    this.logger.log(`mirror initialized with ${defs.length} shards (${this.lease.replicaIdentity})`);
  }

  async onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
    for (const runtime of this.shards.values()) {
      await this.stopShard(runtime);
    }
  }

  async health(): Promise<{ shards: ShardHealth[]; replicas: string[] }> {
    const rows = await this.prisma.k8sMirrorHeartbeat.findMany();
    const now = Date.now();
    const shards: ShardHealth[] = [];
    const replicas: string[] = [];
    for (const row of rows) {
      if (row.shard.startsWith(PRESENCE_PREFIX)) {
        if (now - row.updatedAt.getTime() < PRESENCE_FRESH_MS) {
          replicas.push(row.shard.slice(PRESENCE_PREFIX.length));
        }
        continue;
      }
      shards.push({
        shard: row.shard,
        holder: row.holder,
        lastListAt: row.lastListAt,
        lastEventAt: row.lastEventAt,
        lastResyncAt: row.lastResyncAt,
        resyncRepairs: row.resyncRepairs,
        healthy: row.healthy,
        lastError: row.lastError,
        // The heartbeat timestamp only proves the holder's process is alive —
        // it is written on a timer regardless of whether the watch works. A
        // shard is stale when nobody holds it, when the holder stopped
        // heartbeating, or when the holder says its watch is down.
        stale: !row.holder || now - row.updatedAt.getTime() > STALE_MS || !row.healthy,
      });
    }
    for (const runtime of this.shards.values()) {
      if (!shards.some((s) => s.shard === runtime.def.name)) {
        shards.push({
          shard: runtime.def.name,
          holder: null,
          lastListAt: null,
          lastEventAt: null,
          lastResyncAt: null,
          resyncRepairs: 0,
          healthy: false,
          lastError: null,
          stale: true,
        });
      }
    }
    return { shards, replicas };
  }

  async resyncShard(name: string): Promise<number> {
    const runtime = this.shards.get(name);
    if (!runtime || !runtime.elector.isHolder()) return 0;
    let repairs = 0;
    for (const informer of runtime.informers) {
      repairs += await informer.resync();
    }
    if (repairs > 0) {
      await this.prisma.k8sMirrorHeartbeat.updateMany({
        where: { shard: name },
        data: { resyncRepairs: { increment: repairs }, lastResyncAt: new Date() },
      });
      this.logger.warn(`resync repaired ${repairs} objects in shard ${name}`);
    } else {
      await this.prisma.k8sMirrorHeartbeat.updateMany({
        where: { shard: name },
        data: { lastResyncAt: new Date() },
      });
    }
    return repairs;
  }

  heldShards(): string[] {
    return [...this.shards.values()]
      .filter((r) => r.elector.isHolder())
      .map((r) => r.def.name);
  }

  private canAcquireMore(): boolean {
    const cap = Math.ceil(this.shards.size / Math.max(1, this.presentReplicas));
    return this.heldShards().length < cap;
  }

  private async startShard(runtime: ShardRuntime): Promise<void> {
    if (runtime.informers.length > 0) return;
    this.logger.log(`starting shard ${runtime.def.name}`);
    runtime.activity.unhealthy.clear();
    runtime.informers = runtime.def.resources.map(
      (config) =>
        new MirrorInformer(this.kubernetes.kc!, this.prisma, runtime.def.name, config, {
          onListed: (rv) => {
            runtime.activity.lastListAt = new Date();
            runtime.activity.resourceVersion = rv;
          },
          onWatchEvent: () => {
            runtime.activity.lastEventAt = new Date();
          },
          onHealthChange: (healthy, error) => {
            if (healthy) runtime.activity.unhealthy.delete(config.kind);
            else runtime.activity.unhealthy.set(config.kind, error ?? 'watch down');
            void this.writeHeartbeat(runtime, this.lease.replicaIdentity);
          },
        }),
    );
    await this.writeHeartbeat(runtime, this.lease.replicaIdentity);
    for (const informer of runtime.informers) {
      await informer.start().catch((err) => {
        this.logger.warn(`shard ${runtime.def.name} informer start failed: ${err?.message ?? err}`);
      });
    }
    runtime.resyncTimer = setInterval(() => {
      void this.resyncShard(runtime.def.name);
    }, RESYNC_INTERVAL_MS + Math.floor(Math.random() * 60_000));
    runtime.resyncTimer.unref?.();
  }

  private async stopShard(runtime: ShardRuntime): Promise<void> {
    if (runtime.resyncTimer) {
      clearInterval(runtime.resyncTimer);
      runtime.resyncTimer = undefined;
    }
    const informers = runtime.informers;
    runtime.informers = [];
    for (const informer of informers) {
      await informer.stop().catch(() => {});
    }
    if (informers.length > 0) {
      this.logger.log(`stopped shard ${runtime.def.name}`);
      await this.prisma.k8sMirrorHeartbeat
        .updateMany({
          where: { shard: runtime.def.name, holder: this.lease.replicaIdentity },
          data: { holder: null },
        })
        .catch(() => {});
    }
  }

  private async upsertPresence(): Promise<void> {
    if (!this.enabled) return;
    const shard = PRESENCE_PREFIX + this.lease.replicaIdentity;
    await this.prisma.k8sMirrorHeartbeat
      .upsert({
        where: { shard },
        create: { shard, holder: this.lease.replicaIdentity },
        update: { holder: this.lease.replicaIdentity },
      })
      .catch(() => {});
  }

  private async refreshPresence(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - PRESENCE_FRESH_MS);
      const rows = await this.prisma.k8sMirrorHeartbeat.findMany({
        where: { shard: { startsWith: PRESENCE_PREFIX }, updatedAt: { gte: cutoff } },
        select: { shard: true },
      });
      const others = rows.map((r) => r.shard.slice(PRESENCE_PREFIX.length));
      this.presentReplicas = new Set([...others, this.lease.replicaIdentity]).size;
    } catch {
      this.presentReplicas = Math.max(1, this.presentReplicas);
    }
  }

  private async balance(): Promise<void> {
    if (!this.enabled) return;
    await this.refreshPresence();
    const cap = Math.ceil(this.shards.size / Math.max(1, this.presentReplicas));
    const held = [...this.shards.values()].filter((r) => r.elector.isHolder());
    const excess = held.length - cap;
    if (excess <= 0) return;
    this.logger.log(
      `holding ${held.length}/${this.shards.size} shards with ${this.presentReplicas} replicas present; resigning ${excess}`,
    );
    for (const runtime of held.slice(-excess)) {
      await runtime.elector.resign().catch(() => {});
    }
  }

  private async flushHeartbeats(): Promise<void> {
    for (const runtime of this.shards.values()) {
      if (!runtime.elector.isHolder()) continue;
      await this.writeHeartbeat(runtime, this.lease.replicaIdentity);
    }
  }

  private async writeHeartbeat(runtime: ShardRuntime, holder: string): Promise<void> {
    const failures = [...runtime.activity.unhealthy.entries()];
    const data = {
      holder,
      lastListAt: runtime.activity.lastListAt,
      lastEventAt: runtime.activity.lastEventAt,
      resourceVersion: runtime.activity.resourceVersion,
      healthy: failures.length === 0,
      lastError: failures.length === 0 ? null : failures.map(([k, e]) => `${k}: ${e}`).join('; ').slice(0, 300),
    };
    await this.prisma.k8sMirrorHeartbeat
      .upsert({
        where: { shard: runtime.def.name },
        create: { shard: runtime.def.name, ...data },
        update: data,
      })
      .catch(() => {});
  }

  private async checkStaleness(): Promise<void> {
    if (!this.enabled) return;
    try {
      const { shards } = await this.health();
      const stale = shards.some((s) => s.stale);
      if (stale === this.lastStale) return;
      this.lastStale = stale;
      for (const orgId of this.orgEvents.watchedOrgIds()) {
        this.orgEvents.emitLocal({
          organizationId: orgId,
          type: 'engine.changed',
          payload: { stale },
        });
      }
    } catch {}
  }

  // Crash/recovery notifications are debounced, so something has to notice when
  // a window elapses. Running it on the global leader keeps it to one replica;
  // the state itself lives in Postgres, so it does not matter whether that is
  // the replica holding the pods shard.
  private async sweepCrashStates(): Promise<void> {
    if (!this.enabled) return;
    if (!this.lease.isHolder(GLOBAL_LEADER_LEASE)) return;
    await this.podConsumer.sweepCrashStates();
  }

  private async retention(): Promise<void> {
    if (!this.lease.isHolder(GLOBAL_LEADER_LEASE)) return;
    const cutoff = new Date(Date.now() - TRANSITION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.podTransition.deleteMany({ where: { at: { lt: cutoff } } }).catch(() => {});
    const presenceCutoff = new Date(Date.now() - 60 * 60 * 1000);
    await this.prisma.k8sMirrorHeartbeat
      .deleteMany({
        where: { shard: { startsWith: PRESENCE_PREFIX }, updatedAt: { lt: presenceCutoff } },
      })
      .catch(() => {});
  }

  private async resolveNamespaceRefs(namespace: string): Promise<MirrorRefs> {
    if (!namespace) return {};
    const cached = this.nsRefCache.get(namespace);
    if (cached && cached.exp > Date.now()) return cached.refs;
    let refs: MirrorRefs = {};
    try {
      const project = await this.prisma.project.findFirst({
        where: { namespace },
        select: { id: true },
      });
      if (project) refs = { projectId: project.id };
    } catch {}
    this.nsRefCache.set(namespace, { refs, exp: Date.now() + NS_REF_TTL_MS });
    return refs;
  }
}
