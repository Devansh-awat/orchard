import assert from 'node:assert/strict';
import test from 'node:test';
import {
	componentCopy,
	durationLabel,
	overallCopy,
	statusApiUrl,
	uptimeLabel
} from './status-page';

test('the page reads its data from the apex api when served on a status host', () => {
	assert.equal(statusApiUrl('acme', 'orchard.my', 'orchard.my'), '/apiv1/status/acme');
	assert.equal(statusApiUrl('acme', 'localhost', ''), '/apiv1/status/acme');
	assert.equal(
		statusApiUrl('acme', 'acme-status.orchard.my', 'orchard.my'),
		'https://orchard.my/apiv1/status/acme'
	);
	assert.equal(statusApiUrl('a b', 'orchard.my', 'orchard.my'), '/apiv1/status/a%20b');
});

test('a status host reads from the platform origin when the api is not on the apex', () => {
	assert.equal(
		statusApiUrl(
			'acme',
			'acme-status.apps.example.com',
			'apps.example.com',
			'https://orchard.example.com'
		),
		'https://orchard.example.com/apiv1/status/acme'
	);
	assert.equal(
		statusApiUrl('acme', 'orchard.example.com', 'apps.example.com', 'https://orchard.example.com'),
		'/apiv1/status/acme'
	);
});

test('copy is the canonical status page vocabulary', () => {
	assert.equal(overallCopy('operational').label, 'All systems operational');
	assert.equal(overallCopy('degraded').label, 'Partial outage');
	assert.equal(overallCopy('down').label, 'Major outage');
	assert.equal(componentCopy('maintenance').tone, 'info');
	assert.equal(componentCopy('unknown').label, 'No data');
});

test('durations and uptime round the way a person reads them', () => {
	const now = Date.parse('2026-09-25T12:00:00Z');
	assert.equal(durationLabel('2026-09-25T11:30:00Z', null, now), '30 min');
	assert.equal(durationLabel('2026-09-25T09:15:00Z', '2026-09-25T11:30:00Z', now), '2 h 15 min');
	assert.equal(durationLabel('2026-09-23T10:00:00Z', null, now), '2 d 2 h');
	assert.equal(uptimeLabel(100), '100%');
	assert.equal(uptimeLabel(99.996), '100%');
	assert.equal(uptimeLabel(99.12), '99.12%');
});
