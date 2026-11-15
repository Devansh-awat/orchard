import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IngressService } from '../src/projects/ingress.service';

const dns = require('dns') as typeof import('dns');

function service(cname: string) {
  const svc = Object.create(IngressService.prototype) as IngressService;
  (svc as any).instanceConfig = { value: () => cname };
  (svc as any).access = { domainProofStatus: async () => null };
  return svc;
}

const TUNNEL = '8a1b2c3d-0000-4000-8000-000000000001.cfargotunnel.com';

test('a proxied record into a tunnel passes, with a note about the route', async (t) => {
  t.mock.method(dns, 'resolve4', (_host: string, cb: any) => cb(null, ['104.16.0.1']));
  const result = await service(TUNNEL).validateIngressDns('shop.customer.dev', 'project-1');
  assert.equal(result.valid, true);
  assert.match(result.message, /Route the hostname to the tunnel/);
  assert.deepEqual(result.records, [{ type: 'CNAME', name: 'shop', value: TUNNEL }]);
});

test('a hostname with no public address into a tunnel fails', async (t) => {
  t.mock.method(dns, 'resolve4', (_host: string, cb: any) => cb(new Error('ENODATA')));
  const result = await service(TUNNEL).validateIngressDns('shop.customer.dev', 'project-1');
  assert.equal(result.valid, false);
});
