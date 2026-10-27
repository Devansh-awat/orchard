import test from 'node:test';
import assert from 'node:assert/strict';
import {
	SEALED_PLACEHOLDER,
	autoSecretForKey,
	envVarsToSealedRaw,
	looksSecretKey,
	rawToEnvVarsKeepingSecrets,
	toEnvWrite
} from './env-secrets';

const previous = [
	{ key: 'DATABASE_URL', value: '', secret: true, sealed: true },
	{ key: 'PORT', value: '3000', secret: false }
];

test('raw mode never prints a secret value', () => {
	const raw = envVarsToSealedRaw([
		...previous,
		{ key: 'NEW_SECRET', value: 'typed-but-hidden', secret: true }
	]);
	assert.equal(
		raw,
		`DATABASE_URL=${SEALED_PLACEHOLDER}\nPORT=3000\nNEW_SECRET=${SEALED_PLACEHOLDER}`
	);
});

test('an untouched sealed line keeps the stored value and stays secret', () => {
	const out = rawToEnvVarsKeepingSecrets(`DATABASE_URL=${SEALED_PLACEHOLDER}\nPORT=3000`, previous);
	assert.deepEqual(out[0], { key: 'DATABASE_URL', value: '', secret: true, sealed: true });
	assert.deepEqual(out[1], { key: 'PORT', value: '3000', secret: false });
});

test('an edited sealed line replaces the value but stays secret', () => {
	const out = rawToEnvVarsKeepingSecrets('DATABASE_URL=postgres://new', previous);
	assert.deepEqual(out, [
		{ key: 'DATABASE_URL', value: 'postgres://new', secret: true, sealed: true }
	]);
});

test('a typed secret survives a round trip through raw mode', () => {
	const rows = [{ key: 'NEW_SECRET', value: 'typed', secret: true }];
	const out = rawToEnvVarsKeepingSecrets(envVarsToSealedRaw(rows), rows);
	assert.deepEqual(out, [{ key: 'NEW_SECRET', value: 'typed', secret: true }]);
});

test('new credential-looking keys come in locked', () => {
	const out = rawToEnvVarsKeepingSecrets('STRIPE_SECRET_KEY=sk\nAPI_URL=x', []);
	assert.equal(out[0].secret, true);
	assert.equal(out[1].secret, false);
});

test('the pre-toggle respects an explicit choice and sealed rows', () => {
	assert.equal(autoSecretForKey({ key: 'GITHUB_TOKEN', value: '' }).secret, true);
	assert.equal(
		autoSecretForKey({ key: 'GITHUB_TOKEN', value: '', secret: false, secretTouched: true }).secret,
		false
	);
	assert.equal(looksSecretKey('NEXT_PUBLIC_MAPBOX_TOKEN'), false);
});

test('writes send null for an untouched sealed value', () => {
	assert.deepEqual(toEnvWrite([...previous, { key: ' ', value: '' }]), [
		{ key: 'DATABASE_URL', value: null, secret: true },
		{ key: 'PORT', value: '3000', secret: false }
	]);
});
