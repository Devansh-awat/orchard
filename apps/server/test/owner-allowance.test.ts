import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerLeftAllowance } from '../src/quotas/owner-allowance';

test('a project whose owner left the org deploys within the org default, not zero', () => {
  assert.deepEqual(
    ownerLeftAllowance({ defaultMemberCpuMilli: 5000, defaultMemberMemoryBytes: 8589934592n }),
    { cpuMilli: 5000, memoryBytes: 8589934592 }
  );
});

test('an org without member defaults leaves the departed owner unlimited, like any member', () => {
  assert.deepEqual(
    ownerLeftAllowance({ defaultMemberCpuMilli: null, defaultMemberMemoryBytes: null }),
    {
      cpuMilli: null,
      memoryBytes: null
    }
  );
});

test('a missing org still allows nothing', () => {
  assert.deepEqual(ownerLeftAllowance(null), { cpuMilli: 0, memoryBytes: 0 });
});
