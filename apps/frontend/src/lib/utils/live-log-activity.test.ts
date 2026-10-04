import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_LOG_IDLE_MS, watchLiveLogActivity } from './live-log-activity';

class Page extends EventTarget {
	hidden = false;
}

test('idle logs pause once and interaction cannot resume them', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	const page = new Page();
	const pauses: string[] = [];
	watchLiveLogActivity(page, (reason) => pauses.push(reason));
	t.mock.timers.tick(LIVE_LOG_IDLE_MS - 1);
	assert.deepEqual(pauses, []);
	t.mock.timers.tick(1);
	assert.deepEqual(pauses, ['idle']);
	page.dispatchEvent(new Event('pointerdown'));
	t.mock.timers.tick(LIVE_LOG_IDLE_MS);
	assert.deepEqual(pauses, ['idle']);
});

test('user interaction extends the idle deadline', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	const page = new Page();
	const pauses: string[] = [];
	watchLiveLogActivity(page, (reason) => pauses.push(reason));
	t.mock.timers.tick(LIVE_LOG_IDLE_MS / 2);
	page.dispatchEvent(new Event('keydown'));
	t.mock.timers.tick(LIVE_LOG_IDLE_MS / 2);
	assert.deepEqual(pauses, []);
	t.mock.timers.tick(LIVE_LOG_IDLE_MS / 2);
	assert.deepEqual(pauses, ['idle']);
});

test('hiding the tab pauses immediately and returning does not resume', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	const page = new Page();
	const pauses: string[] = [];
	watchLiveLogActivity(page, (reason) => pauses.push(reason));
	page.hidden = true;
	page.dispatchEvent(new Event('visibilitychange'));
	assert.deepEqual(pauses, ['hidden']);
	page.hidden = false;
	page.dispatchEvent(new Event('visibilitychange'));
	t.mock.timers.tick(LIVE_LOG_IDLE_MS);
	assert.deepEqual(pauses, ['hidden']);
});

test('starting in a hidden tab pauses without waiting', () => {
	const page = new Page();
	page.hidden = true;
	const pauses: string[] = [];
	const cleanup = watchLiveLogActivity(page, (reason) => pauses.push(reason));
	assert.deepEqual(pauses, ['hidden']);
	cleanup();
});

test('cleanup removes the timer and listeners', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	const page = new Page();
	const pauses: string[] = [];
	const cleanup = watchLiveLogActivity(page, (reason) => pauses.push(reason));
	cleanup();
	page.hidden = true;
	page.dispatchEvent(new Event('visibilitychange'));
	t.mock.timers.tick(LIVE_LOG_IDLE_MS);
	assert.deepEqual(pauses, []);
});
