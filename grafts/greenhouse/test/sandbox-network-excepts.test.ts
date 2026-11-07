import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nodeAndApiserverAddresses,
  publicIpv4Excepts
} from '../server/src/sandboxes/runners/cluster-excepts';

test('only public ipv4 node and apiserver addresses are excepted, sorted and unique', () => {
  const nodes = [
    {
      status: {
        addresses: [
          { type: 'InternalIP', address: '10.0.0.5' },
          { type: 'ExternalIP', address: '203.0.113.9' },
          { type: 'ExternalIP', address: '2001:db8::1' },
          { type: 'Hostname', address: 'node-a' }
        ]
      },
      spec: { podCIDRs: ['100.64.1.0/24', '198.18.0.0/24'] }
    },
    { status: { addresses: [{ type: 'ExternalIP', address: '203.0.113.7' }] } }
  ];
  const found = publicIpv4Excepts(
    nodeAndApiserverAddresses(nodes, ['203.0.113.7', '192.168.1.1'], '198.51.100.0/24, bogus')
  );
  assert.deepEqual(found, ['198.18.0.0/24', '198.51.100.0/24', '203.0.113.7/32', '203.0.113.9/32']);
});

test('a prefix that would swallow the internet is ignored', () => {
  assert.deepEqual(publicIpv4Excepts(['0.0.0.0/0', '128.0.0.0/1', '203.0.113.7']), [
    '203.0.113.7/32'
  ]);
});
