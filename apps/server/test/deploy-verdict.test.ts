import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deployVerdict,
  type DeployVerdict,
  type VerdictInput,
  type VerdictWindow
} from '../src/observability/verdict';

const MIB = 1024 ** 2;

function win(over: Partial<VerdictWindow> = {}): VerdictWindow {
  return {
    requests: 1000,
    errorPct: 0.2,
    p95Ms: 180,
    rps: 2,
    memoryBytes: 300 * MIB,
    restarts: 0,
    ...over
  };
}

function verdict(
  before: Partial<VerdictWindow>,
  after: Partial<VerdictWindow>,
  over: Partial<VerdictInput> = {}
): DeployVerdict {
  return deployVerdict({
    before: win(before),
    after: win(after),
    newErrorGroups: 0,
    version: 'v7',
    previousVersion: 'v6',
    ...over
  });
}

function line(v: DeployVerdict, dimension: string) {
  const l = v.lines.find((x) => x.dimension === dimension);
  assert.ok(l);
  return l;
}

const BANNED = [
  /it appears/i,
  /may indicate/i,
  /\bseems?\b/i,
  /potentially/i,
  /\blikely\b/i,
  /\bAI\b/,
  /!/,
  /—/,
  /–/
];

function assertClean(v: DeployVerdict): void {
  for (const text of [v.summary, ...v.lines.map((l) => l.text)]) {
    for (const re of BANNED) assert.doesNotMatch(text, re, `${re} in "${text}"`);
  }
}

test('slower responses with errors unchanged', () => {
  const v = verdict({}, { p95Ms: 248 });
  assert.equal(v.status, 'regressed');
  assert.equal(v.summary, 'v7: responses 38% slower (p95 180 → 248 ms); errors unchanged');
  assert.equal(line(v, 'p95').status, 'regressed');
  assert.equal(line(v, 'p95').text, 'Responses 38% slower than v6 (p95 180 → 248 ms)');
  assert.equal(line(v, 'errors').status, 'unchanged');
  assertClean(v);
});

test('errors regression without p95 data', () => {
  const v = verdict({ p95Ms: null }, { p95Ms: null, errorPct: 1.4 });
  assert.equal(v.status, 'regressed');
  assert.equal(v.summary, 'v7: errors went from 0.2% to 1.4%');
  assert.equal(line(v, 'p95').status, 'insufficient');
  assertClean(v);
});

test('errors regression mentions unchanged responses when known', () => {
  const v = verdict({}, { errorPct: 1.4 });
  assert.equal(v.summary, 'v7: errors went from 0.2% to 1.4%; responses unchanged');
});

test('nothing moved', () => {
  const v = verdict({}, { p95Ms: 200, errorPct: 0.3 });
  assert.equal(v.status, 'unchanged');
  assert.equal(v.summary, 'No change worth noting');
  assertClean(v);
});

test('not enough traffic in either window', () => {
  const low = verdict({ requests: 199 }, { p95Ms: 900, errorPct: 9 });
  assert.equal(low.status, 'insufficient');
  assert.equal(low.summary, 'v7: not enough traffic to compare');
  assert.equal(line(low, 'p95').status, 'insufficient');
  assert.equal(line(low, 'errors').status, 'insufficient');
  assert.equal(line(low, 'errors').text, 'Not enough traffic to compare errors');
  assert.equal(verdict({}, { requests: 199, p95Ms: 900 }).status, 'insufficient');
  assert.equal(verdict({ requests: 200 }, { requests: 200, p95Ms: 900 }).status, 'regressed');
  assertClean(low);
});

test('p95 floors: +25% and +50 ms, both inclusive', () => {
  assert.equal(line(verdict({ p95Ms: 200 }, { p95Ms: 250 }), 'p95').status, 'regressed');
  assert.equal(line(verdict({ p95Ms: 200 }, { p95Ms: 249.9 }), 'p95').status, 'unchanged');
  assert.equal(line(verdict({ p95Ms: 100 }, { p95Ms: 149 }), 'p95').status, 'unchanged');
  assert.equal(line(verdict({ p95Ms: 100 }, { p95Ms: 150 }), 'p95').status, 'regressed');
  assert.equal(line(verdict({ p95Ms: 1000 }, { p95Ms: 1249 }), 'p95').status, 'unchanged');
  assert.equal(line(verdict({ p95Ms: 1000 }, { p95Ms: 1250 }), 'p95').status, 'regressed');
  assert.equal(line(verdict({ p95Ms: 40 }, { p95Ms: 80 }), 'p95').status, 'unchanged');
});

