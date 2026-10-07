import test from 'node:test';
import assert from 'node:assert/strict';
import { settleResize } from './fit';

test('an unmeasurable host proposes nothing and no resize happens', () => {
	assert.equal(settleResize({ cols: 80, rows: 24 }, undefined), null);
	assert.equal(settleResize({ cols: 80, rows: 24 }, { cols: NaN, rows: 10 }), null);
	assert.equal(settleResize({ cols: 80, rows: 24 }, { cols: 1, rows: 10 }), null);
	assert.equal(settleResize({ cols: 80, rows: 24 }, { cols: 10, rows: 0 }), null);
});

test('the same size settles to no resize', () => {
	assert.equal(settleResize({ cols: 120, rows: 40 }, { cols: 120, rows: 40 }), null);
	assert.equal(settleResize({ cols: 120, rows: 40 }, { cols: 120.9, rows: 40.2 }), null);
});

test('a changed size is floored and applied once', () => {
	assert.deepEqual(settleResize({ cols: 80, rows: 24 }, { cols: 133.7, rows: 41.9 }), {
		cols: 133,
		rows: 41
	});
});
