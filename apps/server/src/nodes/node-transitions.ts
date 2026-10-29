import type { NodeTaint } from './node-mapping';

export interface NodeState {
  schedulable: boolean;
  taints: NodeTaint[];
}

export interface NodeTransition {
  reason: string;
  message: string;
}

const PRESSURE_TAINTS: Record<string, string> = {
  'node.kubernetes.io/memory-pressure': 'is low on memory',
  'node.kubernetes.io/disk-pressure': 'is low on disk',
  'node.kubernetes.io/pid-pressure': 'is running out of process ids',
  'node.kubernetes.io/not-ready': 'stopped reporting ready',
  'node.kubernetes.io/unreachable': 'became unreachable'
};

const REASONS: Record<string, string> = {
  'node.kubernetes.io/memory-pressure': 'MemoryPressure',
  'node.kubernetes.io/disk-pressure': 'DiskPressure',
  'node.kubernetes.io/pid-pressure': 'PIDPressure',
  'node.kubernetes.io/not-ready': 'NodeNotReady',
  'node.kubernetes.io/unreachable': 'NodeUnreachable'
};

export function nodeTransitions(
  name: string,
  prev: NodeState | null,
  next: NodeState
): NodeTransition[] {
  if (!prev) return [];
  const out: NodeTransition[] = [];
  if (prev.schedulable && !next.schedulable) {
    out.push({ reason: 'Cordoned', message: `Node ${name} was cordoned` });
  } else if (!prev.schedulable && next.schedulable) {
    out.push({ reason: 'Uncordoned', message: `Node ${name} was uncordoned` });
  }
  const before = new Set(prev.taints.map((t) => t.key));
  for (const taint of next.taints) {
    const text = PRESSURE_TAINTS[taint.key];
    if (!text || before.has(taint.key)) continue;
    out.push({ reason: REASONS[taint.key], message: `Node ${name} ${text}` });
  }
  return out;
}
