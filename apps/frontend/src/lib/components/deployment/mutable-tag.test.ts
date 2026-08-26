import test from 'node:test';
import assert from 'node:assert/strict';
import { isMutableTag, imageTag } from './deployment-helpers';

test('registry hosts are not mistaken for tags', () => {
	assert.equal(imageTag('ghcr.io/org/app:v1.2.3'), 'v1.2.3');
	assert.equal(imageTag('localhost:5000/app:dev'), 'dev');
	// A port on the registry host with no tag on the image must not read as a tag.
	assert.equal(imageTag('localhost:5000/app'), null);
	assert.equal(imageTag('registry.example.com:5000/team/app'), null);
});

test('a moving tag is flagged', () => {
	for (const image of [
		'nginx:latest',
		'ghcr.io/org/app:main',
		'org/app:stable',
		'app:edge',
		'app:NIGHTLY',
		'ghcr.io/org/app:production'
	]) {
		assert.equal(isMutableTag(image), true, image);
	}
});

test('an untagged image is a moving tag, because it resolves to latest', () => {
	assert.equal(isMutableTag('nginx'), true);
	assert.equal(isMutableTag('ghcr.io/org/app'), true);
	assert.equal(isMutableTag('localhost:5000/app'), true);
});

test('a floating version is a moving tag', () => {
	assert.equal(isMutableTag('postgres:17'), true);
	assert.equal(isMutableTag('node:22.1'), true);
	assert.equal(isMutableTag('app:v3'), true);
});

test('a pinned tag or digest is not', () => {
	for (const image of [
		'postgres:17.2.1',
		'ghcr.io/org/app:v1.2.3',
		'app:2026-08-26',
		'app:sha-abc1234',
		'nginx@sha256:0000000000000000000000000000000000000000000000000000000000000000',
		'nginx:latest@sha256:0000000000000000000000000000000000000000000000000000000000000000'
	]) {
		assert.equal(isMutableTag(image), false, image);
	}
});

test('empty input is not flagged, so the create form stays quiet until you type', () => {
	assert.equal(isMutableTag(''), false);
	assert.equal(isMutableTag('   '), false);
	assert.equal(isMutableTag(null), false);
	assert.equal(isMutableTag(undefined), false);
});
