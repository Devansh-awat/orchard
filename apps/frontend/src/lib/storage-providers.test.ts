import test from 'node:test';
import assert from 'node:assert/strict';
import { storageConnection } from './storage-providers';

const keys = { accessKeyId: ' AK ', secretAccessKey: 'SK' };

test('each provider is a pre-filled endpoint, region and addressing style', () => {
	const aws = storageConnection('aws', 'eu-west-1', 'mine', keys);
	assert.equal(aws.endpoint, 'https://s3.eu-west-1.amazonaws.com');
	assert.equal(aws.region, 'eu-west-1');
	assert.equal(aws.pathStyle, 'false');
	const r2 = storageConnection('r2', 'abc', 'mine', keys);
	assert.equal(r2.endpoint, 'https://abc.r2.cloudflarestorage.com');
	assert.equal(r2.region, 'auto');
	assert.equal(r2.pathStyle, 'true');
	const b2 = storageConnection('b2', '', 'mine', keys);
	assert.equal(b2.endpoint, 'https://s3.us-west-004.backblazeb2.com');
	const hetzner = storageConnection('hetzner', 'hel1', 'mine', keys);
	assert.equal(hetzner.endpoint, 'https://hel1.your-objectstorage.com');
	assert.equal(hetzner.region, 'hel1');
});

test('a custom service keeps what was typed, and one bucket covers backups and uploads', () => {
	const other = storageConnection('other', '', ' mine ', {
		...keys,
		endpoint: ' http://minio.example.com:9000 ',
		region: ''
	});
	assert.equal(other.endpoint, 'http://minio.example.com:9000');
	assert.equal(other.region, 'us-east-1');
	assert.equal(other.pathStyle, 'true');
	assert.equal(other.backupBucket, 'mine');
	assert.equal(other.bucketName, 'mine');
	assert.equal(other.accessKeyId, 'AK');
});
