import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TimelineEntry,
  compareEntries,
  decodeCursor,
  describeAudit,
  describeBuildRun,
  describeErrorGroup,
  describePodTransition,
  describeRelease,
  encodeCursor,
  entryId,
  mergeTimeline,
  parseKinds,
  commitHref
} from '../src/observability/timeline-entries';

function entry(kind: TimelineEntry['kind'], id: string, at: string): TimelineEntry {
  return {
    id: entryId(kind, id),
    at,
    kind,
    actor: null,
    title: id,
    detail: null,
    status: null,
    href: null,
    meta: {}
  };
}

test('cursor round-trips and rejects anything that is not a timestamp plus id', () => {
  const cursor = { at: 1_700_000_000_000, id: 'pod:abc' };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('not base64 json'), null);
  assert.equal(decodeCursor(Buffer.from('{"at":"soon","id":"x"}').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('{"at":1,"id":""}').toString('base64url')), null);
});

test('entries order newest first with the id as a stable tiebreak', () => {
  const a = entry('audit', 'a', '2026-01-01T00:00:00.000Z');
  const b = entry('pod', 'b', '2026-01-01T00:00:00.000Z');
  const c = entry('release', 'c', '2026-01-02T00:00:00.000Z');
  const sorted = [a, b, c].sort(compareEntries);
  assert.deepEqual(
    sorted.map((e) => e.id),
    ['release:c', 'pod:b', 'audit:a']
  );
});

test('merge interleaves sources, honours the limit and hands back a resumable cursor', () => {
  const audits = [
    entry('audit', 'a3', '2026-01-03T00:00:00.000Z'),
    entry('audit', 'a1', '2026-01-01T00:00:00.000Z')
  ];
  const pods = [
    entry('pod', 'p4', '2026-01-04T00:00:00.000Z'),
    entry('pod', 'p2', '2026-01-02T00:00:00.000Z')
  ];
  const first = mergeTimeline([audits, pods], { limit: 3 });
  assert.deepEqual(
    first.entries.map((e) => e.id),
    ['pod:p4', 'audit:a3', 'pod:p2']
  );
  assert.ok(first.nextCursor);

  const cursor = decodeCursor(first.nextCursor)!;
  const second = mergeTimeline([audits, pods], { limit: 3, cursor });
  assert.deepEqual(
    second.entries.map((e) => e.id),
    ['audit:a1']
  );
  assert.equal(second.nextCursor, null);
});

test('a source that filled its own page keeps the cursor alive even when the merged page is short', () => {
  const pods = [
    entry('pod', 'p3', '2026-01-03T00:00:00.000Z'),
    entry('pod', 'p2', '2026-01-02T00:00:00.000Z'),
    entry('pod', 'p1', '2026-01-01T00:00:00.000Z')
  ];
  const cursor = { at: Date.parse('2026-01-03T00:00:00.000Z'), id: 'pod:p3' };
  const page = mergeTimeline([pods], { limit: 2, cursor });
  assert.deepEqual(
    page.entries.map((e) => e.id),
    ['pod:p2', 'pod:p1']
  );
  assert.ok(page.nextCursor);
});

test('entries sharing the cursor timestamp are only served once', () => {
  const same = '2026-01-01T00:00:00.000Z';
  const rows = [entry('pod', 'c', same), entry('pod', 'b', same), entry('pod', 'a', same)];
  const first = mergeTimeline([rows], { limit: 2 });
  assert.deepEqual(
    first.entries.map((e) => e.id),
    ['pod:c', 'pod:b']
  );
  const second = mergeTimeline([rows], { limit: 2, cursor: decodeCursor(first.nextCursor)! });
  assert.deepEqual(
    second.entries.map((e) => e.id),
    ['pod:a']
  );
});

test('kinds parse from a comma list and drop unknown or repeated names', () => {
  assert.deepEqual(parseKinds('pod, release,pod,bogus'), ['pod', 'release']);
  assert.deepEqual(parseKinds(undefined), []);
  assert.deepEqual(parseKinds(['audit', 'error']), ['audit', 'error']);
});

