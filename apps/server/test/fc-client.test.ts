import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ndjson,
  parseHosts,
  rankHosts,
  rendezvousScore,
  signFcToken
} from '../src/docker/fc/fc-client';

const hosts = ['fc-builder-0', 'fc-builder-1', 'fc-builder-2'].map((id) => ({ id }));

test('rendezvous ranking matches the shared vectors', () => {
  assert.equal(rendezvousScore('fc-builder-0', 'proj-fudge'), 14840231631676381432n);
  assert.equal(rendezvousScore('fc-builder-0', 'a'), 15732676229586377407n);
  const vectors: Record<string, string[]> = {
    'proj-fudge': ['fc-builder-0', 'fc-builder-2', 'fc-builder-1'],
    'ysws-attend': ['fc-builder-0', 'fc-builder-2', 'fc-builder-1'],
    'orchard-landing': ['fc-builder-2', 'fc-builder-1', 'fc-builder-0'],
    a: ['fc-builder-1', 'fc-builder-0', 'fc-builder-2']
  };
  for (const [key, want] of Object.entries(vectors)) {
    assert.deepEqual(
      rankHosts(hosts, key).map((h) => h.id),
      want,
      key
    );
  }
});

test('ranking is stable when a host is removed', () => {
  const full = rankHosts(hosts, 'proj-fudge').map((h) => h.id);
  const without = rankHosts(
    hosts.filter((h) => h.id !== 'fc-builder-1'),
    'proj-fudge'
  ).map((h) => h.id);
  assert.deepEqual(
    without,
    full.filter((id) => id !== 'fc-builder-1')
  );
});

test('parseHosts derives ids from statefulset pod hostnames', () => {
  const parsed = parseHosts(
    'http://fc-builder-0.fc-builder.orchard-fc-builders.svc.cluster.local:8080/, http://fc-builder-1.fc-builder.orchard-fc-builders.svc.cluster.local:8080'
  );
  assert.deepEqual(
    parsed.map((h) => h.id),
    ['fc-builder-0', 'fc-builder-1']
  );
  assert.equal(parsed[0].url.endsWith(':8080'), true);
  assert.deepEqual(parseHosts(''), []);
});

test('token matches the vector the Go host verifies', () => {
  const now = 1_800_000_000;
  const token = signFcToken('fc-builder-test-secret', now, 60);
  assert.equal(
    token,
    'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmYy1idWlsZGVyIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwNjB9.dR4ulZFFlERfmNb8VJFLLKWPTKN1eyDL8ETvu0kr-Q8'
  );
});

test('ndjson splits across chunk boundaries and tracks byte offsets', async () => {
  const lines = [
    JSON.stringify({ t: 'accepted', at: 1, data: 'fc-builder-0' }),
    JSON.stringify({ t: 'log', at: 2, stream: 'build', data: 'héllo' }),
    JSON.stringify({ t: 'result', at: 3, ok: true })
  ];
  const bytes = Buffer.from(lines.join('\n') + '\n');
  const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 40), bytes.subarray(40)];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    }
  });
  const got: { t: string; offset: number }[] = [];
  for await (const { event, offset } of ndjson(body, 100)) got.push({ t: event.t, offset });
  assert.deepEqual(
    got.map((g) => g.t),
    ['accepted', 'log', 'result']
  );
  assert.equal(got[2].offset, 100 + bytes.length);
  assert.equal(got[0].offset, 100 + Buffer.byteLength(lines[0]) + 1);
});
