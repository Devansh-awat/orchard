import assert from 'node:assert/strict';
import test from 'node:test';
import { ScimTokensController } from '../src/scim/scim-tokens.controller';

const hostile = {
  protocol: 'http',
  headers: { 'x-forwarded-proto': 'https://evil.example/x?' },
  get: () => 'evil.example'
} as any;

function baseUrl(env: { SCIM_BASE_URL?: string; FRONTEND_URL?: string }) {
  const saved = { s: process.env.SCIM_BASE_URL, f: process.env.FRONTEND_URL };
  const apply = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  apply('SCIM_BASE_URL', env.SCIM_BASE_URL);
  apply('FRONTEND_URL', env.FRONTEND_URL);
  try {
    const c = new ScimTokensController({} as any, {} as any) as any;
    return c.scimBaseUrl(hostile, 'org') as string;
  } finally {
    apply('SCIM_BASE_URL', saved.s);
    apply('FRONTEND_URL', saved.f);
  }
}

test('SCIM_BASE_URL wins and ignores request headers', () => {
  assert.equal(
    baseUrl({ SCIM_BASE_URL: 'https://scim.example.com/apiv1/scim/v2/' }),
    'https://scim.example.com/apiv1/scim/v2'
  );
});

test('falls back to FRONTEND_URL, never Host or forwarded headers', () => {
  const url = baseUrl({ FRONTEND_URL: 'https://orchard.example.com/' });
  assert.equal(url, 'https://orchard.example.com/apiv1/scim/v2');
  assert.ok(!url.includes('evil'));
});

test('without any config it does not echo the request Host', () => {
  assert.ok(!baseUrl({}).includes('evil'));
});
