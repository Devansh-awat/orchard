import test from 'node:test';
import assert from 'node:assert/strict';
import { noteReleased } from './version';

test('a note shows only once the running UI has reached its version', () => {
	assert.equal(noteReleased('3.0.0', '3.0.0'), true);
	assert.equal(noteReleased('2.4.1', '3.0.0'), true);
	assert.equal(noteReleased('3.1.0', '3.0.9'), false);
	assert.equal(noteReleased('3.0.10', '3.0.9'), false);
	assert.equal(noteReleased('10.0.0', '9.9.9'), false);
});

test('an unknown running version keeps notes, a malformed note never shows', () => {
	assert.equal(noteReleased('3.0.0', ''), true);
	assert.equal(noteReleased('next', '3.0.0'), false);
});
