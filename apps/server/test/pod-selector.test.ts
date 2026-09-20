import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentPodRegex } from '../src/metrics/pod-selector';

// VictoriaMetrics anchors `=~` on both ends, so mirror that here.
const matches = (name: string, pod: string) =>
  new RegExp(`^(?:${deploymentPodRegex(name)})$`).test(pod);

// Real pod names from the ysws-crescent namespace, which is where this bit.
const CRESCENT = 'crescent-7868f9d8bb-zcktr';
const SSR = 'crescent-ssr-57d9bcbfc8-fxgrs';
const SSR2 = 'crescent-ssr-759c549778-5x6sg';
const WORKER = 'crescent-worker-f9d58b45c-7vf5q';

test('a deployment matches its own pods', () => {
  assert.ok(matches('crescent', CRESCENT));
  assert.ok(matches('crescent-ssr', SSR));
  assert.ok(matches('crescent-ssr', SSR2));
  assert.ok(matches('crescent-worker', WORKER));
});

test('a deployment does not match a sibling whose name it prefixes', () => {
  // `crescent-.*` swept all three of these into the `crescent` app's CPU,
  // against a budget sized for one pod.
  assert.ok(!matches('crescent', SSR));
  assert.ok(!matches('crescent', SSR2));
  assert.ok(!matches('crescent', WORKER));
});

test("the longer name does not match the shorter one's pods either", () => {
  assert.ok(!matches('crescent-ssr', CRESCENT));
  assert.ok(!matches('crescent-worker', CRESCENT));
  assert.ok(!matches('crescent-ssr', WORKER));
});

test('a database pod is not a deployment pod', () => {
  // CNPG names instances `<cluster>-1`, with no ReplicaSet hash — which is why
  // the database queries keep their own prefix match.
  assert.ok(!matches('prod-redis', 'prod-redis-1'));
});

test('regex metacharacters in a name are escaped, not interpreted', () => {
  assert.ok(!matches('a.c', 'abc-7868f9d8bb-zcktr'));
  assert.ok(matches('a.c', 'a.c-7868f9d8bb-zcktr'));
});
