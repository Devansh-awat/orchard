import test from 'node:test';
import assert from 'node:assert/strict';
import { isSandboxStartFault } from '../src/docker/build-faults';

test('the kata thread-id race is treated as a sandbox fault', () => {
  assert.equal(
    isSandboxStartFault(
      'Build failed: Init container inject-build-args failed with exit code 128: StartError' +
        ' - failed to create containerd task: failed to create shim task: failed to get' +
        ' thread ids from hypervisor: open /proc/78145/task/78235/comm: no such file or directory'
    ),
    true
  );
});

test('a shim that never produced a task is a sandbox fault whichever container hit it', () => {
  assert.equal(
    isSandboxStartFault(
      'Build failed: Container buildkit terminated: StartError - failed to create shim task:' +
        ' OCI runtime create failed'
    ),
    true
  );
});

test('the pusher 429 stays a build failure', () => {
  // BuildKit died in under a second and the pusher never got its turn. The
  // real error is in the buildkit logs; re-running just burns another build.
  assert.equal(
    isSandboxStartFault(
      'Build failed: Container pusher terminated: StartError - failed to start containerd task "abc": 429'
    ),
    false
  );
});

test('ordinary build errors never retry', () => {
  assert.equal(
    isSandboxStartFault(
      'Build failed: #12 ERROR: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1'
    ),
    false
  );
  assert.equal(
    isSandboxStartFault('Build failed: error: failed to solve: failed to read dockerfile'),
    false
  );
  assert.equal(isSandboxStartFault(''), false);
});

test('a start error with an unrelated reason is not retried blindly', () => {
  assert.equal(
    isSandboxStartFault(
      'Build failed: Container buildkit terminated: StartError - no such file or directory'
    ),
    false
  );
});
