import test from 'node:test';
import assert from 'node:assert/strict';
import { isDatabaseImage } from './presets';

test('database images are spotted the way the server spots them', () => {
	for (const image of [
		'postgres',
		'postgres:17',
		'ghcr.io/postgres:17',
		'localhost:5000/postgres:17',
		'postgres:17@sha256:abc',
		'pgvector/pgvector:pg17'
	]) {
		assert.equal(isDatabaseImage(image), true, image);
	}
	for (const image of [
		'',
		null,
		undefined,
		'nginx:latest',
		'acme/postgres:17',
		'ghcr.io/a/redis'
	]) {
		assert.equal(isDatabaseImage(image), false, String(image));
	}
});
