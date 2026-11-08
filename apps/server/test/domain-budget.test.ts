import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { DomainBudget, domainBudgetLimits, proofBackoffMs } from '../src/projects/domain-budget';
import { ProjectAccessService } from '../src/projects/project-access.service';
import { InstanceSettingsService } from '../src/instance-settings/instance-settings.service';

class FakePrisma {
  settings = new Map<string, string>();
  records = new Map<string, any>();
  hosts: string[] = [];

  instanceSetting = {
    findUnique: async ({ where }: any) => {
      const value = this.settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, create, update }: any) => {
      this.settings.set(where.key, this.settings.has(where.key) ? update.value : create.value);
    },
    deleteMany: async ({ where }: any) => {
      this.settings.delete(where.key);
    }
  };

  rateLimitRecord = {
    findUnique: async ({ where }: any) =>
      this.records.get(where.identifier_type_action.action) ?? null,
    create: async ({ data }: any) => {
      this.records.set(data.action, { ...data });
    },
    update: async ({ where, data }: any) => {
      const key = where.identifier_type_action.action;
      const current = this.records.get(key);
      const count =
        typeof data.count === 'object' ? current.count + data.count.increment : data.count;
      this.records.set(key, { ...current, ...data, count });
    }
  };

  ingress = {
    findMany: async () => this.hosts.map((host) => ({ host })),
    findFirst: async () => null
  };
}

test('proof failures are free at first and then back off exponentially to a day', () => {
  assert.equal(proofBackoffMs(1), 0);
  assert.equal(proofBackoffMs(5), 0);
  assert.equal(proofBackoffMs(6), 60_000);
  assert.equal(proofBackoffMs(7), 120_000);
  assert.equal(proofBackoffMs(8), 240_000);
  assert.equal(proofBackoffMs(40), 24 * 60 * 60 * 1000);
});

test('limits default to generous values and read the environment', () => {
  assert.deepEqual(domainBudgetLimits({}), { maxCustomDomains: 250, createsPerHour: 30 });
  assert.deepEqual(
    domainBudgetLimits({
      MAX_CUSTOM_DOMAINS_PER_ORG: '5',
      MAX_CUSTOM_DOMAIN_CREATES_PER_HOUR: '0'
    }),
    { maxCustomDomains: 5, createsPerHour: 0 }
  );
});

test('an org can only add so many custom domains an hour', async () => {
  const prisma = new FakePrisma();
  let now = 1_000_000;
  const budget = new DomainBudget(
    prisma as any,
    { MAX_CUSTOM_DOMAIN_CREATES_PER_HOUR: '3' },
    () => new Date(now)
  );
  for (let i = 0; i < 3; i += 1) await budget.consumeCreate('org');
  const err: any = await budget.consumeCreate('org').catch((e) => e);
  assert.equal(err.getStatus(), 429);
  assert.ok(err.getResponse().retryAfter > 0);
  now += 61 * 60 * 1000;
  await budget.consumeCreate('org');
});

test('an org at its custom domain cap cannot add more, platform hosts do not count', async () => {
  const prisma = new FakePrisma();
  prisma.hosts = ['a.example.com', 'b.example.com'];
  const budget = new DomainBudget(prisma as any, { MAX_CUSTOM_DOMAINS_PER_ORG: '2' });
  await assert.rejects(budget.assertCapacity('org'), ForbiddenException);
  await new DomainBudget(prisma as any, { MAX_CUSTOM_DOMAINS_PER_ORG: '3' }).assertCapacity('org');
  await new DomainBudget(prisma as any, { MAX_CUSTOM_DOMAINS_PER_ORG: '0' }).assertCapacity('org');
});

