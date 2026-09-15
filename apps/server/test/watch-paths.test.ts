import test from 'node:test';
import assert from 'node:assert/strict';

import {
  changedFilesFromCompare,
  changedFilesFromPush,
  partitionByWatchPaths,
  fileMatchesWatchPaths,
  normalizeWatchPaths,
  pushMatchesWatchPaths
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
    'packages/ui'
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
  assert.equal(pushMatchesWatchPaths(null as unknown as string[], ['docs/intro.md']), true);
  assert.equal(pushMatchesWatchPaths(undefined as unknown as string[], ['docs/intro.md']), true);
  assert.equal(pushMatchesWatchPaths([], null), true);
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
      { id: 'b', added: [], removed: ['docs/old.md'], modified: [] }
    ],
    head_commit: { id: 'b', added: [], removed: ['docs/old.md'], modified: [] }
  });
  assert.deepEqual(files?.sort(), ['README.md', 'apps/web/a.ts', 'docs/old.md']);
});

test('a head commit missing from the commit list is still counted', () => {
  const files = changedFilesFromPush({
    commits: [],
    head_commit: { id: 'z', added: ['apps/web/a.ts'], removed: [], modified: [] }
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
    modified: ['docs/intro.md']
  }));
  assert.equal(changedFilesFromPush({ commits }), null);
});

// --- compare responses -------------------------------------------------------

test('a compare response reports every changed file', () => {
  assert.deepEqual(
    changedFilesFromCompare({
      files: [
        { filename: 'v2_pipeline/app.py', status: 'modified' },
        { filename: 'frontend/src/routes/posts/+page.svelte', status: 'added' }
      ]
    }),
    ['v2_pipeline/app.py', 'frontend/src/routes/posts/+page.svelte']
  );
});

test('a rename counts as a change to both the old path and the new one', () => {
  // Moving a file out of a watched directory changed that directory, and the
  // push payload says the same thing as an add plus a remove.
  assert.deepEqual(
    changedFilesFromCompare({
      files: [{ filename: 'v2_pipeline/steps.py', previous_filename: 'pipeline/steps.py' }]
    }),
    ['v2_pipeline/steps.py', 'pipeline/steps.py']
  );
});

test('a compare at the 300-file cap is unknown, not empty', () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` }));
  assert.equal(changedFilesFromCompare({ files }), null);
  assert.ok(changedFilesFromCompare({ files: files.slice(0, 299) })?.length === 299);
});

test('a compare with nothing usable is unknown', () => {
  assert.equal(changedFilesFromCompare({}), null);
  assert.equal(changedFilesFromCompare({ files: [] }), null);
  assert.equal(changedFilesFromCompare({ files: [{ status: 'modified' }] }), null);
  assert.equal(changedFilesFromCompare(null), null);
});

test('an unknown compare deploys rather than skipping', () => {
  // The whole point of asking GitHub: when it cannot answer, the deployment
  // still builds. A watch path must never turn a lost answer into a lost build.
  assert.equal(pushMatchesWatchPaths(['v2_pipeline/**'], changedFilesFromCompare({})), true);
});

test('a compare answer filters exactly like a push payload would', () => {
  const compared = changedFilesFromCompare({
    files: [{ filename: 'frontend/src/app.css' }]
  });
  assert.equal(pushMatchesWatchPaths(['frontend/**'], compared), true);
  assert.equal(pushMatchesWatchPaths(['v2_pipeline/**'], compared), false);
});

// --- the two-stage decision -------------------------------------------------

const frontend = { name: 'frontend', autoDeployPaths: ['frontend/**'] };
const pipeline = { name: 'pipeline', autoDeployPaths: ['v2_pipeline/**'] };
const everything = { name: 'everything', autoDeployPaths: [] };

test('each deployment gets its own verdict on the same push', () => {
  const { watched, unmatched } = partitionByWatchPaths(
    [frontend, pipeline, everything],
    ['frontend/src/app.css']
  );
  assert.deepEqual(
    watched.map((d) => d.name),
    ['frontend', 'everything']
  );
  assert.deepEqual(
    unmatched.map((d) => d.name),
    ['pipeline']
  );
});

test('a deployment watching everything is never held back for confirmation', () => {
  // Nothing to confirm, so nothing costs a round trip.
  assert.deepEqual(partitionByWatchPaths([everything], ['anything.txt']).unmatched, []);
  assert.deepEqual(partitionByWatchPaths([everything], null).unmatched, []);
});

test('an unknown file list clears the whole unmatched set', () => {
  // The second stage runs on the leftovers: if GitHub cannot say what changed,
  // every one of them builds rather than being dropped on a list we could not
  // vouch for.
  const first = partitionByWatchPaths([frontend, pipeline], ['docs/readme.md']);
  assert.deepEqual(first.watched, []);

  const second = partitionByWatchPaths(first.unmatched, null);
  assert.deepEqual(
    second.watched.map((d) => d.name),
    ['frontend', 'pipeline']
  );
  assert.deepEqual(second.unmatched, []);
});

test('a confirmed miss stays a miss', () => {
  const first = partitionByWatchPaths([frontend, pipeline], ['docs/readme.md']);
  const second = partitionByWatchPaths(first.unmatched, ['docs/readme.md', 'LICENSE']);
  assert.deepEqual(second.watched, []);
  assert.deepEqual(
    second.unmatched.map((d) => d.name),
    ['frontend', 'pipeline']
  );
});

test('a payload miss that the compare contradicts still builds', () => {
  // The case the second stage exists for: the payload did not mention the file,
  // the complete list does.
  const first = partitionByWatchPaths([pipeline], ['frontend/src/app.css']);
  assert.deepEqual(
    first.unmatched.map((d) => d.name),
    ['pipeline']
  );

  const compared = changedFilesFromCompare({
    files: [{ filename: 'frontend/src/app.css' }, { filename: 'v2_pipeline/app.py' }]
  });
  assert.deepEqual(
    partitionByWatchPaths(first.unmatched, compared).watched.map((d) => d.name),
    ['pipeline']
  );
});

test('paths that are not a list of strings are treated as no filter', () => {
  assert.deepEqual(
    partitionByWatchPaths(
      [{ autoDeployPaths: null }, { autoDeployPaths: 'frontend/**' }],
      ['docs/readme.md']
    ).unmatched,
    []
  );
});
