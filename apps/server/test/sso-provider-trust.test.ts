import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SsoService } from '../src/sso/sso.service';

function service() {
  const svc = Object.create(SsoService.prototype) as SsoService;
  (svc as any).crypto = {
    decryptOrNull: (v: string | null) => (v ? v.replace(/^enc:/, '') : null)
  };
  return svc;
}

const saml: any = {
  protocol: 'saml',
  samlEntryPoint: 'https://idp.example/sso',
  samlMetadataUrl: null,
  samlIdpEntityId: 'https://idp.example',
  samlCertificate: 'enc:CERT-A'
};

test('renaming a provider does not count as a trust change', () => {
  assert.equal(service().trustChanged(saml, { ...saml, name: 'Renamed' }), false);
});

test('resubmitting the same certificate is not a trust change', () => {
  assert.equal(service().trustChanged(saml, { ...saml, samlCertificate: 'enc:CERT-A' }), false);
});

test('swapping only the signing certificate is a trust change', () => {
  assert.equal(service().trustChanged(saml, { ...saml, samlCertificate: 'enc:CERT-EVIL' }), true);
});

test('repointing the entry point or entity id is a trust change', () => {
  assert.equal(service().trustChanged(saml, { ...saml, samlEntryPoint: 'https://evil/sso' }), true);
  assert.equal(service().trustChanged(saml, { ...saml, samlIdpEntityId: 'https://evil' }), true);
});

test('repointing an OIDC issuer or client is a trust change, rotating the secret is not', () => {
  const oidc: any = {
    protocol: 'oidc',
    issuerUrl: 'https://idp.example',
    clientId: 'abc',
    authorizationUrl: null,
    tokenUrl: null,
    userinfoUrl: null
  };
  assert.equal(service().trustChanged(oidc, { ...oidc, clientSecret: 'enc:new' }), false);
  assert.equal(service().trustChanged(oidc, { ...oidc, issuerUrl: 'https://evil' }), true);
  assert.equal(service().trustChanged(oidc, { ...oidc, clientId: 'evil' }), true);
});

test('SSO_ALLOW_INTERNAL_IDP never lets an organization provider reach internal addresses', async () => {
  const previous = process.env.SSO_ALLOW_INTERNAL_IDP;
  process.env.SSO_ALLOW_INTERNAL_IDP = 'true';
  try {
    const svc = service() as any;
    await svc.assertIdpUrl('http://10.0.0.5/realms/x', 'Issuer URL', null);
    await assert.rejects(
      svc.assertIdpUrl('http://10.0.0.5/realms/x', 'Issuer URL', 'org-1'),
      /internal address/
    );
    await assert.rejects(
      svc.fetchIdp('http://127.0.0.1:1/', {}, 'org-1'),
      (err: any) => !/ECONNREFUSED/.test(String(err?.cause?.code ?? err?.code ?? ''))
    );
  } finally {
    if (previous === undefined) delete process.env.SSO_ALLOW_INTERNAL_IDP;
    else process.env.SSO_ALLOW_INTERNAL_IDP = previous;
  }
});
