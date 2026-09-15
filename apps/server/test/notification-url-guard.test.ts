import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress } from '../src/notifications/webhook-guard';

const PUBLIC = [
  '8.8.8.8',
  '1.1.1.1',
  '9.9.9.9',
  '11.0.0.1',
  '100.128.0.1',
  '162.159.128.233',
  '172.32.0.1',
  '198.20.0.1',
  '2600::1',
  '2606:4700::1111',
  '::ffff:8.8.8.8',
  '64:ff9b::808:808'
];

const BLOCKED = [
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '100.127.255.255',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.7',
  '224.0.0.1',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  'fe80::1',
  'febf::1',
  'fc00::1',
  'fd12:3456::1',
  'fec0::1',
  'ff02::1',
  '2001:db8::1',
  '2001:0:abcd::1',
  '2002:808:808::1',
  '64:ff9b::a00:1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  'not-an-ip',
  'example.com'
];

test('public addresses pass', () => {
  for (const ip of PUBLIC) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be public`);
  }
});

test('private, reserved, and malformed addresses are blocked', () => {
  for (const ip of BLOCKED) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});
