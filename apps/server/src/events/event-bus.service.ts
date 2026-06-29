import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { OrgEvent } from './org-events.service';

const STREAM_KEY = 'orchard:events';
const MAXLEN = 10_000;
const REPLAY_LIMIT = 1_000;

export interface BusEntry {
  id: string;
  event: OrgEvent;
}

function parseEntry(fields: string[]): OrgEvent | null {
  const idx = fields.indexOf('data');
  if (idx < 0 || idx + 1 >= fields.length) return null;
  try {
    return JSON.parse(fields[idx + 1]);
  } catch {
    return null;
  }
}

@Injectable()
export class EventBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventBusService.name);
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private consumer: ((entry: BusEntry) => void) | null = null;
  private running = false;
  private lastId = '$';

  get enabled(): boolean {
    return this.pub !== null;
  }

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn(
        'REDIS_URL not set — event bus is local-only (cross-replica SSE delivery disabled, polling fallback covers it)',
      );
      return;
    }
    this.pub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.pub.on('error', (e) => this.logger.warn(`redis pub error: ${e.message}`));
    this.sub.on('error', (e) => this.logger.warn(`redis sub error: ${e.message}`));
    this.running = true;
    void this.consumeLoop();
    this.logger.log('Redis event bus connected');
  }

  async onModuleDestroy() {
    this.running = false;
    try {
      this.sub?.disconnect();
    } catch {}
    try {
      this.pub?.disconnect();
    } catch {}
  }

  setConsumer(fn: (entry: BusEntry) => void) {
    this.consumer = fn;
  }

  async publish(event: OrgEvent): Promise<string | null> {
    if (!this.pub) return null;
    try {
      return await this.pub.xadd(
        STREAM_KEY,
        'MAXLEN',
        '~',
        String(MAXLEN),
        '*',
        'data',
        JSON.stringify(event),
      );
    } catch (e) {
      this.logger.warn(`xadd failed: ${(e as Error).message}`);
      return null;
    }
  }

  async replay(fromId: string): Promise<BusEntry[]> {
    if (!this.pub || !fromId) return [];
    try {
      const rows = (await this.pub.xrange(
        STREAM_KEY,
        `(${fromId}`,
        '+',
        'COUNT',
        REPLAY_LIMIT,
      )) as Array<[string, string[]]>;
      const out: BusEntry[] = [];
      for (const [id, fields] of rows) {
        const event = parseEntry(fields);
        if (event) out.push({ id, event });
      }
      return out;
    } catch (e) {
      this.logger.warn(`xrange replay failed: ${(e as Error).message}`);
      return [];
    }
  }

  private async consumeLoop() {
    while (this.running && this.sub) {
      try {
        const res = (await this.sub.xread(
          'BLOCK',
          5000,
          'STREAMS',
          STREAM_KEY,
          this.lastId,
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            this.lastId = id;
            const event = parseEntry(fields);
            if (event && this.consumer) this.consumer({ id, event });
          }
        }
      } catch (e) {
        if (!this.running) break;
        this.logger.warn(`xread error: ${(e as Error).message}; retrying`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
