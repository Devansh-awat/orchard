import test from 'node:test';
import assert from 'node:assert/strict';
import {
	REPO_EMOJI,
	REPO_ICON_LUCIDE,
	githubAvatarUrl,
	isRepoEmoji,
	repoIconLabel,
	repoIconOf
} from './repo-icon';

test('every emoji offered in the picker is one the server accepts', () => {
	assert.equal(REPO_EMOJI.length, 20);
	for (const emoji of REPO_EMOJI) assert.ok(isRepoEmoji(emoji), emoji);
});

test('the emoji field takes exactly one emoji', () => {
	for (const ok of ['🚀', '❤️', '👍🏽', '🏳️‍🌈', '🇳🇱', '🧑‍💻']) assert.ok(isRepoEmoji(ok), ok);
	for (const bad of ['', 'a', '🚀🚀', '🚀 ', '1', '#', '👨‍👩‍👧‍👦', '\n']) {
		assert.equal(isRepoEmoji(bad), false, JSON.stringify(bad));
	}
});

test('stored icons resolve to what the tile draws', () => {
	const gh = { owner: 'LeafdTK', name: 'orchard' };
	assert.deepEqual(repoIconOf('lucide:rocket', null), { kind: 'lucide', name: 'rocket' });
	assert.deepEqual(repoIconOf('lucide:skull', null), { kind: 'initial' });
	assert.deepEqual(repoIconOf('🌱', null), { kind: 'emoji', value: '🌱' });
	assert.deepEqual(repoIconOf('github', gh), { kind: 'github', owner: 'LeafdTK' });
	assert.deepEqual(repoIconOf('github', null), { kind: 'initial' });
	assert.deepEqual(repoIconOf('github', { owner: '../x', name: 'y' }), { kind: 'initial' });
	assert.deepEqual(repoIconOf(null, gh), { kind: 'initial' });
	assert.deepEqual(repoIconOf('<b>', gh), { kind: 'initial' });
});

test('avatar urls and labels', () => {
	assert.equal(githubAvatarUrl('LeafdTK'), 'https://github.com/LeafdTK.png?size=64');
	assert.equal(repoIconLabel('gamepad-2'), 'Gamepad 2');
	assert.equal(REPO_ICON_LUCIDE.length, 20);
});
