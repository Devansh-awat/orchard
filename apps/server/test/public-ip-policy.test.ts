import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  canonicalIp,
  foreignHolders,
  servicesToAlign,
  sharedIpAnnotations
} from '../src/kubernetes/public-ip-policy';
import { PublicIpPolicyService } from '../src/kubernetes/public-ip-policy.service';

function lb(namespace: string, name: string, ip: string, annotations: Record<string, string> = {}) {
  return {
    metadata: { namespace, name, annotations },
    spec: { type: 'LoadBalancer', loadBalancerIP: ip }
  } as any;
}

test('canonicalIp accepts only real addresses', () => {
  assert.equal(canonicalIp(' 203.0.113.7 '), '203.0.113.7');
  assert.equal(canonicalIp('2001:DB8:0:0::1'), '2001:db8::1');
  assert.equal(canonicalIp('999.1.1.1'), null);
  assert.equal(canonicalIp('1.2.3'), null);
  assert.equal(canonicalIp(':::'), null);
  assert.equal(canonicalIp('abc'), null);
  assert.equal(canonicalIp(null), null);
});

test('sharing annotations list namespaces or allow everyone', () => {
  assert.deepEqual(sharedIpAnnotations('203.0.113.7', ['a', 'b']), {
    'lbipam.cilium.io/sharing-key': 'shared-203-0-113-7',
    'lbipam.cilium.io/sharing-cross-namespace': 'a,b'
  });
  assert.equal(
    sharedIpAnnotations('203.0.113.7', '*')['lbipam.cilium.io/sharing-cross-namespace'],
    '*'
  );
});

test('foreignHolders finds load balancers on the IP outside the org', () => {
  const services = [
    lb('mine', 'db-public', '203.0.113.7'),
    lb('theirs', 'web-pub-t30001', '203.0.113.7'),
    lb('elsewhere', 'other', '198.51.100.1'),
    {
      metadata: {
        namespace: 'pending',
        name: 'requested',
        annotations: { 'lbipam.cilium.io/ips': '203.0.113.7' }
      },
      spec: { type: 'LoadBalancer' }
    },
    {
      metadata: { namespace: 'status', name: 'assigned' },
      spec: { type: 'LoadBalancer' },
      status: { loadBalancer: { ingress: [{ ip: '203.0.113.7' }] } }
    },
    {
      metadata: { namespace: 'cip', name: 'x' },
      spec: { type: 'ClusterIP', loadBalancerIP: '203.0.113.7' }
    }
  ] as any[];
  assert.deepEqual(foreignHolders(services, '203.0.113.7', new Set(['mine'])), [
    'theirs/web-pub-t30001',
    'pending/requested',
    'status/assigned'
  ]);
});

test('servicesToAlign updates only stale siblings on the same IP', () => {
  const key = { 'lbipam.cilium.io/sharing-key': 'shared-203-0-113-7' };
  const services = [
    lb('a', 'stale', '203.0.113.7', { ...key, 'lbipam.cilium.io/sharing-cross-namespace': 'a' }),
    lb('b', 'fresh', '203.0.113.7', { ...key, 'lbipam.cilium.io/sharing-cross-namespace': 'a,b' }),
    lb('other', 'foreign', '203.0.113.7', {
      ...key,
      'lbipam.cilium.io/sharing-cross-namespace': '*'
    }),
    lb('a', 'different-ip', '198.51.100.1', {
      'lbipam.cilium.io/sharing-key': 'shared-198-51-100-1',
      'lbipam.cilium.io/sharing-cross-namespace': 'a'
    })
  ];
  assert.deepEqual(
    servicesToAlign(services, '203.0.113.7', ['a', 'b']).map((s) => s.metadata.name),
    ['stale']
  );
  assert.deepEqual(
    servicesToAlign(services, '203.0.113.7', '*').map((s) => s.metadata.name),
    ['stale', 'fresh']
  );
});

function policy(opts: {
  sharing?: boolean;
  defaultIp?: string;
  otherOrgIps?: string[];
  services?: any[] | Error;
}) {
  const prisma = {
    organization: {
      findMany: async () =>
        (opts.otherOrgIps ?? []).map((databasePublicIp) => ({ databasePublicIp }))
    },
    project: {
      findMany: async ({ where }: any) =>
        where.organizationId === 'org-a'
          ? [
              {
                namespace: 'a-app',
                environments: [{ namespace: 'a-app' }, { namespace: 'a-app-staging' }]
              }
            ]
          : [],
      findFirst: async () => null
    },
    environment: {
      findUnique: async ({ where }: any) =>
        where.namespace.startsWith('a-') ? { project: { organizationId: 'org-a' } } : null
    }
  };
  const kubernetes = {
    getCoreV1Api: () => ({
      listServiceForAllNamespaces: async () => {
        if (opts.services instanceof Error) throw opts.services;
        return { body: { items: opts.services ?? [] } };
      }
    })
  };
  const instanceConfig = { defaultPublicIp: () => opts.defaultIp ?? '' };
  const settings = { isPublicIpSharingAllowed: async () => Boolean(opts.sharing) };
  return new PublicIpPolicyService(
    prisma as any,
    kubernetes as any,
    instanceConfig as any,
    settings as any
  );
}

test('an org may not take an IP another org already set', async () => {
  await assert.rejects(
    policy({ otherOrgIps: ['203.0.113.7'] }).assertOrgMayUse('org-a', '203.0.113.7'),
    ConflictException
  );
  await assert.rejects(
    policy({ otherOrgIps: ['2001:DB8::1'] }).assertOrgMayUse('org-a', '2001:db8::1'),
    ConflictException
  );
});

test('an org may not take an IP a foreign load balancer holds', async () => {
  await assert.rejects(
    policy({ services: [lb('b-app', 'x', '203.0.113.7')] }).assertOrgMayUse('org-a', '203.0.113.7'),
    ConflictException
  );
  await policy({ services: [lb('a-app-staging', 'x', '203.0.113.7')] }).assertOrgMayUse(
    'org-a',
    '203.0.113.7'
  );
});

test('a failed Kubernetes read is not treated as a free IP', async () => {
  await assert.rejects(
    policy({ services: new Error('connection refused') }).assertOrgMayUse('org-a', '203.0.113.7'),
    ServiceUnavailableException
  );
});

test('sharing on, or the instance default IP, skips the conflict checks', async () => {
  const taken = { otherOrgIps: ['203.0.113.7'], services: [lb('b-app', 'x', '203.0.113.7')] };
  await policy({ ...taken, sharing: true }).assertOrgMayUse('org-a', '203.0.113.7');
  await policy({ ...taken, defaultIp: '203.0.113.7' }).assertOrgMayUse('org-a', '203.0.113.7');
});

test('cross-namespace sharing is scoped to the org unless sharing is allowed', async () => {
  assert.deepEqual(await policy({}).shareWith('a-app', '203.0.113.7'), ['a-app', 'a-app-staging']);
  assert.deepEqual(await policy({}).shareWith('stray', '203.0.113.7'), ['stray']);
  assert.equal(await policy({ sharing: true }).shareWith('a-app', '203.0.113.7'), '*');
  assert.equal(await policy({ defaultIp: '203.0.113.7' }).shareWith('a-app', '203.0.113.7'), '*');
});
