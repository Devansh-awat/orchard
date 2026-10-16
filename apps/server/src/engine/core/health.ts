export const STALE_MS = 60_000;
export const UNHEALTHY_GRACE_MS = 30_000;
export const UNHEALTHY_RESIGN_MS = 2 * 60_000;
export const RESIGN_COOLDOWN_MS = 5 * 60_000;

export interface HeartbeatRow {
  holder: string | null;
  updatedAt: Date;
  healthy: boolean;
}

export function shardIsStale(row: HeartbeatRow, now: number, staleMs = STALE_MS): boolean {
  if (now - row.updatedAt.getTime() > staleMs) return true;
  return !row.healthy;
}

export interface Failure {
  error: string;
  since: number;
}

export function lastingFailures(
  failures: Map<string, Failure>,
  now: number,
  graceMs = UNHEALTHY_GRACE_MS
): [string, string][] {
  return [...failures.entries()]
    .filter(([, f]) => now - f.since >= graceMs)
    .map(([kind, f]) => [kind, f.error]);
}

export function shouldHandOver(
  failures: Map<string, Failure>,
  now: number,
  replicasPresent: number,
  resignAfterMs = UNHEALTHY_RESIGN_MS
): boolean {
  if (replicasPresent < 2) return false;
  return lastingFailures(failures, now, resignAfterMs).length > 0;
}
