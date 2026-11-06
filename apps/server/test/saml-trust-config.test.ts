import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { SsoLoginService } from '../src/sso/sso-login.service';
import { SsoService } from '../src/sso/sso.service';
import { SAML_TEST_KEYS as KEYS } from './saml-test-keys';

const svc = () => Object.create(SsoService.prototype) as any;
const body = (cert: string) => cert.replace(/-----[A-Z ]+-----|\s+/g, '');

test('certificates are validated and several can be pinned for rotation', () => {
  const s = svc();
  const a = body(KEYS.idp.cert);
  const b = body(KEYS.other.cert);
  assert.equal(s.normalizeCertificate(KEYS.idp.cert), a);
  assert.equal(s.normalizeCertificate(`${KEYS.idp.cert}\n${KEYS.other.cert}`), `${a},${b}`);
  assert.equal(s.normalizeCertificate(`${a},${b},${a}`), `${a},${b}`);
  assert.throws(() => s.normalizeCertificate('not a certificate'), BadRequestException);
  assert.throws(() => s.normalizeCertificate('AAAA'), BadRequestException);
  assert.throws(() => s.normalizeCertificate(''), BadRequestException);
  const many = Array.from({ length: 5 }, (_, i) => `${a}${'A'.repeat(i)}`).join(',');
  assert.throws(() => s.normalizeCertificate(many), BadRequestException);
});

test('weak RSA certificate keys are refused', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const weak = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => svc().normalizeCertificate(weak), BadRequestException);
});

test('IdP metadata ignores commented-out certificates and refuses federations and DTDs', () => {
  const s = svc();
  const entity = (inner: string) =>
    `<EntityDescriptor entityID="https://idp.example/m"><IDPSSODescriptor>${inner}
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/sso"/>
    </IDPSSODescriptor></EntityDescriptor>`;
  const key = (use: string, cert: string) =>
    `<KeyDescriptor use="${use}"><KeyInfo><X509Data><X509Certificate>${cert}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`;

  const commented = entity(`<!-- ${key('signing', 'OLDCERT')} -->${key('signing', 'NEWCERT')}`);
  assert.equal(s.parseIdpMetadata(commented).certificate, 'NEWCERT');

  const rotating = entity(`${key('signing', 'ONE')}${key('signing', 'TWO')}${key('encryption', 'ENC')}`);
  assert.equal(s.parseIdpMetadata(rotating).certificate, 'ONE,TWO');

  const both = `<EntitiesDescriptor>${entity(key('signing', 'ONE'))}${entity(key('signing', 'TWO'))}</EntitiesDescriptor>`;
  assert.throws(() => s.parseIdpMetadata(both), BadRequestException);

  const dtd = `<!DOCTYPE x [<!ENTITY e "v">]>${entity(key('signing', 'ONE'))}`;
  assert.throws(() => s.parseIdpMetadata(dtd), BadRequestException);

  const spoof = `<Other entityID="https://evil.example/x"/>${entity(key('signing', 'ONE'))}`;
  assert.equal(s.parseIdpMetadata(spoof).entityId, 'https://idp.example/m');
});

test('return-to survives only as a same-origin path, including after browser URL normalisation', () => {
  const login = Object.create(SsoLoginService.prototype) as any;
  login.frontendUrl = 'https://app.example';
  const safe = (v?: string) => login.safeReturnTo(v);
  assert.equal(safe('/projects/1?tab=a'), 'https://app.example/projects/1?tab=a');
  for (const bad of [
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/ /evil.example',
    'https://evil.example',
    '/a\\b',
    `/${'a'.repeat(600)}`
  ]) {
    assert.equal(safe(bad), 'https://app.example/oauth/callback', JSON.stringify(bad));
  }
  assert.equal(safe(undefined), 'https://app.example/oauth/callback');
});
