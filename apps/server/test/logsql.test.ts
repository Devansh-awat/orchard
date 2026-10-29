import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LogQueryError,
  MAX_SEARCH_TERMS,
  buildClients,
  buildContext,
  buildFilter,
  buildLevelCounts,
  buildRouteStats,
  buildSearch,
  buildSlowest,
  normalizeRoute,
  quote,
  scope,
  searchTerms,
  timeRange
} from '../src/logs/logsql';

const span = {
  namespace: 'ysws-terra',
  app: 'terra-api',
  start: '2026-10-29T05:00:00Z',
  end: new Date('2026-10-29T07:00:00.250Z')
};
const scoped = '{namespace="ysws-terra",app="terra-api"';
const range = '_time:[2026-10-29T05:00:00.000Z, 2026-10-29T07:00:00.250Z]';

function unquote(literal: string): string {
  return JSON.parse(literal.replace(/\\u([0-9a-f]{4})/g, '\\u$1'));
}

test('quote escapes backslashes, double quotes and control characters', () => {
  assert.equal(quote('plain'), '"plain"');
  assert.equal(quote('say "hi"'), '"say \\"hi\\""');
  assert.equal(quote('C:\\path\\'), '"C:\\\\path\\\\"');
  assert.equal(quote('a\nb\r\tc'), '"a\\nb\\r\\tc"');
  assert.equal(quote('bell\u0007del\u007fnul\u0000'), '"bell\\u0007del\\u007fnul\\u0000"');
  assert.equal(quote('c1\u0085'), '"c1\\u0085"');
});

test('quote keeps LogsQL operators inert inside the literal', () => {
  for (const raw of [
    'a | delete',
    'level:error',
    'foo*',
    '(x OR y)',
    '{app="x"}',
    "it's",
    '`tick`',
    '_time:5m'
  ]) {
    const literal = quote(raw);
    assert.ok(literal.startsWith('"') && literal.endsWith('"'), raw);
    assert.equal(unquote(literal), raw);
    assert.doesNotMatch(literal.slice(1, -1), /(^|[^\\])"/, raw);
  }
});

test('quote round-trips unicode and repairs lone surrogates', () => {
  assert.equal(quote('héllo 世界 🌱'), '"héllo 世界 🌱"');
  assert.equal(quote('bad\uD800half'), '"bad\uFFFDhalf"');
});

test('quote rejects non-strings', () => {
  assert.throws(() => quote(42 as unknown as string), LogQueryError);
});

test('scope quotes values and can narrow by kind', () => {
  assert.equal(scope({ namespace: 'ns', app: 'web' }), '{namespace="ns",app="web"}');
  assert.equal(
    scope({ namespace: 'ns', app: 'web', kind: 'access' }),
    '{namespace="ns",app="web",kind="access"}'
  );
  assert.equal(scope({ namespace: 'ns', app: 'a"}|x' }), '{namespace="ns",app="a\\"}|x"}');
});

test('scope refuses to run unscoped', () => {
  assert.throws(() => scope({ namespace: '', app: 'web' }), LogQueryError);
  assert.throws(() => scope({ namespace: 'ns', app: '  ' }), LogQueryError);
  assert.throws(
    () => scope({ namespace: undefined as unknown as string, app: 'web' }),
    LogQueryError
  );
  assert.throws(
    () => scope({ namespace: 'ns', app: 'web', kind: 'audit' as never }),
    LogQueryError
  );
});

test('timeRange renders RFC3339 UTC from dates, strings and epoch ms', () => {
  assert.equal(timeRange(span.start, span.end), range);
  assert.equal(
    timeRange(Date.UTC(2026, 9, 29, 5), '2026-10-29T08:00:00+01:00'),
    '_time:[2026-10-29T05:00:00.000Z, 2026-10-29T07:00:00.000Z]'
  );
  assert.throws(() => timeRange('yesterday', span.end), LogQueryError);
  assert.throws(() => timeRange(span.end, span.start), LogQueryError);
});

test('every builder puts the stream scope first', () => {
  const queries = [
    buildSearch({ ...span }),
    buildSearch({ ...span, kind: 'app', q: 'x', levels: ['error'], pods: ['p'] }),
    buildFilter({ ...span, q: 'x' }),
    buildLevelCounts({ ...span, kind: 'app' }),
    buildRouteStats(span),
    buildClients(span).ips,
    buildClients(span).agents,
    buildSlowest(span, 5),
    buildContext({
      namespace: 'ysws-terra',
      app: 'terra-api',
      pod: 'p',
      at: span.start,
      beforeMs: 1,
      afterMs: 1
    })
  ];
  for (const q of queries) assert.ok(q.startsWith(scoped), q);
});

test('buildSearch with only a span is scope, time and newest first', () => {
  assert.equal(buildSearch(span), `${scoped}} ${range} | sort by (_time desc)`);
});

test('buildSearch splits free text into quoted case-insensitive phrases', () => {
  assert.equal(
    buildSearch({ ...span, kind: 'app', q: '  DB   timeout ' }),
    `${scoped},kind="app"} ${range} i("DB") i("timeout") | sort by (_time desc)`
  );
  assert.equal(
    buildFilter({ ...span, q: 'refused "redis down" retry' }),
    `${scoped}} ${range} i("refused") i("redis down") i("retry")`
  );
  assert.deepEqual(searchTerms('""  "" '), []);
  assert.deepEqual(searchTerms(undefined), []);
});

test('buildSearch keeps injection attempts inside quoted literals', () => {
  const q = buildSearch({ ...span, q: '") | delete' });
  assert.equal(q, `${scoped}} ${range} i("\\")") i("|") i("delete") | sort by (_time desc)`);
  const pipes = q.split(/(?<!\\)"[^"\\]*(?:\\.[^"\\]*)*"/).join('');
  assert.equal(pipes.match(/\|/g)?.length, 1);

  const nasty = buildFilter({ ...span, q: '"a\\" | stats count()" * _time:1y level:error (x)' });
  assert.equal(
    nasty,
    `${scoped}} ${range} i("a\\\\") i("|") i("stats") i("count()\\"") i("*") i("_time:1y") i("level:error") i("(x)")`
  );
});

test('buildSearch carries newlines in terms as escapes, never raw', () => {
  const q = buildFilter({ ...span, q: '"line1\nline2"' });
  assert.ok(!q.includes('\n'));
  assert.ok(q.endsWith('i("line1\\nline2")'));
});

test('buildSearch bounds the number and size of search terms', () => {
  const many = Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_, i) => `w${i}`).join(' ');
  assert.throws(() => buildSearch({ ...span, q: many }), LogQueryError);
  assert.throws(() => buildSearch({ ...span, q: 'x'.repeat(257) }), LogQueryError);
});

