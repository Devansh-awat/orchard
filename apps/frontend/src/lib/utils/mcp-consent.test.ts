import test from 'node:test';
import assert from 'node:assert/strict';
import { consentDestination, consentScope, requestedConsentScope } from './mcp-consent';

test('exec is only granted when the box was ticked', () => {
	assert.equal(consentScope('exec', false), 'mcp:deploy');
	assert.equal(consentScope('exec', true), 'mcp:exec');
	assert.equal(consentScope('deploy', true), 'mcp:deploy');
	assert.equal(consentScope('read', true), 'mcp:read');
	assert.equal(consentScope(requestedConsentScope(null), false), 'mcp:deploy');
});

test('only a real loopback host reads as a local app', () => {
	assert.deepEqual(consentDestination('http://127.0.0.1:53127/cb'), {
		host: '127.0.0.1:53127',
		local: true
	});
	assert.deepEqual(consentDestination('http://localhost:8080/cb'), {
		host: 'localhost:8080',
		local: true
	});
	assert.deepEqual(consentDestination('http://[::1]:9/cb'), { host: '[::1]:9', local: true });
	assert.deepEqual(consentDestination('https://127.0.0.1.evil.example/cb'), {
		host: '127.0.0.1.evil.example',
		local: false
	});
	assert.deepEqual(consentDestination('https://localhost.evil.example/cb'), {
		host: 'localhost.evil.example',
		local: false
	});
});

test('a destination that cannot be named is refused', () => {
	assert.equal(consentDestination(''), null);
	assert.equal(consentDestination('not a url'), null);
	assert.equal(consentDestination('javascript:alert(1)'), null);
	assert.equal(consentDestination('myapp://cb'), null);
});
