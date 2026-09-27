import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { completeChain, pemCertificates } from '../src/kubernetes/tls-secret-sync';
import { walSlotKeepSize } from '../src/kubernetes/db-tuning';

const intermediates = pemCertificates(
  readFileSync(new URL('./fixtures/letsencrypt-ye-intermediates.pem', import.meta.url), 'utf8')
);

test('the intermediates cert-manager hands us end in a cross-signed root, which no verifier accepts on its own', () => {
  assert.equal(intermediates.length, 3);
  const last = new X509Certificate(intermediates[2]);
  assert.notEqual(last.issuer, last.subject);
  assert.match(last.issuer, /ISRG Root X1/);
});

test('completing the chain appends the self-signed root from the bundled store, once', () => {
  const bundle = completeChain(intermediates);
  assert.equal(bundle.length, 4);
  const root = new X509Certificate(bundle[3]);
  assert.equal(root.issuer, root.subject);
  assert.match(root.subject, /ISRG Root X1/);
  assert.deepEqual(completeChain(bundle), bundle);
});

test('a chain whose root is unknown is left as it was', () => {
  assert.deepEqual(completeChain(intermediates, []), intermediates);
});

test('the WAL slot cap scales with the disk and stays inside a sane band', () => {
  assert.equal(walSlotKeepSize('10Gi'), '2GB');
  assert.equal(walSlotKeepSize('5Gi'), '1GB');
  assert.equal(walSlotKeepSize('1Gi'), '256MB');
  assert.equal(walSlotKeepSize('3Gi'), '614MB');
  assert.equal(walSlotKeepSize('100Gi'), '8GB');
  assert.equal(walSlotKeepSize(undefined), '256MB');
});
