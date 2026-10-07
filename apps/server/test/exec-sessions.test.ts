import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'exec-sessions-test-secret';

import {
  MAX_DETACHED_PER_USER,
  MAX_SESSIONS_PER_USER,
  ResizableOutput,
  makeHandle,
  oldestDetachedBeyondCap,
  overLimit,
  parseHandle,
  replicaId,
  sessions,
  sessionsByUser,
  track,
  untrack,
  type ExecSession
} from '../src/kubernetes/exec-sessions';

function fakeSession(id: string, owner: string, state: ExecSession['state'], detachedAt = 0) {
  return {
    id,
    ownerUserId: owner,
    state,
    detachedAt: detachedAt || null
  } as unknown as ExecSession;
}

function reset() {
  sessions.clear();
  sessionsByUser.clear();
}

test('a handle round-trips and carries the replica that minted it', () => {
  const id = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';
  const handle = makeHandle(id);
  assert.deepEqual(parseHandle(handle), { replica: replicaId, id });
});

test('a tampered or malformed handle is rejected', () => {
  const id = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';
  const handle = makeHandle(id);
  const parts = handle.split('.');
  parts[2] = '00000000-0000-4000-8000-000000000000';
  assert.equal(parseHandle(parts.join('.')), null);
  assert.equal(parseHandle(`${handle}x`), null);
  assert.equal(parseHandle('v2.a.b.c'), null);
  assert.equal(parseHandle('not-a-handle'), null);
});

test('the per-user cap counts every tracked session', () => {
  reset();
  for (let i = 0; i < MAX_SESSIONS_PER_USER - 1; i++) {
    track(fakeSession(`s${i}`, 'u1', 'attached'));
  }
  assert.equal(overLimit('u1'), false);
  track(fakeSession('last', 'u1', 'attached'));
  assert.equal(overLimit('u1'), true);
  assert.equal(overLimit('u2'), false);
  untrack(sessions.get('last')!);
  assert.equal(overLimit('u1'), false);
  reset();
});

test('the oldest detached sessions beyond the cap are the ones culled', () => {
  reset();
  for (let i = 0; i < MAX_DETACHED_PER_USER + 2; i++) {
    track(fakeSession(`d${i}`, 'u1', 'detached', 1000 + i));
  }
  track(fakeSession('live', 'u1', 'attached'));
  const culled = oldestDetachedBeyondCap('u1').map((s) => s.id);
  assert.deepEqual(culled, ['d0', 'd1']);
  reset();
});

test('the PTY size stream dedupes unchanged sizes and clamps the rest', () => {
  const out = new ResizableOutput();
  let events = 0;
  out.on('resize', () => (events += 1));
  out.setSize(120, 40);
  out.setSize(120, 40);
  assert.equal(events, 1);
  out.setSize(0, 5000);
  assert.deepEqual([out.columns, out.rows], [1, 1000]);
  out.setSize(NaN, 10);
  assert.deepEqual([out.columns, out.rows], [1, 1000]);
  assert.equal(events, 2);
});
