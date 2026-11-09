import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SOURCE_URL, sourceUrl } from './source-url';

test('the source link defaults to the upstream repository', () => {
	assert.equal(sourceUrl(undefined), DEFAULT_SOURCE_URL);
	assert.equal(sourceUrl(''), DEFAULT_SOURCE_URL);
	assert.equal(sourceUrl('   '), DEFAULT_SOURCE_URL);
});

test('an operator can point the source link at a fork', () => {
	assert.equal(
		sourceUrl('https://git.example.com/me/orchard'),
		'https://git.example.com/me/orchard'
	);
	assert.equal(sourceUrl('  http://git.lan/orchard '), 'http://git.lan/orchard');
});

test('a value that is not a web address falls back to the default', () => {
	assert.equal(sourceUrl('javascript:alert(1)'), DEFAULT_SOURCE_URL);
	assert.equal(sourceUrl('not a url'), DEFAULT_SOURCE_URL);
});