test('levels become a validated in() filter', () => {
  assert.equal(
    buildFilter({ ...span, levels: ['error', 'warn', 'error'] }),
    `${scoped}} ${range} level:in("error","warn")`
  );
  assert.throws(() => buildFilter({ ...span, levels: ['error', 'fatal'] }), LogQueryError);
  assert.throws(() => buildFilter({ ...span, levels: ['*'] }), LogQueryError);
  assert.equal(buildFilter({ ...span, levels: [] }), `${scoped}} ${range}`);
});

test('pods become a quoted in() filter', () => {
  assert.equal(
    buildFilter({ ...span, pods: ['web-1', 'we"b-2', '*'] }),
    `${scoped}} ${range} pod:in("web-1","we\\"b-2","*")`
  );
  assert.throws(() => buildFilter({ ...span, pods: [''] }), LogQueryError);
  assert.throws(
    () => buildFilter({ ...span, pods: Array.from({ length: 101 }, (_, i) => `p${i}`) }),
    LogQueryError
  );
});

test('buildSearch appends a validated limit', () => {
  assert.ok(buildSearch({ ...span, limit: 200 }).endsWith('| sort by (_time desc) | limit 200'));
  for (const limit of [0, -1, 1.5, 5001, Number.NaN]) {
    assert.throws(() => buildSearch({ ...span, limit }), LogQueryError, String(limit));
  }
});

test('buildLevelCounts counts every level, whatever levels were selected', () => {
  const opts = { ...span, kind: 'app' as const, q: 'boom', levels: ['error'] };
  assert.equal(
    buildLevelCounts(opts),
    `${scoped},kind="app"} ${range} i("boom") | stats by (level) count() hits`
  );
});

