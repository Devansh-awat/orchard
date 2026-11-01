import { Injectable, Optional } from '@nestjs/common';
import { SharedCache } from '../cache/shared-cache.service';
import { VictoriaMetricsService } from './victoria-metrics.service';
import { presenceQueries, type SignalPresence } from './signal-presence';

const PRESENCE_KEY = 'signal-presence:v1';
const PRESENCE_FRESH_MS = 60_000;
const PRESENCE_KEEP_MS = 60 * 60_000;
const PRESENCE_TIMEOUT_MS = 10_000;

@Injectable()
export class SignalPresenceService {
  private readonly cache: SharedCache;

  constructor(
    private readonly vm: VictoriaMetricsService,
    @Optional() cache?: SharedCache
  ) {
    this.cache = cache ?? new SharedCache();
  }

  current(): Promise<SignalPresence> {
    return this.cache.snapshot(
      PRESENCE_KEY,
      { freshMs: PRESENCE_FRESH_MS, keepMs: PRESENCE_KEEP_MS },
      () => this.load()
    );
  }

  private async load(): Promise<SignalPresence> {
    const q = presenceQueries();
    const grouped = (p: { query: string; label: string }) =>
      this.vm.queryInstantGrouped(p.query, p.label, PRESENCE_TIMEOUT_MS).then((m) => [...m.keys()]);
    const ids = Object.keys(q.http);
    const [namespaces, ...http] = await Promise.all([
      grouped(q.namespaces),
      ...ids.map((id) => grouped(q.http[id]))
    ]);
    return { namespaces, http: Object.fromEntries(ids.map((id, i) => [id, http[i]])) };
  }
}
