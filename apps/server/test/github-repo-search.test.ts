import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RepoSearchError,
  buildSearchQ,
  classifyGitHubFailure,
  mergeExact,
  normalizeRepoQuery,
  ownedBy,
  pickSearchInstallation,
  rankRepos,
  repoSearchErrorResponse,
  retryAfterSeconds,
  sanitizeTerms,
  toSearchedRepo,
  type SearchedRepo
} from '../src/github/repo-search';

const org = { id: 'a', installationId: 1n, accountLogin: 'hackclub', accountType: 'Organization' };
const me = { id: 'b', installationId: 2n, accountLogin: 'leafd', accountType: 'User' };
const installs = [org, me];

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null
});

const repo = (name: string, id: number, owner = 'hackclub'): SearchedRepo => ({
  id,
  name,
  full_name: `${owner}/${name}`,
  owner,
  private: false,
  default_branch: 'main',
  pushed_at: null,
  updated_at: null
});

test('only an account among the user installations can be searched', () => {
  assert.equal(pickSearchInstallation(installs, 'hackclub'), org);
  assert.equal(pickSearchInstallation(installs, 'HackClub'), org);
  assert.equal(pickSearchInstallation(installs, 'leafd'), me);
  assert.equal(pickSearchInstallation(installs, 'vercel'), null);
  assert.equal(pickSearchInstallation(installs, ''), null);
  assert.equal(pickSearchInstallation(installs, undefined), null);
  assert.equal(pickSearchInstallation(installs, ['hackclub']), null);
  assert.equal(pickSearchInstallation(installs, 'hackclub org:vercel'), null);
  assert.equal(pickSearchInstallation(installs, 'hackclub/site'), null);
  assert.equal(pickSearchInstallation([], 'hackclub'), null);
});

test('organizations scope with org:, people with user:', () => {
  assert.equal(buildSearchQ(org, []), 'org:hackclub fork:true archived:false');
  assert.equal(buildSearchQ(me, []), 'user:leafd fork:true archived:false');
  assert.equal(
    buildSearchQ(org, ['arcade', 'bot']),
    'arcade bot in:name org:hackclub fork:true archived:false'
  );
  assert.throws(() => buildSearchQ({ accountLogin: 'a b', accountType: 'User' }, []));
  assert.throws(() => buildSearchQ({ accountLogin: 'x:y', accountType: 'User' }, []));
});

