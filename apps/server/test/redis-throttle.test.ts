import test from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { RedisThrottleService, type ThrottleWindow } from '../src/auth/redis-throttle.service';

const URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:16379';

const WINDOW: ThrottleWindow = {
  maxAttempts: 3,
  windowMs: 60_000,
  blockDurationMs: 120_000
};

async function reachable(): Promise<boolean> {
  const probe = new Redis(URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    try {
      probe.disconnect();
    } catch {}
  }
}

let probe: Promise<boolean> | null = null;
const haveRedis = () => (probe ??= reachable());

function redisTest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!(await haveRedis())) {
      t.skip(`no redis at ${URL} (docker run -d -p 16379:6379 redis:7-alpine)`);
      return;
    }
    await fn();
  });
}

function build(): RedisThrottleService {
  const service = new RedisThrottleService();
  process.env.REDIS_URL = URL;
  service.onModuleInit();
  return service;
}

let seq = 0;
const freshKey = () => `test:${process.pid}:${Date.now()}:${seq++}`;

redisTest('a spent window blocks, and reports how long is left', async () => {
  const service = build();
  const key = freshKey();
  try {
    assert.equal(await service.retryAfter(key, WINDOW), 0);
    await service.hit(key, WINDOW);
    assert.equal(await service.retryAfter(key, WINDOW), 0, 'one failure is not a block');
    await service.hit(key, WINDOW);
    assert.equal(await service.retryAfter(key, WINDOW), 0, 'two failures is not a block');
    await service.hit(key, WINDOW);
    const left = await service.retryAfter(key, WINDOW);
    assert.ok(left !== null && left > 0, 'the third failure blocks');
    assert.ok(left! <= 120, `retry-after should be inside the block duration, got ${left}`);
  } finally {
    await service.clear(key);
    service.onModuleDestroy();
  }
});

redisTest('clearing gives the budget back', async () => {
  const service = build();
  const key = freshKey();
  try {
    for (let i = 0; i < WINDOW.maxAttempts; i++) await service.hit(key, WINDOW);
    assert.ok((await service.retryAfter(key, WINDOW))! > 0);
    await service.clear(key);
    assert.equal(await service.retryAfter(key, WINDOW), 0);
  } finally {
    await service.clear(key);
    service.onModuleDestroy();
  }
});

redisTest('the budget does not multiply across replicas', async () => {
  const podA = build();
  const podB = build();
  const key = freshKey();
  try {
    await podA.hit(key, WINDOW);
    await podB.hit(key, WINDOW);
    assert.equal(await podA.retryAfter(key, WINDOW), 0, 'two of three spent');
    assert.equal(await podB.retryAfter(key, WINDOW), 0, 'two of three spent');

    await podA.hit(key, WINDOW);

    const onA = await podA.retryAfter(key, WINDOW);
    const onB = await podB.retryAfter(key, WINDOW);
    assert.ok(onA! > 0, 'the pod that recorded the last failure blocks');
    assert.ok(onB! > 0, 'and so does the one that did not');
  } finally {
    await podA.clear(key);
    podA.onModuleDestroy();
    podB.onModuleDestroy();
  }
});

redisTest('separate keys are separate budgets', async () => {
  const service = build();
  const mine = freshKey();
  const theirs = freshKey();
  try {
    for (let i = 0; i < WINDOW.maxAttempts; i++) await service.hit(mine, WINDOW);
    assert.ok((await service.retryAfter(mine, WINDOW))! > 0);
    assert.equal(
      await service.retryAfter(theirs, WINDOW),
      0,
      'one attacker must not block anyone else'
    );
  } finally {
    await service.clear(mine);
    await service.clear(theirs);
    service.onModuleDestroy();
  }
});

redisTest('counters carry a ttl so nothing has to sweep them', async () => {
  const service = build();
  const key = freshKey();
  const client = new Redis(URL, { maxRetriesPerRequest: 1 });
  try {
    await service.hit(key, WINDOW);
    const ttl = await client.pttl(`orchard:throttle:${key}`);
    assert.ok(ttl > 0, `expected a ttl, got ${ttl}`);
    assert.ok(ttl <= WINDOW.windowMs + 60_000, `ttl ${ttl} should not outlive the window by much`);
  } finally {
    await service.clear(key);
    client.disconnect();
    service.onModuleDestroy();
  }
});

test('a service with no REDIS_URL answers null so callers fall back', async () => {
  const previous = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  const service = new RedisThrottleService();
  service.onModuleInit();
  try {
    assert.equal(service.available, false);
    assert.equal(await service.retryAfter('anything', WINDOW), null);
    assert.equal(await service.hit('anything', WINDOW), false);
    assert.equal(await service.clear('anything'), false);
  } finally {
    service.onModuleDestroy();
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
});
