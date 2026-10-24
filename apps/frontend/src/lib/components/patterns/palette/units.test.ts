import assert from 'node:assert/strict';
import test from 'node:test';
import { convert } from './units';

test('converts bytes across binary and decimal prefixes', () => {
	const c = convert('512mib in gb');
	assert.ok(c);
	assert.equal(c.dimension, 'Memory');
	assert.equal(c.from.text, '512 MiB');
	assert.equal(c.to.value, 0.536870912);
	assert.equal(c.to.unit, 'GB');
	assert.equal(c.copy, '0.536870912');
	assert.equal(convert('1 gib to mib')?.to.value, 1024);
	assert.equal(convert('2 tb in gb')?.to.value, 2000);
	assert.equal(convert('1 tib as gib')?.to.value, 1024);
	assert.equal(convert('1024 b in kib')?.to.value, 1);
	assert.equal(convert('1 kb in b')?.to.value, 1000);
	assert.equal(convert('4Gi in Mi')?.to.value, 4096);
});

test('converts CPU between millicores and cores', () => {
	const c = convert('1500m to cores');
	assert.ok(c);
	assert.equal(c.dimension, 'CPU');
	assert.equal(c.from.text, '1,500 millicores');
	assert.equal(c.to.text, '1.5 cores');
	assert.equal(convert('2 cores in m')?.to.value, 2000);
	assert.equal(convert('1000m in cores')?.to.text, '1 core');
	assert.equal(convert('250 millicores in vcpu')?.to.value, 0.25);
});

test('converts durations', () => {
	const c = convert('90 min in h');
	assert.ok(c);
	assert.equal(c.dimension, 'Duration');
	assert.equal(c.to.text, '1.5 h');
	assert.equal(convert('2d in h')?.to.value, 48);
	assert.equal(convert('1500ms to s')?.to.value, 1.5);
	assert.equal(convert('1 h in s')?.to.value, 3600);
	assert.equal(convert('3 hours -> minutes')?.to.value, 180);
});

test('picks a sensible target when none is given', () => {
	assert.equal(convert('1500m')?.to.text, '1.5 cores');
	assert.equal(convert('2 cores')?.to.text, '2,000 millicores');
	assert.equal(convert('2048mib')?.to.text, '2 GiB');
	assert.equal(convert('512mib')?.to.unit, 'MB');
	assert.equal(convert('90min')?.to.text, '1.5 h');
	assert.equal(convert('45s')?.to.text, '45,000 ms');
	assert.equal(convert('500ms')?.to.text, '0.5 s');
});

test('accepts digit separators', () => {
	assert.equal(convert('1,536 mib in gib')?.to.value, 1.5);
	assert.equal(convert('10_000m in cores')?.to.value, 10);
});

test('refuses mismatched or unknown units', () => {
	for (const input of [
		'512mib in s',
		'5 parsecs',
		'web',
		'api',
		'512',
		'mib in gb',
		'1 gb in gb',
		'1 gb in lightyears'
	]) {
		assert.equal(convert(input), null, input);
	}
});
