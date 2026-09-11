import test from 'node:test';
import assert from 'node:assert/strict';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';

const sig = K8sWorkloadService.volumeSignature;

// The signature is what decides whether a rebuild re-applies volumes, so it has
// to see a missing volume as different and an unchanged one as identical.
test('an attached volume is not equal to no volumes', () => {
  assert.notEqual(sig([{ name: 'data', type: 'pvc', mountPath: '/data', pvcName: 'data' }]), sig([]));
});

test('the same volume in a different order is the same volume set', () => {
  const a = sig([
    { name: 'data', type: 'pvc', mountPath: '/data', pvcName: 'data' },
    { name: 'cache', type: 'emptyDir', mountPath: '/cache' },
  ]);
  const b = sig([
    { name: 'cache', type: 'emptyDir', mountPath: '/cache' },
    { name: 'data', type: 'pvc', mountPath: '/data', pvcName: 'data' },
  ]);
  assert.equal(a, b);
});

test('a claim name defaults to the volume name, so both spellings match', () => {
  assert.equal(
    sig([{ name: 'data', type: 'pvc', mountPath: '/data' }]),
    sig([{ name: 'data', type: 'pvc', mountPath: '/data', pvcName: 'data' }]),
  );
});

// Each of these is a real change to what the pod sees, and each was invisible
// while a rebuild only ever patched the image.
test('moving the mount path, the claim, or read-only is a change', () => {
  const base = { name: 'data', type: 'pvc' as const, mountPath: '/data', pvcName: 'data' };
  assert.notEqual(sig([base]), sig([{ ...base, mountPath: '/var/data' }]));
  assert.notEqual(sig([base]), sig([{ ...base, pvcName: 'data-v2' }]));
  assert.notEqual(sig([base]), sig([{ ...base, readOnly: true }]));
});

test('a pvc and an emptyDir at the same path are not interchangeable', () => {
  assert.notEqual(
    sig([{ name: 'data', type: 'pvc', mountPath: '/data', pvcName: 'data' }]),
    sig([{ name: 'data', type: 'emptyDir', mountPath: '/data' }]),
  );
});

test('no volumes on either side compares equal, so a rebuild does not churn', () => {
  assert.equal(sig([]), sig([]));
});
