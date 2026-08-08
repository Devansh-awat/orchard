import * as k8s from '@kubernetes/client-node';

export interface NodeTaint {
  key: string;
  value: string | null;
  effect: string;
}

export interface NodeRow {
  name: string;
  labels: Record<string, string>;
  taints: NodeTaint[];
  schedulable: boolean;
  cpuCapacity?: string;
  memoryCapacity?: string;
}

// Pure mapping from a live k8s node to the columns we persist. Shared by the
// node informer (live watch) and the manual syncFromCluster reconcile so the
// two paths can never drift.
export function mapNodeToRow(n: k8s.V1Node): NodeRow | null {
  const name = n.metadata?.name;
  if (!name) return null;
  const labels = (n.metadata?.labels || {}) as Record<string, string>;
  const taints: NodeTaint[] = (n.spec?.taints || []).map((t) => ({
    key: t.key,
    value: t.value ?? null,
    effect: t.effect,
  }));
  const capacity = n.status?.capacity || {};
  return {
    name,
    labels,
    taints,
    schedulable: !n.spec?.unschedulable,
    cpuCapacity: typeof capacity.cpu === 'string' ? capacity.cpu : undefined,
    memoryCapacity: typeof capacity.memory === 'string' ? capacity.memory : undefined,
  };
}
