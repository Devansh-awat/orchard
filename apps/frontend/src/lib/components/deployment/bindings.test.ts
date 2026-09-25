import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	autoEnvKey,
	isResourceRef,
	refFor,
	refLabel,
	refParts,
	suggestedKey,
	type Binding,
	type BindingOption
} from './bindings';

const db: Binding = {
	id: 'b1',
	name: 'db',
	resourceType: 'database',
	resourceId: 'x',
	resource: { name: 'Midnight', status: 'ready' },
	endpoint: 'host:5432',
	fields: ['connection_string', 'host'],
	usedBy: [],
	createdAt: ''
};
const api: Binding = { ...db, id: 'b2', name: 'api', resourceType: 'deployment' };

test('a reference is told apart from a literal', () => {
	assert.equal(isResourceRef('${{resource.db.connection_string}}'), true);
	assert.equal(isResourceRef('${{ resource.db.host }}'), true);
	assert.equal(isResourceRef('postgresql://app:pw@host/db'), false);
	assert.equal(isResourceRef('${{shared.KEY}}'), false);
});

test('a reference reads as the resource and field it points at', () => {
	assert.deepEqual(refParts(refFor('db', 'host')), { binding: 'db', field: 'host' });
	assert.equal(
		refLabel('${{resource.db.connection_string}}', [db]),
		'Midnight · Connection string'
	);
	assert.equal(refLabel('${{resource.cache.url}}', [db]), 'cache · URL');
	assert.equal(refLabel('literal', [db]), null);
});

test('suggested keys read like the variables people already write', () => {
	assert.equal(suggestedKey(db, 'connection_string', []), 'DATABASE_URL');
	assert.equal(suggestedKey(db, 'connection_string', ['DATABASE_URL']), 'DB_URL');
	assert.equal(suggestedKey(db, 'host', []), 'DB_HOST');
	assert.equal(suggestedKey(db, 'host', ['DB_HOST']), 'DB_HOST_2');
	assert.equal(suggestedKey(api, 'url', []), 'API_URL');
});

test('connecting adds the obvious variable only while its key is free', () => {
	const dbOption: BindingOption = {
		resourceType: 'database',
		resourceId: 'x',
		name: 'Midnight',
		status: 'ready',
		endpoint: null,
		suggestedName: 'midnight'
	};
	const appOption: BindingOption = {
		...dbOption,
		resourceType: 'deployment',
		suggestedName: 'api'
	};
	assert.equal(autoEnvKey(dbOption, []), 'DATABASE_URL');
	assert.equal(autoEnvKey(dbOption, ['DATABASE_URL']), null);
	assert.equal(autoEnvKey(appOption, []), 'API_URL');
});
