import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException
} from '@nestjs/common';
import {
  IdempotencyInterceptor,
  IDEMPOTENCY_MAX_BODY_BYTES,
  IDEMPOTENCY_PENDING_TTL_MS,
  IDEMPOTENCY_TTL_MS,
  idempotencyFingerprint,
  idempotencyScope
} from '../src/idempotency/idempotency.interceptor';
import type { IdempotencyRecord, IdempotencyStore } from '../src/idempotency/idempotency.store';

class MemoryStore implements IdempotencyStore {
  available = true;

  records = new Map<string, IdempotencyRecord>();

  claimTtls: number[] = [];

  completeTtls: number[] = [];

  async claim(key: string, fingerprint: string, ttlMs: number) {
    this.claimTtls.push(ttlMs);
    if (this.records.has(key)) return false;
    this.records.set(key, { state: 'pending', fingerprint });
    return true;
  }

  async get(key: string) {
    return this.records.get(key) ?? null;
  }

  async complete(key: string, record: IdempotencyRecord, ttlMs: number) {
    this.completeTtls.push(ttlMs);
    this.records.set(key, record);
  }

  async release(key: string) {
    this.records.delete(key);
  }
}

function makeContext(req: Record<string, any>) {
  const headers: Record<string, string> = {};
  const res = { statusCode: 201, setHeader: (k: string, v: string) => (headers[k] = v), headers };
  return {
    res,
    ctx: {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res })
    } as any
  };
}

function request(overrides: Record<string, any> = {}) {
  return {
    method: 'POST',
    route: { path: '/deployments/:id/rebuild' },
    params: { id: 'd1' },
    query: {},
    body: { force: true },
    user: { sub: 'user-1' },
    headers: { 'idempotency-key': 'abc-123' },
    ...overrides
  };
}

async function run(
  interceptor: IdempotencyInterceptor,
  req: Record<string, any>,
  handler: () => any
) {
  const { ctx, res } = makeContext(req);
  let calls = 0;
  const out = await interceptor.intercept(ctx, {
    handle: () => {
      calls += 1;
      return handler();
    }
  });
  const value = await lastValueFrom(out);
  return { value, calls, res };
}

test('passes through without a key', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  const r = await run(i, request({ headers: {} }), () => of({ ok: 1 }));
  assert.equal(r.calls, 1);
  assert.equal(store.records.size, 0);
});

test('replays the stored response for the same key and body', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  const first = await run(i, request(), () => of({ releaseId: 'r1' }));
  assert.deepEqual(first.value, { releaseId: 'r1' });
  const second = await run(i, request(), () => of({ releaseId: 'r2' }));
  assert.equal(second.calls, 0);
  assert.deepEqual(second.value, { releaseId: 'r1' });
  assert.equal(second.res.headers['Idempotent-Replayed'], 'true');
});

test('rejects key reuse with a different body', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  await run(i, request(), () => of({ ok: 1 }));
  await assert.rejects(
    run(i, request({ body: { force: false } }), () => of({ ok: 2 })),
    UnprocessableEntityException
  );
});

test('body key order does not change the fingerprint', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  await run(i, request({ body: { a: 1, b: 2 } }), () => of({ ok: 1 }));
  const again = await run(i, request({ body: { b: 2, a: 1 } }), () => of({ ok: 2 }));
  assert.equal(again.calls, 0);
});

test('a request still in flight conflicts', async () => {
  const store = new MemoryStore();
  store.records.set(idempotencyScope(request(), 'abc-123'), {
    state: 'pending',
    fingerprint: idempotencyFingerprint(request())
  });
  const i = new IdempotencyInterceptor(store);
  await assert.rejects(
    run(i, request(), () => of({ ok: 1 })),
    ConflictException
  );
});

test('errors release the key so a retry runs again', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  await assert.rejects(run(i, request(), () => throwError(() => new Error('boom'))));
  assert.equal(store.records.size, 0);
  const retry = await run(i, request(), () => of({ ok: 1 }));
  assert.equal(retry.calls, 1);
});

test('keys are scoped per user and per route params', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  await run(i, request(), () => of({ ok: 1 }));
  const otherUser = await run(i, request({ user: { sub: 'user-2' } }), () => of({ ok: 2 }));
  assert.equal(otherUser.calls, 1);
  const otherDeployment = await run(i, request({ params: { id: 'd2' } }), () => of({ ok: 3 }));
  assert.equal(otherDeployment.calls, 1);
});

test('invalid keys are rejected', async () => {
  const i = new IdempotencyInterceptor(new MemoryStore());
  await assert.rejects(
    run(i, request({ headers: { 'idempotency-key': 'has space' } }), () => of({})),
    BadRequestException
  );
  await assert.rejects(
    run(i, request({ headers: { 'idempotency-key': 'x'.repeat(256) } }), () => of({})),
    BadRequestException
  );
});

test('oversized responses are not stored', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  await run(i, request(), () => of({ blob: 'x'.repeat(IDEMPOTENCY_MAX_BODY_BYTES + 1) }));
  assert.equal(store.records.size, 0);
});

test('without a store connection requests pass through', async () => {
  const store = new MemoryStore();
  store.available = false;
  const i = new IdempotencyInterceptor(store);
  const r = await run(i, request(), () => of({ ok: 1 }));
  assert.equal(r.calls, 1);
  assert.equal(store.records.size, 0);
});

test('in-flight claims expire quickly so a crashed request does not lock the key for a day', async () => {
  const store = new MemoryStore();
  const i = new IdempotencyInterceptor(store);
  await run(i, request(), () => of({ ok: 1 }));
  assert.deepEqual(store.claimTtls, [IDEMPOTENCY_PENDING_TTL_MS]);
  assert.deepEqual(store.completeTtls, [IDEMPOTENCY_TTL_MS]);
  assert.ok(IDEMPOTENCY_PENDING_TTL_MS < IDEMPOTENCY_TTL_MS);
});
