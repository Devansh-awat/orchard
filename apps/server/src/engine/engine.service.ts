import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { engineDisabled } from './engine-disabled';
import { CLUSTER_IDENTITY_NAMESPACE, PrismaEngineStore } from './prisma-store';
import { PrismaService } from '../prisma/prisma.service';
import { resolveNamespaceScope } from '../projects/namespace-scope';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';
import { OrgEventsService } from '../events/org-events.service';
import { Elector } from './core/lease-elector';
import {
  Failure,
  lastingFailures,
  RESIGN_COOLDOWN_MS,
  shardIsStale,
  shouldHandOver,
  UNHEALTHY_GRACE_MS
} from './core/health';
import { EngineInformer, EngineRefs } from './core/informer';
import { EngineShard, buildEngineShards, registeredEngineShards } from './shards';
import { PodConsumer } from './consumers/pod.consumer';
import { CnpgConsumer } from './consumers/cnpg.consumer';
import { JobConsumer } from './consumers/job.consumer';
import { CronJobConsumer } from './consumers/cronjob.consumer';
import { WorkloadConsumer } from './consumers/workload.consumer';
import { IngressConsumer } from './consumers/ingress.consumer';
import { StorageConsumer } from './consumers/storage.consumer';
import { ServiceConsumer } from './consumers/service.consumer';
import { NamespaceConsumer } from './consumers/namespace.consumer';
import { GuardConsumer } from './consumers/guard.consumer';
import { EventConsumer } from './consumers/event.consumer';
import { ScanJobConsumer } from './consumers/scan-job.consumer';

const PRESENCE_PREFIX = 'replica:';
const PRESENCE_INTERVAL_MS = 10_000;
const BALANCE_INTERVAL_MS = 15_000;
const FLUSH_INTERVAL_MS = 20_000;
const RESYNC_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DB_STATS_INTERVAL_MS = 30_000;
const VOLUME_SWEEP_INTERVAL_MS = 60_000;
const POD_ROWS_REBUILD_INTERVAL_MS = 10 * 60 * 1000;
const TENANT_POLICY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CRASH_SWEEP_INTERVAL_MS = 5_000;
const PRESENCE_FRESH_MS = 30_000;
const TRANSITION_RETENTION_DAYS = 30;
const CLUSTER_EVENT_RETENTION_DAYS = 30;
const NS_REF_TTL_MS = 10 * 60 * 1000;
const NS_REF_NEGATIVE_TTL_MS = 30 * 1000;
const VERIFY_RETRY_MS = 5_000;
const VERIFY_RETRY_MAX_MS = 60_000;