test('failed proofs pause the org with a growing delay and a success clears it', async () => {
  const prisma = new FakePrisma();
  let now = 5_000_000;
  const budget = new DomainBudget(prisma as any, {}, () => new Date(now));
  for (let i = 0; i < 5; i += 1) {
    await budget.assertProofNotPaused('org');
    await budget.recordProofFailure('org');
  }
  await budget.assertProofNotPaused('org');
  await budget.recordProofFailure('org');
  const first: any = await budget.assertProofNotPaused('org').catch((e) => e);
  assert.equal(first.getStatus(), 429);
  assert.equal(first.getResponse().retryAfter, 60);

  now += 61_000;
  await budget.assertProofNotPaused('org');
  await budget.recordProofFailure('org');
  const second: any = await budget.assertProofNotPaused('org').catch((e) => e);
  assert.equal(second.getResponse().retryAfter, 120);

  await budget.clearProofFailures('org');
  await budget.assertProofNotPaused('org');
});

function access(prisma: FakePrisma, opts: { on: boolean; txt?: string[]; held?: boolean }) {
  const service = Object.create(ProjectAccessService.prototype) as any;
  service.instanceSettings = { isCustomDomainVerificationRequired: async () => opts.on };
  service.lookupProof = async () => opts.txt ?? [];
  service.prisma = {
    ingress: {
      findFirst: async ({ where }: any) =>
        where.projectId === 'p' && opts.held ? { id: 'i' } : null,
      findMany: prisma.ingress.findMany
    },
    organization: { findUnique: async () => null },
    statusPage: { findUnique: async () => null },
    project: { findUnique: async () => ({ organizationId: 'org' }) },
    orgDomain: { findFirst: async () => null }
  };
  service.domainBudget = new DomainBudget(prisma as any, {}, () => new Date(9_000_000));
  return service;
}

test('failed domain proofs through the ingress path are counted and paused', async () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  try {
    const prisma = new FakePrisma();
    const service = access(prisma, { on: true });
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(
        service.assertHostnameAvailable('x.example.com', 'p'),
        BadRequestException
      );
    }
    await assert.rejects(
      service.assertHostnameAvailable('x.example.com', 'p'),
      BadRequestException
    );
    const paused: any = await service
      .assertHostnameAvailable('x.example.com', 'p')
      .catch((e: any) => e);
    assert.equal(paused.getStatus(), 429);
  } finally {
    process.env.JWT_SECRET = previous;
  }
});

test('hosts the project already holds skip the new domain budget', async () => {
  const prisma = new FakePrisma();
  prisma.records.set('custom_domain_create', {
    count: 999,
    windowStart: new Date(9_000_000),
    action: 'custom_domain_create'
  });
  await access(prisma, { on: true, held: true }).assertHostnameAvailable('x.example.com', 'p');
  await assert.rejects(
    access(prisma, { on: false }).assertHostnameAvailable('x.example.com', 'p'),
    (err: any) => err.getStatus() === 429
  );
});

function settings(stored?: string) {
  const prisma = {
    instanceSetting: {
      findUnique: async () => (stored === undefined ? null : { value: stored })
    }
  };
  return new InstanceSettingsService(prisma as any);
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('domain proof is required by default only when signup is open', async () => {
  await withEnv({ CUSTOM_DOMAIN_VERIFICATION: undefined, SIGNUP_MODE: 'open' }, async () => {
    assert.equal(await settings().isCustomDomainVerificationRequired(), true);
    assert.equal((await settings().getCustomDomainVerificationState()).enabled, true);
  });
  for (const mode of ['invite_only', 'closed', undefined]) {
    await withEnv({ CUSTOM_DOMAIN_VERIFICATION: undefined, SIGNUP_MODE: mode }, async () => {
      assert.equal(await settings().isCustomDomainVerificationRequired(), false);
    });
  }
});

test('an explicit setting or variable still wins over the open-signup default', async () => {
  await withEnv({ CUSTOM_DOMAIN_VERIFICATION: undefined, SIGNUP_MODE: 'open' }, async () => {
    assert.equal(await settings('false').isCustomDomainVerificationRequired(), false);
  });
  await withEnv({ CUSTOM_DOMAIN_VERIFICATION: 'false', SIGNUP_MODE: 'open' }, async () => {
    assert.equal(await settings().isCustomDomainVerificationRequired(), false);
  });
  await withEnv({ CUSTOM_DOMAIN_VERIFICATION: 'true', SIGNUP_MODE: 'invite_only' }, async () => {
    assert.equal(await settings().isCustomDomainVerificationRequired(), true);
  });
});
