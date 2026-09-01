import test from 'node:test';
import assert from 'node:assert/strict';

import {
  changedFilesFromPush,
  fileMatchesWatchPaths,
  normalizeWatchPaths,
  pushMatchesWatchPaths,
} from '../src/github/watch-paths';

test('a bare directory matches everything under it', () => {
  const patterns = normalizeWatchPaths(['apps/web']);
  assert.equal(fileMatchesWatchPaths('apps/web/src/main.ts', patterns), true);
  assert.equal(fileMatchesWatchPaths('apps/web', patterns), true);
  assert.equal(fileMatchesWatchPaths('apps/webhooks/index.ts', patterns), false);
  assert.equal(fileMatchesWatchPaths('apps/api/src/main.ts', patterns), false);
});

test('leading slashes, ./ prefixes and trailing slashes normalize away', () => {
  assert.deepEqual(normalizeWatchPaths(['/apps/web/', './packages/ui', '  ']), [
    'apps/web/',
    'packages/ui',
  ]);
  const patterns = normalizeWatchPaths(['/apps/web/']);
  assert.equal(fileMatchesWatchPaths('/apps/web/src/main.ts', patterns), true);
  assert.equal(fileMatchesWatchPaths('apps/web', patterns), false);
});

test('globstar matches across directories and collapses to zero', () => {
  const patterns = normalizeWatchPaths(['apps/**/Dockerfile']);
  assert.equal(fileMatchesWatchPaths('apps/Dockerfile', patterns), true);
  assert.equal(fileMatchesWatchPaths('apps/web/Dockerfile', patterns), true);
  assert.equal(fileMatchesWatchPaths('apps/web/deep/Dockerfile', patterns), true);
  assert.equal(fileMatchesWatchPaths('Dockerfile', patterns), false);
});

test('single star stays inside one segment', () => {
  const patterns = normalizeWatchPaths(['src/*.ts']);
  assert.equal(fileMatchesWatchPaths('src/main.ts', patterns), true);
  assert.equal(fileMatchesWatchPaths('src/nested/main.ts', patterns), false);
});

test('leading globstar matches dotfiles and the repo root', () => {
  const patterns = normalizeWatchPaths(['**/*.md']);
  assert.equal(fileMatchesWatchPaths('README.md', patterns), true);
  assert.equal(fileMatchesWatchPaths('docs/guide/intro.md', patterns), true);
  assert.equal(fileMatchesWatchPaths('.github/README.md', patterns), true);
  assert.equal(fileMatchesWatchPaths('readme.mdx', patterns), false);
});

test('brace alternation and character classes', () => {
  const braces = normalizeWatchPaths(['src/**/*.{ts,tsx}']);
  assert.equal(fileMatchesWatchPaths('src/app/page.tsx', braces), true);
  assert.equal(fileMatchesWatchPaths('src/app/page.ts', braces), true);
  assert.equal(fileMatchesWatchPaths('src/app/page.css', braces), false);

  const classes = normalizeWatchPaths(['v[0-9]/api.ts']);
  assert.equal(fileMatchesWatchPaths('v2/api.ts', classes), true);
  assert.equal(fileMatchesWatchPaths('vx/api.ts', classes), false);
});

test('dots in a pattern are literal', () => {
  const patterns = normalizeWatchPaths(['package.json']);
  assert.equal(fileMatchesWatchPaths('package.json', patterns), true);
  assert.equal(fileMatchesWatchPaths('packageXjson', patterns), false);
});

test('negations win over includes regardless of order', () => {
  const after = normalizeWatchPaths(['apps/web/**', '!apps/web/**/*.md']);
  assert.equal(fileMatchesWatchPaths('apps/web/src/main.ts', after), true);
  assert.equal(fileMatchesWatchPaths('apps/web/README.md', after), false);

  const before = normalizeWatchPaths(['!apps/web/**/*.md', 'apps/web/**']);
  assert.equal(fileMatchesWatchPaths('apps/web/README.md', before), false);
});

test('a list of only negations includes everything else', () => {
  const patterns = normalizeWatchPaths(['!docs/**']);
  assert.equal(fileMatchesWatchPaths('src/main.ts', patterns), true);
  assert.equal(fileMatchesWatchPaths('docs/intro.md', patterns), false);
});

test('no patterns always deploys', () => {
  assert.equal(pushMatchesWatchPaths([], ['docs/intro.md']), true);
  assert.equal(pushMatchesWatchPaths(['   '], ['docs/intro.md']), true);
});

test('unknown changed files fail open', () => {
  assert.equal(pushMatchesWatchPaths(['apps/web/**'], null), true);
  assert.equal(pushMatchesWatchPaths(['apps/web/**'], []), true);
});

test('a push deploys when any one file matches', () => {
  const patterns = ['apps/web/**'];
  assert.equal(pushMatchesWatchPaths(patterns, ['docs/intro.md', 'apps/web/src/main.ts']), true);
  assert.equal(pushMatchesWatchPaths(patterns, ['docs/intro.md', 'README.md']), false);
});

test('changed files come from every commit in the push', () => {
  const files = changedFilesFromPush({
    commits: [
      { id: 'a', added: ['apps/web/a.ts'], removed: [], modified: ['README.md'] },
      { id: 'b', added: [], removed: ['docs/old.md'], modified: [] },
    ],
    head_commit: { id: 'b', added: [], removed: ['docs/old.md'], modified: [] },
  });
  assert.deepEqual(files?.sort(), ['README.md', 'apps/web/a.ts', 'docs/old.md']);
});

test('a head commit missing from the commit list is still counted', () => {
  const files = changedFilesFromPush({
    commits: [],
    head_commit: { id: 'z', added: ['apps/web/a.ts'], removed: [], modified: [] },
  });
  assert.deepEqual(files, ['apps/web/a.ts']);
});

test('a push with no file information is unknown, not empty', () => {
  assert.equal(changedFilesFromPush({ commits: [] }), null);
  assert.equal(changedFilesFromPush({}), null);
  assert.equal(changedFilesFromPush({ commits: [{ id: 'a' }] }), null);
});

test('a truncated commit list is unknown', () => {
  const commits = Array.from({ length: 2048 }, (unused, i) => ({
    id: String(i),
    added: [],
    removed: [],
    modified: ['docs/intro.md'],
  }));
  assert.equal(changedFilesFromPush({ commits }), null);
});
