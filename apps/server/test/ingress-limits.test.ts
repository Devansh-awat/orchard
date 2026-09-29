import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingressLimitReached, ingressLimits } from '../src/projects/ingress-limits';
import { RATE_LIMIT_CONFIGS } from '../src/auth/rate-limit.service';

const limits = ingressLimits({});

test('the defaults are twenty per app and a hundred per project', () => {
  assert.equal(limits.perDeployment, 20);
  assert.equal(limits.perProject, 100);
  assert.equal(ingressLimits({ MAX_INGRESSES_PER_DEPLOYMENT: '3' }).perDeployment, 3);
  assert.equal(ingressLimits({ MAX_INGRESSES_PER_DEPLOYMENT: 'no' }).perDeployment, 20);
});

test('under the caps nothing is refused', () => {
  assert.equal(ingressLimitReached({ deployment: 19, project: 99 }, limits), null);
  assert.equal(ingressLimitReached({ project: 0 }, limits), null);
});

test('the twenty-first domain on an app is refused', () => {
  assert.match(ingressLimitReached({ deployment: 20, project: 20 }, limits) ?? '', /at most 20/);
});

test('a project cannot exceed its cap through many apps', () => {
  assert.match(ingressLimitReached({ deployment: 1, project: 100 }, limits) ?? '', /at most 100/);
});

test('invites are limited per recipient and per organization', () => {
  assert.equal(RATE_LIMIT_CONFIGS.invite_email.maxAttempts, 5);
  assert.equal(RATE_LIMIT_CONFIGS.invite_org.maxAttempts, 100);
  assert.equal(RATE_LIMIT_CONFIGS.invite_email.windowMs, 60 * 60 * 1000);
});
