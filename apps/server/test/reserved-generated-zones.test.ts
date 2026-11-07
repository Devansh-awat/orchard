import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReservedSubdomainLabel } from '../src/instance-network/reserved-hosts';

test('generated app host shapes are reserved when the base domain is the app domain', () => {
  const env = { APP_DOMAIN: 'apps.example.com' } as NodeJS.ProcessEnv;
  assert.equal(isReservedSubdomainLabel('shop-myproj-a1b2c3', 'apps.example.com', env), true);
  assert.equal(isReservedSubdomainLabel('shop', 'apps.example.com', env), false);
  assert.equal(isReservedSubdomainLabel('shop-myproj-a1b2c3', 'other.example.com', env), false);
});

test('explicit wildcard domains reserve generated app host shapes', () => {
  const env = { PLATFORM_WILDCARD_DOMAINS: '.apps.example.com=wild-tls' } as NodeJS.ProcessEnv;
  assert.equal(isReservedSubdomainLabel('x-p-00ff00', 'apps.example.com', env), true);
});

test('the public database and preview zones reserve every label', () => {
  const env = {
    PUBLIC_DB_DOMAIN: 'db.example.com',
    SANDBOX_PREVIEW_DOMAIN: 'preview.example.com'
  } as NodeJS.ProcessEnv;
  assert.equal(isReservedSubdomainLabel('pg-acme', 'db.example.com', env), true);
  assert.equal(isReservedSubdomainLabel('anything', 'preview.example.com', env), true);
  assert.equal(isReservedSubdomainLabel('anything', 'example.com', env), false);
});
