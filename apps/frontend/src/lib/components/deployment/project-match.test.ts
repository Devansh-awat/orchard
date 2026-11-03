import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProjectByName } from './project-match';

const projects = [
	{ id: '1', name: "hi's Project", slug: 'hi-s-project' },
	{ id: '2', name: 'Other', slug: 'other' }
];

test('an existing project is found by name, whatever the case or padding', () => {
	assert.equal(findProjectByName(projects, "hi's Project")?.id, '1');
	assert.equal(findProjectByName(projects, "  HI'S project ")?.id, '1');
});

test('a new name matches nothing', () => {
	assert.equal(findProjectByName(projects, 'Fresh'), null);
	assert.equal(findProjectByName(projects, ''), null);
	assert.equal(findProjectByName(projects, null), null);
	assert.equal(findProjectByName([], 'Other'), null);
});
