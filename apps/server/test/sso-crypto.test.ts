import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { SSO_KEY_MISSING_MESSAGE, SsoCryptoService } from '../src/sso/sso-crypto.service';

function withKey<T>(key: string | undefined, fn: () => T): T {
  const previous = process.env.SSO_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.SSO_ENCRYPTION_KEY;
  else process.env.SSO_ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SSO_ENCRYPTION_KEY;
    else process.env.SSO_ENCRYPTION_KEY = previous;
  }
}

test('saving an SSO secret without a key explains what to configure', () => {
  const crypto = withKey(undefined, () => new SsoCryptoService());
  assert.equal(crypto.enabled, false);
  assert.throws(
    () => crypto.encrypt('client-secret'),
    (err: unknown) =>
      err instanceof ServiceUnavailableException &&
      err.getStatus() === 503 &&
      err.message === SSO_KEY_MISSING_MESSAGE
  );
  assert.equal(crypto.decryptOrNull('a:b:c'), undefined);
});

test('secrets round-trip when the key is set', () => {
  const crypto = withKey('test-key-for-sso-crypto', () => new SsoCryptoService());
  const sealed = crypto.encrypt('client-secret');
  assert.notEqual(sealed, 'client-secret');
  assert.equal(crypto.decrypt(sealed), 'client-secret');
});
