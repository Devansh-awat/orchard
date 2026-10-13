import type { SandboxDesiredState, SandboxStatus } from '../../generated/prisma/client';
import type { RunnerObservation } from './sandbox-runner';

export const SANDBOX_DISAPPEARED = 'Sandbox resource disappeared from the cluster';

export interface ObservedRow {
  id: string;
  status: SandboxStatus;
  desiredState?: SandboxDesiredState | null;
}

export interface SandboxStatusWriter {
  sandbox: {
    updateMany(args: {
      where: { id: string; status: SandboxStatus; desiredState?: SandboxDesiredState };
      data: { status: SandboxStatus; statusMessage?: string | null };
    }): Promise<{ count: number }>;
  };
}

export interface ObservationChange {
  status: SandboxStatus;
  statusMessage?: string | null;
}

const TRANSITIONAL: SandboxStatus[] = ['starting', 'stopping'];

export function deriveObservedStatus(
  row: ObservedRow,
  observation: RunnerObservation
): ObservationChange | null {
  if (row.status === 'deleting' || row.desiredState === 'deleted') return null;
  if (!observation.exists) {
    if (row.status === 'creating' || row.status === 'starting' || row.status === 'error') {
      return null;
    }
    return { status: 'error', statusMessage: observation.message || SANDBOX_DISAPPEARED };
  }
  if (!observation.status) return null;
  let target: SandboxStatus = observation.status;
  if (row.desiredState === 'running' && target === 'stopped') target = 'starting';
  if (row.desiredState === 'stopped' && target === 'running') target = 'stopping';
  if (target === row.status) return null;
  const keepMessage =
    TRANSITIONAL.includes(target) || (target === 'stopped' && row.status === 'stopping');
  return keepMessage ? { status: target } : { status: target, statusMessage: null };
}

export async function applyObservation(
  prisma: SandboxStatusWriter,
  row: ObservedRow,
  observation: RunnerObservation
): Promise<ObservationChange | null> {
  const change = deriveObservedStatus(row, observation);
  if (!change) return null;
  const where = row.desiredState
    ? { id: row.id, status: row.status, desiredState: row.desiredState }
    : { id: row.id, status: row.status };
  const { count } = await prisma.sandbox.updateMany({ where, data: change });
  return count > 0 ? change : null;
}
