import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantQuotaFloor, tenantQuotaHard } from '../src/kubernetes/tenant-quota';

const floor = tenantQuotaFloor({});

test('an uncapped namespace still gets a quota, never none', () => {
  const hard = tenantQuotaHard({}, floor);
  assert.equal(hard['pods'], '200');
  assert.equal(hard['services'], '100');
  assert.equal(hard['persistentvolumeclaims'], '50');
  assert.equal(hard['requests.storage'], String(500 * 1024 ** 3));
  assert.equal(hard['requests.cpu'], undefined);
  assert.equal(hard['requests.memory'], undefined);
});

test('explicit caps win over the floor and keep the cpu and memory lines', () => {
  const hard = tenantQuotaHard(
    { cpuLimitMilli: 4000, memoryLimitBytes: 8 * 1024 ** 3, maxPods: 20, maxServices: 5 },
    floor
  );
  assert.equal(hard['pods'], '20');
  assert.equal(hard['services'], '5');
  assert.equal(hard['requests.cpu'], '4000m');
  assert.equal(hard['limits.cpu'], '4000m');
  assert.equal(hard['requests.memory'], String(8 * 1024 ** 3));
  assert.equal(hard['persistentvolumeclaims'], '50');
});

test('the floor is tunable from the environment and ignores nonsense', () => {
  const custom = tenantQuotaFloor({
    TENANT_QUOTA_FLOOR_PODS: '10',
    TENANT_QUOTA_FLOOR_SERVICES: 'lots',
    TENANT_QUOTA_FLOOR_PVCS: '-3'
  });
  assert.equal(custom.pods, 10);
  assert.equal(custom.services, 100);
  assert.equal(custom.persistentvolumeclaims, 50);
});

test('zero or null caps fall back to the floor rather than removing the line', () => {
  const hard = tenantQuotaHard({ maxPods: 0, maxServices: null }, floor);
  assert.equal(hard['pods'], '200');
  assert.equal(hard['services'], '100');
});
