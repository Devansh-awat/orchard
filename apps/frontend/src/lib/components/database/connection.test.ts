import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatConnection, parsePublicAddress } from './connection';

const HOSTNAME =
	'postgresql://u:••••••••@db.example.com:31577/app?sslmode=verify-full&sslrootcert=system';

test('reads the public address the server computed', () => {
	assert.deepEqual(parsePublicAddress(HOSTNAME), {
		host: 'db.example.com',
		port: '31577',
		query: 'sslmode=verify-full&sslrootcert=system'
	});
	assert.deepEqual(parsePublicAddress('postgresql://u:x@1.2.3.4:31000/app?sslmode=require'), {
		host: '1.2.3.4',
		port: '31000',
		query: 'sslmode=require'
	});
	assert.equal(parsePublicAddress(null), null);
});

test('public connections keep their tls settings in every format', () => {
	const target = {
		user: 'u',
		host: '1.2.3.4',
		port: '31000',
		database: 'app',
		query: 'sslmode=require'
	};
	assert.equal(
		formatConnection('uri', target, 'pw'),
		'postgresql://u:pw@1.2.3.4:31000/app?sslmode=require'
	);
	assert.equal(
		formatConnection('psql', target, 'pw'),
		'psql "postgresql://u:pw@1.2.3.4:31000/app?sslmode=require"'
	);
	assert.equal(
		formatConnection('env', target, 'pw'),
		'DATABASE_URL="postgresql://u:pw@1.2.3.4:31000/app?sslmode=require"'
	);
	assert.equal(
		formatConnection('jdbc', target, 'pw'),
		'jdbc:postgresql://1.2.3.4:31000/app?user=u&password=pw&sslmode=require'
	);
});

test('jdbc verifies a public hostname through the java trust store', () => {
	const target = {
		user: 'u',
		host: 'db.example.com',
		port: '31577',
		database: 'app',
		query: 'sslmode=verify-full&sslrootcert=system'
	};
	assert.equal(
		formatConnection('jdbc', target, 'pw'),
		'jdbc:postgresql://db.example.com:31577/app?user=u&password=pw&sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory'
	);
});

test('private connections stay plain', () => {
	const target = { user: 'u', host: 'pg-rw.ns.svc', port: 5432, database: 'app' };
	assert.equal(formatConnection('uri', target, 'pw'), 'postgresql://u:pw@pg-rw.ns.svc:5432/app');
	assert.equal(
		formatConnection('jdbc', target, 'pw'),
		'jdbc:postgresql://pg-rw.ns.svc:5432/app?user=u&password=pw'
	);
});
