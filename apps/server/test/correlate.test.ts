import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correlate,
  formatBytes,
  formatMs,
  formatPercent,
  isStrong,
  minutesAfter,
  type Change,
  type Finding,
  type Symptom
} from '../src/observability/correlate';

const MIN = 60_000;
const MIB = 1024 ** 2;
const T0 = Date.parse('2026-10-29T14:02:00Z');

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function symptom(over: Partial<Symptom> = {}): Symptom {
  return {
    id: 's1',
    kind: 'error-rate',
    onset: T0,
    before: 0.2,
    after: 4.1,
    presentBefore: false,
    ...over
  };
}

function change(over: Partial<Change> = {}): Change {
  return { id: 'c1', t: T0 - 2 * MIN, kind: 'deploy', label: 'v7', actor: null, ...over };
}

function run(symptoms: Symptom[], changes: Change[] = [], dependencies: Change[] = []): Finding[] {
  return correlate({ symptoms, changes, dependencies, formatTime: hhmm });
}

const BANNED = [
  /it appears/i,
  /may indicate/i,
  /\bseems?\b/i,
  /potentially/i,
  /\blikely\b/i,
  /\bAI\b/,
  /\bmight\b/i,
  /\bperhaps\b/i,
  /\bpossibly\b/i,
  /!/,
  /—/,
  /–/
];

function assertClean(sentence: string): void {
  for (const re of BANNED) assert.doesNotMatch(sentence, re, `${re} in "${sentence}"`);
  assert.match(sentence, /^[A-Z]/);
  assert.match(sentence, /\.$/);
  assert.doesNotMatch(sentence, /[a-z0-9]+-[a-z0-9]{8,10}-[a-z0-9]{5}/);
}

test('errors link to the deploy two minutes earlier', () => {
  const [f] = run([symptom()], [change()]);
  assert.equal(
    f.sentence,
    'Errors went from 0.2% to 4.1% at 14:02, two minutes after v7 went live.'
  );
  assert.equal(f.causeId, 'c1');
  assert.deepEqual(f.evidence, ['s1', 'c1']);
  assert.equal(f.at, T0);
  assert.equal(f.symptomId, 's1');
});

test('p95 links to a resource change a minute earlier', () => {
  const [f] = run(
    [symptom({ kind: 'p95', before: 180, after: 248 })],
    [change({ kind: 'resources', label: 'memory limit', t: T0 - MIN })]
  );
  assert.equal(
    f.sentence,
    'Responses slowed from 180 ms to 248 ms at 14:02, a minute after the memory limit changed.'
  );
});

test('throttling without a cause names the CPU limit in the present tense', () => {
  const onset = Date.parse('2026-10-29T13:40:00Z');
  const [f] = run([symptom({ kind: 'throttling', onset, before: 2, after: 38 })]);
  assert.equal(
    f.sentence,
    'Throttled 38% of the time since 13:40; the CPU limit is the bottleneck.'
  );
  assert.equal(f.causeId, null);
  assert.deepEqual(f.evidence, ['s1']);
});

test('a finished throttling window uses a past range', () => {
  const onset = Date.parse('2026-10-29T13:40:00Z');
  const [f] = run([symptom({ kind: 'throttling', onset, end: onset + 30 * MIN, after: 40 })]);
  assert.equal(f.sentence, 'Throttled 40% of the time from 13:40 to 14:10.');
});

test('a restart burst links to a database restart as a dependency', () => {
  const onset = Date.parse('2026-10-29T09:12:00Z');
  const [f] = run(
    [symptom({ kind: 'restart-burst', onset, before: 0, after: 4 })],
    [],
    [{ id: 'db1', t: onset - 20_000, kind: 'database', label: 'the database main-db' }]
  );
  assert.equal(
    f.sentence,
    'Restarted 4 times from 09:12, right after the database main-db restarted.'
  );
  assert.equal(f.causeId, 'db1');
});

test('a single restart reads as once', () => {
  const [f] = run(
    [symptom({ kind: 'restart-burst', before: 0, after: 1 })],
    [change({ t: T0 - 5 * MIN })]
  );
  assert.equal(f.sentence, 'Restarted once from 14:02, five minutes after v7 went live.');
});

