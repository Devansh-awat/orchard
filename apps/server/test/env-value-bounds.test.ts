import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  MAX_ENV_VARS,
  MAX_VALUE_BYTES,
  assertEnvSetStorable,
  assertEnvValueStorable
} from '../src/projects/environment-shared-vars.service';

test('a value at the 64KB ceiling is accepted, one byte over is not', () => {
  assert.doesNotThrow(() => assertEnvValueStorable('K', 'x'.repeat(MAX_VALUE_BYTES)));
  assert.throws(
    () => assertEnvValueStorable('K', 'x'.repeat(MAX_VALUE_BYTES + 1)),
    BadRequestException
  );
});

test('the limit is measured in utf8 bytes, not characters', () => {
  const emoji = '\u{1F34E}';
  assert.throws(() => assertEnvValueStorable('K', emoji.repeat(MAX_VALUE_BYTES / 4 + 1)));
});

test('a plaintext value may not impersonate a ciphertext', () => {
  assert.throws(() => assertEnvValueStorable('K', 'enc:v1:deadbeef'), BadRequestException);
  assert.throws(() => assertEnvValueStorable('K', 'enc:v1:'), BadRequestException);
  assert.doesNotThrow(() => assertEnvValueStorable('K', 'enc:v2:something'));
  assert.doesNotThrow(() => assertEnvValueStorable('K', ' enc:v1:not-at-start'));
  assert.doesNotThrow(() => assertEnvValueStorable('K', ''));
});

test('a set is bounded by count and every value is checked', () => {
  const tooMany = Array.from({ length: MAX_ENV_VARS + 1 }, (_, i) => ({ key: `K${i}`, value: '' }));
  assert.throws(() => assertEnvSetStorable(tooMany), BadRequestException);
  assert.doesNotThrow(() => assertEnvSetStorable(tooMany.slice(0, MAX_ENV_VARS)));
  assert.throws(
    () =>
      assertEnvSetStorable([
        { key: 'OK', value: 'fine' },
        { key: 'BAD', value: 'enc:v1:abc' }
      ]),
    /BAD/
  );
});
