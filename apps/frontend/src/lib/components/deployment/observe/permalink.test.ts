import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momentLink, readMoment } from './permalink';

test('a moment link round-trips its window, crosshair and panel', () => {
	const at = Date.UTC(2026, 9, 28, 14, 2);
	const link = momentLink('https://orchard.my/hq/deployments/abc?tab=overview&range=7d', {
		at,
		panel: 'panel-error-rate',
		now: at + 3_600_000
	});
	const url = new URL(link);
	assert.equal(url.searchParams.get('tab'), 'observe');
	assert.equal(url.searchParams.get('range'), null);
	const m = readMoment(url);
	assert.equal(m.at, at);
	assert.equal(m.from, at - 15 * 60_000);
	assert.equal(m.to, at + 15 * 60_000);
	assert.equal(m.panel, 'panel-error-rate');
});

test('the window never reaches past now and a broken window is ignored', () => {
	const at = Date.UTC(2026, 9, 28, 14, 2);
	const m = readMoment(new URL(momentLink('https://x.test/a', { at, now: at + 60_000 })));
	assert.equal(m.to, at + 60_000);
	assert.deepEqual(readMoment(new URL('https://x.test/a?from=10&to=5')).from, null);
});
