import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'os';
import { readFileSync } from 'fs';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { Elector, LeaseElector, StaticElector } from '../engine/core/lease-elector';

export const GLOBAL_LEADER_LEASE = 'orchard-global-leader';

const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

@Injectable()
export class LeaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(LeaseService.name);

  private readonly electors = new Map<string, Elector>();

  private readonly identity = hostname();

  private readonly namespace: string | null;

  constructor(private readonly kubernetes: KubernetesService) {
    this.namespace = LeaseService.resolveNamespace();
  }

  private static resolveNamespace(): string | null {
    if (process.env.ORCHARD_CONTROL_NAMESPACE) return process.env.ORCHARD_CONTROL_NAMESPACE;
    try {
      const ns = readFileSync(SA_NAMESPACE_PATH, 'utf-8').trim();
      if (ns) return ns;
    } catch {}
    return null;
  }

  get replicaIdentity(): string {
    return this.identity;
  }

  // Whether this process is a member of the cluster it is pointed at: it has a
  // cluster to talk to, and a namespace whose leases it can contend for. A dev
  // process holding a real kubeconfig but no control namespace fails this, and
  // that is the whole point — it cannot see the leases, so it can neither win
  // nor lose them, and anything cluster-wide it runs is a second uncoordinated
  // actor on someone else's infrastructure.
  get canCoordinate(): boolean {
    return !!this.kubernetes.kc && !!this.namespace;
  }

  register(
    name: string,
    opts?: {
      leaseDurationSeconds?: number;
      renewIntervalMs?: number;
      autoStart?: boolean;
      shouldAcquire?: () => boolean;
    }
  ): Elector {
    const existing = this.electors.get(name);
    if (existing) return existing;
    let elector: Elector;
    if (!this.kubernetes.kc || !this.namespace) {
      // Acting as sole holder is only safe with no cluster to contend with. A
      // kubeconfig means we are pointed at a real cluster whose own replicas
      // already hold these leases, so a dev process that merely lacks a control
      // namespace must stay out of leader-only work rather than appoint itself
      // a second leader: it cannot see the lease, so it cannot lose it, and it
      // would run reconcilers (build recovery, the mirror shards) against live
      // infrastructure in parallel with production.
      const holder = !this.kubernetes.kc && process.env.NODE_ENV !== 'production';
      if (!holder) {
        this.logger.error(
          `lease ${name} cannot be held (no ${!this.kubernetes.kc ? 'kubeconfig' : 'control namespace — set ORCHARD_CONTROL_NAMESPACE for out-of-cluster deployments'}); leader-only work is disabled on this replica`
        );
      } else {
        this.logger.log(`lease ${name}: out-of-cluster dev mode, acting as sole holder`);
      }
      elector = new StaticElector(holder);
    } else {
      elector = new LeaseElector(this.kubernetes.kc, {
        namespace: this.namespace,
        name,
        identity: this.identity,
        leaseDurationSeconds: opts?.leaseDurationSeconds,
        renewIntervalMs: opts?.renewIntervalMs,
        shouldAcquire: opts?.shouldAcquire,
        logger: new Logger(`LeaseElector:${name}`)
      });
    }
    this.electors.set(name, elector);
    if (opts?.autoStart !== false) elector.start();
    return elector;
  }

  isHolder(name: string): boolean {
    return this.electors.get(name)?.isHolder() ?? false;
  }

  // Registration order across modules is not guaranteed, so a caller may
  // subscribe before the lease exists. Register it here rather than making
  // every caller worry about who booted first.
  onAcquired(name: string, listener: () => void): void {
    const elector = this.electors.get(name) ?? this.register(name);
    elector.on('acquired', listener);
    // Already leader by the time this ran: fire once so the subscriber is not
    // stuck waiting for an edge that has already passed.
    if (elector.isHolder()) setImmediate(listener);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.electors.values()].map((elector) => elector.stop()));
  }
}
