import { createHash } from 'node:crypto';

export const SUPERADMIN_CLAIM_KEY = 'superadmin_claim';

export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export interface ClaimRecord {
  hash: string;
  expiresAt: string;
}

export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function claimUrl(token: string): string {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/setup/claim?token=${token}`;
}
