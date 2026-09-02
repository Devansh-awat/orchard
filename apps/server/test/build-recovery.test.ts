import test from 'node:test';
import assert from 'node:assert/strict';

import { isObservedJobStatus } from '../src/projects/build-recovery';

test('a real job phase is an observation', () => {
  assert.equal(isObservedJobStatus('pending'), true);
  assert.equal(isObservedJobStatus('running'), true);
  assert.equal(isObservedJobStatus('succeeded'), true);
  assert.equal(isObservedJobStatus('failed'), true);
});

test('a job that can no longer be read is not an observation', () => {
  assert.equal(isObservedJobStatus('unknown'), false);
  assert.equal(isObservedJobStatus(undefined), false);
  assert.equal(isObservedJobStatus(null), false);
  assert.equal(isObservedJobStatus(''), false);
  assert.equal(isObservedJobStatus('Succeeded'), false);
});
