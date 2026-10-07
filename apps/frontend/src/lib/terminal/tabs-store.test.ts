import test from 'node:test';
import assert from 'node:assert/strict';
import {
	decodeTerminalTabs,
	encodeTerminalTabs,
	loadTerminalTabs,
	saveTerminalTabs,
	terminalTabsKey
} from './tabs-store';

class MemoryStorage {
	map = new Map<string, string>();
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}

test('tabs round-trip through storage with their session handles', () => {
	const storage = new MemoryStorage();
	const key = terminalTabsKey('deployment', 'd1');
	saveTerminalTabs(
		key,
		{
			tabs: [
				{ id: 'a', podName: 'web-1', container: 'web', label: 'Shell 1', sessionHandle: 'v1.x' },
				{ id: 'b', podName: 'web-1', container: 'web', label: 'Shell 2', title: 'vim' }
			],
			active: 'b',
			counter: 2
		},
		storage
	);
	assert.deepEqual(loadTerminalTabs(key, storage), {
		tabs: [
			{ id: 'a', podName: 'web-1', container: 'web', label: 'Shell 1', sessionHandle: 'v1.x' },
			{ id: 'b', podName: 'web-1', container: 'web', label: 'Shell 2', title: 'vim' }
		],
		active: 'b',
		counter: 2
	});
});

test('closing the last tab removes the entry instead of storing an empty list', () => {
	const storage = new MemoryStorage();
	const key = terminalTabsKey('database', 'db1');
	storage.setItem(key, 'stale');
	saveTerminalTabs(key, { tabs: [], active: 'logs', counter: 3 }, storage);
	assert.equal(storage.getItem(key), null);
	assert.equal(encodeTerminalTabs({ tabs: [], active: 'logs', counter: 0 }), null);
});

test('garbage and half-valid entries are rejected or repaired', () => {
	assert.equal(decodeTerminalTabs(null), null);
	assert.equal(decodeTerminalTabs('{not json'), null);
	assert.equal(decodeTerminalTabs('{"tabs":[{"id":""}]}'), null);
	const repaired = decodeTerminalTabs(
		JSON.stringify({
			tabs: [{ id: 'a', podName: 'p', container: 'c', label: 'Shell 1' }, { nope: true }],
			active: 'missing',
			counter: 'x'
		})
	);
	assert.deepEqual(repaired, {
		tabs: [{ id: 'a', podName: 'p', container: 'c', label: 'Shell 1' }],
		active: 'a',
		counter: 1
	});
});
