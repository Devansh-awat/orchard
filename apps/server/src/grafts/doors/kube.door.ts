import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import type { KubeConfig } from '@kubernetes/client-node';
import { LeaderElectionService } from '../../events/leader-election.service';
import { K8sCnpgService } from '../../kubernetes/k8s-cnpg.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { registerEngineShard, type EngineShardBuilder } from '../../engine/shards';
import type { GraftRecord } from '../graft-registry';
import { assertClaimed, bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class KubeDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'kube',
    version: 1,
    status: 'stable',
    capability: 'kube.read'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(LeaderElectionService) private readonly leader: LeaderElectionService
  ) {
    this.graft = bindGraft(parent, KubeDoorV1.meta);
  }

  private get kubernetes(): KubernetesService {
    return this.moduleRef.get(KubernetesService, { strict: false });
  }

  get kc(): KubeConfig | null {
    return this.kubernetes.kc ?? null;
  }

  isLeader(): boolean {
    return this.leader.isLeader();
  }

  onLeaderAcquired(listener: () => void): void {
    this.leader.onAcquired(listener);
  }

  registerEngineShard(build: EngineShardBuilder): void {
    if (!this.graft.manifest!.capabilities.includes('kube.informers')) {
      throw new Error(
        `graft ${this.graft.id} needs the "kube.informers" capability to watch resources`
      );
    }
    registerEngineShard(async () => {
      const shard = await build();
      if (!shard) return null;
      assertClaimed(this.graft, 'engineShards', shard.name, 'engine shard');
      return shard;
    });
  }

  registerMirrorShard(build: EngineShardBuilder): void {
    this.registerEngineShard(build);
  }

  databaseTlsHostname(namespace: string, clusterName: string): string | null {
    try {
      return this.moduleRef
        .get(K8sCnpgService, { strict: false })
        .publicTlsHostname(namespace, clusterName);
    } catch {
      return null;
    }
  }
}
