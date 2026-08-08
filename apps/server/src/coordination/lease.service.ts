import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'os';
import { readFileSync } from 'fs';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { Elector, LeaseElector, StaticElector } from './lease-elector';

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

  // Real election requires an unambiguous installation boundary. In-cluster
  // that's our own namespace; out-of-cluster it must be opted into via
  // ORCHARD_CONTROL_NAMESPACE. Defaulting out-of-cluster processes into a
  // shared lease would let a laptop dev server (which points its kubeconfig
  // at the same cluster prod manages) steal leadership from prod replicas.
  private static resolveNamespace(): string | null {
    if (process.env.ORCHARD_CONTROL_NAMESPACE) return process.env.ORCHARD_CONTROL_NAMESPACE;
    try {
      const ns = readFileSync(SA_NAMESPACE_PATH, 'utf-8').trim();
      if (ns) return ns;
    } catch {}
    return null;
  }

  register(
    name: string,
    opts?: { leaseDurationSeconds?: number; renewIntervalMs?: number; autoStart?: boolean },
  ): Elector {
    const existing = this.electors.get(name);
    if (existing) return existing;
    let elector: Elector;
    if (!this.kubernetes.kc || !this.namespace) {
      const holder = process.env.NODE_ENV !== 'production';
      if (!holder) {
        this.logger.error(
          `lease ${name} cannot be held (no ${!this.kubernetes.kc ? 'kubeconfig' : 'control namespace — set ORCHARD_CONTROL_NAMESPACE for out-of-cluster deployments'}); leader-only work is disabled on this replica`,
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
      });
    }
    this.electors.set(name, elector);
    if (opts?.autoStart !== false) elector.start();
    return elector;
  }

  isHolder(name: string): boolean {
    return this.electors.get(name)?.isHolder() ?? false;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.electors.values()].map((elector) => elector.stop()));
  }
}
