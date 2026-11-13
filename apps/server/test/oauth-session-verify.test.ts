import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-thirty-two-characters-long';
process.env.AUTH_PROVIDER = 'none';

import { OAuthService } from '../src/auth/oauth.service';
import { SessionsService } from '../src/auth/sessions.service';
import { GitHubService } from '../src/github/github.service';
import { GitOauthController } from '../src/git/git-oauth.controller';

type Row = { revokedAt: Date | null; expiresAt: Date; user: { disabledAt: Date | null } };

function harness(rows: Record<string, Row>) {
  const prisma = {
    session: { findUnique: async ({ where }: any) => rows[where.id] ?? null }
  };
  const sessions = new SessionsService(prisma as any, {} as any, {} as any);
  return new OAuthService(sessions);
}

const live = (): Row => ({
  revokedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000),
  user: { disabledAt: null }
});

async function mint(oauth: OAuthService, sessionId?: string, extra: Record<string, unknown> = {}) {
  return new SignJWT({
    email: 'a@example.com',
    name: 'A',
    ...(sessionId ? { sessionId } : {}),
    ...extra
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(oauth.getJwtSecret());
}

test('a live session verifies', async () => {
  const oauth = harness({ s1: live() });
  const payload = await oauth.verifySessionToken(await mint(oauth, 's1'));
  assert.equal(payload.sessionId, 's1');
});

test('revoked, expired, unknown, sessionless and disabled-user tokens are refused', async () => {
  const oauth = harness({
    revoked: { ...live(), revokedAt: new Date() },
    expired: { ...live(), expiresAt: new Date(Date.now() - 1000) },
    disabled: { ...live(), user: { disabledAt: new Date() } }
  });
  for (const sessionId of ['revoked', 'expired', 'disabled', 'missing', undefined]) {
    await assert.rejects(
      oauth.verifySessionToken(await mint(oauth, sessionId)),
      /Invalid or expired/,
      `session ${sessionId} should be refused`
    );
  }
});

test('a typed token is refused even with a live session', async () => {
  const oauth = harness({ s1: live() });
  await assert.rejects(
    oauth.verifySessionToken(await mint(oauth, 's1', { type: 'mcp_access' })),
    /Invalid or expired/
  );
});

test('the signature-only check still accepts a revoked session so logout can revoke it', async () => {
  const oauth = harness({ gone: { ...live(), revokedAt: new Date() } });
  const payload = await oauth.verifySessionSignature(await mint(oauth, 'gone'));
  assert.equal(payload.sessionId, 'gone');
});

test('starting a git link with a revoked session cookie is refused', async () => {
  const oauth = harness({ gone: { ...live(), revokedAt: new Date() } });
  const github = Object.create(GitHubService.prototype) as GitHubService;
  Object.assign(github, { oauthService: oauth });
  const controller = Object.create(GitOauthController.prototype) as GitOauthController;
  Object.assign(controller, { github });
  let location = '';
  const res = { redirect: (url: string) => (location = url), cookie: () => res } as any;
  await controller.start('gitlab', { cookies: { session_token: await mint(oauth, 'gone') } }, res);
  assert.match(location, /error=Not%20authenticated/);
});