test('buildFilter is the pipe-free query /select/logsql/hits takes', () => {
  assert.ok(
    !buildFilter({ ...span, kind: 'app', q: 'a | b', levels: ['warn'] }).match(/(^|[^"])\| /)
  );
});

test('buildRouteStats groups access logs by host and ingest-normalised route', () => {
  assert.equal(
    buildRouteStats(span),
    `${scoped},kind="access"} ${range} | stats by (host, route) count() requests, count() if (status:>=500) errors, ` +
      'quantile(0.5, duration_ms) p50, quantile(0.95, duration_ms) p95, quantile(0.99, duration_ms) p99' +
      ' | sort by (requests desc)'
  );
  assert.ok(
    buildRouteStats({ ...span, limit: 50 }).endsWith('| sort by (requests desc) | limit 50')
  );
});

test('buildClients returns top client ips and user agents', () => {
  const { ips, agents } = buildClients(span, 5);
  assert.equal(ips, `${scoped},kind="access"} ${range} | top 5 by (client_ip)`);
  assert.equal(agents, `${scoped},kind="access"} ${range} | top 5 by (user_agent)`);
  assert.throws(() => buildClients(span, 0), LogQueryError);
});

test('buildSlowest sorts access logs by duration', () => {
  assert.equal(
    buildSlowest(span, 20),
    `${scoped},kind="access"} ${range} | sort by (duration_ms desc) | limit 20`
  );
  assert.throws(() => buildSlowest(span, 1001), LogQueryError);
});

test('buildContext reads one pod around a moment, oldest first', () => {
  assert.equal(
    buildContext({
      namespace: 'ysws-terra',
      app: 'terra-api',
      pod: 'terra-api-1',
      at: '2026-10-29T06:00:10Z',
      beforeMs: 5000,
      afterMs: 2500,
      limit: 100
    }),
    `${scoped},kind="app"} _time:[2026-10-29T06:00:05.000Z, 2026-10-29T06:00:12.500Z] pod:="terra-api-1" | sort by (_time) | limit 100`
  );
});

test('buildContext validates its span and pod', () => {
  const base = { namespace: 'ns', app: 'web', pod: 'p', at: span.start, beforeMs: 0, afterMs: 0 };
  assert.ok(buildContext({ ...base, pod: 'x") | delete' }).includes('pod:="x\\") | delete"'));
  assert.throws(() => buildContext({ ...base, pod: '' }), LogQueryError);
  assert.throws(() => buildContext({ ...base, beforeMs: -1 }), LogQueryError);
  assert.throws(() => buildContext({ ...base, afterMs: Number.POSITIVE_INFINITY }), LogQueryError);
  assert.throws(() => buildContext({ ...base, afterMs: 7 * 60 * 60 * 1000 }), LogQueryError);
  assert.throws(() => buildContext({ ...base, at: 'nope' }), LogQueryError);
});

test('normalizeRoute collapses ids and strips query and fragment', () => {
  const cases: [string, string][] = [
    ['/', '/'],
    ['', '/'],
    ['/health', '/health'],
    ['/users/42', '/users/:id'],
    ['/users/42/orders/7?page=2', '/users/:id/orders/:id'],
    ['/a#frag', '/a'],
    ['/api/items/9f8e7d6c-5b4a-4928-a706-f5e4d3c2b1a0', '/api/items/:id'],
    ['/api/items/9F8E7D6C-5B4A-4928-A706-F5E4D3C2B1A0/edit', '/api/items/:id/edit'],
    ['/blob/5f2b8c9e1a3d4f6b', '/blob/:id'],
    ['/commit/0123456789abcdef0123456789abcdef01234567', '/commit/:id'],
    ['/p/cmst3ej21000y01p67my5t5c3/review/q60018se', '/p/:id/review/:id'],
    ['/s/V1StGXR8_Z5jdHi6B-myT', '/s/:id'],
    ['/v2/oauth2/callback', '/v2/oauth2/callback'],
    ['/assets/index-a1b2.js', '/assets/index-a1b2.js'],
    ['/release-notes/2fa-setup', '/release-notes/2fa-setup'],
    ['/deadbeef', '/deadbeef'],
    ['/users/42/', '/users/:id/'],
    ['//double//7', '//double//:id']
  ];
  for (const [input, want] of cases) assert.equal(normalizeRoute(input), want, input);
});
