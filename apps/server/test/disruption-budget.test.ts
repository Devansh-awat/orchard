import test from 'node:test';
import assert from 'node:assert/strict';
import {
  disruptionBudgetActive,
  disruptionBudgetManifest,
  normalizeMinAvailable,
  readMinAvailable,
} from '../src/kubernetes/disruption-budget';

test('a budget that covers every replica is never written', () => {
  // The whole point: minAvailable == replicas leaves zero allowed
  // disruptions, and `kubectl drain` then blocks on this app forever.
  assert.equal(disruptionBudgetActive(1, 1), false);
  assert.equal(disruptionBudgetActive(2, 2), false);
  assert.equal(disruptionBudgetActive(3, 2), false);
});

test('a budget applies as soon as there is a pod to spare', () => {
  assert.equal(disruptionBudgetActive(1, 2), true);
  assert.equal(disruptionBudgetActive(2, 5), true);
});

test('zero means the user turned the budget off', () => {
  assert.equal(disruptionBudgetActive(0, 5), false);
});

test('nonsense minAvailable collapses to off rather than throwing', () => {
  assert.equal(normalizeMinAvailable(-3), 0);
  assert.equal(normalizeMinAvailable(Number.NaN), 0);
  assert.equal(normalizeMinAvailable('nope'), 0);
  assert.equal(normalizeMinAvailable(undefined), 0);
  assert.equal(normalizeMinAvailable('2'), 2);
  assert.equal(normalizeMinAvailable(2.9), 2);
});

test('a percentage budget is not adopted into the integer column', () => {
  // spec.minAvailable is an IntOrString. "50%" is legal Kubernetes and has no
  // honest integer to adopt, so the stored setting is left alone.
  assert.equal(readMinAvailable({ minAvailable: '50%' } as never), null);
  assert.equal(readMinAvailable({ maxUnavailable: 1 } as never), null);
  assert.equal(readMinAvailable(undefined), null);
  assert.equal(readMinAvailable({ minAvailable: 2 } as never), 2);
  assert.equal(readMinAvailable({ minAvailable: '2' } as never), 2);
  assert.equal(readMinAvailable({ minAvailable: 0 } as never), 0);
});

test('the manifest carries the label the mirror informer selects on', () => {
  const pdb = disruptionBudgetManifest({ name: 'web', namespace: 'ysws-thing', minAvailable: 1 });
  // Drop this label and the budget still works, but Orchard stops seeing it.
  assert.equal(pdb.metadata?.labels?.['app.kubernetes.io/managed-by'], 'orchard');
  assert.deepEqual(pdb.spec?.selector?.matchLabels, { 'app.kubernetes.io/name': 'web' });
  assert.equal(pdb.spec?.minAvailable, 1);
  // A pod that never went ready must stay evictable, or one crash-looping
  // replica makes the node undrainable.
  assert.equal(pdb.spec?.unhealthyPodEvictionPolicy, 'AlwaysAllow');
});
