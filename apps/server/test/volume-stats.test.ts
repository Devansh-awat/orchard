import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataVolumesOf,
  fullestVolume,
  projectedFill,
  sizeToResumeWrites,
  writeGuardDecision,
  parseKubeletSummary
} from '../src/kubernetes/volume-stats';

const GI = 1024 ** 3;

test('a kubelet summary maps every pvc-backed volume by namespace and claim', () => {
  const usage = parseKubeletSummary({
    pods: [
      {
        podRef: { name: 'pg-hardware-1', namespace: 'ysws-telescreen' },
        volume: [
          {
            name: 'pgdata',
            usedBytes: 20 * GI,
            capacityBytes: 26 * GI,
            availableBytes: 6 * GI,
            pvcRef: { name: 'pg-hardware-1', namespace: 'ysws-telescreen' }
          },
          { name: 'tmp', usedBytes: 1, capacityBytes: 2 }
        ]
      },
      {
        podRef: { name: 'other' },
        volume: [{ pvcRef: { name: 'x', namespace: 'ns' }, usedBytes: 'nope', capacityBytes: 1 }]
      }
    ]
  });
  assert.equal(usage.size, 1);
  assert.deepEqual(usage.get('ysws-telescreen/pg-hardware-1'), {
    usedBytes: 20 * GI,
    capacityBytes: 26 * GI,
    availableBytes: 6 * GI
  });
});

test('only the numbered data volumes of a cluster count, and the fullest one wins', () => {
  const usage = parseKubeletSummary({
    pods: [
      {
        volume: [
          { usedBytes: 5, capacityBytes: 10, pvcRef: { name: 'pg-a-1', namespace: 'ns' } },
          { usedBytes: 9, capacityBytes: 10, pvcRef: { name: 'pg-a-2', namespace: 'ns' } },
          { usedBytes: 10, capacityBytes: 10, pvcRef: { name: 'pg-a-1-wal', namespace: 'ns' } },
          { usedBytes: 10, capacityBytes: 10, pvcRef: { name: 'pg-ab-1', namespace: 'ns' } }
        ]
      }
    ]
  });
  const volumes = dataVolumesOf(usage, 'ns', 'pg-a');
  assert.equal(volumes.length, 2);
  assert.equal(fullestVolume(volumes)?.usedBytes, 9);
  assert.equal(fullestVolume([]), null);
});

test('the write guard engages at ninety-two percent and releases under eighty-five', () => {
  assert.equal(writeGuardDecision(false, 18 * GI, 20 * GI), null);
  assert.equal(writeGuardDecision(false, 18.5 * GI, 20 * GI), 'on');
  assert.equal(writeGuardDecision(true, 18 * GI, 20 * GI), null);
  assert.equal(writeGuardDecision(true, 16.9 * GI, 20 * GI), 'off');
  assert.equal(writeGuardDecision(false, 1, 0), null);
});

test('a paused database names the smallest size that brings it under eighty-five percent', () => {
  const hardware = { usedBytes: 27_905_277_952, capacityBytes: 31_593_590_784 };
  assert.equal(sizeToResumeWrites(hardware, '30Gi'), '32Gi');
  assert.ok(projectedFill(hardware, '30Gi', '31Gi')! >= 0.85);
  assert.ok(projectedFill(hardware, '30Gi', '32Gi')! < 0.85);
  assert.equal(sizeToResumeWrites({ usedBytes: 10 * GI, capacityBytes: 20 * GI }, '20Gi'), null);
  assert.equal(sizeToResumeWrites({ usedBytes: 1, capacityBytes: 0 }, '20Gi'), null);
  assert.equal(sizeToResumeWrites({ usedBytes: 1, capacityBytes: 1 }, 'nope'), null);
});
