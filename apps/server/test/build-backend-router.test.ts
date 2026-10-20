import test from 'node:test';
import assert from 'node:assert/strict';
import { builderPoolOf, decideBuilder } from '../src/docker/fc/build-backend-router';

const on = () => Promise.resolve(true);
const off = () => Promise.resolve(false);
const broken = () => Promise.reject(new Error('posthog down'));
const never = () => {
  throw new Error('flag must not be evaluated');
};

test('super builds always stay on depot', async () => {
  for (const override of [null, 'firecracker', 'kubernetes']) {
    assert.equal(
      await decideBuilder({
        buildWithDepot: true,
        override,
        firecrackerAvailable: true,
        flag: never
      }),
      'depot'
    );
  }
});

test('firecracker unavailable means the standard builder, whatever the override', async () => {
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'firecracker',
      firecrackerAvailable: false,
      flag: never
    }),
    'kubernetes'
  );
});

test('overrides win over the flag', async () => {
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'kubernetes',
      firecrackerAvailable: true,
      flag: never
    }),
    'kubernetes'
  );
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'firecracker',
      firecrackerAvailable: true,
      flag: never
    }),
    'firecracker'
  );
});

test('the flag decides when there is no override, and failure means the standard builder', async () => {
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: null,
      firecrackerAvailable: true,
      flag: on
    }),
    'firecracker'
  );
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: null,
      firecrackerAvailable: true,
      flag: off
    }),
    'kubernetes'
  );
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: null,
      firecrackerAvailable: true,
      flag: broken
    }),
    'kubernetes'
  );
});

test('legacy runs without a recorded builder fall back to the depot flag', () => {
  assert.equal(builderPoolOf({ builder: null }, true), 'depot');
  assert.equal(builderPoolOf({ builder: null }, false), 'kubernetes');
  assert.equal(builderPoolOf({ builder: 'firecracker' }, false), 'firecracker');
  assert.equal(builderPoolOf({ builder: 'nonsense' }, false), 'kubernetes');
});