test('typed qualifiers and operators never reach the search', () => {
  assert.deepEqual(sanitizeTerms('site org:vercel'), ['site']);
  assert.deepEqual(sanitizeTerms('is:public is:private user:torvalds'), []);
  assert.deepEqual(sanitizeTerms('repo:vercel/next.js'), []);
  assert.deepEqual(sanitizeTerms('a OR b NOT c AND d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sanitizeTerms('"quoted" (paren) -neg'), ['quoted', 'paren', 'neg']);
  assert.deepEqual(sanitizeTerms('next.js my_app'), ['next.js', 'my_app']);
  assert.deepEqual(sanitizeTerms('fork:false archived:true'), []);
  assert.deepEqual(sanitizeTerms('a\tb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(sanitizeTerms('site site'), ['site']);
  const q = buildSearchQ(org, sanitizeTerms('x org:vercel is:public OR user:me'));
  assert.equal(q, 'x in:name org:hackclub fork:true archived:false');
  assert.equal(q.match(/org:|user:/g)?.length, 1);
});

test('queries are capped in terms and length', () => {
  assert.deepEqual(sanitizeTerms('a b c d e f g'), ['a', 'b', 'c', 'd', 'e']);
  const long = 'x'.repeat(150);
  assert.deepEqual(sanitizeTerms(long), []);
  assert.deepEqual(sanitizeTerms(`ok ${'y'.repeat(99)}`), ['ok']);
  const huge = normalizeRepoQuery('hackclub', `${'z'.repeat(60)} ${'w'.repeat(500)}`);
  assert.deepEqual(huge.terms, ['z'.repeat(60)]);
  assert.ok(normalizeRepoQuery('hackclub', 'q'.repeat(10_000)).key.length <= 100);
});

test('an empty query asks for the recent list', () => {
  for (const raw of ['', '   ', undefined, null, 42, ['a']]) {
    const q = normalizeRepoQuery('hackclub', raw);
    assert.deepEqual(q.terms, []);
    assert.equal(q.exactName, null);
    assert.equal(q.key, '');
    assert.equal(q.foreignOwner, false);
  }
});

test('owner/name in the searched account becomes an exact lookup', () => {
  const q = normalizeRepoQuery('hackclub', 'hackclub/arcade-bot');
  assert.deepEqual(q.terms, ['arcade-bot']);
  assert.equal(q.exactName, 'arcade-bot');
  assert.equal(normalizeRepoQuery('hackclub', 'HackClub/site').exactName, 'site');
  assert.equal(
    normalizeRepoQuery('hackclub', 'https://github.com/hackclub/site.git').exactName,
    'site'
  );
  assert.equal(
    normalizeRepoQuery('hackclub', 'git@github.com:hackclub/site.git').exactName,
    'site'
  );
  assert.equal(normalizeRepoQuery('hackclub', 'site').exactName, 'site');
  assert.equal(normalizeRepoQuery('hackclub', 'my site').exactName, null);
  assert.equal(normalizeRepoQuery('hackclub', '..').exactName, null);
  const prefix = normalizeRepoQuery('hackclub', 'hackclub/');
  assert.deepEqual(prefix.terms, []);
  assert.equal(prefix.exactName, null);
});

test('owner/name in another account searches nothing', () => {
  for (const raw of ['vercel/next.js', 'https://github.com/vercel/next.js', 'hackclubx/site']) {
    const q = normalizeRepoQuery('hackclub', raw);
    assert.equal(q.foreignOwner, true, raw);
    assert.deepEqual(q.terms, []);
    assert.equal(q.exactName, null);
  }
});

test('exact matches rank first, then prefixes, otherwise GitHub order', () => {
  const ranked = rankRepos(
    [repo('my-site', 1), repo('site-old', 2), repo('site', 3), repo('other', 4)],
    ['site']
  );
  assert.deepEqual(
    ranked.map((r) => r.name),
    ['site', 'site-old', 'my-site', 'other']
  );
  const recent = [repo('b', 1), repo('a', 2)];
  assert.deepEqual(rankRepos(recent, []), recent);
});

test('the direct lookup only adds what search missed', () => {
  const found = [repo('site', 1)];
  assert.deepEqual(mergeExact(found, repo('site', 1)), found);
  assert.deepEqual(
    mergeExact(found, repo('fresh', 9)).map((r) => r.id),
    [9, 1]
  );
  assert.deepEqual(mergeExact(found, null), found);
});

test('results owned by another account are recognised', () => {
  const parsed = toSearchedRepo({
    id: 7,
    name: 'next.js',
    full_name: 'vercel/next.js',
    owner: { login: 'vercel' },
    private: false,
    default_branch: 'canary'
  });
  assert.ok(parsed);
  assert.equal(ownedBy(parsed, 'hackclub'), false);
  assert.equal(ownedBy(parsed, 'Vercel'), true);
  assert.equal(toSearchedRepo({ name: 'x' }), null);
  assert.equal(toSearchedRepo(null), null);
  assert.equal(toSearchedRepo({ id: 1, full_name: 'a/b' })?.default_branch, 'main');
});

test('GitHub failures map to a typed error', () => {
  assert.equal(classifyGitHubFailure(401, headers({})), 'reauth');
  assert.equal(classifyGitHubFailure(429, headers({})), 'rate_limited');
  assert.equal(
    classifyGitHubFailure(403, headers({ 'x-ratelimit-remaining': '0' })),
    'rate_limited'
  );
  assert.equal(classifyGitHubFailure(403, headers({ 'retry-after': '30' })), 'rate_limited');
  assert.equal(
    classifyGitHubFailure(403, headers({}), 'You have exceeded a secondary rate limit'),
    'rate_limited'
  );
  assert.equal(classifyGitHubFailure(403, headers({ 'x-ratelimit-remaining': '12' })), 'denied');
  assert.equal(classifyGitHubFailure(422, headers({})), 'invalid');
  assert.equal(classifyGitHubFailure(503, headers({})), 'unavailable');
});

test('retry hints come from GitHub headers and stay short', () => {
  assert.equal(retryAfterSeconds(headers({ 'retry-after': '7' })), 7);
  assert.equal(retryAfterSeconds(headers({ 'retry-after': '600' })), 60);
  assert.equal(retryAfterSeconds(headers({ 'x-ratelimit-reset': '1012' }), 1_000_000), 12);
  assert.equal(retryAfterSeconds(headers({ 'x-ratelimit-reset': '900' }), 1_000_000), 1);
  assert.equal(retryAfterSeconds(headers({})), 10);
});

test('error responses never use 401, which would sign the user out', () => {
  const kinds = ['not_installed', 'reauth', 'rate_limited', 'denied', 'unavailable'] as const;
  for (const kind of kinds) {
    const { status } = repoSearchErrorResponse(new RepoSearchError(kind));
    assert.notEqual(status, 401, kind);
  }
  const limited = repoSearchErrorResponse(new RepoSearchError('rate_limited', 20));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'github_rate_limited');
  assert.equal(limited.body.retryAfter, 20);
  assert.equal(repoSearchErrorResponse(new RepoSearchError('not_installed')).status, 404);
});
