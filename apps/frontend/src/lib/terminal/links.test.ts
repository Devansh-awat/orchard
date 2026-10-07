import test from 'node:test';
import assert from 'node:assert/strict';
import { urlAt } from './links';

const line = '  ➜  Local:   http://localhost:5173/, (ready).';

test('a click inside a url opens exactly that url without trailing punctuation', () => {
	assert.equal(urlAt(line, line.indexOf('localhost')), 'http://localhost:5173/');
	assert.equal(urlAt(line, line.indexOf('http')), 'http://localhost:5173/');
});

test('a click on plain text opens nothing', () => {
	assert.equal(urlAt(line, line.indexOf('Local')), null);
	assert.equal(urlAt(line, line.indexOf('ready')), null);
});

test('the url under the pointer wins when a row has several', () => {
	const row = 'see https://a.example/x and https://b.example/y';
	assert.equal(urlAt(row, row.indexOf('b.example')), 'https://b.example/y');
});
