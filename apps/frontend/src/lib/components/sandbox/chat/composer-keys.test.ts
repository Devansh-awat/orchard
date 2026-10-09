import test from 'node:test';
import assert from 'node:assert/strict';
import {
	alternateChord,
	followUpFor,
	sendChord,
	sendIntent,
	type ComposerKey
} from './composer-keys';

function enter(mods: Partial<ComposerKey> = {}): ComposerKey {
	return { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods };
}

test('enter mode sends on enter, keeps shift enter for a newline, and mod enter is the other follow up', () => {
	assert.equal(sendIntent(enter(), 'enter'), 'send');
	assert.equal(sendIntent(enter({ shiftKey: true }), 'enter'), null);
	assert.equal(sendIntent(enter({ metaKey: true }), 'enter'), 'alternate');
	assert.equal(sendIntent(enter({ ctrlKey: true }), 'enter'), 'alternate');
});

test('mod enter mode leaves plain enter as a newline', () => {
	assert.equal(sendIntent(enter(), 'mod-enter'), null);
	assert.equal(sendIntent(enter({ shiftKey: true }), 'mod-enter'), null);
	assert.equal(sendIntent(enter({ metaKey: true }), 'mod-enter'), 'send');
	assert.equal(sendIntent(enter({ ctrlKey: true }), 'mod-enter'), 'send');
	assert.equal(sendIntent(enter({ metaKey: true, shiftKey: true }), 'mod-enter'), 'alternate');
});

test('composition, alt and other keys never send', () => {
	assert.equal(sendIntent(enter({ isComposing: true }), 'enter'), null);
	assert.equal(sendIntent(enter({ altKey: true }), 'enter'), null);
	assert.equal(sendIntent({ ...enter(), key: 'a' }, 'enter'), null);
});

test('the alternate chord flips the preferred follow up', () => {
	assert.equal(followUpFor('send', 'queue'), 'queue');
	assert.equal(followUpFor('alternate', 'queue'), 'steer');
	assert.equal(followUpFor('send', 'steer'), 'steer');
	assert.equal(followUpFor('alternate', 'steer'), 'queue');
	assert.equal(sendChord('enter', '⌘'), '↵');
	assert.equal(sendChord('mod-enter', '⌘'), '⌘↵');
	assert.equal(alternateChord('enter', '⌘'), '⌘↵');
	assert.equal(alternateChord('mod-enter', 'Ctrl '), 'Ctrl ⇧↵');
});
