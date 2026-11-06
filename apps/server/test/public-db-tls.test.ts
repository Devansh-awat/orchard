import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  caBundleForIssuedSecret,
  clusterUsesPublicDbTls,
  publicDbCertificate,
  publicDbClusterCertificates,
  publicDbTlsNames
} from '../src/kubernetes/public-db-tls';
import { pemCertificates } from '../src/kubernetes/tls-secret-sync';

test('per-database certificate covers only the requested hostnames', () => {
  const cert = publicDbCertificate({
    namespace: 'ns',
    clusterName: 'pg-a',
    hostnames: ['ns-pg-a.db.example.com'],
    issuer: { name: 'le', kind: 'ClusterIssuer' }
  });
  assert.deepEqual(cert.spec.dnsNames, ['ns-pg-a.db.example.com']);
  assert.ok(!JSON.stringify(cert).includes('*.'));
  assert.equal(cert.spec.secretName, publicDbTlsNames('pg-a').secret);
});

test('secret names cannot collide with slug-derived names', () => {
  const n = publicDbTlsNames('pg-a');
  assert.ok(n.secret.includes('--') && n.ca.includes('--'));
});

test('cluster wiring detection', () => {
  const certs = publicDbClusterCertificates('pg-a');
  assert.equal(clusterUsesPublicDbTls({ spec: { certificates: certs as never } }, 'pg-a'), true);
  assert.equal(
    clusterUsesPublicDbTls(
      {
        spec: {
          certificates: { serverTLSSecret: 'wildcard-db-tls', serverCASecret: 'wildcard-db-tls' }
        }
      },
      'pg-a'
    ),
    false
  );
});

test('ca bundle comes from the issued chain when ca.crt is empty', () => {
  const pem = readFileSync(
    new URL('./fixtures/letsencrypt-ye-intermediates.pem', import.meta.url),
    'utf8'
  );
  const certs = pemCertificates(pem);
  const tls = Buffer.from(`${certs[0]}\n${certs[1]}\n`).toString('base64');
  const out = caBundleForIssuedSecret({ 'tls.crt': tls });
  assert.ok(out);
  assert.ok(pemCertificates(Buffer.from(out!, 'base64').toString()).length >= 1);
  assert.equal(caBundleForIssuedSecret({ 'ca.crt': 'abc' }), 'abc');
  assert.equal(caBundleForIssuedSecret({}), null);
});
