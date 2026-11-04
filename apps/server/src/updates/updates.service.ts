import { Injectable, Logger } from '@nestjs/common';
import { parseLatest, updatesBase } from './release-notes';

export interface LatestUpdate {
  version: string;
  url: string | null;
  publishedAt: string | null;
  markdown: string;
}

const FRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 8000;

@Injectable()
export class UpdatesService {
  private readonly logger = new Logger(UpdatesService.name);
  private cached: { value: LatestUpdate | null; until: number } | null = null;
  private inflight: Promise<LatestUpdate | null> | null = null;

  async latest(): Promise<LatestUpdate | null> {
    const base = updatesBase();
    if (!base) return null;
    if (this.cached && this.cached.until > Date.now()) return this.cached.value;
    this.inflight ??= this.fetchLatest(base).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchLatest(base: string): Promise<LatestUpdate | null> {
    try {
      const note = parseLatest(await this.get(`${base}/latest.json`).then((r) => r.json()));
      const value = note
        ? {
            version: note.version,
            url: note.url,
            publishedAt: note.publishedAt,
            markdown: await this.get(`${base}/${note.file}`).then((r) => r.text())
          }
        : null;
      this.cached = { value, until: Date.now() + FRESH_MS };
      return value;
    } catch (e: any) {
      this.logger.warn(`couldn't load the latest release notes from ${base}: ${e?.message ?? e}`);
      const value = this.cached?.value ?? null;
      this.cached = { value, until: Date.now() + RETRY_MS };
      return value;
    }
  }

  private async get(url: string) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'orchard-updates' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res;
  }
}
