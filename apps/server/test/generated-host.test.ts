import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generatedHostLabel,
  hostnameStyle,
  opaqueDatabaseLabel
} from '../src/projects/generated-host';
import { isReservedSubdomainLabel } from '../src/instance-network/reserved-hosts';

const input = {
  deploymentId: '0b0a0c1e-1111-4222-8333-444455556666',
  deploymentName: 'storefront',
  projectSlug: 'acme-secret-launch',
  attempt: 0
};
const env = { JWT_SECRET: 'test-secret', APP_DOMAIN: 'apps.example.com' } as NodeJS.ProcessEnv;

test('opaque is the default style', () => {
  assert.equal(hostnameStyle({} as NodeJS.ProcessEnv), 'opaque');
  assert.equal(hostnameStyle({ HOSTNAME_STYLE: 'readable' } as NodeJS.ProcessEnv), 'readable');
  assert.equal(hostnameStyle({ HOSTNAME_STYLE: 'bogus' } as NodeJS.ProcessEnv), 'opaque');
});

test('opaque labels reveal nothing about the app or project and are stable', () => {
  const label = generatedHostLabel(input, env);
  assert.match(label, /^[0-9a-f]{10}-[0-9a-f]{6}$/);
  assert.ok(!label.includes('storefront'));
  assert.ok(!label.includes('acme'));
  assert.equal(generatedHostLabel(input, env), label);
  assert.notEqual(generatedHostLabel({ ...input, attempt: 1 }, env), label);
  assert.notEqual(generatedHostLabel(input, { ...env, JWT_SECRET: 'other' }), label);
});

test('readable style keeps the legacy shape', () => {
  const label = generatedHostLabel(input, { ...env, HOSTNAME_STYLE: 'readable' });
  assert.match(label, /^storefront-acme-secre-[0-9a-f]{6}$/);
});

test('opaque labels are reserved against vanity claims in the app domain', () => {
  const label = generatedHostLabel(input, env);
  assert.equal(isReservedSubdomainLabel(label, 'apps.example.com', env), true);
});

test('database labels carry no namespace', () => {
  const label = opaqueDatabaseLabel('acme-shop-a1b2c3', 'main-db', env);
  assert.match(label, /^db-[0-9a-f]{20}$/);
  assert.ok(!label.includes('acme'));
  assert.notEqual(label, opaqueDatabaseLabel('acme-shop-a1b2c4', 'main-db', env));
});
