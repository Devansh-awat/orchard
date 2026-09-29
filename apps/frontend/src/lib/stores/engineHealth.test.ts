import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, CONFIRM_MS, type Settled } from './engineHealth.settle';

const healthy = { stale: false, shards: [] };
const down = { stale: true, shards: [{ shard: 'pods', holder: null, stale: true }] };
const quiet: Settled = { shown: healthy, pendingSince: null };

test('a single stale report does not show the banner', () => {
	const next = settle(quiet, down, 1000);
	assert.equal(next.shown.stale, false);
	assert.equal(next.pendingSince, 1000);
});

test('stale that persists past the confirm window shows the banner', () => {
	const pending = settle(quiet, down, 1000);
	const still = settle(pending, down, 1000 + CONFIRM_MS);
	assert.equal(still.shown.stale, true);
	assert.equal(still.pendingSince, null);
});

test('a recovery inside the window cancels the pending banner', () => {
	const pending = settle(quiet, down, 1000);
	const back = settle(pending, healthy, 4000);
	assert.equal(back.shown.stale, false);
	assert.equal(back.pendingSince, null);
});

test('once shown, the banner hides the moment the engine is healthy again', () => {
	const shown: Settled = { shown: down, pendingSince: null };
	assert.equal(settle(shown, healthy, 9000).shown.stale, false);
	assert.equal(settle(shown, down, 9000).shown.stale, true);
});
