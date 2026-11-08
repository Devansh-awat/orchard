import * as k8s from '@kubernetes/client-node';
import { TENANT_NAMESPACE_LABEL_SELECTORS } from '../kubernetes/security-policies';
import {
  ABUSE_QUOTA_NAME,
  DENY_POLICY_NAME,
  ORG_QUOTA_NAME,
  type AdmissionFacts,
  type DaemonSetFact,
  type IssuerFact,
  type NamespaceFact,
  type NodeFact
} from './doctor.checks';
import { isNotFound } from './doctor.types';

export const SELFTEST_LABEL = 'orchard.my/selftest';

export interface ClusterReader {
  apiGroups(): Promise<string[]>;
  daemonSets(): Promise<DaemonSetFact[]>;
  nodes(): Promise<NodeFact[]>;
  managedNamespaces(): Promise<NamespaceFact[]>;
  denyPolicyNamespaces(): Promise<string[]>;
  quotas(): Promise<Record<string, string[]>>;
  runtimeClassExists(name: string): Promise<boolean>;
  admission(): Promise<AdmissionFacts>;
  priorityClassExists(name: string): Promise<boolean>;
  clusterIssuer(name: string): Promise<IssuerFact>;
}

const ADMISSION_GROUP = 'admissionregistration.k8s.io';

export class KubeClusterReader implements ClusterReader {
  constructor(private readonly kc: k8s.KubeConfig) {}

  async apiGroups(): Promise<string[]> {
    const { body } = await this.kc.makeApiClient(k8s.ApisApi).getAPIVersions();
    return (body.groups ?? []).map((g) => g.name);
  }

  async daemonSets(): Promise<DaemonSetFact[]> {
    const { body } = await this.kc.makeApiClient(k8s.AppsV1Api).listDaemonSetForAllNamespaces();
    return body.items.map((d) => ({
      name: d.metadata?.name ?? '',
      namespace: d.metadata?.namespace ?? '',
      desired: d.status?.desiredNumberScheduled ?? 0,
      ready: d.status?.numberReady ?? 0
    }));
  }

  async nodes(): Promise<NodeFact[]> {
    const { body } = await this.kc.makeApiClient(k8s.CoreV1Api).listNode();
    return body.items.map((n) => ({
      name: n.metadata?.name ?? '',
      kubelet: n.status?.nodeInfo?.kubeletVersion ?? ''
    }));
  }

  async managedNamespaces(): Promise<NamespaceFact[]> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const byName = new Map<string, NamespaceFact>();
    for (const selector of TENANT_NAMESPACE_LABEL_SELECTORS) {
      const { body } = await core.listNamespace(
        undefined,
        undefined,
        undefined,
        undefined,
        selector
      );
      for (const ns of body.items) {
        const name = ns.metadata?.name;
        const labels = ns.metadata?.labels ?? {};
        if (!name || labels[SELFTEST_LABEL] !== undefined) continue;
        byName.set(name, { name, labels });
      }
    }
    return [...byName.values()];
  }

  async denyPolicyNamespaces(): Promise<string[]> {
    const { body } = await this.kc
      .makeApiClient(k8s.NetworkingV1Api)
      .listNetworkPolicyForAllNamespaces(undefined, undefined, `metadata.name=${DENY_POLICY_NAME}`);
    return body.items.map((p) => p.metadata?.namespace ?? '').filter(Boolean);
  }

  async quotas(): Promise<Record<string, string[]>> {
    const { body } = await this.kc
      .makeApiClient(k8s.CoreV1Api)
      .listResourceQuotaForAllNamespaces(
        undefined,
        undefined,
        undefined,
        'app.kubernetes.io/managed-by=orchard'
      );
    const out: Record<string, string[]> = {};
    for (const q of body.items) {
      const ns = q.metadata?.namespace;
      const name = q.metadata?.name;
      if (!ns || !name) continue;
      if (name !== ORG_QUOTA_NAME && name !== ABUSE_QUOTA_NAME) continue;
      (out[ns] ??= []).push(name);
    }
    return out;
  }

  async runtimeClassExists(name: string): Promise<boolean> {
    try {
      await this.kc.makeApiClient(k8s.NodeV1Api).readRuntimeClass(name);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async admission(): Promise<AdmissionFacts> {
    const custom = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const list = async (plural: string): Promise<any[]> => {
      for (const version of ['v1', 'v1beta1']) {
        try {
          const res: any = await custom.listClusterCustomObject(ADMISSION_GROUP, version, plural);
          return res.body?.items ?? [];
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      return [];
    };
    const [policies, bindings] = await Promise.all([
      list('validatingadmissionpolicies'),
      list('validatingadmissionpolicybindings')
    ]);
    return {
      policies: policies.map((p) => String(p.metadata?.name ?? '')).filter(Boolean),
      bindings: bindings.map((b) => ({
        name: String(b.metadata?.name ?? ''),
        policyName: String(b.spec?.policyName ?? ''),
        actions: Array.isArray(b.spec?.validationActions)
          ? b.spec.validationActions.map(String)
          : []
      }))
    };
  }

  async priorityClassExists(name: string): Promise<boolean> {
    try {
      await this.kc.makeApiClient(k8s.SchedulingV1Api).readPriorityClass(name);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async clusterIssuer(name: string): Promise<IssuerFact> {
    try {
      const res: any = await this.kc
        .makeApiClient(k8s.CustomObjectsApi)
        .getClusterCustomObject('cert-manager.io', 'v1', 'clusterissuers', name);
      const conditions: any[] = res.body?.status?.conditions ?? [];
      const ready = conditions.find((c) => c.type === 'Ready');
      return { exists: true, ready: ready ? ready.status === 'True' : null };
    } catch (error) {
      if (isNotFound(error)) return { exists: false, ready: null };
      throw error;
    }
  }
}