test('memory step names the env var key', () => {
  const [f] = run(
    [symptom({ kind: 'memory-step', before: 210 * MIB, after: 480 * MIB })],
    [change({ kind: 'env', label: 'CACHE_SIZE', t: T0 - 3 * MIN })]
  );
  assert.equal(
    f.sentence,
    'Memory stepped up from 210 MiB to 480 MiB at 14:02, three minutes after CACHE_SIZE changed.'
  );
});

test('a cause exactly at onset links as right after', () => {
  const [f] = run([symptom()], [change({ t: T0 })]);
  assert.equal(f.causeId, 'c1');
  assert.match(f.sentence, /right after v7 went live/);
});

test('a cause exactly ten minutes before onset links, one ms more does not', () => {
  const weak = symptom({ before: 0.2, after: 1 });
  assert.equal(run([weak], [change({ t: T0 - 10 * MIN })])[0].causeId, 'c1');
  assert.match(run([weak], [change({ t: T0 - 10 * MIN })])[0].sentence, /ten minutes after/);
  assert.deepEqual(run([weak], [change({ t: T0 - 10 * MIN - 1 })]), []);
});

test('a change after the onset is never the cause', () => {
  assert.deepEqual(run([symptom({ after: 1 })], [change({ t: T0 + 1 })]), []);
});

test('the closest candidate wins', () => {
  const [f] = run(
    [symptom()],
    [
      change({ id: 'far', t: T0 - 8 * MIN }),
      change({ id: 'near', kind: 'env', label: 'API_URL', t: T0 - 90_000 })
    ]
  );
  assert.equal(f.causeId, 'near');
  assert.match(f.sentence, /two minutes after API_URL changed/);
});

test('equally close candidates prefer deploy, resources, env, config, database, platform', () => {
  const t = T0 - 4 * MIN;
  const order: Change['kind'][] = ['deploy', 'resources', 'env', 'config', 'database', 'platform'];
  for (let i = 0; i < order.length; i++) {
    const pool = order.slice(i).map((kind) => change({ id: kind, kind, t, label: 'x' }));
    pool.reverse();
    assert.equal(run([symptom()], pool)[0].causeId, order[i]);
  }
  const [f] = run(
    [symptom()],
    [change({ id: 'node', kind: 'node', t }), change({ id: 'db', kind: 'database', t })]
  );
  assert.equal(f.causeId, 'db');
});

test('a symptom already present before onset gets no cause', () => {
  const out = run([symptom({ presentBefore: true, before: 0.2, after: 1 })], [change()]);
  assert.deepEqual(out, []);
  const strong = run([symptom({ presentBefore: true, before: 0.2, after: 9 })], [change()]);
  assert.equal(strong.length, 1);
  assert.equal(strong[0].causeId, null);
  assert.equal(strong[0].sentence, 'Errors went from 0.2% to 9% at 14:02.');
});

test('weak symptoms without a cause produce nothing', () => {
  assert.deepEqual(
    run([
      symptom({ id: 'a', kind: 'error-rate', before: 1, after: 4.9 }),
      symptom({ id: 'b', kind: 'p95', before: 400, after: 799 }),
      symptom({ id: 'c', kind: 'memory-step', before: 300 * MIB, after: 500 * MIB }),
      symptom({ id: 'd', kind: 'restart-burst', before: 0, after: 2 }),
      symptom({ id: 'e', kind: 'throttling', before: 0, after: 24 })
    ]),
    []
  );
});

test('strong thresholds without a cause', () => {
  assert.equal(isStrong(symptom({ kind: 'error-rate', before: 3, after: 5 })), true);
  assert.equal(isStrong(symptom({ kind: 'error-rate', before: 3.1, after: 5 })), false);
  assert.equal(isStrong(symptom({ kind: 'error-rate', before: 0, after: 4.99 })), false);
  assert.equal(isStrong(symptom({ kind: 'p95', before: 500, after: 1000 })), true);
  assert.equal(isStrong(symptom({ kind: 'p95', before: 500, after: 999 })), false);
  assert.equal(isStrong(symptom({ kind: 'p95', before: 2000, after: 3000 })), false);
  assert.equal(
    isStrong(symptom({ kind: 'memory-step', before: 256 * MIB, after: 512 * MIB })),
    true
  );
  assert.equal(
    isStrong(symptom({ kind: 'memory-step', before: 1024 * MIB, after: 1280 * MIB })),
    false
  );
  assert.equal(isStrong(symptom({ kind: 'restart-burst', before: 0, after: 3 })), true);
  assert.equal(isStrong(symptom({ kind: 'throttling', before: 0, after: 25 })), true);
});

