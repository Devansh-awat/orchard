import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, Logger } from '@nestjs/common';
import { SsoProtocol } from '@prisma/client';
import { SsoService } from '../src/sso/sso.service';

function build(metadata: any) {
  const updates: any[] = [];
  const s = Object.create(SsoService.prototype) as any;
  s.logger = new Logger('test');
  s.logger.error = () => undefined;
  s.logger.log = () => undefined;
  s.entityIdAttempts = new Map();
  s.crypto = { decryptOrNull: (v: string) => v };
  s.prisma = {
    identityProvider: {
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      }
    }
  };
  let fetches = 0;
  s.fetchIdpMetadata = async () => {
    fetches++;
    if (metadata instanceof Error) throw metadata;
    return metadata;
  };
  return { s, updates, fetches: () => fetches };
}

const base = {
  id: 'p1',
  name: 'Okta',
  protocol: SsoProtocol.saml,
  samlIdpEntityId: null,
  samlMetadataUrl: 'https://idp.example/metadata',
  samlCertificate: 'CERTA'
};

test('a legacy provider gets its entity ID from its stored metadata when the pinned cert is listed', async () => {
  const { s, updates } = build({ entityId: 'https://idp.example/m', certificate: 'CERTB,CERTA' });
  const out = await s.ensureIdpEntityId(base);
  assert.equal(out.samlIdpEntityId, 'https://idp.example/m');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, { id: 'p1', samlIdpEntityId: null });
});

test('metadata that does not list the pinned certificate is never adopted', async () => {
  const { s, updates } = build({ entityId: 'https://evil.example/m', certificate: 'OTHER' });
  await assert.rejects(s.ensureIdpEntityId(base), BadRequestException);
  assert.equal(updates.length, 0);
});

test('no metadata URL means a clear admin-facing error and no guess', async () => {
  const p = { ...base, samlMetadataUrl: null };
  const { s, updates, fetches } = build({ entityId: 'x', certificate: 'CERTA' });
  await assert.rejects(s.ensureIdpEntityId(p), /set the IdP entity ID/);
  assert.equal(updates.length, 0);
  assert.equal(fetches(), 0);
});

test('a metadata fetch failure is refused and not retried within a minute', async () => {
  const { s, fetches } = build(new Error('down'));
  await assert.rejects(s.ensureIdpEntityId(base), BadRequestException);
  await assert.rejects(s.ensureIdpEntityId(base), BadRequestException);
  assert.equal(fetches(), 1);
});

test('providers that already have an entity ID, and non-SAML providers, are untouched', async () => {
  const has = { ...base, samlIdpEntityId: 'https://idp.example/m' };
  const { s, fetches } = build({ entityId: 'other', certificate: 'CERTA' });
  assert.equal(await s.ensureIdpEntityId(has), has);
  const oidc = { ...base, protocol: SsoProtocol.oidc };
  assert.equal(await s.ensureIdpEntityId(oidc), oidc);
  assert.equal(fetches(), 0);
});
