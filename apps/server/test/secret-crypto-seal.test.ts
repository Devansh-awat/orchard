import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

function withKey<T>(key: string | undefined, fn: () => T): T {
  const previous = {
    secrets: process.env.SECRETS_ENCRYPTION_KEY,
    sso: process.env.SSO_ENCRYPTION_KEY
  };
  if (key === undefined) {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    delete process.env.SSO_ENCRYPTION_KEY;
  } else {
    process.env.SECRETS_ENCRYPTION_KEY = key;
  }
  try {
    return fn();
  } finally {
    if (previous.secrets === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = previous.secrets;
    if (previous.sso === undefined) delete process.env.SSO_ENCRYPTION_KEY;
    else process.env.SSO_ENCRYPTION_KEY = previous.sso;
  }
}

test('seal encrypts and open round-trips it', () => {
  withKey('test-key', () => {
    const crypto = new SecretCryptoService();
    assert.equal(crypto.enabled, true);
    const sealed = crypto.seal('ghp_super_secret');
    assert.notEqual(sealed, 'ghp_super_secret');
    assert.ok(crypto.isEncrypted(sealed));
    assert.equal(crypto.open(sealed), 'ghp_super_secret');
  });
});

test('open passes legacy plaintext rows through untouched', () => {
  withKey('test-key', () => {
    const crypto = new SecretCryptoService();
    assert.equal(crypto.open('legacy-plaintext'), 'legacy-plaintext');
  });
});

test('seal does not double-encrypt a value that is already ciphertext', () => {
  withKey('test-key', () => {
    const crypto = new SecretCryptoService();
    const once = crypto.seal('value');
    assert.equal(crypto.seal(once), once);
  });
});

test('seal and open preserve null, undefined and empty string', () => {
  withKey('test-key', () => {
    const crypto = new SecretCryptoService();
    assert.equal(crypto.seal(null), null);
    assert.equal(crypto.seal(undefined), undefined);
    assert.equal(crypto.seal(''), '');
    assert.equal(crypto.open(null), null);
    assert.equal(crypto.open(undefined), undefined);
    assert.equal(crypto.open(''), '');
  });
});

test('without a key, seal stores plaintext and open returns it', () => {
  withKey(undefined, () => {
    const crypto = new SecretCryptoService();
    assert.equal(crypto.enabled, false);
    assert.equal(crypto.seal('plain'), 'plain');
    assert.equal(crypto.open('plain'), 'plain');
  });
});

test('a value sealed under one key cannot be opened under another', () => {
  const sealed = withKey('key-a', () => new SecretCryptoService().seal('value'));
  withKey('key-b', () => {
    assert.throws(() => new SecretCryptoService().open(sealed));
  });
});
