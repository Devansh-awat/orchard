import test from 'node:test';
import assert from 'node:assert/strict';
import { shellShortcut, type ShellKey } from './shortcuts';

function key(code: string, mods: Partial<Omit<ShellKey, 'code'>> = {}): ShellKey {
	return {
		code,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		defaultPrevented: false,
		...mods
	};
}

const anywhere = { terminal: false };
const terminal = { terminal: true };

test('cmd s is always claimed so the browser save dialog never opens', () => {
	assert.equal(shellShortcut(key('KeyS', { metaKey: true }), anywhere), 'save');
	assert.equal(shellShortcut(key('KeyS', { ctrlKey: true }), anywhere), 'save');
	assert.equal(shellShortcut(key('KeyS', { metaKey: true }), terminal), 'save');
	assert.equal(shellShortcut(key('KeyS', { metaKey: true, altKey: true }), anywhere), null);
});

test('keys a focused editor already handled never reach the shell', () => {
	for (const code of ['KeyS', 'KeyB', 'KeyJ', 'KeyN', 'KeyP']) {
		assert.equal(
			shellShortcut(key(code, { metaKey: true, defaultPrevented: true }), anywhere),
			null
		);
	}
});

test('panel shortcuts keep their bindings', () => {
	assert.equal(shellShortcut(key('KeyB', { metaKey: true }), anywhere), 'toggle-left');
	assert.equal(
		shellShortcut(key('KeyB', { metaKey: true, altKey: true }), anywhere),
		'toggle-right'
	);
	assert.equal(shellShortcut(key('KeyJ', { metaKey: true }), anywhere), 'toggle-dock');
	assert.equal(shellShortcut(key('KeyN', { metaKey: true }), anywhere), 'new-session');
	assert.equal(shellShortcut(key('Backquote', { ctrlKey: true }), anywhere), 'terminal');
	assert.equal(shellShortcut(key('KeyG', { metaKey: true, shiftKey: true }), anywhere), 'changes');
	assert.equal(shellShortcut(key('KeyP', { metaKey: true }), anywhere), 'find-file');
});

test('cmd k is left to the editor chord and the palette', () => {
	assert.equal(shellShortcut(key('KeyK', { metaKey: true }), anywhere), null);
});

test('ctrl chords inside a terminal belong to the shell program', () => {
	assert.equal(shellShortcut(key('KeyB', { ctrlKey: true }), terminal), null);
	assert.equal(shellShortcut(key('KeyN', { ctrlKey: true }), terminal), null);
	assert.equal(shellShortcut(key('KeyB', { metaKey: true }), terminal), 'toggle-left');
});

test('plain keys are never shortcuts', () => {
	assert.equal(shellShortcut(key('KeyS'), anywhere), null);
	assert.equal(shellShortcut(key('KeyB', { shiftKey: true }), anywhere), null);
});
