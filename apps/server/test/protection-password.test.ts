import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProtectionPassword } from '../src/projects/ingress.service';

test('a protection password needs at least 8 characters', () => {
  assert.throws(() => assertProtectionPassword('a'), /at least 8 characters/);
  assert.throws(() => assertProtectionPassword('1234567'), /at least 8 characters/);
  assert.doesNotThrow(() => assertProtectionPassword('12345678'));
});
