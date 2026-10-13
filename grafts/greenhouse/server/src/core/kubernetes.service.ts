import { Inject, Injectable } from '@nestjs/common';
import type { KubeConfig } from '@kubernetes/client-node';
import { Doors, type KubeDoor } from '@orchard/graft-sdk/server';

@Injectable()
export class KubernetesService {
  constructor(@Inject(Doors.kube) private readonly kube: KubeDoor) {}

  get kc(): KubeConfig | null {
    return (this.kube.kc as unknown as KubeConfig | null) ?? null;
  }
}

@Injectable()
export class K8sCnpgService {
  constructor(@Inject(Doors.kube) private readonly kube: KubeDoor) {}

  publicTlsHostname(namespace: string, clusterName: string): string {
    return this.kube.databaseTlsHostname(namespace, clusterName) ?? '';
  }
}
