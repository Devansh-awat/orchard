import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPositiveOrBlank, QuotasService } from '../src/quotas/quotas.service';
import { memberAllowance } from '../src/quotas/member-usage';
import { podResourcesFor } from '../src/kubernetes/presets';

function service() {
  const writes: any[] = [];
  const prisma: any = {
    organization: {
      findUnique: async () => ({ quotaGroupId: null }),
      updateMany: async (a: any) => writes.push(a),
      update: async (a: any) => writes.push(a)
    },
    organizationMember: {
      findUnique: async () => ({
        cpuAllowanceMilli: null,
        memoryAllowanceBytes: null,
        cpuAllowanceUnlimited: false,
        memoryAllowanceUnlimited: false
      }),
      update: async (a: any) => writes.push(a)
    },
    project: {
      findMany: async () => [],
      update: async (a: any) => writes.push(a),
      findUnique: async () => null
    }
  };
  const svc = new (QuotasService as any)(prisma, {}, {}, {}, {}) as QuotasService;
  return { svc, writes };
}

test('a blank cap is fine and zero, negative and junk values are refused', () => {
  assert.doesNotThrow(() => assertPositiveOrBlank({ a: null, b: undefined, c: 1 }));
  assert.throws(() => assertPositiveOrBlank({ 'CPU cap': 0 }), /CPU cap must be greater than 0/);
  assert.throws(() => assertPositiveOrBlank({ x: -5 }), /greater than 0/);
  assert.throws(() => assertPositiveOrBlank({ x: Number.NaN }), /greater than 0/);
  assert.throws(() => assertPositiveOrBlank({ x: '4' as any }), /greater than 0/);
});

test('every cap and allowance write refuses zero before touching the database', async () => {
  const { svc, writes } = service();
  await assert.rejects(svc.updateOrgCaps('o', { cpuLimitMilli: 0 }), /CPU cap/);
  await assert.rejects(svc.updateOrgCaps('o', { memoryLimitBytes: 0 }), /Memory cap/);
  await assert.rejects(svc.updateOrgCaps('o', { maxPods: 0 }), /Max pods/);
  await assert.rejects(svc.updateOrgCaps('o', { maxServices: 0 }), /Max services/);
  await assert.rejects(svc.updateOrgCaps('o', { defaultPodCpuMilli: 0 }), /Default CPU/);
  await assert.rejects(svc.updateOrgCaps('o', { defaultPodMemoryBytes: 0 }), /Default memory/);
  await assert.rejects(svc.updateProjectCaps('p', { cpuLimitMilli: 0 }), /CPU cap/);
  await assert.rejects(svc.updateProjectCaps('p', { memoryLimitBytes: 0 }), /Memory cap/);
  await assert.rejects(svc.setMemberAllowance('o', 'u', { cpuMilli: 0 }), /CPU allowance/);
  await assert.rejects(svc.setMemberAllowance('o', 'u', { memoryBytes: 0 }), /Memory allowance/);
  await assert.rejects(svc.setOrgDefaultMemberAllowance('o', { cpuMilli: 0 }), /CPU allowance/);
  await assert.rejects(
    svc.setOrgDefaultMemberAllowance('o', { memoryBytes: 0 }),
    /Memory allowance/
  );
  assert.equal(writes.length, 0);
});

test('blank still clears a cap', async () => {
  const { svc, writes } = service();
  await svc.updateOrgCaps('o', { cpuLimitMilli: null, memoryLimitBytes: null });
  assert.equal(writes[0].data.cpuLimitMilli, null);
  assert.equal(writes[0].data.memoryLimitBytes, null);
});

test('a stored zero organization default CPU reads as unset, not as a 1m limit', () => {
  const org = { defaultPodCpuMilli: 0, defaultPodMemoryBytes: 0 };
  assert.deepEqual(podResourcesFor(null, org), { cpuMilli: 100, memoryBytes: 128 * 1024 * 1024 });
  assert.equal(podResourcesFor(null, { ...org, defaultPodCpuMilli: 250 }).cpuMilli, 250);
});

test('a stored zero member allowance keeps blocking the way it does today', () => {
  const allowance = memberAllowance(
    {
      cpuAllowanceMilli: 0,
      memoryAllowanceBytes: BigInt(0),
      cpuAllowanceUnlimited: false,
      memoryAllowanceUnlimited: false
    },
    { defaultMemberCpuMilli: null, defaultMemberMemoryBytes: null }
  );
  assert.equal(allowance.cpuMilli, 0);
  assert.equal(allowance.memoryBytes, 0);
});
