import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOrgCanCreate,
  assertWithinOrgCount,
  newOrgCaps,
  orgCountLimits
} from '../src/quotas/org-limits';
import { AdminService } from '../src/admin/admin.service';

test('count limits default to generous values', () => {
  assert.deepEqual(orgCountLimits({}), { projects: 500, environments: 1000, deployments: 2000 });
});

test('count limits read the environment and 0 turns one off', () => {
  const limits = orgCountLimits({
    MAX_PROJECTS_PER_ORG: '12',
    MAX_ENVIRONMENTS_PER_ORG: '0',
    MAX_DEPLOYMENTS_PER_ORG: 'abc'
  });
  assert.deepEqual(limits, { projects: 12, environments: 0, deployments: 2000 });
});

test('an org already over the limit cannot create more but keeps what it has', () => {
  assert.doesNotThrow(() => assertWithinOrgCount('projects', 499, 500));
  assert.throws(() => assertWithinOrgCount('projects', 500, 500), /limit 500/);
  assert.throws(() => assertWithinOrgCount('projects', 900, 500), /already has 900/);
  assert.doesNotThrow(() => assertWithinOrgCount('projects', 900, 0));
});

test('new org caps default to 16 CPU and 32 GiB', () => {
  assert.deepEqual(newOrgCaps({}), {
    cpuLimitMilli: 16000,
    memoryLimitBytes: BigInt(32 * 1024 ** 3)
  });
});

test('new org caps can be changed or removed', () => {
  assert.deepEqual(newOrgCaps({ NEW_ORG_CPU: '500m', NEW_ORG_MEMORY: '2Gi' }), {
    cpuLimitMilli: 500,
    memoryLimitBytes: BigInt(2 * 1024 ** 3)
  });
  assert.deepEqual(newOrgCaps({ NEW_ORG_CPU: '0', NEW_ORG_MEMORY: 'unlimited' }), {
    cpuLimitMilli: null,
    memoryLimitBytes: null
  });
});

function fakePrisma(counts: { projects?: number; environments?: number; deployments?: number }) {
  const seen: any[] = [];
  return {
    seen,
    project: {
      count: async (args: any) => {
        seen.push(['project', args.where]);
        return counts.projects ?? 0;
      }
    },
    environment: {
      count: async (args: any) => {
        seen.push(['environment', args.where]);
        return counts.environments ?? 0;
      }
    },
    deployment: {
      count: async (args: any) => {
        seen.push(['deployment', args.where]);
        return counts.deployments ?? 0;
      }
    }
  } as any;
}

test('creates are refused once the org is at the cap', async () => {
  const env = {
    MAX_PROJECTS_PER_ORG: '3',
    MAX_ENVIRONMENTS_PER_ORG: '2',
    MAX_DEPLOYMENTS_PER_ORG: '5'
  };
  const prisma = fakePrisma({ projects: 3, environments: 1, deployments: 7 });
  await assert.rejects(assertOrgCanCreate(prisma, 'o1', 'projects', env), /limit 3/);
  await assert.doesNotReject(assertOrgCanCreate(prisma, 'o1', 'environments', env));
  await assert.rejects(assertOrgCanCreate(prisma, 'o1', 'deployments', env), /already has 7/);
  assert.deepEqual(prisma.seen[0], ['project', { organizationId: 'o1' }]);
  assert.deepEqual(prisma.seen[1], [
    'environment',
    { isDefault: false, project: { organizationId: 'o1' } }
  ]);
});

test('an unlimited cap skips the count query', async () => {
  const prisma = fakePrisma({ projects: 10_000 });
  await assertOrgCanCreate(prisma, 'o1', 'projects', { MAX_PROJECTS_PER_ORG: '0' });
  assert.equal(prisma.seen.length, 0);
});

function adminService() {
  const created: any[] = [];
  const svc = Object.create(AdminService.prototype) as any;
  svc.prisma = {
    user: { findFirst: async () => null },
    organization: {
      create: async (args: any) => {
        created.push(args.data);
        return { id: 'o1', name: 'n', slug: 's', plan: null };
      }
    }
  };
  svc.audit = { log: async () => {} };
  return { svc, created };
}

test('a new org is created with the default compute caps', async () => {
  const { svc, created } = adminService();
  await svc.createOrganization({ name: 'Acme', slug: 'acme' }, 'admin');
  assert.equal(created[0].cpuLimitMilli, 16000);
  assert.equal(created[0].memoryLimitBytes, BigInt(32 * 1024 ** 3));
});

test('the first org created by setup is left uncapped', async () => {
  const { svc, created } = adminService();
  await svc.createOrganization({ name: 'Home', slug: 'home' }, 'admin', {
    applyDefaultCaps: false
  });
  assert.equal('cpuLimitMilli' in created[0], false);
  assert.equal('memoryLimitBytes' in created[0], false);
});
