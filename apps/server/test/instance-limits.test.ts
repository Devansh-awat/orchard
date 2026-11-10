import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  countLimit,
  isLimitPinned,
  nodePortExposureEnabled,
  resolveLimit,
  setInstanceLimitOverrides,
  storedLimitError
} from '../src/quotas/instance-limits';
import { maxPublicPortsPerOrg } from '../src/projects/public-exposure-quota';
import { domainBudgetLimits } from '../src/projects/domain-budget';
import { orgCountCeilings } from '../src/quotas/org-limits';
import { maxVolumeBytes, maxVolumeSize } from '../src/kubernetes/pvc-limits';
import { abuseCaps, abuseQuotaHard } from '../src/kubernetes/tenant-abuse-quota';
import { orgBuildLimit } from '../src/projects/build-queue.service';
import { LIMITS } from '../src/instance-config/instance-config.sections';

afterEach(() => setInstanceLimitOverrides({}));

test('with nothing stored or set, every limit keeps its old default', () => {
  assert.equal(maxPublicPortsPerOrg({}), 20);
  assert.deepEqual(domainBudgetLimits({}), { maxCustomDomains: 250, createsPerHour: 30 });
  assert.deepEqual(orgCountCeilings({}), { projects: 0, environments: 0, deployments: 0 });
  assert.equal(maxVolumeSize({}), '200Gi');
  assert.equal(resolveLimit('databaseReplicas', {}), 5);
  assert.equal(resolveLimit('scansPerOrg', {}), 1);
  assert.equal(orgBuildLimit(16, ''), 8);
  assert.equal(nodePortExposureEnabled({}), true);
});

test('a value stored in the admin panel replaces the default', () => {
  setInstanceLimitOverrides({
    publicPortsPerOrg: '200',
    customDomainsPerOrg: '10',
    projectsPerOrg: '3',
    volumeSizeGiB: '1024',
    buildsPerOrg: '2',
    nodePortExposure: 'false'
  });
  assert.equal(maxPublicPortsPerOrg({}), 200);
  assert.equal(domainBudgetLimits({}).maxCustomDomains, 10);
  assert.equal(orgCountCeilings({}).projects, 3);
  assert.equal(maxVolumeSize({}), '1024Gi');
  assert.equal(orgBuildLimit(16, ''), 2);
  assert.equal(nodePortExposureEnabled({}), false);
});

test('off turns a limit off', () => {
  setInstanceLimitOverrides({
    publicPortsPerOrg: 'off',
    customDomainCreatesPerHour: 'off',
    volumeSizeGiB: 'off',
    buildsPerOrg: 'off',
    scansPerOrg: 'off',
    namespaceNodePorts: 'off',
    ephemeralStorageGiB: 'off'
  });
  assert.equal(maxPublicPortsPerOrg({}), 0);
  assert.equal(domainBudgetLimits({}).createsPerHour, 0);
  assert.equal(maxVolumeSize({}), null);
  assert.equal(maxVolumeBytes({}), Number.POSITIVE_INFINITY);
  assert.equal(orgBuildLimit(16, ''), 0);
  assert.equal(resolveLimit('scansPerOrg', {}), 'off');
  const caps = abuseCaps({});
  assert.equal(caps.nodePorts, null);
  assert.equal(caps.ephemeralLimitBytes, 0);
  assert.deepEqual(abuseQuotaHard(caps), { 'services.loadbalancers': '20' });
});

test('the environment pins a limit over anything stored', () => {
  setInstanceLimitOverrides({ publicPortsPerOrg: 'off', volumeSizeGiB: '10' });
  const env = { MAX_PUBLIC_PORTS_PER_ORG: '5', MAX_VOLUME_SIZE: '1Ti' };
  assert.equal(maxPublicPortsPerOrg(env), 5);
  assert.equal(maxVolumeSize(env), '1Ti');
  assert.equal(resolveLimit('volumeSizeGiB', env), 1024);
  assert.equal(isLimitPinned('publicPortsPerOrg', env), true);
  assert.equal(isLimitPinned('publicPortsPerOrg', {}), false);
  assert.equal(countLimit('publicPortsPerOrg', { MAX_PUBLIC_PORTS_PER_ORG: '0' }), 0);
  assert.equal(nodePortExposureEnabled({ TENANT_NODEPORT_EXPOSURE: 'true' }), true);
});

test('a zero in the environment keeps its old meaning per limit', () => {
  assert.equal(resolveLimit('publicPortsPerOrg', { MAX_PUBLIC_PORTS_PER_ORG: '0' }), 'off');
  assert.equal(abuseCaps({ TENANT_QUOTA_FLOOR_NODEPORTS: '0' }).nodePorts, 0);
  assert.equal(resolveLimit('databaseReplicas', { MAX_DATABASE_REPLICAS: '0' }), 5);
});

test('stored values that make no sense are refused and ignored', () => {
  assert.equal(
    storedLimitError('publicPortsPerOrg', '0'),
    'publicPortsPerOrg must be a whole number, 1 or more, or off'
  );
  assert.equal(
    storedLimitError('databaseReplicas', 'off'),
    'databaseReplicas must be a whole number, 1 or more'
  );
  assert.equal(storedLimitError('namespaceNodePorts', '0'), null);
  assert.equal(storedLimitError('publicPortsPerOrg', '1.5') !== null, true);
  assert.equal(storedLimitError('publicPortsPerOrg', ''), null);
  setInstanceLimitOverrides({ publicPortsPerOrg: 'lots', databaseReplicas: 'off' });
  assert.equal(maxPublicPortsPerOrg({}), 20);
  assert.equal(resolveLimit('databaseReplicas', {}), 5);
  assert.throws(() => LIMITS.validate!({ publicPortsPerOrg: '-1' }), /publicPortsPerOrg/);
  assert.throws(() => LIMITS.validate!({ nodePortExposure: 'maybe' }), /nodePortExposure/);
  assert.doesNotThrow(() =>
    LIMITS.validate!({ publicPortsPerOrg: 'off', nodePortExposure: 'false' })
  );
});
