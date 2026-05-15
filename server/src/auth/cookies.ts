import type { Response } from 'express';

// H-2: Single source of truth for the session cookie. Previously the OAuth,
// SSO and passwordless controllers each set their own cookie attributes and
// drifted: passwordless used SameSite=Lax while OAuth/SSO used Strict. The
// platform's CSRF posture must not depend on which login flow the user used
// last. All call sites now route through this helper.

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isSessionCookieSecure(): boolean {
  const override = process.env.SESSION_COOKIE_SECURE?.toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie('session_token', token, {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: 'strict',
    maxAge: ONE_WEEK_MS,
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie('session_token', {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: 'strict',
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined,
  });
}
