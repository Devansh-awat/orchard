export interface RestoreLimiterOptions {
  minIntervalMs: number;
  burst: number;
  windowMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_RESTORE_LIMITS: RestoreLimiterOptions = {
  minIntervalMs: 30_000,
  burst: 3,
  windowMs: 60 * 60 * 1000,
  maxBackoffMs: 30 * 60 * 1000
};

export interface RestoreGate {
  allowed: boolean;
  retryAt: number;
  backingOff: boolean;
}

export class RestoreLimiter {
  private readonly history = new Map<string, number[]>();

  constructor(
    private readonly opts: RestoreLimiterOptions = DEFAULT_RESTORE_LIMITS,
    private readonly now: () => number = () => Date.now()
  ) {}

  check(key: string): RestoreGate {
    const recent = this.recent(key);
    const now = this.now();
    if (recent.length === 0) return { allowed: true, retryAt: now, backingOff: false };
    const retryAt = recent[recent.length - 1] + this.interval(recent.length);
    const backingOff = recent.length >= this.opts.burst;
    return { allowed: now >= retryAt, retryAt, backingOff };
  }

  record(key: string): { restores: number; backingOff: boolean; nextAllowedAt: number } {
    const recent = this.recent(key);
    const at = this.now();
    recent.push(at);
    this.history.set(key, recent);
    return {
      restores: recent.length,
      backingOff: recent.length >= this.opts.burst,
      nextAllowedAt: at + this.interval(recent.length)
    };
  }

  forget(key: string): void {
    this.history.delete(key);
  }

  private interval(restores: number): number {
    if (restores < this.opts.burst) return this.opts.minIntervalMs;
    const doublings = restores - this.opts.burst + 1;
    return Math.min(this.opts.maxBackoffMs, this.opts.minIntervalMs * 2 ** doublings);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    const kept = (this.history.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.history.delete(key);
    else this.history.set(key, kept);
    return kept;
  }
}
