import type { Response } from 'express';

// H-2: Single source of truth for the session cookie, so the OAuth, SSO and
// passwordless controllers cannot drift apart on cookie attributes.
// SameSite=Lax is required so the cookie survives cross-site top-level
// navigations (e.g. GitHub OAuth redirect back to our callback).

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function isSessionCookieSecure(): boolean {
  const override = process.env.SESSION_COOKIE_SECURE?.toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie('session_token', token, {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: 'lax',
    maxAge: ONE_WEEK_MS,
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie('session_token', {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: 'lax',
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined
  });
}

const GITHUB_OAUTH_STATE_COOKIE = 'github_oauth_state';
const GITHUB_OAUTH_STATE_PATH = '/apiv1/github';
const TEN_MINUTES_MS = 10 * 60 * 1000;

export function setGithubOauthStateCookie(res: Response, state: string): void {
  res.cookie(GITHUB_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: 'lax',
    maxAge: TEN_MINUTES_MS,
    path: GITHUB_OAUTH_STATE_PATH
  });
}

export function clearGithubOauthStateCookie(res: Response): void {
  res.clearCookie(GITHUB_OAUTH_STATE_COOKIE, { path: GITHUB_OAUTH_STATE_PATH });
}

const GIT_OAUTH_STATE_COOKIE = 'git_oauth_state';
const GIT_OAUTH_STATE_PATH = '/apiv1/git/oauth';

export function setGitOauthStateCookie(res: Response, state: string): void {
  res.cookie(GIT_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: 'lax',
    maxAge: TEN_MINUTES_MS,
    path: GIT_OAUTH_STATE_PATH
  });
}

export function clearGitOauthStateCookie(res: Response): void {
  res.clearCookie(GIT_OAUTH_STATE_COOKIE, { path: GIT_OAUTH_STATE_PATH });
}

const SSO_START_COOKIE = 'sso_start';

function ssoStartCookieOptions() {
  const secure = isSessionCookieSecure();
  return { httpOnly: true, secure, sameSite: secure ? 'none' : 'lax', path: '/' } as const;
}

export function setSsoStartCookie(res: Response, token: string): void {
  res.cookie(SSO_START_COOKIE, token, { ...ssoStartCookieOptions(), maxAge: TEN_MINUTES_MS });
}

export function clearSsoStartCookie(res: Response): void {
  res.clearCookie(SSO_START_COOKIE, ssoStartCookieOptions());
}

export function ssoStartCookie(req: { cookies?: Record<string, string> }): string | undefined {
  return req.cookies?.[SSO_START_COOKIE];
}
