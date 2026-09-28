import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SECRETS_ENCRYPTION_KEY = 'job-snapshot-test-key';

import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import {
  decodeStepsSnapshot,
  encodeStepsSnapshot,
  maskStepsSnapshot,
  SNAPSHOT_SECRET_MASK,
  SnapshotCipher
} from '../src/jobs/steps-snapshot';

const crypto = new SecretCryptoService();

const steps = [
  {
    stepOrder: 1,
    name: 'migrate',
    type: 'app',
    image: 'ghcr.io/acme/app:sha',
    envVars: [
      { key: 'DATABASE_URL', value: 'postgres://real', secret: true },
      { key: 'PORT', value: '3000', secret: false },
      { key: 'FLAG', value: 'on' }
    ],
    cpuMilli: 500,
    memoryBytes: 268435456,
    timeoutSeconds: 600,
    retries: 0
  },
  {
    stepOrder: 2,
    name: 'notify',
    type: 'script',
    image: 'node:22',
    envVars: [{ key: 'WEBHOOK_TOKEN', value: 'tok-123', secret: true }],
    cpuMilli: 250,
    memoryBytes: 134217728,
    timeoutSeconds: 60,
    retries: 1
  }
];

const persisted = (value: unknown) => JSON.parse(JSON.stringify(value));

test('secret values are ciphertext in the stored snapshot and nothing else changes', () => {
  const stored = persisted(encodeStepsSnapshot(steps, crypto));
  const [migrate, notify] = stored;

  assert.equal(migrate.envVars[0].key, 'DATABASE_URL');
  assert.ok(crypto.isEncrypted(migrate.envVars[0].value));
  assert.notEqual(migrate.envVars[0].value, 'postgres://real');
  assert.ok(crypto.isEncrypted(notify.envVars[0].value));

  assert.deepEqual(migrate.envVars[1], { key: 'PORT', value: '3000', secret: false });
  assert.deepEqual(migrate.envVars[2], { key: 'FLAG', value: 'on' });
  assert.ok(!JSON.stringify(stored).includes('postgres://real'));
  assert.ok(!JSON.stringify(stored).includes('tok-123'));

  const { envVars: _a, ...migrateRest } = migrate;
  const { envVars: _b, ...originalRest } = steps[0];
  assert.deepEqual(migrateRest, originalRest);
});

test('decoding a stored snapshot round-trips back to the resolved steps', () => {
  const stored = persisted(encodeStepsSnapshot(steps, crypto));
  assert.deepEqual(decodeStepsSnapshot(stored, crypto), steps);
});

test('every run gets a distinct ciphertext for the same secret', () => {
  const a = persisted(encodeStepsSnapshot(steps, crypto))[0].envVars[0].value;
  const b = persisted(encodeStepsSnapshot(steps, crypto))[0].envVars[0].value;
  assert.notEqual(a, b);
  assert.equal(crypto.decrypt(a), crypto.decrypt(b));
});

test('a snapshot written before encryption still decodes as plaintext', () => {
  const legacy = persisted(steps);
  assert.deepEqual(decodeStepsSnapshot(legacy, crypto), steps);
});

test('masking hides secret values whether stored encrypted or as legacy plaintext', () => {
  for (const raw of [persisted(encodeStepsSnapshot(steps, crypto)), persisted(steps)]) {
    const masked = maskStepsSnapshot(raw);
    assert.deepEqual(masked[0].envVars, [
      { key: 'DATABASE_URL', value: SNAPSHOT_SECRET_MASK, secret: true },
      { key: 'PORT', value: '3000', secret: false },
      { key: 'FLAG', value: 'on' }
    ]);
    assert.deepEqual(masked[1].envVars, [
      { key: 'WEBHOOK_TOKEN', value: SNAPSHOT_SECRET_MASK, secret: true }
    ]);
    assert.ok(!JSON.stringify(masked).includes('postgres://real'));
    assert.ok(!JSON.stringify(masked).includes('tok-123'));
  }
});

test('without an encryption key the secret value is dropped rather than stored in plaintext', () => {
  const keyless: SnapshotCipher = {
    enabled: false,
    encrypt: () => {
      throw new Error('should not encrypt without a key');
    },
    decrypt: (value) => value
  };
  const stored = persisted(encodeStepsSnapshot(steps, keyless));
  assert.deepEqual(stored[0].envVars[0], { key: 'DATABASE_URL', value: '', secret: true });
  assert.deepEqual(stored[0].envVars[1], { key: 'PORT', value: '3000', secret: false });
  assert.ok(!JSON.stringify(stored).includes('postgres://real'));
});

test('a malformed or missing snapshot decodes to no steps', () => {
  assert.deepEqual(decodeStepsSnapshot(null, crypto), []);
  assert.deepEqual(decodeStepsSnapshot({ not: 'an array' }, crypto), []);
  assert.deepEqual(maskStepsSnapshot(undefined), []);
});
