import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common';
import {
  DatabaseOperationsService,
  planRejected
} from '../src/projects/database-operations.service';

function planHarness(kind: string, mode: string | null, options: { failPhase?: boolean } = {}) {
  const committed: { created: any[]; updates: any[] } = { created: [], updates: [] };
  const prisma = {
    project: {
      findUnique: async () => ({
        id: 'p1',
        namespace: 'ns',
        organizationId: 'o1',
        ownerId: 'u1',
        organization: {}
      })
    },
    environment: { findUnique: async () => null },
    database: { findFirst: async () => null },
    databaseOperation: {
      update: async () => assert.fail('the phase moves inside the transaction')
    },
    $transaction: async (fn: (tx: any) => Promise<void>) => {
      const created: any[] = [];
      const updates: any[] = [];
      await fn({
        database: { create: async (a: any) => created.push(a.data) },
        databaseOperation: {
          update: async (a: any) => {
            if (options.failPhase) throw new Error('connection lost');
            updates.push(a.data);
          }
        }
      });
      committed.created.push(...created);
      committed.updates.push(...updates);
    }
  };
  const quotas = {
    resolvePodResources: async () => ({ cpuMilli: 500, memoryBytes: 1024 }),
    podSizing: async () => ({ cpuMilli: 500, memoryBytes: 1024 }),
    limitsOff: async () => false,
    enforceOrgCapForNewPod: async () => {},
    enforceMemberAllowanceForNewPod: async () => {}
  };
  const service = new DatabaseOperationsService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    { seal: (v: string) => `sealed:${v}`, open: (v: string) => v } as any,
    quotas as any,
    { resolveEnvironment: async () => null } as any,
    { get: () => ({ generatePassword: () => 'new-password' }) } as any
  );
  const op = {
    id: 'op1',
    kind,
    mode,
    phase: 'queued',
    request: {},
    requestedBy: 'u1',
    source: {
      databaseId: 'src',
      trashId: null,
      projectId: 'p1',
      environmentId: null,
      name: 'appdb',
      dbName: 'org_proj_appdb',
      dbUser: 'u_org_proj_appdb',
      dbPassword: 'old',
      pgMajor: 17,
      storageSize: '1Gi',
      replicas: 1,
      cpuRequestMilli: null,
      memoryRequestBytes: null,
      pgParameters: null,
      sharedPreloadLibs: null,
      nodePoolId: null,
      placementOverride: null
    }
  };
  return { service, op, committed };
}

for (const [kind, mode] of [
  ['fork', 'fork'],
  ['restore', 'fork']
] as const) {
  test(`a ${kind}/${mode} keeps the name inside the copied cluster and records its source`, async () => {
    const { service, op, committed } = planHarness(kind, mode);
    await (service as any).plan(op);
    assert.equal(committed.created.length, 1);
    const [row] = committed.created;
    assert.equal(row.dbName, 'org_proj_appdb');
    assert.equal(row.name, 'appdb-fork');
    assert.equal(row.forkedFromId, 'src');
    assert.equal(row.dbPassword, 'sealed:new-password');
    assert.equal(committed.updates.length, 1);
    assert.equal(committed.updates[0].phase, 'provisioning');
    assert.equal(committed.updates[0].targetDatabaseId, row.id);
    assert.equal(committed.updates[0].targetClusterName, row.clusterName);
  });
}

test('a plan that dies between its two writes leaves no database row behind', async () => {
  const { service, op, committed } = planHarness('fork', 'fork', { failPhase: true });
  await assert.rejects((service as any).plan(op), /connection lost/);
  assert.deepEqual(committed, { created: [], updates: [] });
});

test('the database name is only unique inside its own cluster', () => {
  const prismaDir = resolve(__dirname, '../prisma');
  const model = readFileSync(join(prismaDir, 'schema.prisma'), 'utf8').match(
    /model Database \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(model);
  assert.ok(!model.includes('@@unique([dbName])'));
  const migrations = readdirSync(join(prismaDir, 'migrations')).filter((d) => /^\d/.test(d));
  const dropped = migrations.filter((d) =>
    readFileSync(join(prismaDir, 'migrations', d, 'migration.sql'), 'utf8').includes(
      'DROP INDEX "databases_db_name_key"'
    )
  );
  assert.equal(dropped.length, 1);
});

test('a plan the request itself rules out fails at once, anything else retries', () => {
  assert.equal(planRejected('queued', new BadRequestException('name taken')), true);
  assert.equal(planRejected('queued', new NotFoundException('gone')), true);
  assert.equal(planRejected('queued', { code: 'P2002' }), true);
  assert.equal(planRejected('queued', new Error('connect ECONNREFUSED')), false);
  assert.equal(planRejected('queued', new InternalServerErrorException('boom')), false);
  assert.equal(planRejected('provisioning', new BadRequestException('no backup yet')), false);
});
