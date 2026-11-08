import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  UNIFORM_NOT_FOUND_MESSAGE,
  UniformNotFoundInterceptor
} from '../src/http/uniform-not-found.interceptor';

function context(params: Record<string, string>) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ params }) })
  } as never;
}

async function run(params: Record<string, string>, error: unknown) {
  const handler = { handle: () => throwError(() => error) };
  return lastValueFrom(new UniformNotFoundInterceptor().intercept(context(params), handler)).catch(
    (caught) => caught
  );
}

test('a hidden resource and a missing resource answer with the same 404 body', async () => {
  const hidden = await run({ id: 'a' }, new NotFoundException('Project not found'));
  const missing = await run({ id: 'b' }, new NotFoundException('Database b not found'));
  assert.equal(hidden.getStatus(), 404);
  assert.deepEqual(hidden.getResponse(), missing.getResponse());
  assert.equal(hidden.message, UNIFORM_NOT_FOUND_MESSAGE);
});

test('routes without path ids and other errors pass through untouched', async () => {
  const listing = await run({}, new NotFoundException('Nothing here'));
  assert.equal(listing.message, 'Nothing here');
  const bad = new BadRequestException('nope');
  assert.equal(await run({ id: 'a' }, bad), bad);
});

test('successful responses are untouched', async () => {
  const handler = { handle: () => of({ ok: true }) };
  const out = await lastValueFrom(
    new UniformNotFoundInterceptor().intercept(context({ id: 'a' }), handler)
  );
  assert.deepEqual(out, { ok: true });
});
