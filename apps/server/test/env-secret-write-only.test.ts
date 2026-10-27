import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvKeepRules, StoredEnvVar } from '../src/projects/env-write-rules';
import { DeploymentsService } from '../src/projects/deployments.service';

/**
 * A secret variable goes into the deployment's Kubernetes Secret and is never
 * handed back, so every client that edits one variable is editing a set it
 * cannot fully read. These pin the two halves of that: what a read returns, and
 * what a full-replace write does with the values it was never given.
 */

const stored = (rows: StoredEnvVar[]) => new Map(rows.map((r) => [r.key, r]));

const BEFORE = stored([
  { key: 'DATABASE_URL', value: 'postgres://real', secret: true },
  { key: 'PORT', value: '3000', secret: false }
]);

test('a read never hands back a secret value', () => {
  const out = DeploymentsService.redactSecretEnv({
    envVars: [
      { key: 'DATABASE_URL', value: 'postgres://real', secret: true },
      { key: 'PORT', value: '3000', secret: false }
    ]
  } as any);
  assert.deepEqual(out.envVars, [
    { key: 'DATABASE_URL', value: null, secret: true },
    { key: 'PORT', value: '3000', secret: false }
  ]);
});

// The merge every read-modify-write client performs: it echoes back the null it
// was given for the secret and a real value for the one it is changing.
test('a null value keeps the secret the client was never shown', () => {
  const out = applyEnvKeepRules(
    [
      { key: 'DATABASE_URL', value: null, secret: true },
      { key: 'PORT', value: '8080', secret: false }
    ],
    BEFORE
  );
  assert.deepEqual(out, [
    { key: 'DATABASE_URL', value: 'postgres://real', secret: true },
    { key: 'PORT', value: '8080', secret: false }
  ]);
});

// The web editor renders a withheld value as an empty box, so an untouched
// secret comes back blank rather than null.
test('a blank on a row that is secret before and after keeps it', () => {
  const out = applyEnvKeepRules([{ key: 'DATABASE_URL', value: '', secret: true }], BEFORE);
  assert.deepEqual(out, [{ key: 'DATABASE_URL', value: 'postgres://real', secret: true }]);
});

test('a real value replaces a secret', () => {
  const out = applyEnvKeepRules(
    [{ key: 'DATABASE_URL', value: 'postgres://new', secret: true }],
    BEFORE
  );
  assert.deepEqual(out, [{ key: 'DATABASE_URL', value: 'postgres://new', secret: true }]);
});

test('un-marking a secret is refused, value or not', () => {
  assert.throws(
    () => applyEnvKeepRules([{ key: 'DATABASE_URL', value: null, secret: false }], BEFORE),
    /DATABASE_URL is sealed/
  );
  assert.throws(
    () => applyEnvKeepRules([{ key: 'DATABASE_URL', secret: false }], BEFORE),
    /DATABASE_URL is sealed/
  );
  assert.throws(
    () => applyEnvKeepRules([{ key: 'DATABASE_URL', value: 'now-public', secret: false }], BEFORE),
    /DATABASE_URL is sealed/
  );
});

test('omitting the flag on a sealed key keeps it sealed', () => {
  const out = applyEnvKeepRules([{ key: 'DATABASE_URL', value: 'postgres://new' }], BEFORE);
  assert.deepEqual(out, [{ key: 'DATABASE_URL', value: 'postgres://new', secret: true }]);
});

// A key the deployment has never seen has nothing to keep, so it stores empty
// rather than inventing a value or refusing the write.
test('a new key with no value stores empty', () => {
  const out = applyEnvKeepRules([{ key: 'NEW_ONE', value: null, secret: true }], BEFORE);
  assert.deepEqual(out, [{ key: 'NEW_ONE', value: '', secret: true }]);
});

test('a blank on a row that was not secret is a real change', () => {
  const out = applyEnvKeepRules([{ key: 'PORT', value: '', secret: false }], BEFORE);
  assert.deepEqual(out, [{ key: 'PORT', value: '', secret: false }]);
});

test('dropping a key from the set removes it, secret or not', () => {
  const out = applyEnvKeepRules([{ key: 'PORT', value: '3000' }], BEFORE);
  assert.deepEqual(out, [{ key: 'PORT', value: '3000', secret: false }]);
});
