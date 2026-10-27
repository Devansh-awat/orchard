import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEnvKeepRules,
  defaultSecretFlag,
  looksSecret,
  resolveSecretFlag
} from '../src/projects/env-write-rules';

test('secret-looking keys are recognised', () => {
  for (const key of [
    'STRIPE_SECRET_KEY',
    'GITHUB_TOKEN',
    'DB_PASSWORD',
    'SMTP_PASSWD',
    'JWT_PRIVATE_KEY',
    'OPENAI_API_KEY',
    'SIGNING_KEY',
    'DATABASE_URL',
    'SENTRY_DSN',
    'GOOGLE_CREDENTIALS',
    'AWS_CREDENTIAL',
    'session_secret'
  ]) {
    assert.equal(looksSecret(key), true, key);
  }
});

test('ordinary and public bundle keys are not', () => {
  for (const key of [
    'PORT',
    'NODE_ENV',
    'API_URL',
    'KEYBOARD_LAYOUT',
    'NEXT_PUBLIC_MAPBOX_TOKEN',
    'VITE_API_KEY',
    'PUBLIC_POSTHOG_KEY'
  ]) {
    assert.equal(looksSecret(key), false, key);
  }
});

test('an explicit flag always wins for a new key', () => {
  assert.equal(defaultSecretFlag('GITHUB_TOKEN', false), false);
  assert.equal(defaultSecretFlag('PORT', true), true);
  assert.equal(defaultSecretFlag('GITHUB_TOKEN', undefined), true);
  assert.equal(defaultSecretFlag('PORT', null), false);
});

test('an existing key keeps its flag when none is sent', () => {
  assert.equal(resolveSecretFlag('GITHUB_TOKEN', undefined, { secret: false }), false);
  assert.equal(resolveSecretFlag('PORT', undefined, { secret: true }), true);
});

test('a sealed key cannot be unsealed', () => {
  assert.throws(() => resolveSecretFlag('PORT', false, { secret: true }), /sealed/);
});

test('a plain key can still be sealed', () => {
  assert.equal(resolveSecretFlag('PORT', true, { secret: false }), true);
});

test('a full replace applies the default to new keys only', () => {
  const out = applyEnvKeepRules(
    [
      { key: 'OPENAI_API_KEY', value: 'sk-1' },
      { key: 'EXISTING_TOKEN', value: 'plain' },
      { key: 'PORT', value: '3000' },
      { key: 'EXPLICIT_TOKEN', value: 'x', secret: false }
    ],
    new Map([['EXISTING_TOKEN', { key: 'EXISTING_TOKEN', value: 'old', secret: false }]])
  );
  assert.deepEqual(out, [
    { key: 'OPENAI_API_KEY', value: 'sk-1', secret: true },
    { key: 'EXISTING_TOKEN', value: 'plain', secret: false },
    { key: 'PORT', value: '3000', secret: false },
    { key: 'EXPLICIT_TOKEN', value: 'x', secret: false }
  ]);
});
