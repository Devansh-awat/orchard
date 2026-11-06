import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'protection-ambiguity-test-secret';

// oxlint-disable-next-line import/first
import { ProtectionService, pathIsAmbiguous } from '../src/auth/protection.service';
// oxlint-disable-next-line import/first
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

const AMBIGUOUS = [
  '/public/..;/private',
  '/public/.;/private',
  '/public;x=1/../private',
  '/public/%2e%2e/private',
  '/public/%2E%2e/private',
  '/public/.%2e/private',
  '/public/..%2fprivate',
  '/public%2f..%2fprivate',
  '/public%2Fprivate',
  '/public/%3b/private',
  '/public/..%3Bx/private',
  '/public//private',
  '/public//..//private',
  '/public/\\..\\private',
  '/public/..%5cprivate',
  '/public/%252e%252e/private',
  '/public/%252f',
  '/public/../private',
  '/public/./private',
  '/public/..',
  '/public/.',
  '/public/...',
  '/public/.. /private',
  '/public/%00',
  '/public/\u0000',
  '/public/%c0%ae%c0%ae/private',
  '/public/%u002e%u002e/private',
  '/public#/../private'
];

test('path parameters, encoded separators and dot segments are all ambiguous', () => {
  for (const path of AMBIGUOUS) {
    assert.equal(pathIsAmbiguous(path), true, path);
    assert.equal(pathIsAmbiguous(`${path}?q=1`), true, `${path} with a query`);
  }
});

test('ordinary paths stay unambiguous', () => {
  for (const path of [
    '/public/file.css',
    '/public/a.b.c',
    '/public/.well-known/x',
    '/public/caf%C3%A9',
    '/public/ok?next=/a;b/../c',
    '/public/ok?x=%2f%2e%2e',
    '/'
  ]) {
    assert.equal(pathIsAmbiguous(path), false, path);
  }
});

test('an ambiguous path never matches a bypass pattern end to end', async () => {
  const svc = Object.create(ProtectionService.prototype) as any;
  svc.jwtSecret = new TextEncoder().encode('x');
  svc.frontendUrl = 'https://orchard.test';
  svc.ingressCache = new Map();
  svc.negativeCache = new Map();
  svc.crypto = new SecretCryptoService();
  svc.prisma = {
    ingress: {
      findMany: async () => [
        {
          id: 'i1',
          projectId: 'p1',
          namespace: 'ns',
          protectionMode: 'orchard',
          protectionPasswordHash: null,
          protectionBypassSecret: null,
          protectionBypassPaths: ['/public'],
          host: 'h.test',
          project: { organizationId: 'o1', name: 'P' },
          service: { name: 'app', port: 3000 }
        }
      ]
    }
  };
  const ok = await svc.checkProtection('h.test', '/public/ok', undefined, undefined);
  assert.equal(ok.allow, true);
  for (const path of AMBIGUOUS.filter((p) => !p.includes('\u0000'))) {
    const decision = await svc.checkProtection('h.test', path, undefined, undefined);
    assert.equal(decision.allow, false, path);
  }
});
