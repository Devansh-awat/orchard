import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

export interface OidcState {
  providerId: string;
  // null for instance-wide providers, which authenticate against the platform
  // rather than into one organization.
  orgId: string | null;
  codeVerifier: string;
  nonce?: string;
  returnTo?: string;
}

const TTL_MS = 10 * 60 * 1000;
const KEY_PREFIX = 'orchard:oidc:';

@Injectable()
export class OidcStateStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OidcStateStore.name);

  private readonly memory = new Map<string, { value: OidcState; expiresAt: number }>();

  private redis: Redis | null = null;

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.warn(
          'REDIS_URL not set: OIDC login state is per-pod; SSO breaks with multiple replicas',
        );
      }
      return;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: 2 });
    this.redis.on('error', (e) => this.logger.warn(`oidc redis error: ${e.message}`));
  }

  onModuleDestroy() {
    try {
      this.redis?.disconnect();
    } catch {}
  }

  async set(state: string, value: OidcState): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(KEY_PREFIX + state, JSON.stringify(value), 'PX', TTL_MS);
        return;
      } catch (error) {
        this.logger.warn(`oidc redis set failed, using memory: ${(error as Error).message}`);
      }
    }
    this.memory.set(state, { value, expiresAt: Date.now() + TTL_MS });
  }

  async consume(state: string): Promise<OidcState | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.getdel(KEY_PREFIX + state);
        if (raw) return JSON.parse(raw) as OidcState;
      } catch (error) {
        this.logger.warn(`oidc redis consume failed, using memory: ${(error as Error).message}`);
      }
    }
    const hit = this.memory.get(state);
    this.memory.delete(state);
    // Best-effort GC of expired neighbours.
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.expiresAt < now) this.memory.delete(k);
    }
    if (!hit) return null;
    if (hit.expiresAt < now) return null;
    return hit.value;
  }
}