test('audit rows read as plain English with their diff and sensitive keys already redacted upstream', () => {
  const scaled = describeAudit({
    action: 'deployment.scaled',
    targetType: 'deployment',
    targetLabel: 'web',
    metadata: { replicas: [1, 3], repo: 'https://github.com/org/web' }
  });
  assert.equal(scaled.title, 'Scaled');
  assert.equal(scaled.detail, 'replicas 1 → 3');
  assert.equal(scaled.status, 'info');

  const removed = describeAudit({
    action: 'ingress.deleted',
    targetType: 'ingress',
    targetLabel: 'web.example.com',
    metadata: null
  });
  assert.equal(removed.title, 'Domain removed');
  assert.equal(removed.detail, 'web.example.com');
  assert.equal(removed.status, 'warning');

  const unknown = describeAudit({
    action: 'deployment.some_new.thing_happened',
    targetLabel: null,
    metadata: {}
  });
  assert.equal(unknown.title, 'Some new thing happened');
});

test('build runs explain why nothing shipped', () => {
  assert.deepEqual(describeBuildRun({ status: 'skipped', detail: null, commitMessage: 'x' }), {
    title: 'Build skipped',
    detail: 'Superseded by a newer build',
    status: 'neutral'
  });
  assert.deepEqual(
    describeBuildRun({
      status: 'failed',
      detail: 'npm ERR! missing script: build\nmore lines',
      commitMessage: 'fix things'
    }),
    { title: 'Build failed', detail: 'npm ERR! missing script: build', status: 'error' }
  );
  assert.equal(
    describeBuildRun({ status: 'scheduled', detail: null, commitMessage: null }).detail,
    'Waiting for a build slot'
  );
});

test('releases lead with the commit and fall back to the branch or tag', () => {
  const withCommit = describeRelease({
    tag: 'abc1234',
    image: 'harbor/x:abc1234',
    branch: 'main',
    commitSha: 'abc1234567890',
    commitMessage: 'feat: ship it\n\nlong body'
  });
  assert.equal(withCommit.title, 'feat: ship it');
  assert.equal(withCommit.detail, 'main · abc1234');
  assert.equal(withCommit.status, 'success');

  const imageOnly = describeRelease({
    tag: 'v2',
    image: 'ghcr.io/org/app:v2',
    branch: null,
    commitSha: null,
    commitMessage: null
  });
  assert.equal(imageOnly.title, 'v2');
  assert.equal(imageOnly.detail, 'ghcr.io/org/app:v2');
});

test('pod transitions surface the reason and exit code only when something went wrong', () => {
  const crash = describePodTransition({
    podName: 'web-7d9f-abcde',
    fromStatus: 'ready',
    toStatus: 'crashing',
    reason: 'OOMKilled',
    exitCode: 137
  });
  assert.equal(crash.title, 'Pod crashing');
  assert.equal(crash.detail, 'web-7d9f-abcde · OOMKilled · exit 137');
  assert.equal(crash.status, 'error');

  const ready = describePodTransition({
    podName: 'web-7d9f-abcde',
    fromStatus: 'starting',
    toStatus: 'ready',
    reason: 'Completed',
    exitCode: 0
  });
  assert.equal(ready.detail, 'web-7d9f-abcde');
  assert.equal(ready.status, 'success');
});

test('a generic error type never doubles up as "New error: Error"', () => {
  assert.deepEqual(describeErrorGroup({ type: 'Error', message: 'boom\nstack' }), {
    title: 'boom',
    detail: null,
    status: 'error'
  });
  assert.deepEqual(describeErrorGroup({ type: 'TypeError', message: 'x is not a function' }), {
    title: 'New error: TypeError',
    detail: 'x is not a function',
    status: 'error'
  });
});

test('commit links strip a trailing .git and need both a repo and a sha', () => {
  assert.equal(
    commitHref('https://github.com/org/app.git', 'deadbeef'),
    'https://github.com/org/app/commit/deadbeef'
  );
  assert.equal(commitHref(null, 'deadbeef'), null);
  assert.equal(commitHref('https://github.com/org/app', null), null);
});
