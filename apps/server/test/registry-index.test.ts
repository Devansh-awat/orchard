import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  loadVerifiedRegistryIndex,
  MissingRegistryObject,
  registrySignaturePolicyFromEnv,
  verifyRegistryIndex,
  type RegistryIndexState,
  type RegistryIndexStateStore
} from '../src/registry-index/signed-index';

const key = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const pub = (k: typeof key) =>
  (k.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
const keys = [pub(key)];
const now = new Date('2026-06-01T00:00:00Z');

function signed(body: object, signer = key) {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, sig: sign(null, raw, signer.privateKey).toString('base64') + '\n' };
}

const fresh = { sequence: 100, expiresAt: '2026-07-01T00:00:00Z', revoked: ['sha256:aa'] };

test('a fresh signed index verifies', () => {
  const { raw, sig } = signed(fresh);
  const v = verifyRegistryIndex({
    name: 'x',
    raw,
    signature: sig,
    state: null,
    policy: 'required',
    now,
    keys
  });
  assert.equal(v.signed, true);
  assert.equal(v.sequence, 100);
});

test('a signature from another key, or over other bytes, is refused', () => {
  const forged = signed(fresh, other);
  assert.throws(
    () =>
      verifyRegistryIndex({
        name: 'x',
        raw: forged.raw,
        signature: forged.sig,
        state: null,
        policy: 'auto',
        now,
        keys
      }),
    /does not verify/
  );
  const good = signed(fresh);
  assert.throws(
    () =>
      verifyRegistryIndex({
        name: 'x',
        raw: Buffer.from(JSON.stringify({ ...fresh, revoked: [] })),
        signature: good.sig,
        state: null,
        policy: 'auto',
        now,
        keys
      }),
    /does not verify/
  );
});

test('an expired index and an index without sequence or expiry are refused', () => {
  const run = (body: object) => {
    const { raw, sig } = signed(body);
    return () =>
      verifyRegistryIndex({
        name: 'x',
        raw,
        signature: sig,
        state: null,
        policy: 'auto',
        now,
        keys
      });
  };
  assert.throws(run({ ...fresh, expiresAt: '2026-05-31T00:00:00Z' }), /expired/);
  assert.throws(run({ expiresAt: fresh.expiresAt }), /sequence/);
  assert.throws(run({ sequence: 1 }), /expiresAt/);
});

test('a lower sequence than the last accepted is a rollback and is refused', () => {
  const { raw, sig } = signed({ ...fresh, sequence: 99 });
  assert.throws(
    () =>
      verifyRegistryIndex({
        name: 'x',
        raw,
        signature: sig,
        state: { sequence: 100, signed: true },
        policy: 'auto',
        now,
        keys
      }),
    /rollback/
  );
  const same = signed(fresh);
  assert.doesNotThrow(() =>
    verifyRegistryIndex({
      name: 'x',
      raw: same.raw,
      signature: same.sig,
      state: { sequence: 100, signed: true },
      policy: 'auto',
      now,
      keys
    })
  );
});

test('unsigned is accepted only in auto mode and only before a signed copy was seen', () => {
  const raw = Buffer.from('{"revoked":[]}');
  const base = { name: 'x', raw, signature: null, now, keys };
  const v = verifyRegistryIndex({ ...base, state: null, policy: 'auto' });
  assert.equal(v.signed, false);
  assert.match(v.warnings[0], /NOT signed/);
  assert.throws(
    () => verifyRegistryIndex({ ...base, state: null, policy: 'required' }),
    /required/
  );
  assert.throws(
    () => verifyRegistryIndex({ ...base, state: { sequence: 1, signed: true }, policy: 'auto' }),
    /downgrade/
  );
});

test('the policy env defaults to auto and rejects junk', () => {
  assert.equal(registrySignaturePolicyFromEnv({}), 'auto');
  assert.equal(
    registrySignaturePolicyFromEnv({ ORCHARD_REGISTRY_SIGNATURE: 'Required' }),
    'required'
  );
  assert.throws(() => registrySignaturePolicyFromEnv({ ORCHARD_REGISTRY_SIGNATURE: 'off' }));
});

test('loading persists the accepted sequence and refuses a replay of an older index', async () => {
  const saved = new Map<string, RegistryIndexState>();
  const store: RegistryIndexStateStore = {
    load: async (n) => saved.get(n) ?? null,
    save: async (n, s) => void saved.set(n, s)
  };
  const serve = (body: object, withSig = true) => {
    const s = signed(body);
    return async (suffix: '' | '.sig') => {
      if (!suffix) return s.raw;
      if (!withSig) throw new MissingRegistryObject('no sig');
      return Buffer.from(s.sig);
    };
  };
  const common = { name: 'idx', store, policy: 'auto' as const, now, keys };
  await loadVerifiedRegistryIndex({
    ...common,
    read: serve(fresh),
    remember: (v) => ({ revoked: (v.body as { revoked: string[] }).revoked })
  });
  assert.deepEqual(saved.get('idx'), { sequence: 100, signed: true, revoked: ['sha256:aa'] });
  await assert.rejects(
    loadVerifiedRegistryIndex({ ...common, read: serve({ ...fresh, sequence: 50 }) }),
    /rollback/
  );
  await assert.rejects(
    loadVerifiedRegistryIndex({ ...common, read: serve({ revoked: [] }, false) }),
    /downgrade/
  );
  assert.equal(saved.get('idx')?.sequence, 100);
});

test('fetchRevoked keeps the last accepted revocation list when the catalog stops verifying', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fetchRevoked } = await import('../src/grafts/sync');
  const dir = mkdtempSync(join(tmpdir(), 'revoked-'));
  mkdirSync(join(dir, 'grafts'), { recursive: true });
  const saved = new Map<string, RegistryIndexState>();
  const store: RegistryIndexStateStore = {
    load: async (n) => saved.get(n) ?? null,
    save: async (n, s) => void saved.set(n, s)
  };
  try {
    writeFileSync(join(dir, 'grafts/index.json'), JSON.stringify({ revoked: ['AA'] }));
    const first = await fetchRevoked(dir, false, { env: {}, store });
    assert.deepEqual([...(first.revoked ?? [])], ['sha256:aa']);

    writeFileSync(join(dir, 'grafts/index.json'), JSON.stringify({ revoked: [] }));
    writeFileSync(join(dir, 'grafts/index.json.sig'), Buffer.alloc(64, 2).toString('base64'));
    const forged = await fetchRevoked(dir, false, { env: {}, store });
    assert.deepEqual([...(forged.revoked ?? [])], ['sha256:aa']);
    assert.match(forged.warning ?? '', /last accepted revocation list/);

    const strict = await fetchRevoked(dir, false, {
      env: { ORCHARD_REGISTRY_SIGNATURE: 'required' },
      store: { load: async () => null, save: async () => undefined }
    });
    assert.equal(strict.revoked, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
