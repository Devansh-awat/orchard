import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitOauthService, expiresAtFrom, needsRefresh } from '../src/git/git-oauth.service';

function service(values: Record<string, Record<string, string | null>>) {
  const svc = Object.create(GitOauthService.prototype) as GitOauthService;
  Object.assign(svc, {
    instanceConfig: {
      isConfigured: (section: { id: string }) => Object.keys(values[section.id] ?? {}).length > 0,
      value: (section: { id: string }, name: string) => values[section.id]?.[name] ?? null
    }
  });
  return svc;
}

test('a token is refreshed shortly before it expires, never when it has no expiry', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  assert.equal(needsRefresh(null, now), false);
  assert.equal(needsRefresh(new Date('2026-09-25T12:00:30Z'), now), true);
  assert.equal(needsRefresh(new Date('2026-09-25T13:00:00Z'), now), false);
  assert.equal(needsRefresh(new Date('2026-09-25T11:00:00Z'), now), true);
  assert.equal(expiresAtFrom(7200, now)?.toISOString(), '2026-09-25T14:00:00.000Z');
  assert.equal(expiresAtFrom('nope', now), null);
  assert.equal(expiresAtFrom(0, now), null);
});

test('only forges the admin registered are offered, and the authorize url points at them', () => {
  const none = service({});
  assert.deepEqual(none.available(), { gitlab: null, bitbucket: null });
  assert.throws(() => none.authorizeUrl('gitlab', 's'), /not set up/);

  const selfHosted = service({
    'git-gitlab': { baseUrl: 'https://git.example.com', clientId: 'abc', clientSecret: 'x' }
  });
  assert.deepEqual(selfHosted.available(), {
    gitlab: { baseUrl: 'https://git.example.com' },
    bitbucket: null
  });
  const url = new URL(selfHosted.authorizeUrl('gitlab', 'state 1'));
  assert.equal(url.origin, 'https://git.example.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('state'), 'state 1');
  assert.equal(url.searchParams.get('scope'), 'read_api read_repository read_user');
  assert.ok(url.searchParams.get('redirect_uri')?.endsWith('/apiv1/git/oauth/gitlab/callback'));

  const bb = service({ 'git-bitbucket': { key: 'k', secret: 's' } });
  const bbUrl = new URL(bb.authorizeUrl('bitbucket', 'st'));
  assert.equal(bbUrl.origin, 'https://bitbucket.org');
  assert.equal(bbUrl.searchParams.get('client_id'), 'k');
});
