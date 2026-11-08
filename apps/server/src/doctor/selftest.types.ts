import type { Topology } from './selftest.plan';

export const LISTENER_PORT = 8080;

export interface NamespaceShape {
  managed: boolean;
  denyPolicy: boolean;
  quota: boolean;
  podSecurity: string | null;
}

export interface PodState {
  phase: string;
  ip: string | null;
  detail: string;
}

export interface SelfTestPodInput {
  name: string;
  role: 'listener' | 'probe';
  env?: Record<string, string>;
}

export interface SelfTestTimeouts {
  listenerMs: number;
  probeMs: number;
  deleteMs: number;
  pollMs: number;
}

export interface SelfTestCluster {
  createTenantNamespace(name: string, labels: Record<string, string>): Promise<void>;
  namespaceShape(name: string): Promise<NamespaceShape>;
  createPod(namespace: string, pod: SelfTestPodInput): Promise<void>;
  podState(namespace: string, name: string): Promise<PodState>;
  podLog(namespace: string, name: string): Promise<string>;
  discover(sameIp: string, otherIp: string): Promise<Topology>;
  deleteNamespace(name: string): Promise<void>;
  namespaceExists(name: string): Promise<boolean>;
  listSelfTestNamespaces(): Promise<{ name: string; createdAt: number }[]>;
}
