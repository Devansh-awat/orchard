import test from 'node:test';
import assert from 'node:assert/strict';
import {
	claimForMessage,
	claimOwnPrompt,
	placeUserPart,
	type ClaimableEntry
} from './prompt-claims';

const SEB = 'u_seb';
const annabel = { id: 'u_annabel' };
const seb = { id: SEB };

test('a remote prompt shows up live even while my own prompt is still unconfirmed', () => {
	const entries: ClaimableEntry[] = [
		{ kind: 'user', text: 'earlier', messageID: 'msg_1' },
		{ kind: 'text', text: 'answer' },
		{ kind: 'user', text: 'fix the tests', local: true }
	];
	assert.equal(claimForMessage(entries, 'msg_a', annabel, SEB), null);
	assert.deepEqual(
		placeUserPart(entries, { messageID: 'msg_a', text: 'rename the button' }, annabel, SEB),
		{ push: true }
	);
});

test('my own prompt is claimed by id, by text, or by the next message update', () => {
	const entries: ClaimableEntry[] = [
		{ kind: 'user', text: 'one', local: true },
		{ kind: 'user', text: 'two', local: true }
	];
	assert.equal(claimOwnPrompt(entries, 'msg_1'), 0);
	assert.deepEqual(placeUserPart(entries, { messageID: 'msg_2', text: ' two ' }, seb, SEB), {
		claim: 1
	});
	assert.deepEqual(placeUserPart(entries, { messageID: 'msg_2', text: 'two' }, null, SEB), {
		claim: 1
	});
	assert.equal(claimForMessage(entries, 'msg_2', null, SEB), 1);
	assert.equal(claimForMessage(entries, 'msg_2', seb, SEB), 1);
});

test('an unattributed prompt arriving before the live attribution still renders', () => {
	const quiet: ClaimableEntry[] = [{ kind: 'user', text: 'mine', messageID: 'msg_1' }];
	assert.equal(claimForMessage(quiet, 'msg_a', null, SEB), null);
	assert.deepEqual(placeUserPart(quiet, { messageID: 'msg_a', text: 'theirs' }, null, SEB), {
		push: true
	});
	assert.equal(placeUserPart(quiet, { messageID: 'msg_1', text: 'mine' }, null, SEB), null);
});

test('a waiting local prompt holds back an unknown part instead of duplicating it', () => {
	const entries: ClaimableEntry[] = [{ kind: 'user', text: '/review', local: true }];
	assert.equal(
		placeUserPart(entries, { messageID: 'msg_x', text: 'expanded template' }, null, SEB),
		null
	);
});
