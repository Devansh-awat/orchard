import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOrgCanCreate,
  assertWithinOrgCount,
  effectiveCountLimit,
  envNewOrgDefaults,
  newOrgCapsData,
  orgCountCeilings,
  parseNewOrgDefaults,
  validateNewOrgDefaults
} from '../src/quotas/org-limits';
import { AdminService } from '../src/admin/admin.service';
import { QuotasService } from '../src/quotas/quotas.service';
import {
  AdminNewOrgDefaultsController,
  AdminQuotasController
} from '../src/quotas/quotas.controller';
import {
  InstanceSettingsService,
  NEW_ORG_DEFAULTS_KEY
} from '../src/instance-settings/instance-settings.service';
import { REQUIRES_SUPERADMIN_KEY } from '../src/auth/decorators';

const UNCAPPED = {
  cpuLimitMilli: null,
  memoryLimitBytes: null,
  maxProjects: null,
  maxEnvironments: null,
  maxDeployments: null
};

class FakeSettingsPrisma {
  rows = new Map<string, string>();
  instanceSetting = {
    findUnique: async ({ where }: any) => {
      const value = this.rows.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, update }: any) => {
      this.rows.set(where.key, update.value);
      return { key: where.key, value: update.value };
    }
  };
}

function settingsService() {
  const prisma = new FakeSettingsPrisma();
  return { prisma, settings: new InstanceSettingsService(prisma as any) };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('new orgs are uncapped by default', () => {
  assert.deepEqual(envNewOrgDefaults({}), UNCAPPED);
  assert.deepEqual(newOrgCapsData(envNewOrgDefaults({})), UNCAPPED);
});

test('the environment can still seed the compute caps, 0 or unlimited means none', () => {
  assert.deepEqual(envNewOrgDefaults({ NEW_ORG_CPU: '500m', NEW_ORG_MEMORY: '2Gi' }), {
    ...UNCAPPED,
    cpuLimitMilli: 500,
    memoryLimitBytes: 2 * 1024 ** 3
  });
  assert.deepEqual(envNewOrgDefaults({ NEW_ORG_CPU: '0', NEW_ORG_MEMORY: 'unlimited' }), UNCAPPED);
});

test('the memory cap is handed to Prisma as a bigint', () => {
  const caps = newOrgCapsData({ ...UNCAPPED, memoryLimitBytes: 1024 ** 3, maxProjects: 4 });
  assert.equal(caps.memoryLimitBytes, BigInt(1024 ** 3));
  assert.equal(caps.maxProjects, 4);
});

test('count ceilings from the environment default to none', () => {
  assert.deepEqual(orgCountCeilings({}), { projects: 0, environments: 0, deployments: 0 });
  assert.deepEqual(
    orgCountCeilings({
      MAX_PROJECTS_PER_ORG: '12',
      MAX_ENVIRONMENTS_PER_ORG: '0',
      MAX_DEPLOYMENTS_PER_ORG: 'abc'
    }),
    { projects: 12, environments: 0, deployments: 0 }
  );
});

test('the effective count limit is the stricter of the org value and the ceiling', () => {
  assert.equal(effectiveCountLimit(null, 0), 0);
  assert.equal(effectiveCountLimit(5, 0), 5);
  assert.equal(effectiveCountLimit(null, 9), 9);
  assert.equal(effectiveCountLimit(5, 9), 5);
  assert.equal(effectiveCountLimit(20, 9), 9);
});

test('an org already over the limit cannot create more but keeps what it has', () => {
  assert.doesNotThrow(() => assertWithinOrgCount('projects', 499, 500));
  assert.throws(() => assertWithinOrgCount('projects', 500, 500), /limit 500/);
  assert.throws(() => assertWithinOrgCount('projects', 900, 500), /already has 900/);
  assert.doesNotThrow(() => assertWithinOrgCount('projects', 900, 0));
});

test('stored defaults parse, and a malformed row degrades to nothing', () => {
  assert.deepEqual(
    parseNewOrgDefaults(
      JSON.stringify({ cpuLimitMilli: 4000, maxProjects: 10, maxDeployments: -1 })
    ),
    { ...UNCAPPED, cpuLimitMilli: 4000, maxProjects: 10 }
  );
  assert.equal(parseNewOrgDefaults('not json'), null);
  assert.equal(parseNewOrgDefaults('[1]'), null);
  assert.equal(parseNewOrgDefaults(null), null);
});

test('admin input is validated, and blank or null means uncapped', () => {
  assert.deepEqual(validateNewOrgDefaults({ cpuLimitMilli: 8000, maxProjects: null }), {
    ...UNCAPPED,
    cpuLimitMilli: 8000
  });
  assert.deepEqual(validateNewOrgDefaults({}), UNCAPPED);
  assert.throws(() => validateNewOrgDefaults({ maxProjects: 0 }), /Project limit/);
  assert.throws(() => validateNewOrgDefaults({ cpuLimitMilli: '4' }), /CPU cap/);
  assert.throws(() => validateNewOrgDefaults({ memoryLimitBytes: 1.5 }), /Memory cap/);
  assert.throws(() => validateNewOrgDefaults(null), /object/);
});

function fakePrisma(
  counts: { projects?: number; environments?: number; deployments?: number },
  org: {
    maxProjects?: number | null;
    maxEnvironments?: number | null;
    maxDeployments?: number | null;
  } = {}
) {
  const seen: any[] = [];
  return {
    seen,
    organization: { findUnique: async () => org },
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

test('an org with no limit is never refused', async () => {
  const prisma = fakePrisma({ projects: 10_000, environments: 10_000, deployments: 10_000 });
  for (const kind of ['projects', 'environments', 'deployments'] as const) {
    await assertOrgCanCreate(prisma, 'o1', kind, {});
  }
  assert.equal(prisma.seen.length, 0);
});

test('creates are refused once the org is at its own limit', async () => {
  const prisma = fakePrisma(
    { projects: 3, environments: 1, deployments: 7 },
    { maxProjects: 3, maxEnvironments: 2, maxDeployments: 5 }
  );
  await assert.rejects(assertOrgCanCreate(prisma, 'o1', 'projects', {}), /limit 3/);
  await assert.doesNotReject(assertOrgCanCreate(prisma, 'o1', 'environments', {}));
  await assert.rejects(assertOrgCanCreate(prisma, 'o1', 'deployments', {}), /already has 7/);
  assert.deepEqual(prisma.seen[0], ['project', { organizationId: 'o1' }]);
  assert.deepEqual(prisma.seen[1], [
    'environment',
    { isDefault: false, project: { organizationId: 'o1' } }
  ]);
});

test('an environment ceiling still binds an org with no limit of its own', async () => {
  const prisma = fakePrisma({ projects: 2 });
  await assert.rejects(
    assertOrgCanCreate(prisma, 'o1', 'projects', { MAX_PROJECTS_PER_ORG: '2' }),
    /limit 2/
  );
});

function adminService(settings: InstanceSettingsService) {
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
  svc.settings = settings;
  return { svc, created };
}

test('a new org is created uncapped when nothing is configured', () =>
  withEnv({ NEW_ORG_CPU: undefined, NEW_ORG_MEMORY: undefined }, async () => {
    const { settings } = settingsService();
    const { svc, created } = adminService(settings);
    await svc.createOrganization({ name: 'Acme', slug: 'acme' }, 'admin');
    assert.equal(created[0].cpuLimitMilli, null);
    assert.equal(created[0].memoryLimitBytes, null);
    assert.equal(created[0].maxProjects, null);
    assert.equal(created[0].maxEnvironments, null);
    assert.equal(created[0].maxDeployments, null);
  }));

test('the instance default is snapshotted into a new org and is not retroactive', () =>
  withEnv({ NEW_ORG_CPU: undefined, NEW_ORG_MEMORY: undefined }, async () => {
    const { settings } = settingsService();
    const { svc, created } = adminService(settings);
    await svc.createOrganization({ name: 'Before', slug: 'before' }, 'admin');
    await settings.setNewOrgDefaults({
      cpuLimitMilli: 4000,
      memoryLimitBytes: 8 * 1024 ** 3,
      maxProjects: 25,
      maxEnvironments: 50,
      maxDeployments: 100
    });
    await svc.createOrganization({ name: 'After', slug: 'after' }, 'admin');
    assert.equal(created[0].cpuLimitMilli, null);
    assert.equal(created[0].maxProjects, null);
    assert.equal(created[1].cpuLimitMilli, 4000);
    assert.equal(created[1].memoryLimitBytes, BigInt(8 * 1024 ** 3));
    assert.equal(created[1].maxProjects, 25);
    assert.equal(created[1].maxEnvironments, 50);
    assert.equal(created[1].maxDeployments, 100);
  }));

test('a stored instance default of all blanks beats the environment seed', () =>
  withEnv({ NEW_ORG_CPU: '2', NEW_ORG_MEMORY: '4Gi' }, async () => {
    const { settings } = settingsService();
    const seeded = await settings.getNewOrgCaps();
    assert.equal(seeded.cpuLimitMilli, 2000);
    await settings.setNewOrgDefaults(UNCAPPED);
    assert.deepEqual(await settings.getNewOrgCaps(), UNCAPPED);
    const state = await settings.getNewOrgDefaultsState();
    assert.deepEqual(state.stored, UNCAPPED);
    assert.equal(state.fallback.cpuLimitMilli, 2000);
  }));

test('the first org created by setup is left alone even with an instance default', async () => {
  const { settings } = settingsService();
  await settings.setNewOrgDefaults({ ...UNCAPPED, cpuLimitMilli: 1000 });
  const { svc, created } = adminService(settings);
  await svc.createOrganization({ name: 'Home', slug: 'home' }, 'admin', {
    applyDefaultCaps: false
  });
  assert.equal('cpuLimitMilli' in created[0], false);
  assert.equal('maxProjects' in created[0], false);
});

test('the instance default is stored in the generic settings table', async () => {
  const { prisma, settings } = settingsService();
  await settings.setNewOrgDefaults({ ...UNCAPPED, maxProjects: 7 });
  assert.deepEqual(JSON.parse(prisma.rows.get(NEW_ORG_DEFAULTS_KEY)!), {
    ...UNCAPPED,
    maxProjects: 7
  });
});

function quotasService(orgs: Record<string, any>) {
  const svc = Object.create(QuotasService.prototype) as any;
  svc.prisma = {
    organization: {
      findUnique: async ({ where }: any) => orgs[where.id] ?? null,
      findMany: async () => [],
      updateMany: async ({ where, data }: any) => {
        for (const id of where.id.in) Object.assign(orgs[id], data);
        return { count: where.id.in.length };
      }
    }
  };
  svc.applyAllProjectsForOrg = async () => {};
  return svc as QuotasService;
}

test('a per-org override changes only that org and null clears it', async () => {
  const orgs: Record<string, any> = {
    a: { id: 'a', quotaGroupId: null, cpuLimitMilli: 16000, maxProjects: 10 },
    b: { id: 'b', quotaGroupId: null, cpuLimitMilli: 16000, maxProjects: 10 }
  };
  const svc = quotasService(orgs);
  await svc.updateOrgCaps('a', { cpuLimitMilli: null, maxProjects: 99, maxDeployments: 5 });
  assert.equal(orgs.a.cpuLimitMilli, null);
  assert.equal(orgs.a.maxProjects, 99);
  assert.equal(orgs.a.maxDeployments, 5);
  assert.equal(orgs.b.cpuLimitMilli, 16000);
  assert.equal(orgs.b.maxProjects, 10);
  await svc.updateOrgCaps('a', { maxProjects: null });
  assert.equal(orgs.a.maxProjects, null);
  assert.equal(orgs.a.maxDeployments, 5);
});

test('a per-org override rejects zero and negative counts', async () => {
  const svc = quotasService({ a: { id: 'a', quotaGroupId: null } });
  await assert.rejects(svc.updateOrgCaps('a', { maxProjects: 0 }), /Project limit/);
  await assert.rejects(svc.updateOrgCaps('a', { maxEnvironments: -3 }), /Environment limit/);
});

test('existing orgs keep what they have when an instance default is set', async () => {
  const orgs: Record<string, any> = {
    old: { id: 'old', quotaGroupId: null, cpuLimitMilli: 16000, maxProjects: null }
  };
  const { settings } = settingsService();
  await settings.setNewOrgDefaults({ ...UNCAPPED, cpuLimitMilli: 1000, maxProjects: 1 });
  assert.equal(orgs.old.cpuLimitMilli, 16000);
  assert.equal(orgs.old.maxProjects, null);
  const prisma = fakePrisma({ projects: 400 }, orgs.old);
  await assert.doesNotReject(assertOrgCanCreate(prisma, 'old', 'projects', {}));
});

test('only superadmins can read or write the defaults and per-org caps', () => {
  assert.equal(Reflect.getMetadata(REQUIRES_SUPERADMIN_KEY, AdminNewOrgDefaultsController), true);
  assert.equal(Reflect.getMetadata(REQUIRES_SUPERADMIN_KEY, AdminQuotasController), true);
});

test('writing the defaults and a per-org override is audited', async () => {
  const { settings } = settingsService();
  const events: any[] = [];
  const audit = {
    log: async (e: any) => {
      events.push(e);
    }
  } as any;
  const controller = new AdminNewOrgDefaultsController(settings, audit);
  const state = await controller.set({ maxProjects: 3 }, { auth: { userId: 'u1' } });
  assert.equal(state.value.maxProjects, 3);
  await assert.rejects(controller.set({ maxProjects: 0 }, { auth: { userId: 'u1' } }));
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'admin.new_org_defaults_updated');
  assert.equal(events[0].actorUserId, 'u1');

  const orgs: Record<string, any> = { a: { id: 'a', quotaGroupId: null } };
  const quotas = new AdminQuotasController(quotasService(orgs), audit);
  await quotas.updateOrgQuota('a', { maxProjects: 9 }, { auth: { userId: 'u1' } });
  assert.equal(events[1].action, 'admin.org.quota_updated');
  assert.equal(events[1].organizationId, 'a');
  assert.deepEqual(events[1].metadata, { maxProjects: 9 });
});
