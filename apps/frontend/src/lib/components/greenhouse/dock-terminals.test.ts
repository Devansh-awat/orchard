import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTerminalTabs, encodeTerminalTabs } from '../../terminal/tabs-store';
import { decodeDockTerminals, dockPaneId, encodeDockTerminals } from './dock-terminals';

const S1 = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';
const S2 = 'aaaaaaaa-1b0c-4d5e-8f90-123456789abc';
const USER = 'bbbbbbbb-1b0c-4d5e-8f90-123456789abc';

test('dock terminals and their session handles survive a reload', () => {
	const state = {
		terminals: new Map([
			[S1, ['1', '3']],
			[S2, ['1']]
		]),
		handles: new Map([
			[dockPaneId(S1, 'term:3'), 'v1.h3'],
			[dockPaneId(S1, 'setup'), 'v1.setup'],
			[dockPaneId(S1, `watch:${USER}`), 'v1.watch'],
			[dockPaneId(S2, 'term:1'), 'v1.s2']
		])
	};
	const raw = encodeTerminalTabs(encodeDockTerminals(state, S2));
	const back = decodeDockTerminals(decodeTerminalTabs(raw));
	assert.deepEqual(
		[...back.terminals],
		[
			[S2, ['1']],
			[S1, ['1', '3']]
		]
	);
	assert.equal(back.handles.get(dockPaneId(S1, 'term:3')), 'v1.h3');
	assert.equal(back.handles.get(dockPaneId(S1, 'setup')), 'v1.setup');
	assert.equal(back.handles.get(dockPaneId(S1, `watch:${USER}`)), 'v1.watch');
	assert.equal(back.handles.get(dockPaneId(S2, 'term:1')), 'v1.s2');
});

test('a closed terminal does not come back from a stale handle', () => {
	const state = {
		terminals: new Map([[S1, ['1']]]),
		handles: new Map([[dockPaneId(S1, 'term:2'), 'v1.gone']])
	};
	const back = decodeDockTerminals(encodeDockTerminals(state, S1));
	assert.deepEqual([...back.terminals], [[S1, ['1']]]);
	assert.equal(back.handles.size, 0);
});

test('junk panes from storage are dropped', () => {
	const back = decodeDockTerminals({
		tabs: [
			{ id: 'x', podName: S1, container: 'term:../../x', label: 'x' },
			{ id: 'y', podName: S1, container: 'term:2', label: 'y', sessionHandle: 'v1.ok' },
			{ id: 'z', podName: '', container: 'term:1', label: 'z' }
		],
		active: 'y',
		counter: 3
	});
	assert.deepEqual([...back.terminals], [[S1, ['2']]]);
	assert.deepEqual([...back.handles], [[dockPaneId(S1, 'term:2'), 'v1.ok']]);
	assert.equal(
		encodeTerminalTabs(encodeDockTerminals({ terminals: new Map(), handles: new Map() }, S1)),
		null
	);
});
