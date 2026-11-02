export const SANDBOX_FAILURE_REASON = 'FailedCreatePodSandBox';
const SANDBOX_FAILURES_BEFORE_GIVING_UP = 3;
const MAX_MESSAGE = 300;

export interface PodEventLike {
  reason?: string | null;
  message?: string | null;
  count?: number | null;
}

export function sandboxFailureReason(message: string | null | undefined): string {
  const text = (message ?? '').trim();
  const cause = text.match(/failed to create shim task:\s*(.+)$/s)?.[1] ?? text;
  const reason = cause.replace(/^\(combined from similar events\):\s*/, '').trim();
  return reason.length > MAX_MESSAGE ? `${reason.slice(0, MAX_MESSAGE)}…` : reason;
}

export function sandboxStartFailure(events: readonly PodEventLike[]): string | null {
  const failures = events.filter((e) => e.reason === SANDBOX_FAILURE_REASON);
  const attempts = failures.reduce((sum, e) => sum + Math.max(1, e.count ?? 1), 0);
  if (attempts < SANDBOX_FAILURES_BEFORE_GIVING_UP) return null;
  const last = failures[failures.length - 1];
  return `the build sandbox failed to start ${attempts} times: ${sandboxFailureReason(last.message)}`;
}
