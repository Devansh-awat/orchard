import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { GuardKind, GuardManifest } from './compare';

export interface GuardKey {
  kind: GuardKind;
  namespace: string;
  name: string;
}

export type LiveRead = { state: 'present'; obj: GuardManifest } | { state: 'absent' };

export interface GuardCluster {
  read(key: GuardKey): Promise<LiveRead>;
  namespaceActive(namespace: string): Promise<boolean>;
  create(key: GuardKey, manifest: GuardManifest): Promise<GuardManifest>;
  replace(key: GuardKey, manifest: GuardManifest): Promise<GuardManifest>;
  secretValue(namespace: string, name: string, field: string): Promise<string | null>;
}

const PLURALS: Record<Exclude<GuardKind, 'NetworkPolicy'>, string> = {
  CiliumNetworkPolicy: 'ciliumnetworkpolicies',
  CiliumEnvoyConfig: 'ciliumenvoyconfigs'
};

export function statusOf(err: unknown): number | undefined {
  const e = err as any;
  return e?.response?.statusCode ?? e?.statusCode ?? e?.body?.code;
}

function plain(body: unknown): GuardManifest {
  return JSON.parse(JSON.stringify(body ?? {}));
}

export class K8sGuardCluster implements GuardCluster {
  constructor(private readonly kubernetes: KubernetesService) {}

  private get kc(): k8s.KubeConfig {
    this.kubernetes.ensureKubeConfig();
    return this.kubernetes.kc!;
  }

  async read(key: GuardKey): Promise<LiveRead> {
    try {
      if (key.kind === 'NetworkPolicy') {
        const { body } = await this.kc
          .makeApiClient(k8s.NetworkingV1Api)
          .readNamespacedNetworkPolicy(key.name, key.namespace);
        return { state: 'present', obj: plain(body) };
      }
      const { body } = await this.kc
        .makeApiClient(k8s.CustomObjectsApi)
        .getNamespacedCustomObject('cilium.io', 'v2', key.namespace, PLURALS[key.kind], key.name);
      return { state: 'present', obj: plain(body) };
    } catch (err) {
      if (statusOf(err) === 404) return { state: 'absent' };
      throw err;
    }
  }

  async namespaceActive(namespace: string): Promise<boolean> {
    try {
      const { body } = await this.kc.makeApiClient(k8s.CoreV1Api).readNamespace(namespace);
      return !body.metadata?.deletionTimestamp && body.status?.phase !== 'Terminating';
    } catch (err) {
      if (statusOf(err) === 404) return false;
      throw err;
    }
  }

  async create(key: GuardKey, manifest: GuardManifest): Promise<GuardManifest> {
    if (key.kind === 'NetworkPolicy') {
      const { body } = await this.kc
        .makeApiClient(k8s.NetworkingV1Api)
        .createNamespacedNetworkPolicy(key.namespace, manifest as k8s.V1NetworkPolicy);
      return plain(body);
    }
    const { body } = await this.kc
      .makeApiClient(k8s.CustomObjectsApi)
      .createNamespacedCustomObject('cilium.io', 'v2', key.namespace, PLURALS[key.kind], manifest);
    return plain(body);
  }

  async replace(key: GuardKey, manifest: GuardManifest): Promise<GuardManifest> {
    if (key.kind === 'NetworkPolicy') {
      const { body } = await this.kc
        .makeApiClient(k8s.NetworkingV1Api)
        .replaceNamespacedNetworkPolicy(key.name, key.namespace, manifest as k8s.V1NetworkPolicy);
      return plain(body);
    }
    const { body } = await this.kc
      .makeApiClient(k8s.CustomObjectsApi)
      .replaceNamespacedCustomObject(
        'cilium.io',
        'v2',
        key.namespace,
        PLURALS[key.kind],
        key.name,
        manifest
      );
    return plain(body);
  }

  async secretValue(namespace: string, name: string, field: string): Promise<string | null> {
    try {
      const { body } = await this.kc
        .makeApiClient(k8s.CoreV1Api)
        .readNamespacedSecret(name, namespace);
      const raw = body.data?.[field];
      return raw ? Buffer.from(raw, 'base64').toString('utf8') : null;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }
}
