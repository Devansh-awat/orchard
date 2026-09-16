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

export function claimUrl(token: string, base?: string): string {
  const origin = (base || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${origin}/setup/claim?token=${token}`;
}

/**
 * Whether a claim link may be minted right now.
 *
 * A fresh instance is obviously claimable. The harder case is an instance that
 * has a superadmin who can no longer reach it: claim the box, skip the passkey
 * step, clear your cookies, and with no SMTP there is no sign-in code to send
 * and no passkey to present. Refusing to mint there is a permanent lockout of
 * the operator from their own machine, recoverable only by hand-editing the
 * database.
 *
 * So the question is not "is there a superadmin" but "is there any way back
 * in". A passkey on a superadmin, working SMTP, or a configured OAuth provider
 * are each a way in, and while any of them exists this stays refused and says
 * which one to use.
 *
 * Minting grants nothing new: it is reachable only with exec on the server pod,
 * which already means owning the database this reads.
 */
export interface RecoveryState {
  superadmins: number;
  passkeys: number;
  password: boolean;
  smtp: boolean;
  oauth: boolean;
  claimable: boolean;
  /** The way back in that blocks minting, when one exists. */
  blockedBy: 'passkey' | 'password' | 'smtp' | 'oauth' | null;
}

interface RecoveryPrisma {
  user: { count(args: any): Promise<number> };
  passkey: { count(args: any): Promise<number> };
  instanceSetting: { findUnique(args: any): Promise<{ value: string } | null> };
}

function envSet(...names: string[]): boolean {
  return names.every((name) => !!(process.env[name] || '').trim());
}

async function smtpConfigured(prisma: RecoveryPrisma): Promise<boolean> {
  if ((process.env.SMTP_HOST || '').trim()) return true;
  try {
    // The same row InstanceConfigService writes. `host` is not a secret field,
    // so it is stored in the clear and readable without the crypto service this
    // script has no way to construct.
    const row = await prisma.instanceSetting.findUnique({ where: { key: 'email' } });
    if (!row?.value) return false;
    return !!String((JSON.parse(row.value) as { host?: string })?.host || '').trim();
  } catch {
    return false;
  }
}

export async function recoveryState(prisma: RecoveryPrisma): Promise<RecoveryState> {
  const superadmins = await prisma.user.count({ where: { isSuperAdmin: true } });
  if (superadmins === 0) {
    return {
      superadmins,
      passkeys: 0,
      password: false,
      smtp: false,
      oauth: false,
      claimable: true,
      blockedBy: null
    };
  }

  const passkeys = await prisma.passkey.count({ where: { user: { isSuperAdmin: true } } });
  const password =
    (await prisma.user.count({
      where: { isSuperAdmin: true, passwordHash: { not: null } }
    })) > 0;
  const smtp = await smtpConfigured(prisma);
  const oauth =
    envSet('AUTH_OAUTH_CLIENT_ID', 'AUTH_OAUTH_CLIENT_SECRET') ||
    envSet('HACKCLUB_CLIENT_ID', 'HACKCLUB_CLIENT_SECRET');

  let blockedBy: RecoveryState['blockedBy'] = null;
  if (passkeys > 0) blockedBy = 'passkey';
  else if (password) blockedBy = 'password';
  else if (smtp) blockedBy = 'smtp';
  else if (oauth) blockedBy = 'oauth';

  return {
    superadmins,
    passkeys,
    password,
    smtp,
    oauth,
    claimable: blockedBy === null,
    blockedBy
  };
}
