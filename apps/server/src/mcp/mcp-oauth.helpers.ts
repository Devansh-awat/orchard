import { createHash } from 'crypto';

export type RefreshGenerationCheck =
  | { ok: true; gen: number }
  | { ok: false; reason: 'malformed generation' | 'refresh token already rotated' };

export function checkRefreshGeneration(claim: unknown, current: number): RefreshGenerationCheck {
  const gen = claim === undefined ? 0 : claim;
  if (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 0) {
    return { ok: false, reason: 'malformed generation' };
  }
  if (gen !== current) return { ok: false, reason: 'refresh token already rotated' };
  return { ok: true, gen };
}

export function oauthCodeKey(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}
