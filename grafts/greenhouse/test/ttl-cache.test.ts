import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../server/src/sandboxes/runners/ttl-cache';

test('concurrent reads share one load and expire after the ttl', async () => {
  let loads = 0;
  const cache = new TtlCache<number>(20);
  const load = async () => ++loads;
  const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(await cache.get('k', load), 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await cache.get('k', load), 2);
});

test('failed loads and values the cache refuses to keep are retried next time', async () => {
  let loads = 0;
  const cache = new TtlCache<string | null>(10_000, (v) => v !== null);
  await assert.rejects(
    cache.get('k', async () => {
      loads++;
      throw new Error('boom');
    })
  );
  assert.equal(await cache.get('k', async () => (loads++, null)), null);
  assert.equal(await cache.get('k', async () => (loads++, 'pod')), 'pod');
  assert.equal(await cache.get('k', async () => (loads++, 'other')), 'pod');
  assert.equal(loads, 3);
  cache.forget('k');
  assert.equal(await cache.get('k', async () => 'fresh'), 'fresh');
});

test('the cache never grows past its bound', async () => {
  const cache = new TtlCache<number>(10_000, () => true, 3);
  for (let i = 0; i < 10; i++) await cache.get(`k${i}`, async () => i);
  assert.equal(await cache.get('k9', async () => -1), 9);
  assert.equal(await cache.get('k0', async () => -1), -1);
});
