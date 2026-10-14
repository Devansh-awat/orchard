export class TtlCache<V> {
  private readonly entries = new Map<string, { expires: number; value: Promise<V> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly keep: (value: V) => boolean = () => true,
    private readonly max = 2000
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value;
    if (this.entries.size >= this.max) this.prune(now);
    const value = load();
    this.entries.set(key, { expires: now + this.ttlMs, value });
    value.then(
      (v) => {
        if (!this.keep(v) && this.entries.get(key)?.value === value) this.entries.delete(key);
      },
      () => {
        if (this.entries.get(key)?.value === value) this.entries.delete(key);
      }
    );
    return value;
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(key);
    }
    if (this.entries.size >= this.max) this.entries.clear();
  }
}
