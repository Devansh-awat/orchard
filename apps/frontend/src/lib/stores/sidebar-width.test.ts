import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidebarWidthPx, SIDEBAR_COLLAPSED_W, SIDEBAR_EXPANDED_W } from './sidebar-width';

test('the sidebar takes no room on mobile, whatever its collapsed state', () => {
	assert.equal(sidebarWidthPx(false, true), 0);
	assert.equal(sidebarWidthPx(true, true), 0);
});

test('on desktop the width follows the rail', () => {
	assert.equal(sidebarWidthPx(false, false), SIDEBAR_EXPANDED_W);
	assert.equal(sidebarWidthPx(true, false), SIDEBAR_COLLAPSED_W);
});
