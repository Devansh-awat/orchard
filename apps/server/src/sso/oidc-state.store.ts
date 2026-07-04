import { Injectable, Logger } from '@nestjs/common';

// M-3: OIDC state lives behind a tiny store interface so the implementation
// can be swapped without touching SsoService. Today this is an in-memory
// Map (per-pod, lazily GC'd) — exactly the prior behaviour, but extracted so
// `consume` is atomic (get+delete in one call, no race window between two
// concurrent callbacks). A future commit can drop in a Redis-backed
// implementation when multi-replica SSO is needed.

export interface OidcState {
  orgId: string;
  codeVerifier: string;
}

const TTL_MS = 10 * 60 * 1000;

@Injectable()
export class OidcStateStore {
  private readonly logger = new Logger(OidcStateStore.name);

  private readonly memory = new Map<string, { value: OidcState; expiresAt: number }>();

  async set(state: string, value: OidcState): Promise<void> {
    this.memory.set(state, { value, expiresAt: Date.now() + TTL_MS });
  }

  /**
   * Single-use lookup: returns the state and atomically removes it so a
   * captured callback URL cannot be replayed even within the TTL window.
   */
  async consume(state: string): Promise<OidcState | null> {
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
