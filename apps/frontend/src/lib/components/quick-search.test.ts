import assert from 'node:assert/strict';
import test from 'node:test';
import {
	actionsFor,
	frecencyScore,
	fuzzy,
	rankedResults,
	recentItems,
	recordUse,
	searchResults,
	type TreeItem
} from './quick-search';

const tree: TreeItem[] = [
	{
		id: 'p1',
		name: 'Horizons',
		type: 'project',
		href: '/ysws/projects/horizons',
		slug: 'horizons',
		children: [
			{
				id: 'd1',
				name: 'backend',
				type: 'deployment',
				href: '/ysws/deployments/d1',
				ingressHost: 'horizons.hackclub.com'
			},
			{ id: 'd2', name: 'backup-worker', type: 'deployment', href: '/ysws/deployments/d2' },
			{ id: 'db1', name: 'horizons-db', type: 'database', href: '/ysws/databases/db1' }
		]
	}
];

const NOW = Date.parse('2026-09-22T12:00:00Z');

test('every item opens, and only apps with a domain can be visited or copied', () => {
	const backend = actionsFor(tree[0].children![0]);
	assert.equal(backend[0].id, 'open');
	assert.ok(
		backend.some(
			(a) => a.id === 'restart' && a.method === 'POST' && a.path?.endsWith('/d1/restart')
		)
	);
	assert.ok(backend.some((a) => a.id === 'visit' && a.href === 'https://horizons.hackclub.com'));
	const worker = actionsFor(tree[0].children![1]);
	assert.equal(
		worker.some((a) => a.id === 'visit'),
		false
	);
	const db = actionsFor(tree[0].children![2]);
	assert.ok(db.some((a) => a.id === 'copy-connection' && a.copyField === 'connectionString'));
	const project = actionsFor(tree[0]);
	assert.equal(
		project.find((a) => a.id === 'new-app')?.href,
		'/ysws/deployments/new?project=horizons'
	);
});

test('frecency rewards repeated recent use and fades over a week', () => {
	const fresh = recordUse(recordUse({}, 'd1', NOW), 'd1', NOW);
	assert.equal(frecencyScore(fresh.d1, NOW), 90);
	const weekOld = { d1: { count: 2, last: NOW - 7 * 24 * 60 * 60 * 1000 } };
	assert.ok(Math.abs(frecencyScore(weekOld.d1, NOW) - 45) < 0.01);
	assert.equal(frecencyScore(undefined, NOW), 0);
	const heavy = { d1: { count: 50, last: NOW } };
	assert.equal(frecencyScore(heavy.d1, NOW), 160);
});

test('a thing you open often outranks an equally good match you never touch', () => {
	const plain = searchResults(tree, 'back');
	assert.deepEqual(
		plain.flat.map((h) => h.item.id),
		['d1', 'd2']
	);
	const frecency = recordUse(recordUse({}, 'd2', NOW), 'd2', NOW);
	const ranked = rankedResults(tree, 'back', frecency, NOW);
	assert.deepEqual(
		ranked.flat.map((h) => h.item.id),
		['d2', 'd1']
	);
});

test('the empty palette lists what you used most, dropping anything that no longer exists', () => {
	let frecency = recordUse({}, 'db1', NOW);
	frecency = recordUse(recordUse(recordUse(frecency, 'd1', NOW), 'd1', NOW), 'gone', NOW);
	assert.deepEqual(
		recentItems(tree, frecency, NOW).map((i) => i.id),
		['d1', 'db1']
	);
	assert.deepEqual(recentItems(tree, {}, NOW), []);
});

test('fuzzy still prefers prefixes over scattered letters', () => {
	assert.ok((fuzzy('backend', 'back')?.score ?? 0) > (fuzzy('backend', 'bkd')?.score ?? 0));
});
