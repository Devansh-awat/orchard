import test from 'node:test';
import assert from 'node:assert/strict';
import { createRawjsonTranscoder, transcodeRawjson } from '../src/docker/buildkit-rawjson';

const RUN = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const COPY = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
const EXPORT = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';

function line(status: unknown): string {
  return `${JSON.stringify(status)}\n`;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function idOf(text: string, marker: string): string {
  const match = text.split('\n').find((l) => l.includes(marker));
  assert.ok(match, `no line mentioning ${marker} in:\n${text}`);
  return match.slice(1).split(/\s/)[0];
}

test('a vertex the solver only knows about is not reported as running', () => {
  const t = createRawjsonTranscoder();
  const out = t.feed(line({ vertexes: [{ digest: RUN, name: '[builder 2/5] RUN pnpm install' }] }));
  assert.equal(out, '');
});

test('a step opens when it starts and closes with its real duration', () => {
  const t = createRawjsonTranscoder();
  let text = t.feed(
    line({
      vertexes: [
        {
          digest: RUN,
          name: '[builder 2/5] RUN pnpm install',
          started: '2026-09-21T10:00:00.000Z'
        }
      ]
    })
  );
  assert.match(text, /^#[0-9a-f]{8} \[builder 2\/5\] RUN pnpm install$/m);

  text = t.feed(
    line({
      logs: [
        { vertex: RUN, data: b64('added 400 packages\n'), timestamp: '2026-09-21T10:00:02.500Z' }
      ]
    })
  );
  assert.match(text, /^#[0-9a-f]{8} 2\.500 added 400 packages$/m);

  text = t.feed(
    line({
      vertexes: [
        {
          digest: RUN,
          name: '[builder 2/5] RUN pnpm install',
          started: '2026-09-21T10:00:00.000Z',
          completed: '2026-09-21T10:00:08.400Z'
        }
      ]
    })
  );
  assert.match(text, /^#[0-9a-f]{8} DONE 8\.4s$/m);
});

test('a step keeps the same id across every message about it', () => {
  const t = createRawjsonTranscoder();
  const opened = t.feed(
    line({
      vertexes: [{ digest: RUN, name: '[builder 2/5] RUN x', started: '2026-09-21T10:00:00Z' }]
    })
  );
  const closed = t.feed(
    line({
      vertexes: [
        {
          digest: RUN,
          name: '[builder 2/5] RUN x',
          started: '2026-09-21T10:00:00Z',
          completed: '2026-09-21T10:00:01Z'
        }
      ]
    })
  );
  assert.equal(idOf(opened, 'RUN x'), idOf(closed, 'DONE'));
});

test('ids survive a restarted transcoder so a resumed build does not renumber', () => {
  const vertex = {
    digest: RUN,
    name: '[builder 2/5] RUN x',
    started: '2026-09-21T10:00:00Z'
  };
  const first = createRawjsonTranscoder().feed(line({ vertexes: [vertex] }));
  const second = createRawjsonTranscoder().feed(line({ vertexes: [vertex] }));
  assert.equal(idOf(first, 'RUN x'), idOf(second, 'RUN x'));
});

test('the header still goes out for a cached step that never started', () => {
  const t = createRawjsonTranscoder();
  const text = t.feed(
    line({
      vertexes: [
        {
          digest: COPY,
          name: '[builder 3/5] COPY . .',
          started: '2026-09-21T10:00:00Z',
          completed: '2026-09-21T10:00:00Z',
          cached: true
        }
      ]
    })
  );
  const lines = text.trim().split('\n');
  assert.match(lines[0], /\[builder 3\/5\] COPY \. \.$/);
  assert.match(lines[1], /^#[0-9a-f]{8} CACHED$/);
});

test('a failed step reports its error on one line', () => {
  const text = transcodeRawjson(
    line({
      vertexes: [
        {
          digest: RUN,
          name: '[builder 2/5] RUN pnpm build',
          started: '2026-09-21T10:00:00Z',
          completed: '2026-09-21T10:00:03Z',
          error: 'process "/bin/sh -c pnpm build" did not complete successfully:\n  exit code: 1'
        }
      ]
    })
  );
  assert.match(
    text,
    /^#[0-9a-f]{8} ERROR: process "\/bin\/sh -c pnpm build" did not complete successfully: exit code: 1$/m
  );
});

test('log chunks that split mid-line are rejoined, not printed twice', () => {
  const t = createRawjsonTranscoder();
  t.feed(line({ vertexes: [{ digest: RUN, name: 'RUN x', started: '2026-09-21T10:00:00Z' }] }));
  const first = t.feed(
    line({ logs: [{ vertex: RUN, data: b64('half a '), timestamp: '2026-09-21T10:00:01Z' }] })
  );
  assert.equal(first, '');
  const second = t.feed(
    line({ logs: [{ vertex: RUN, data: b64('line\n'), timestamp: '2026-09-21T10:00:01Z' }] })
  );
  assert.match(second, /^#[0-9a-f]{8} 1\.000 half a line$/m);
});

test('a status message that is split across chunks is parsed once, when it completes', () => {
  const t = createRawjsonTranscoder();
  const whole = line({
    vertexes: [{ digest: RUN, name: 'RUN x', started: '2026-09-21T10:00:00Z' }]
  });
  const cut = Math.floor(whole.length / 2);
  assert.equal(t.feed(whole.slice(0, cut)), '');
  assert.match(t.feed(whole.slice(cut)), /^#[0-9a-f]{8} RUN x$/m);
});

function transfer(current: number, timestamp: string, completed?: string) {
  return line({
    statuses: [
      {
        id: 'transferring context:',
        vertex: COPY,
        name: 'transferring',
        current,
        timestamp,
        completed
      }
    ]
  });
}

test('transfer progress is reported, and only when it changes', () => {
  const t = createRawjsonTranscoder();
  t.feed(
    line({
      vertexes: [
        { digest: COPY, name: '[internal] load build context', started: '2026-09-21T10:00:00Z' }
      ]
    })
  );
  assert.match(t.feed(transfer(199, '2026-09-21T10:00:01Z')), /transferring context: 199B$/m);
  assert.equal(t.feed(transfer(199, '2026-09-21T10:00:03Z')), '');
  assert.match(
    t.feed(transfer(71241, '2026-09-21T10:00:04Z', '2026-09-21T10:00:04Z')),
    /transferring context: 69\.57kB done$/m
  );
});

test('a layer that ticks constantly is reported about once a second', () => {
  const t = createRawjsonTranscoder();
  t.feed(
    line({
      vertexes: [
        { digest: COPY, name: '[internal] load build context', started: '2026-09-21T10:00:00Z' }
      ]
    })
  );
  let emitted = 0;
  for (let ms = 0; ms < 3000; ms += 10) {
    const at = new Date(Date.UTC(2026, 8, 21, 10, 0, 0, ms)).toISOString();
    const text = t.feed(transfer(4096 + ms * 1024, at));
    if (text) emitted += text.trim().split('\n').length;
  }
  assert.equal(emitted, 3);
});

test('plain output and solver errors pass through untouched', () => {
  const t = createRawjsonTranscoder();
  const text = t.feed(
    '#5 [super-build 1/2] FROM docker.io/library/node\n' +
      'error: failed to solve: process "pnpm build" did not complete successfully: exit code: 1\n'
  );
  assert.match(text, /^#5 \[super-build 1\/2\] FROM docker\.io\/library\/node$/m);
  assert.match(text, /^error: failed to solve: /m);
});

test('a build that dies mid-step leaves nothing looking busy', () => {
  const t = createRawjsonTranscoder();
  t.feed(
    line({
      vertexes: [
        { digest: RUN, name: 'RUN x', started: '2026-09-21T10:00:00Z' },
        { digest: EXPORT, name: 'exporting to oci image format', started: '2026-09-21T10:00:00Z' }
      ]
    })
  );
  const flushed = t.flush();
  assert.equal(
    flushed
      .trim()
      .split('\n')
      .filter((l) => l.endsWith('CANCELED')).length,
    2
  );
});

test('flush emits nothing for a build where every step closed', () => {
  const t = createRawjsonTranscoder();
  t.feed(
    line({
      vertexes: [
        {
          digest: RUN,
          name: 'RUN x',
          started: '2026-09-21T10:00:00Z',
          completed: '2026-09-21T10:00:01Z'
        }
      ]
    })
  );
  assert.equal(t.flush(), '');
});

test('a step that finishes before its neighbours still shows as finished', () => {
  // The bug this whole path exists for: with --progress=plain, BuildKit holds a
  // vertex's DONE line while it prints another vertex's section, so a step whose
  // dependents had already completed was still drawn with a spinner.
  const t = createRawjsonTranscoder();
  const text = t.feed(
    line({
      vertexes: [
        {
          digest: COPY,
          name: '[builder 1/2] COPY /root/.local/state/mise',
          started: '2026-09-21T10:00:00Z',
          completed: '2026-09-21T10:00:01Z'
        },
        {
          digest: EXPORT,
          name: 'exporting to oci image format',
          started: '2026-09-21T10:00:01Z'
        }
      ]
    })
  );
  const copyId = idOf(text, 'COPY /root/.local/state/mise');
  const exportId = idOf(text, 'exporting to oci image format');
  assert.match(text, new RegExp(`^#${copyId} DONE `, 'm'));
  assert.doesNotMatch(text, new RegExp(`^#${exportId} (DONE|CACHED|ERROR)`, 'm'));
});
