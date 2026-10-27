import { createHash, timingSafeEqual } from 'crypto';

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

const CLIENT_SECRET_PREFIX = 'sha256:';

export function hashClientSecret(secret: string): string {
  return `${CLIENT_SECRET_PREFIX}${createHash('sha256').update(secret).digest('hex')}`;
}

export function isHashedClientSecret(stored: string): boolean {
  return stored.startsWith(CLIENT_SECRET_PREFIX);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function verifyClientSecret(stored: string, presented: string | undefined): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = isHashedClientSecret(stored) ? stored : hashClientSecret(stored);
  return timingSafeEqual(digest(expected), digest(hashClientSecret(presented)));
}