test('strong p95 without a cause is an observation only', () => {
  const [f] = run([symptom({ kind: 'p95', before: 300, after: 1250 })]);
  assert.equal(f.sentence, 'Responses slowed from 300 ms to 1.3 s at 14:02.');
});

test('one sentence per symptom, sorted by onset', () => {
  const out = run(
    [
      symptom({ id: 'late', onset: T0 + 5 * MIN, after: 9 }),
      symptom({ id: 'early', kind: 'p95', before: 180, after: 248 }),
      symptom({ id: 'gone', onset: Number.NaN })
    ],
    [change({ t: T0 - MIN }), change({ id: 'c2', t: T0 - 2 * MIN })]
  );
  assert.deepEqual(
    out.map((f) => [f.symptomId, f.causeId]),
    [
      ['early', 'c1'],
      ['late', 'c1']
    ]
  );
  assert.match(out[1].sentence, /six minutes after v7/);
});

test('scale, config, platform, eviction and node phrasing', () => {
  const kinds: [Change['kind'], string, RegExp][] = [
    ['scale', '3 replicas', /after the app was scaled to 3 replicas\.$/],
    ['config', 'api.example.com', /after api\.example\.com changed\.$/],
    ['platform', 'Orchard update', /after the Orchard update rolled out\.$/],
    ['eviction', 'an instance', /after an instance was evicted\.$/],
    ['node', 'node house', /after the node house was drained\.$/]
  ];
  for (const [kind, label, re] of kinds) {
    const [f] = run([symptom()], [change({ kind, label })]);
    assert.match(f.sentence, re);
  }
});

test('minute wording spells one through ten', () => {
  assert.equal(minutesAfter(0), 'right after');
  assert.equal(minutesAfter(59_999), 'right after');
  assert.equal(minutesAfter(60_000), 'a minute after');
  assert.equal(minutesAfter(89_999), 'a minute after');
  assert.equal(minutesAfter(90_000), 'two minutes after');
  const words = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  words.forEach((w, i) => assert.equal(minutesAfter((i + 2) * MIN), `${w} minutes after`));
});

test('number formatting', () => {
  assert.equal(formatPercent(0.2), '0.2%');
  assert.equal(formatPercent(4), '4%');
  assert.equal(formatPercent(0.04), '0.04%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatMs(180.4), '180 ms');
  assert.equal(formatMs(2000), '2 s');
  assert.equal(formatBytes(512 * MIB), '512 MiB');
  assert.equal(formatBytes(1.5 * 1024 * MIB), '1.5 GiB');
});

test('every generated sentence passes the copy rules', () => {
  const kinds: Symptom['kind'][] = [
    'error-rate',
    'p95',
    'memory-step',
    'restart-burst',
    'throttling'
  ];
  const causeKinds: Change['kind'][] = [
    'deploy',
    'config',
    'resources',
    'env',
    'scale',
    'platform',
    'eviction',
    'node',
    'database'
  ];
  const values: Record<Symptom['kind'], [number, number]> = {
    'error-rate': [0.2, 9],
    p95: [180, 1400],
    'memory-step': [200 * MIB, 900 * MIB],
    'restart-burst': [0, 5],
    throttling: [0, 60]
  };
  const sentences: string[] = [];
  for (const kind of kinds) {
    const [before, after] = values[kind];
    for (const end of [undefined, T0 + 20 * MIN]) {
      sentences.push(...run([symptom({ kind, before, after, end })]).map((f) => f.sentence));
      sentences.push(
        ...run([symptom({ kind, before: after, after: before, end })], [change()]).map(
          (f) => f.sentence
        )
      );
      for (const ck of causeKinds) {
        for (let m = 0; m <= 10; m++) {
          const out = run(
            [symptom({ kind, before, after, end })],
            [change({ kind: ck, t: T0 - m * MIN, label: 'web' })]
          );
          sentences.push(...out.map((f) => f.sentence));
        }
      }
    }
  }
  assert.ok(sentences.length > 900);
  for (const s of sentences) assertClean(s);
});
