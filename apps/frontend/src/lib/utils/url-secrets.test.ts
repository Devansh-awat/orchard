import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubUrlSecrets } from './url-secrets';

test('an invite token never reaches analytics', () => {
	const token = 'a'.repeat(64);
	assert.equal(
		scrubUrlSecrets(`https://orchard.test/invite/${token}`),
		'https://orchard.test/invite/redacted'
	);
	assert.equal(
		scrubUrlSecrets(`/apiv1/invitations/${token}/sign-up`),
		'/apiv1/invitations/redacted/sign-up'
	);
	assert.equal(scrubUrlSecrets('/apiv1/invitations/pending'), '/apiv1/invitations/pending');
});
