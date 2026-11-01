import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowanceCommitment,
  groupByOwner,
  memberAllowance,
  ownedUsage
} from '../src/quotas/member-usage';

const unlimited = {
  cpuAllowanceMilli: null,
  memoryAllowanceBytes: null,
  cpuAllowanceUnlimited: false,
  memoryAllowanceUnlimited: false
};

test('explicit beats default beats unlimited, and the unlimited flag beats everything', () => {
  const org = { defaultMemberCpuMilli: 500, defaultMemberMemoryBytes: 512n };
  assert.deepEqual(memberAllowance(unlimited, org), {
    cpuMilli: 500,
    memoryBytes: 512,
    source: { cpu: 'default', memory: 'default' }
  });
  assert.deepEqual(
    memberAllowance({ ...unlimited, cpuAllowanceMilli: 250, memoryAllowanceBytes: 1024n }, org),
    { cpuMilli: 250, memoryBytes: 1024, source: { cpu: 'explicit', memory: 'explicit' } }
  );
  assert.deepEqual(
    memberAllowance(
      {
        ...unlimited,
        cpuAllowanceMilli: 250,
        cpuAllowanceUnlimited: true,
        memoryAllowanceUnlimited: true
      },
      org
    ),
    { cpuMilli: null, memoryBytes: null, source: { cpu: 'unlimited', memory: 'unlimited' } }
  );
  assert.deepEqual(
    memberAllowance(unlimited, { defaultMemberCpuMilli: null, defaultMemberMemoryBytes: null }),
    { cpuMilli: null, memoryBytes: null, source: { cpu: 'unlimited', memory: 'unlimited' } }
  );
});

test('usage multiplies by replicas, a stopped app costs nothing, a database is at least one instance', () => {
  const usage = ownedUsage([
    {
      id: 'p1',
      name: 'one',
      deployments: [
        {
          id: 'a',
          name: 'a',
          cpuRequestMilli: 100,
          memoryRequestBytes: 10n,
          replicas: 3,
          stopped: false
        },
        {
          id: 'b',
          name: 'b',
          cpuRequestMilli: 100,
          memoryRequestBytes: 10n,
          replicas: 3,
          stopped: true
        },
        {
          id: 'c',
          name: 'c',
          cpuRequestMilli: 50,
          memoryRequestBytes: null,
          replicas: null,
          stopped: false
        }
      ],
      databases: [
        { id: 'd', name: 'd', cpuRequestMilli: 200, memoryRequestBytes: 20n, replicas: 0 }
      ]
    }
  ]);
  assert.equal(usage.cpuMilli, 300 + 0 + 50 + 200);
  assert.equal(usage.memoryBytes, 30 + 20);
  assert.equal(usage.breakdown.length, 4);
  assert.equal(ownedUsage([], undefined).cpuMilli, 0);
  const excluded = ownedUsage(
    [
      {
        id: 'p',
        name: 'p',
        deployments: [
          {
            id: 'a',
            name: 'a',
            cpuRequestMilli: 100,
            memoryRequestBytes: 1n,
            replicas: 1,
            stopped: false
          }
        ],
        databases: []
      }
    ],
    'a'
  );
  assert.equal(excluded.cpuMilli, 0);
});

test('projects group by owner and ownerless projects belong to nobody', () => {
  const grouped = groupByOwner([
    { ownerId: 'u1', id: 'a' },
    { ownerId: null, id: 'b' },
    { ownerId: 'u1', id: 'c' },
    { ownerId: 'u2', id: 'd' }
  ]);
  assert.deepEqual(
    grouped.get('u1')?.map((p) => p.id),
    ['a', 'c']
  );
  assert.equal(grouped.get('u2')?.length, 1);
  assert.equal(grouped.size, 2);
});

test('commitment skips unlimited members and honours overrides', () => {
  const org = {
    defaultMemberCpuMilli: 100,
    defaultMemberMemoryBytes: 10n,
    members: [
      { userId: 'a', ...unlimited },
      { userId: 'b', ...unlimited, cpuAllowanceMilli: 300, memoryAllowanceBytes: 30n },
      { userId: 'c', ...unlimited, cpuAllowanceUnlimited: true, memoryAllowanceUnlimited: true }
    ]
  };
  assert.deepEqual(allowanceCommitment(org), { cpuMilli: 400, memoryBytes: 40 });
  assert.deepEqual(
    allowanceCommitment(org, {
      memberOverride: {
        userId: 'c',
        cpuMilli: 50,
        memoryBytes: 5,
        cpuUnlimited: false,
        memoryUnlimited: false
      },
      defaultOverride: { cpuMilli: 0, memoryBytes: 0 }
    }),
    { cpuMilli: 350, memoryBytes: 35 }
  );
});
