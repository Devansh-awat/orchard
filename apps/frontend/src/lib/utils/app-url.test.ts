import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAppUrl } from './app-url';

test('standard ports stay out of the URL', () => {
	assert.equal(formatAppUrl('app.example.com'), 'https://app.example.com');
	assert.equal(
		formatAppUrl('app.example.com', '', true, { https: '443' }),
		'https://app.example.com'
	);
	assert.equal(
		formatAppUrl('app.example.com', '', false, { http: '80' }),
		'http://app.example.com'
	);
});

test('a custom port lands between the host and the path', () => {
	assert.equal(
		formatAppUrl('app.example.com', '/health', true, { https: '8443' }),
		'https://app.example.com:8443/health'
	);
	assert.equal(
		formatAppUrl('app.example.com', '', false, { http: '8080', https: '8443' }),
		'http://app.example.com:8080'
	);
});

test('a path already inside the host keeps its place', () => {
	assert.equal(
		formatAppUrl('app.example.com/api', '', true, { https: '8443' }),
		'https://app.example.com:8443/api'
	);
});

test('no host means no URL', () => {
	assert.equal(formatAppUrl(null), '');
	assert.equal(formatAppUrl(''), '');
	assert.equal(formatAppUrl(undefined, '/x'), '');
});