test('p95 improvement floors: -25% and -50 ms', () => {
  assert.equal(line(verdict({ p95Ms: 200 }, { p95Ms: 150 }), 'p95').status, 'improved');
  assert.equal(line(verdict({ p95Ms: 200 }, { p95Ms: 150.1 }), 'p95').status, 'unchanged');
  assert.equal(line(verdict({ p95Ms: 1000 }, { p95Ms: 750 }), 'p95').status, 'improved');
  assert.equal(line(verdict({ p95Ms: 1000 }, { p95Ms: 751 }), 'p95').status, 'unchanged');
  assert.equal(line(verdict({ p95Ms: 100 }, { p95Ms: 51 }), 'p95').status, 'unchanged');
  const v = verdict({ p95Ms: 400 }, { p95Ms: 200 });
  assert.equal(v.status, 'improved');
  assert.equal(v.summary, 'v7: responses 50% faster (p95 400 → 200 ms); errors unchanged');
});

test('error floors: 2x and +0.5 points, both inclusive', () => {
  assert.equal(line(verdict({ errorPct: 0.5 }, { errorPct: 1 }), 'errors').status, 'regressed');
  assert.equal(line(verdict({ errorPct: 0.5 }, { errorPct: 0.99 }), 'errors').status, 'unchanged');
  assert.equal(line(verdict({ errorPct: 0.2 }, { errorPct: 0.7 }), 'errors').status, 'regressed');
  assert.equal(line(verdict({ errorPct: 0.2 }, { errorPct: 0.69 }), 'errors').status, 'unchanged');
  assert.equal(line(verdict({ errorPct: 2 }, { errorPct: 3.9 }), 'errors').status, 'unchanged');
  assert.equal(line(verdict({ errorPct: 2 }, { errorPct: 4 }), 'errors').status, 'regressed');
  assert.equal(line(verdict({ errorPct: 0 }, { errorPct: 0.5 }), 'errors').status, 'regressed');
  assert.equal(line(verdict({ errorPct: 0 }, { errorPct: 0.4 }), 'errors').status, 'unchanged');
});

test('error improvement floors: halved and -0.5 points', () => {
  assert.equal(line(verdict({ errorPct: 1 }, { errorPct: 0.5 }), 'errors').status, 'improved');
  assert.equal(line(verdict({ errorPct: 1 }, { errorPct: 0.51 }), 'errors').status, 'unchanged');
  assert.equal(line(verdict({ errorPct: 0.8 }, { errorPct: 0.3 }), 'errors').status, 'improved');
  assert.equal(line(verdict({ errorPct: 0.8 }, { errorPct: 0.31 }), 'errors').status, 'unchanged');
  assert.equal(line(verdict({ errorPct: 0.6 }, { errorPct: 0.2 }), 'errors').status, 'unchanged');
  const v = verdict({ errorPct: 1.4, p95Ms: null }, { errorPct: 0.2, p95Ms: null });
  assert.equal(v.status, 'improved');
  assert.equal(v.summary, 'v7: errors fell from 1.4% to 0.2%');
});

test('restarts regress only when they went up and reached two', () => {
  assert.equal(line(verdict({ restarts: 0 }, { restarts: 1 }), 'restarts').status, 'unchanged');
  assert.equal(
    line(verdict({ restarts: 0 }, { restarts: 1 }), 'restarts').text,
    'Restarted once, up from 0'
  );
  assert.equal(line(verdict({ restarts: 2 }, { restarts: 2 }), 'restarts').status, 'unchanged');
  assert.equal(
    line(verdict({ restarts: 3 }, { restarts: 1 }), 'restarts').text,
    'Restarted once, down from 3'
  );
  assert.equal(line(verdict({ restarts: 0 }, { restarts: 0 }), 'restarts').text, 'No restarts');
  const v = verdict({ restarts: 1 }, { restarts: 2 });
  assert.equal(line(v, 'restarts').status, 'regressed');
  assert.equal(v.status, 'regressed');
  assert.equal(v.summary, 'v7: restarted 2 times, up from 1');
});

