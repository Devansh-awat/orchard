import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

// M-3: OIDC state lives behind a tiny store interface so the implementation
// can be swapped without touching SsoService. With REDIS_URL set the state is
// shared across replicas (the /authorize and /callback legs of an SSO login
// routinely land on different pods behind the Service); without it we fall
// back to the original per-pod Map for single-process dev. `consume` is
// atomic in both paths (GETDEL / get+delete) so a captured callback URL
// cannot be replayed even within the TTL window.

export interface OidcState {
  orgId: string;
  codeVerifier: string;
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

  /**
   * Single-use lookup: returns the state and atomically removes it so a
   * captured callback URL cannot be replayed even within the TTL window.
   */
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
