import assert from 'node:assert/strict';
import test from 'node:test';
import { calculate, evaluate, formatNumber } from './calc';

const value = (input: string) => evaluate(input)?.value;

test('respects precedence and associativity', () => {
	assert.equal(value('(512*3)/4+2^5'), 416);
	assert.equal(value('1 + 2 * 3'), 7);
	assert.equal(value('(1 + 2) * 3'), 9);
	assert.equal(value('2^3^2'), 512);
	assert.equal(value('10 - 4 - 3'), 3);
	assert.equal(value('100 / 10 / 5'), 2);
});

test('handles unary minus around powers', () => {
	assert.equal(value('-2^2'), -4);
	assert.equal(value('(-2)^2'), 4);
	assert.equal(value('2^-1'), 0.5);
	assert.equal(value('--3'), 3);
	assert.equal(value('3 - -3'), 6);
});

test('reads decimals and scientific notation', () => {
	assert.equal(value('.5 + 1.25'), 1.75);
	assert.equal(value('1e3 * 2'), 2000);
	assert.equal(value('2.5e-1 * 4'), 1);
});

test('treats % as modulo between operands and percent after one', () => {
	assert.equal(value('10 % 3'), 1);
	assert.equal(value('200 * 15%'), 30);
	assert.equal(value('50%'), 0.5);
	assert.equal(value('10 % -3'), 1);
});

test('knows constants and functions', () => {
	assert.equal(value('pi'), Math.PI);
	assert.equal(value('2e'), 2 * Math.E);
	assert.equal(value('2pi'), 2 * Math.PI);
	assert.equal(value('sqrt(16) + 1'), 5);
	assert.equal(value('round(2.567, 2)'), 2.57);
	assert.equal(value('round(2.5)'), 3);
	assert.equal(value('floor(-1.5)'), -2);
	assert.equal(value('ceil(1.2)'), 2);
	assert.equal(value('min(4, 2, 8)'), 2);
	assert.equal(value('max(4, 2, 8)'), 8);
	assert.equal(value('log(1000)'), 3);
	assert.equal(value('log(8, 2)'), 3);
	assert.equal(value('ln(e)'), 1);
	assert.equal(value('2(3 + 4)'), 14);
	assert.equal(value('(1 + 1)(2 + 2)'), 8);
});

test('accepts typographic operators and a trailing equals sign', () => {
	assert.equal(value('6 × 7'), 42);
	assert.equal(value('9 ÷ 3'), 3);
	assert.equal(value('5 − 2'), 3);
	assert.equal(value('2 ** 10'), 1024);
	assert.equal(value('2 + 2 ='), 4);
});

test('rejects anything that is not arithmetic', () => {
	for (const input of [
		'',
		'web',
		'hackclub-site',
		'1 +',
		'(1 + 2',
		'1 + 2)',
		'sqrt 16',
		'sqrt(1, 2)',
		'min()',
		'alert(1)',
		'constructor',
		'constructor(1)',
		'toString(1)',
		'__proto__',
		'__proto__ + 1',
		'1 / 0',
		'sqrt(-1)',
		'2 3',
		'512mib in gb',
		'1;2'
	]) {
		assert.equal(evaluate(input), null, input);
	}
});

test('only offers a calculation when there is something to calculate', () => {
	assert.equal(calculate('42'), null);
	assert.equal(calculate('-7'), null);
	assert.equal(calculate('(5)'), null);
	assert.equal(calculate('pi'), null);
	assert.equal(calculate('e'), null);
	assert.equal(calculate('(512*3)/4+2^5')?.formatted, '416');
	assert.equal(calculate('2pi')?.copy, String(Number((2 * Math.PI).toPrecision(12))));
});

test('formats results for reading and for copying', () => {
	assert.equal(formatNumber(0.1 + 0.2), '0.3');
	assert.equal(formatNumber(1234567.891), '1,234,567.891');
	assert.equal(formatNumber(-0), '0');
	assert.equal(formatNumber(2 ** 64), '1.844674e19');
	assert.equal(formatNumber(1 / 3), '0.3333333333');
	assert.equal(calculate('0.1 + 0.2')?.copy, '0.3');
	assert.equal(calculate('1000 * 1000')?.formatted, '1,000,000');
	assert.equal(calculate('1000 * 1000')?.copy, '1000000');
});
