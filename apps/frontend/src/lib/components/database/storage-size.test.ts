import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStorageBytes, storageExpansionError, totalAllocatedStorage } from './storage-size';

test('parses Kubernetes storage quantities across units', () => {
	assert.equal(parseStorageBytes('10240Mi'), parseStorageBytes('10Gi'));
	assert.equal(parseStorageBytes('1Ti'), 1024n ** 4n);
});

test('rejects malformed and zero quantities', () => {
	for (const value of ['', '0Gi', '-1Gi', '1.5Gi', '10GB', 'Gi']) {
		assert.equal(parseStorageBytes(value), null);
	}
});

test('requires a grow-only size within the 200Gi limit', () => {
	assert.equal(storageExpansionError('10Gi', '10240Mi'), 'Enter a size larger than 10Gi.');
	assert.equal(storageExpansionError('10Gi', '9Gi'), 'Enter a size larger than 10Gi.');
	assert.equal(storageExpansionError('10Gi', '201Gi'), "Storage can't exceed 200Gi.");
	assert.equal(storageExpansionError('10Gi', '11Gi'), null);
});

test('calculates total allocated storage across instances', () => {
	assert.equal(totalAllocatedStorage('16Gi', 3), '48Gi');
	assert.equal(totalAllocatedStorage('512Mi', 2), '1Gi');
});
