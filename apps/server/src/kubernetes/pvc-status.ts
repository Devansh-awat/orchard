import type * as k8s from '@kubernetes/client-node';
import { parseMemory } from './quantity';

export type PvcResizeState = 'resizing' | 'pendingRestart' | 'failed' | null;

export interface PvcObservation {
  phase: string | null;
  requested: string | null;
  capacity: string | null;
  resizeState: PvcResizeState;
  message: string | null;
}

const ALLOCATED_STATUS: Record<string, PvcResizeState> = {
  ControllerResizeInProgress: 'resizing',
  ControllerResizeInfeasible: 'failed',
  ControllerResizeFailed: 'failed',
  NodeResizePending: 'pendingRestart',
  NodeResizeInProgress: 'resizing',
  NodeResizeInfeasible: 'failed',
  NodeResizeFailed: 'failed'
};

function quantity(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
}

export function observePvc(pvc: k8s.V1PersistentVolumeClaim): PvcObservation {
  const status = (pvc.status ?? {}) as k8s.V1PersistentVolumeClaimStatus & {
    allocatedResourceStatuses?: Record<string, string>;
  };
  const phase = quantity(status.phase);
  const requested = quantity(pvc.spec?.resources?.requests?.storage);
  const capacity = quantity(status.capacity?.storage);
  const conditions = status.conditions ?? [];

  const allocated = status.allocatedResourceStatuses?.storage;
  const condition = (type: string) =>
    conditions.find((c) => c.type === type && c.status !== 'False');
  const messageOf = (c: k8s.V1PersistentVolumeClaimCondition | undefined) =>
    c ? (quantity(c.message) ?? quantity(c.reason)) : null;

  if (allocated && ALLOCATED_STATUS[allocated]) {
    const failed = ALLOCATED_STATUS[allocated] === 'failed';
    return {
      phase,
      requested,
      capacity,
      resizeState: ALLOCATED_STATUS[allocated],
      message: failed
        ? (messageOf(condition('Resizing')) ?? `Resize reported ${allocated}`)
        : messageOf(condition('FileSystemResizePending'))
    };
  }

  const pending = condition('FileSystemResizePending');
  if (pending) {
    return {
      phase,
      requested,
      capacity,
      resizeState: 'pendingRestart',
      message: messageOf(pending)
    };
  }
  const resizing = condition('Resizing');
  if (resizing) {
    return { phase, requested, capacity, resizeState: 'resizing', message: messageOf(resizing) };
  }
  if (requested && capacity && parseMemory(requested) > parseMemory(capacity)) {
    return { phase, requested, capacity, resizeState: 'resizing', message: null };
  }
  return { phase, requested, capacity, resizeState: null, message: null };
}

export function storageShrinks(previous: string | null | undefined, next: string): boolean {
  if (!previous) return false;
  const before = parseMemory(previous);
  const after = parseMemory(next);
  return before > 0 && after > 0 && after < before;
}
