import test from 'node:test';
import assert from 'node:assert/strict';
import { LeaseService } from '../src/coordination/lease.service';

// The bug this guards against: LeaseElector.start() kicks off its first tick
// without awaiting it, so isLeader() is false for the whole first round-trip.
// Anything doing a one-shot pass at boot (an informer's initial LIST) ran
// inside that window and was silently dropped, so the pod mirror was built
// only from live events. A pod that never changed again was never written,
// which is how a Tailscale sidecar sat Running for six days behind a
// deployment that read "pending".
//
// onAcquired has to fire for both orderings: subscribing before leadership
// lands, and subscribing after it already has.

function makeService(): LeaseService {
  // No kubeconfig means register() builds a StaticElector, which holds
  // immediately outside production. That is exactly the "already leader when
  // you subscribe" ordering we need to cover.
  return new LeaseService({ kc: null } as never);
}

test('a subscriber registered before acquisition is called', async () => {
  const svc = makeService();
  let calls = 0;
  svc.onAcquired('test-lease', () => {
    calls += 1;
  });
  await new Promise((r) => {
    setTimeout(r, 20);
  });
  assert.ok(calls >= 1, 'expected the listener to fire on acquisition');
});

test('a subscriber registered after acquisition is still called', async () => {
  const svc = makeService();
  // Force the lease to exist and settle first.
  svc.register('late-lease');
  await new Promise((r) => {
    setTimeout(r, 20);
  });

  let calls = 0;
  svc.onAcquired('late-lease', () => {
    calls += 1;
  });
  await new Promise((r) => {
    setTimeout(r, 20);
  });
  assert.equal(calls, 1, 'a late subscriber must not wait for an edge that already passed');
});

test('subscribing does not require the lease to be registered first', async () => {
  const svc = makeService();
  let calls = 0;
  // No register() call: onAcquired has to create the lease itself, because
  // module init order across the app is not guaranteed.
  svc.onAcquired('unregistered-lease', () => {
    calls += 1;
  });
  await new Promise((r) => {
    setTimeout(r, 20);
  });
  assert.ok(calls >= 1);
  assert.equal(svc.isHolder('unregistered-lease'), true);
});
