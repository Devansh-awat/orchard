import './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxExecTarget, sandboxTargetKey } from '../server/src/core/exec-sessions';

const core = require('../../../apps/server/src/kubernetes/exec-sessions') as {
  targetKey(target: unknown): string;
  directoryEntry(replica: string, addr: string, ownerUserId: string, target: unknown): unknown;
};

test('target keys separate sandboxes, sessions, terminal indexes and modes', () => {
  const box = sandboxExecTarget({
    sandboxId: '3f2d7e6a-1b0c-4d5e-8f90-123456789abc',
    sessionId: 'aaaaaaaa-1b0c-4d5e-8f90-123456789abc',
    index: '0',
    mode: 'rw',
    worktreePath: '/persist/home/.worktrees/app/fix'
  });
  assert.equal(box.kind, 'sandbox');
  assert.equal(
    core.targetKey(box),
    'sandbox:3f2d7e6a-1b0c-4d5e-8f90-123456789abc/aaaaaaaa-1b0c-4d5e-8f90-123456789abc/0/rw'
  );
  const keyOf = (patch: Partial<typeof box>) =>
    core.targetKey(sandboxExecTarget({ ...box, ...patch }));
  assert.notEqual(core.targetKey(box), keyOf({ index: '1' }));
  assert.notEqual(core.targetKey(box), keyOf({ mode: 'ro' }));
  assert.notEqual(core.targetKey(box), keyOf({ sessionId: null }));
  assert.equal(keyOf({ worktreePath: null }), core.targetKey(box));
  assert.equal(
    keyOf({ terminalUserId: '22222222-2222-4222-8222-222222222222' }),
    `${core.targetKey(box)}/22222222-2222-4222-8222-222222222222`
  );
  assert.equal(keyOf({ terminalUserId: null }), core.targetKey(box));
  assert.equal(sandboxTargetKey(box), box.key);
});

test('a sandbox directory entry carries only the target key old replicas match on', () => {
  const box = sandboxExecTarget({
    sandboxId: 's',
    sessionId: null,
    index: '0',
    mode: 'rw',
    worktreePath: null
  });
  assert.deepEqual(core.directoryEntry('replica-a', '10.0.0.1:3001', 'u1', box), {
    replica: 'replica-a',
    addr: '10.0.0.1:3001',
    ownerUserId: 'u1',
    targetKey: 'sandbox:s/-/0/rw'
  });
});
