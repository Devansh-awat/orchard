import test from 'node:test';
import assert from 'node:assert/strict';
import { routeKey, type KeyHandlerDeps } from './keys';

function key(code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		code,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...mods
	} as KeyboardEvent;
}

function deps() {
	const calls: string[] = [];
	const d: KeyHandlerDeps = {
		onClear: () => calls.push('clear'),
		onZoom: (step) => calls.push(`zoom:${step}`)
	};
	return { calls, d };
}

test('cmd+k clears through the shell', () => {
	const { calls, d } = deps();
	assert.equal(routeKey(key('KeyK', { metaKey: true }), d), 'handled');
	assert.deepEqual(calls, ['clear']);
});

test('ctrl+k still reaches the shell as a readline kill', () => {
	const { calls, d } = deps();
	assert.equal(routeKey(key('KeyK', { ctrlKey: true }), d), 'pass');
	assert.deepEqual(calls, []);
});

test('ctrl+shift+v is left to the browser so it pastes', () => {
	const { d } = deps();
	assert.equal(routeKey(key('KeyV', { ctrlKey: true, shiftKey: true }), d), 'native');
});

test('zoom chords step the font and reset it', () => {
	const { calls, d } = deps();
	routeKey(key('Equal', { metaKey: true }), d);
	routeKey(key('Minus', { ctrlKey: true }), d);
	routeKey(key('Digit0', { metaKey: true }), d);
	assert.deepEqual(calls, ['zoom:1', 'zoom:-1', 'zoom:0']);
});

test('plain typing passes straight through', () => {
	const { calls, d } = deps();
	assert.equal(routeKey(key('KeyA'), d), 'pass');
	assert.equal(routeKey(key('Equal'), d), 'pass');
	assert.deepEqual(calls, []);
});

test('option acts as meta on mac so readline word motions work', () => {
	const sent: string[] = [];
	const d: KeyHandlerDeps = {
		onClear: () => {},
		onZoom: () => {},
		onInput: (data) => sent.push(data),
		optionIsMeta: () => true
	};
	assert.equal(routeKey(key('KeyB', { altKey: true }), d), 'handled');
	assert.equal(routeKey(key('Period', { altKey: true }), d), 'handled');
	assert.equal(routeKey(key('KeyF', { altKey: true, shiftKey: true }), d), 'handled');
	assert.deepEqual(sent, ['\x1bb', '\x1b.', '\x1bF']);
});

test('option is left alone when meta mode is off, so layouts can type with it', () => {
	const sent: string[] = [];
	const d: KeyHandlerDeps = {
		onClear: () => {},
		onZoom: () => {},
		onInput: (data) => sent.push(data),
		optionIsMeta: () => false
	};
	assert.equal(routeKey(key('KeyL', { altKey: true }), d), 'pass');
	assert.deepEqual(sent, []);
});
