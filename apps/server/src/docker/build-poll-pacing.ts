export interface TerminalSignal {
  at: number;
}

export function isUnseenTerminalSignal(
  signal: TerminalSignal | null | undefined,
  lastSeenAt: number,
): boolean {
  return !!signal && signal.at !== lastSeenAt;
}

export function remainingIntervalMs(
  pollInterval: number,
  waitedMs: number,
  earlyWakeEarned: boolean,
): number {
  if (earlyWakeEarned) return 0;
  const remaining = pollInterval - waitedMs;
  return remaining > 0 ? remaining : 0;
}