interface ShardRuntime {
  def: EngineShard;
  elector: Elector;
  informers: EngineInformer[];
  activity: {
    lastListAt: Date | null;
    lastEventAt: Date | null;
    resourceVersion: string | null;
    // Per-informer watch health. A shard is only healthy when every one of its
    // informers has a live watch.
    unhealthy: Map<string, Failure>;
  };
  resyncTimer?: ReturnType<typeof setInterval>;
  graceTimer?: ReturnType<typeof setTimeout>;
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
export class EngineService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EngineService.name);

  private readonly shards = new Map<string, ShardRuntime>();

  private readonly cooldownUntil = new Map<string, number>();

  private readonly nsRefCache = new Map<string, { refs: EngineRefs; exp: number }>();

  private timers: ReturnType<typeof setInterval>[] = [];

  private presentReplicas = 1;

  private lastStale = false;

  private enabled = false;

  private destroyed = false;

  private verifyTimer?: ReturnType<typeof setTimeout>;

  private readonly store: PrismaEngineStore;

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly prisma: PrismaService,
    private readonly lease: LeaseService,
    private readonly orgEvents: OrgEventsService,
    private readonly podConsumer: PodConsumer,
    private readonly cnpgConsumer: CnpgConsumer,
    private readonly jobConsumer: JobConsumer,
    private readonly cronJobConsumer: CronJobConsumer,
    private readonly workloadConsumer: WorkloadConsumer,
    private readonly ingressConsumer: IngressConsumer,
    private readonly storageConsumer: StorageConsumer,
    private readonly serviceConsumer: ServiceConsumer,
    private readonly namespaceConsumer: NamespaceConsumer,
    private readonly guardConsumer: GuardConsumer,
    private readonly eventConsumer: EventConsumer,
    private readonly scanJobConsumer: ScanJobConsumer
  ) {
    this.store = new PrismaEngineStore(prisma);
  }

  async onApplicationBootstrap() {
    if (engineDisabled()) {
      this.logger.warn('ENGINE_DISABLED=true: legacy informers stay active, the engine is off');
      return;
    }
    if (!this.kubernetes.kc) {
      this.logger.warn('no kubeconfig; mirror disabled');
      return;
    }
    // Presence is written before any lease is held, so gating only on the lease
    // would still let an outsider register itself as a replica and shrink every
    // real replica's shard cap, leaving shards unheld and the engine reported
    // down. A process that cannot coordinate stays out of the table entirely.
    if (!this.lease.canCoordinate) {
      this.logger.warn(
        'no control namespace (set ORCHARD_CONTROL_NAMESPACE for out-of-cluster deployments); mirror disabled so this replica cannot claim shards or presence in a cluster it is not part of'
      );
      return;
    }
    this.enabled = true;

    const defs = buildEngineShards({
      pods: this.podConsumer,
      cnpg: this.cnpgConsumer,
      jobs: this.jobConsumer,
      cronJobs: this.cronJobConsumer,
      workloads: this.workloadConsumer,
      ingresses: this.ingressConsumer,
      storage: this.storageConsumer,
      services: this.serviceConsumer,
      namespaces: this.namespaceConsumer,
      certManager: await this.certManagerInstalled(),
      guard: this.guardConsumer,
      events: this.eventConsumer,
      scans: this.scanJobConsumer,
      cilium: await this.ciliumWatchable(),
      namespaceRefs: (ns) => this.resolveNamespaceRefs(ns)
    });
    for (const build of registeredEngineShards()) {
      try {
        const def = await build();
        if (def) defs.push(def);
      } catch (e: any) {
        this.logger.warn(`extension mirror shard skipped: ${e?.message}`);
      }
    }

    for (const def of defs) {
      const runtime: ShardRuntime = {
        def,
        elector: this.lease.register(def.lease, {
          autoStart: false,
          shouldAcquire: () =>
            this.canAcquireMore() && (this.cooldownUntil.get(def.name) ?? 0) <= Date.now()
        }),
        informers: [],
        activity: {
          lastListAt: null,
          lastEventAt: null,
          resourceVersion: null,
          unhealthy: new Map()
        }
      };
      runtime.elector.on('acquired', () => {
        void this.startShard(runtime);
      });
      runtime.elector.on('lost', () => {
        void this.stopShard(runtime);
      });
      this.shards.set(def.name, runtime);
    }

    void this.startOnVerifiedMirror();

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
      setInterval(() => {
        void this.sampleDatabaseStats();
      }, DB_STATS_INTERVAL_MS),
      setInterval(() => {
        void this.sweepVolumes();
      }, VOLUME_SWEEP_INTERVAL_MS),
      setInterval(() => {
        void this.rebuildPodRows();
      }, POD_ROWS_REBUILD_INTERVAL_MS),
      setInterval(() => {
        void this.checkTenantPolicies();
      }, TENANT_POLICY_CHECK_INTERVAL_MS)
    ];
    this.lease.onAcquired(GLOBAL_LEADER_LEASE, () => {
      void this.rebuildPodRows().then(() => this.sweepVolumes());
    });
    for (const t of this.timers) t.unref?.();
    this.logger.log(
      `mirror initialized with ${defs.length} shards (${this.lease.replicaIdentity})`
    );
  }

  private async startOnVerifiedMirror(): Promise<void> {
    let delay = VERIFY_RETRY_MS;
    while (!this.destroyed) {
      try {
        const clusterUid = await this.clusterUid();
        if (await this.store.dropForeignMirror(clusterUid)) {
          this.logger.warn(
            `the mirror was recorded against another cluster (${CLUSTER_IDENTITY_NAMESPACE} is now ${clusterUid}); discarded it and rebuilding from this cluster`
          );
        }
        break;
      } catch (err) {
        this.logger.warn(
          `could not check which cluster the mirror belongs to, shards stay down until it can: ${(err as Error)?.message ?? err}`
        );
        await new Promise<void>((resolve) => {
          this.verifyTimer = setTimeout(resolve, delay);
          this.verifyTimer.unref?.();
        });
        delay = Math.min(delay * 2, VERIFY_RETRY_MAX_MS);
      }
    }
    if (this.destroyed) return;
    await this.upsertPresence();
    await this.refreshPresence();
    for (const runtime of this.shards.values()) runtime.elector.start();
  }

  protected async clusterUid(): Promise<string> {
    const { body } = await this.kubernetes
      .kc!.makeApiClient(k8s.CoreV1Api)
      .readNamespace(CLUSTER_IDENTITY_NAMESPACE);
    const uid = body?.metadata?.uid;
    if (!uid) throw new Error(`namespace ${CLUSTER_IDENTITY_NAMESPACE} has no uid`);
    return uid;
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    for (const t of this.timers) clearInterval(t);
    for (const runtime of this.shards.values()) {
      await this.stopShard(runtime);
    }
  }

  async health(): Promise<{ shards: ShardHealth[]; replicas: string[]; undelivered: number }> {
    // Objects whose manifest we hold but whose derived state has not landed.
    // Normally zero, and briefly non-zero while a failure is being retried. A
    // number that stays up means consumers are failing and the mirror is
    // telling you so, instead of quietly serving state that stopped moving.
    const [rows, undelivered] = await Promise.all([
      this.prisma.k8sMirrorHeartbeat.findMany(),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count
        FROM "k8s_objects"
        WHERE "derived_version" IS NULL
          OR split_part("derived_version", '#', 1) <> "resource_version"
      `
    ]);
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
        // The heartbeat timestamp only proves the holder's process is alive,
        // it is written on a timer regardless of whether the watch works. A
        // shard is stale when the holder stopped heartbeating, or when the
        // holder says its watch has been down for longer than the grace. A
        // released shard whose last heartbeat is fresh is a handoff, not an
        // outage: the next replica claims it within the balance interval.
        stale: shardIsStale(row, now)
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
          stale: true
        });
      }
    }
    return { shards, replicas, undelivered: Number(undelivered[0]?.count ?? 0) };
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
        data: { resyncRepairs: { increment: repairs }, lastResyncAt: new Date() }
      });
      this.logger.warn(`resync repaired ${repairs} objects in shard ${name}`);
    } else {
      await this.prisma.k8sMirrorHeartbeat.updateMany({
        where: { shard: name },
        data: { lastResyncAt: new Date() }
      });
    }
    return repairs;
  }

  heldShards(): string[] {
    return [...this.shards.values()].filter((r) => r.elector.isHolder()).map((r) => r.def.name);
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
        new EngineInformer(
          this.kubernetes.kc!,
          this.store,
          runtime.def.name,
          config,
          {
            onListed: (rv) => {
              runtime.activity.lastListAt = new Date();
              runtime.activity.resourceVersion = rv;
            },
            onWatchEvent: () => {
              runtime.activity.lastEventAt = new Date();
            },
            onHealthChange: (healthy, error) => {
              if (healthy) {
                runtime.activity.unhealthy.delete(config.kind);
                void this.writeHeartbeat(runtime, this.lease.replicaIdentity);
                return;
              }
              runtime.activity.unhealthy.set(config.kind, {
                error: error ?? 'watch down',
                since: Date.now()
              });
              if (runtime.graceTimer) clearTimeout(runtime.graceTimer);
              runtime.graceTimer = setTimeout(() => {
                runtime.graceTimer = undefined;
                if (runtime.informers.length === 0) return;
                void this.writeHeartbeat(runtime, this.lease.replicaIdentity);
              }, UNHEALTHY_GRACE_MS + 500);
              runtime.graceTimer.unref?.();
            }
          },
          new Logger(`Engine:${runtime.def.name}/${config.kind}`)
        )
    );
    await this.writeHeartbeat(runtime, this.lease.replicaIdentity);
    for (const informer of runtime.informers) {
      await informer.start().catch((err) => {
        this.logger.warn(`shard ${runtime.def.name} informer start failed: ${err?.message ?? err}`);
      });
    }
    runtime.resyncTimer = setInterval(
      () => {
        void this.resyncShard(runtime.def.name);
      },
      RESYNC_INTERVAL_MS + Math.floor(Math.random() * 60_000)
    );
    runtime.resyncTimer.unref?.();
  }

  private async stopShard(runtime: ShardRuntime): Promise<void> {
    if (runtime.resyncTimer) {
      clearInterval(runtime.resyncTimer);
      runtime.resyncTimer = undefined;
    }
    if (runtime.graceTimer) {
      clearTimeout(runtime.graceTimer);
      runtime.graceTimer = undefined;
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
          data: { holder: null }
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
        update: { holder: this.lease.replicaIdentity }
      })
      .catch(() => {});
  }

  private async refreshPresence(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - PRESENCE_FRESH_MS);
      const rows = await this.prisma.k8sMirrorHeartbeat.findMany({
        where: { shard: { startsWith: PRESENCE_PREFIX }, updatedAt: { gte: cutoff } },
        select: { shard: true }
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
    const now = Date.now();
    for (const runtime of this.shards.values()) {
      if (!runtime.elector.isHolder()) continue;
      if (!shouldHandOver(runtime.activity.unhealthy, now, this.presentReplicas)) continue;
      const failures = lastingFailures(runtime.activity.unhealthy, now)
        .map(([kind, error]) => `${kind}: ${error}`)
        .join('; ');
      this.logger.error(
        `shard ${runtime.def.name} has been unhealthy on this replica for too long (${failures}); handing it to another replica`
      );
      this.cooldownUntil.set(runtime.def.name, now + RESIGN_COOLDOWN_MS);
      await runtime.elector.resign().catch(() => {});
    }
    const cap = Math.ceil(this.shards.size / Math.max(1, this.presentReplicas));
    const held = [...this.shards.values()].filter((r) => r.elector.isHolder());
    const excess = held.length - cap;
    if (excess <= 0) return;
    this.logger.log(
      `holding ${held.length}/${this.shards.size} shards with ${this.presentReplicas} replicas present; resigning ${excess}`
    );
    for (const runtime of held.slice(-excess)) {
      await runtime.elector.resign().catch(() => {});
    }
  }

  private async flushHeartbeats(): Promise<void> {
    const held = [...this.shards.values()].filter((r) => r.elector.isHolder());
    if (held.length === 0) return;
    await this.prisma
      .$transaction(
        held.map((runtime) => this.heartbeatUpsert(runtime, this.lease.replicaIdentity))
      )
      .catch(async (err) => {
        this.logger.warn(
          `batched heartbeat failed, writing shards one by one: ${err?.message ?? err}`
        );
        for (const runtime of held) await this.writeHeartbeat(runtime, this.lease.replicaIdentity);
      });
  }

  private async writeHeartbeat(runtime: ShardRuntime, holder: string): Promise<void> {
    await this.heartbeatUpsert(runtime, holder).catch(() => {});
  }

  private heartbeatUpsert(runtime: ShardRuntime, holder: string) {
    const failures = lastingFailures(runtime.activity.unhealthy, Date.now());
    const data = {
      holder,
      lastListAt: runtime.activity.lastListAt,
      lastEventAt: runtime.activity.lastEventAt,
      resourceVersion: runtime.activity.resourceVersion,
      healthy: failures.length === 0,
      lastError:
        failures.length === 0
          ? null
          : failures
              .map(([k, e]) => `${k}: ${e}`)
              .join('; ')
              .slice(0, 300)
    };
    return this.prisma.k8sMirrorHeartbeat.upsert({
      where: { shard: runtime.def.name },
      create: { shard: runtime.def.name, ...data },
      update: data
    });
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
          payload: { stale }
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
    await this.cnpgConsumer.sweepCrashStates();
  }

  private async sweepVolumes(): Promise<void> {
    if (!this.enabled) return;
    if (!this.lease.isHolder(GLOBAL_LEADER_LEASE)) return;
    await this.cnpgConsumer.sweepVolumes().catch((err) => {
      this.logger.warn(`volume sweep failed: ${(err as Error)?.message ?? err}`);
    });
  }

  private async checkTenantPolicies(): Promise<void> {
    if (!this.enabled) return;
    if (!this.lease.isHolder(GLOBAL_LEADER_LEASE)) return;
    await this.guardConsumer.checkTenantPolicies().catch((err) => {
      this.logger.warn(`tenant policy check failed: ${(err as Error)?.message ?? err}`);
    });
  }

  private async rebuildPodRows(): Promise<void> {
    if (!this.enabled) return;
    if (!this.lease.isHolder(GLOBAL_LEADER_LEASE)) return;
    await this.cnpgConsumer.rebuildPodRows().catch((err) => {
      this.logger.warn(`database pod rebuild failed: ${(err as Error)?.message ?? err}`);
    });
  }

  private async sampleDatabaseStats(): Promise<void> {
    if (!this.enabled) return;
    if (!this.lease.isHolder(GLOBAL_LEADER_LEASE)) return;
    await this.cnpgConsumer.sampleAllStats();
  }

  private async retention(): Promise<void> {
    if (!this.lease.isHolder(GLOBAL_LEADER_LEASE)) return;
    const cutoff = new Date(Date.now() - TRANSITION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.podTransition.deleteMany({ where: { at: { lt: cutoff } } }).catch(() => {});
    await this.eventConsumer.prune(CLUSTER_EVENT_RETENTION_DAYS).catch(() => {});
    const presenceCutoff = new Date(Date.now() - 60 * 60 * 1000);
    await this.prisma.k8sMirrorHeartbeat
      .deleteMany({
        where: { shard: { startsWith: PRESENCE_PREFIX }, updatedAt: { lt: presenceCutoff } }
      })
      .catch(() => {});
  }

  private async certManagerInstalled(): Promise<boolean> {
    try {
      await this.kubernetes
        .kc!.makeApiClient(k8s.ApiextensionsV1Api)
        .readCustomResourceDefinition('certificates.cert-manager.io');
      return true;
    } catch (e: any) {
      const code = e?.response?.statusCode ?? e?.statusCode;
      if (code !== 404) {
        this.logger.warn(
          `could not check for cert-manager, certificates stay unmirrored: ${e?.message}`
        );
      }
      return false;
    }
  }

  private async ciliumWatchable(): Promise<{ networkPolicies: boolean; envoyConfigs: boolean }> {
    if (!(await this.kubernetes.isCiliumAvailable())) {
      return { networkPolicies: false, envoyConfigs: false };
    }
    const probe = async (plural: string): Promise<boolean> => {
      try {
        await this.kubernetes
          .kc!.makeApiClient(k8s.CustomObjectsApi)
          .listClusterCustomObject(
            'cilium.io',
            'v2',
            plural,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            1
          );
        return true;
      } catch (e: any) {
        const code = e?.response?.statusCode ?? e?.statusCode;
        if (code !== 404) {
          this.logger.warn(
            `cannot watch ${plural}, the guard leaves them unwatched: ${e?.message}`
          );
        }
        return false;
      }
    };
    return {
      networkPolicies: await probe('ciliumnetworkpolicies'),
      envoyConfigs: await probe('ciliumenvoyconfigs')
    };
  }

  private async resolveNamespaceRefs(namespace: string): Promise<EngineRefs> {
    if (!namespace) return {};
    const cached = this.nsRefCache.get(namespace);
    if (cached && cached.exp > Date.now()) return cached.refs;
    // Left to throw. Swallowing the error and caching `{}` told the informer
    // this namespace belongs to no project, for the next ten minutes, and for
    // as long afterwards as none of its objects changed.
    const scope = await resolveNamespaceScope(this.prisma, namespace);
    const refs: EngineRefs = scope ? { projectId: scope.projectId } : {};
    this.nsRefCache.set(namespace, {
      refs,
      exp: Date.now() + (scope ? NS_REF_TTL_MS : NS_REF_NEGATIVE_TTL_MS)
    });
    return refs;
  }
}
