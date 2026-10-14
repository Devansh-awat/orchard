import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsService } from '../src/analytics/analytics.service';

function serviceWith(answers: Array<boolean | undefined | Error>) {
  delete process.env.POSTHOG_API_KEY;
  const svc = new AnalyticsService();
  let calls = 0;
  (svc as any).client = {
    isFeatureEnabled: async () => {
      const next = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (next instanceof Error) throw next;
      return next;
    }
  };
  return { svc, calls: () => calls };
}

test('flag answers are cached per user and parallel checks share one request', async () => {
  const { svc, calls } = serviceWith([true]);
  const results = await Promise.all([
    svc.isFeatureEnabled('greenhouse', 'u1'),
    svc.isFeatureEnabled('greenhouse', 'u1'),
    svc.isFeatureEnabled('greenhouse', 'u1')
  ]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u1'), true);
  assert.equal(calls(), 1);
});

test('a failed or empty refresh keeps the last known answer instead of turning the flag off', async (t) => {
  const { svc, calls } = serviceWith([true, undefined, new Error('timeout')]);
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u1'), true);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u1'), true);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.setTime(Date.now() + 61_000);
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u1'), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u1'), true);
  assert.ok(calls() >= 2);
});

test('a cold unknown answer is retried at once, so a new server pod does not flip the flag off', async () => {
  const { svc, calls } = serviceWith([undefined, true]);
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u2'), true);
  assert.equal(calls(), 2);
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u2'), true);
  assert.equal(calls(), 2);
});

test('an answer that stays unknown is false but retried soon, and other users are separate', async (t) => {
  const { svc, calls } = serviceWith([undefined, undefined, undefined, true]);
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u3'), false);
  assert.equal(calls(), 3);
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u3'), false);
  assert.equal(calls(), 3);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 6_000 });
  await svc.isFeatureEnabled('greenhouse', 'u3');
  await new Promise((r) => setImmediate(r));
  assert.equal(await svc.isFeatureEnabled('greenhouse', 'u3'), true);
  assert.equal(calls(), 4);
});