test('restarts regress even without traffic', () => {
  const v = verdict({ requests: 0 }, { requests: 0, restarts: 4 });
  assert.equal(v.status, 'regressed');
  assert.equal(v.summary, 'v7: restarted 4 times, up from 0');
});

test('memory floors: +30% and +64 MiB is notable, not a regression', () => {
  const v = verdict({ memoryBytes: 300 * MIB }, { memoryBytes: 390 * MIB });
  assert.equal(line(v, 'memory').status, 'notable');
  assert.equal(v.status, 'unchanged');
  assert.equal(v.summary, 'v7: memory up 30% (300 → 390 MiB)');
  assert.equal(
    line(verdict({ memoryBytes: 300 * MIB }, { memoryBytes: 389 * MIB }), 'memory').status,
    'unchanged'
  );
  assert.equal(
    line(verdict({ memoryBytes: 100 * MIB }, { memoryBytes: 163 * MIB }), 'memory').status,
    'unchanged'
  );
  assert.equal(
    line(verdict({ memoryBytes: 100 * MIB }, { memoryBytes: 164 * MIB }), 'memory').status,
    'notable'
  );
  assert.equal(
    line(verdict({ memoryBytes: 400 * MIB }, { memoryBytes: 280 * MIB }), 'memory').text,
    'Memory down 30% (400 → 280 MiB)'
  );
  assert.equal(line(verdict({ memoryBytes: null }, {}), 'memory').status, 'insufficient');
});

test('memory in GiB', () => {
  const v = verdict({ memoryBytes: 1024 * MIB }, { memoryBytes: 2048 * MIB });
  assert.equal(line(v, 'memory').text, 'Memory up 100% (1 → 2 GiB)');
});

test('slow responses switch to seconds', () => {
  const v = verdict({ p95Ms: 800 }, { p95Ms: 1600 });
  assert.equal(line(v, 'p95').text, 'Responses 100% slower than v6 (p95 800 ms → 1.6 s)');
  const s = verdict({ p95Ms: 1200 }, { p95Ms: 2500 });
  assert.match(s.summary, /p95 1\.2 → 2\.5 s/);
});

test('new error groups are named in the summary', () => {
  const v = verdict({}, {}, { newErrorGroups: 3 });
  assert.equal(v.newErrorGroups, 3);
  assert.equal(v.status, 'unchanged');
  assert.equal(v.summary, 'v7: 3 new errors');
  assert.equal(verdict({}, {}, { newErrorGroups: 1 }).summary, 'v7: 1 new error');
  assert.equal(
    verdict({}, { p95Ms: 300 }, { newErrorGroups: 1 }).summary,
    'v7: responses 67% slower (p95 180 → 300 ms); errors unchanged; 1 new error'
  );
});

test('a missing version label falls back to this deploy', () => {
  const v = verdict({}, { errorPct: 3 }, { version: null, previousVersion: null });
  assert.equal(v.summary, 'This deploy: errors went from 0.2% to 3%; responses unchanged');
  const low = verdict({ requests: 5 }, {}, { version: null });
  assert.equal(low.summary, 'This deploy: not enough traffic to compare');
});

test('regression beats improvement for the overall status', () => {
  const v = verdict({ p95Ms: 400 }, { p95Ms: 200, errorPct: 2 });
  assert.equal(v.status, 'regressed');
  assert.equal(
    v.summary,
    'v7: responses 50% faster (p95 400 → 200 ms); errors went from 0.2% to 2%'
  );
  assertClean(v);
});

test('every line has before and after values', () => {
  const v = verdict({}, { p95Ms: 248 });
  assert.deepEqual(
    v.lines.map((l) => [l.dimension, l.before, l.after]),
    [
      ['p95', 180, 248],
      ['errors', 0.2, 0.2],
      ['restarts', 0, 0],
      ['memory', 300 * MIB, 300 * MIB]
    ]
  );
});
