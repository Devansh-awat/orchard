import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_COMMANDS } from '../../sandbox/chat/slash-commands';
import { commandItems, shortcutGroups } from './shortcut-groups';

test('the shortcuts page lists every built in command with its aliases', () => {
	const items = commandItems();
	assert.equal(items.length, LOCAL_COMMANDS.length);
	assert.deepEqual(
		items.find((i) => i.keys[0] === '/undo'),
		{ keys: ['/undo'], label: 'Roll back the last prompt and its changes, also /rewind' }
	);
	const groups = shortcutGroups(true, 'enter', 'queue');
	assert.equal(groups.at(-1)?.title, 'Commands');
	const labels = groups.flatMap((g) => g.items.map((i) => `${g.title}:${i.label}`));
	assert.equal(new Set(labels).size, labels.length);
});
