import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDbTuning,
  parsePgMemory,
  formatPgMemory,
  MANAGED_DB_MIN_MEMORY_BYTES,
} from '../src/kubernetes/db-tuning';
import { parseMemory } from '../src/kubernetes/quantity';

const MiB = 1024 * 1024;

test('postgres memory units are 1024-based and distinct from k8s units', () => {
  assert.equal(parsePgMemory('128MB'), 128 * MiB);
  assert.equal(parsePgMemory('1GB'), 1024 * MiB);
  assert.equal(parsePgMemory('64kB'), 64 * 1024);
  assert.equal(parsePgMemory('nonsense'), 0);

  // The reason this parser exists at all: the k8s one silently returns 0 for
  // "MB", so reusing it would have made every override look like zero bytes.
  assert.equal(parseMemory('128MB'), 0);
});

test('formatPgMemory round-trips through parsePgMemory', () => {
  for (const bytes of [16 * MiB, 32 * MiB, 256 * MiB, 2048 * MiB]) {
    assert.equal(parsePgMemory(formatPgMemory(bytes)), bytes);
  }
});

test('shared_buffers is a quarter of the limit, never the whole thing', () => {
  // The incident: 128MB of shared_buffers on a 128Mi container.
  assert.equal(deriveDbTuning({ memoryLimitBytes: 128 * MiB }).sharedBuffers, '32MB');
  assert.equal(deriveDbTuning({ memoryLimitBytes: 256 * MiB }).sharedBuffers, '64MB');
  assert.equal(deriveDbTuning({ memoryLimitBytes: 1024 * MiB }).sharedBuffers, '256MB');
  // And the opposite waste: 8Gi clusters were also pinned at 128MB.
  assert.equal(deriveDbTuning({ memoryLimitBytes: 8192 * MiB }).sharedBuffers, '2GB');
});

test('a tiny limit still gets a usable floor', () => {
  assert.equal(deriveDbTuning({ memoryLimitBytes: 32 * MiB }).sharedBuffers, '16MB');
});

test('an unknown limit assumes the managed-database floor', () => {
  const assumed = deriveDbTuning({ memoryLimitBytes: MANAGED_DB_MIN_MEMORY_BYTES });
  assert.deepEqual(deriveDbTuning({ memoryLimitBytes: 0 }), assumed);
  assert.deepEqual(deriveDbTuning({ memoryLimitBytes: null }), assumed);
  assert.deepEqual(deriveDbTuning({}), assumed);
});

test('a manual shared_buffers is honoured verbatim, however large', () => {
  const t = deriveDbTuning({
    memoryLimitBytes: 128 * MiB,
    overrides: { sharedBuffers: '512MB' },
  });
  // Four times the container's entire memory limit, and we still hand it back.
  assert.equal(t.sharedBuffers, '512MB');
});

test('a dangerous manual value advises instead of clamping', () => {
  const t = deriveDbTuning({
    memoryLimitBytes: 128 * MiB,
    overrides: { sharedBuffers: '128MB' },
  });
  assert.equal(t.sharedBuffers, '128MB');
  const advisory = t.advisories.find((a) => a.key === 'shared_buffers');
  assert.ok(advisory, 'expected a shared_buffers advisory');
  assert.match(advisory.message, /100%/);
  // It should tell the user what automatic would have picked.
  assert.match(advisory.message, /32MB/);
});

test('a reasonable manual value stays quiet', () => {
  const t = deriveDbTuning({
    memoryLimitBytes: 1024 * MiB,
    overrides: { sharedBuffers: '320MB' },
  });
  assert.equal(t.sharedBuffers, '320MB');
  assert.deepEqual(t.advisories, []);
});

test('derived values never advise about themselves', () => {
  for (const bytes of [64 * MiB, 128 * MiB, 512 * MiB, 4096 * MiB]) {
    assert.deepEqual(deriveDbTuning({ memoryLimitBytes: bytes }).advisories, []);
  }
});

test('base-backup compression is off on small instances, on above the threshold', () => {
  assert.equal(deriveDbTuning({ memoryLimitBytes: 128 * MiB }).dataCompression, null);
  assert.equal(deriveDbTuning({ memoryLimitBytes: 256 * MiB }).dataCompression, null);
  assert.equal(deriveDbTuning({ memoryLimitBytes: 512 * MiB }).dataCompression, 'gzip');
  assert.equal(deriveDbTuning({ memoryLimitBytes: 4096 * MiB }).dataCompression, 'gzip');
});

test('compression can be forced either way, with an advisory when it is unsafe', () => {
  const forcedOn = deriveDbTuning({
    memoryLimitBytes: 128 * MiB,
    overrides: { backupCompression: 'gzip' },
  });
  assert.equal(forcedOn.dataCompression, 'gzip');
  assert.ok(forcedOn.advisories.some((a) => a.key === 'backupCompression'));

  const forcedOff = deriveDbTuning({
    memoryLimitBytes: 4096 * MiB,
    overrides: { backupCompression: 'none' },
  });
  assert.equal(forcedOff.dataCompression, null);
  assert.deepEqual(forcedOff.advisories, []);

  // Forcing on where it was already safe is not worth a warning.
  const forcedOnSafe = deriveDbTuning({
    memoryLimitBytes: 4096 * MiB,
    overrides: { backupCompression: 'gzip' },
  });
  assert.equal(forcedOnSafe.dataCompression, 'gzip');
  assert.deepEqual(forcedOnSafe.advisories, []);
});

test('an empty or null override means derived, not "set to empty"', () => {
  const derived = deriveDbTuning({ memoryLimitBytes: 1024 * MiB });
  for (const overrides of [
    { sharedBuffers: null, backupCompression: null },
    { sharedBuffers: '', backupCompression: '' },
    { sharedBuffers: '   ' },
  ]) {
    assert.deepEqual(deriveDbTuning({ memoryLimitBytes: 1024 * MiB, overrides }), derived);
  }
});
