import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSycophancy } from './sycophancy';

test('an opener at the start of a message goes and the next sentence is capitalised', () => {
	assert.equal(
		stripSycophancy("You're absolutely right! The bug is in auth."),
		'The bug is in auth.'
	);
	assert.equal(stripSycophancy("You're absolutely right. the fix is small."), 'The fix is small.');
	assert.equal(stripSycophancy('You are absolutely right, it was the cache.'), 'It was the cache.');
	assert.equal(stripSycophancy('Absolutely right! Let me fix it.'), 'Let me fix it.');
	assert.equal(stripSycophancy("YOU'RE ABSOLUTELY RIGHT!! moving on"), 'Moving on');
	assert.equal(
		stripSycophancy("You're absolutely right — that check is inverted."),
		'That check is inverted.'
	);
});

test('curly apostrophes count too', () => {
	assert.equal(stripSycophancy('You’re absolutely right! Fixed.'), 'Fixed.');
	assert.equal(
		stripSycophancy('Good point. You’re absolutely right, I missed it.'),
		'Good point. I missed it.'
	);
});

test('an opener in the middle of a paragraph is removed at its sentence boundary', () => {
	assert.equal(
		stripSycophancy("Good catch. You're absolutely right! I missed the null case."),
		'Good catch. I missed the null case.'
	);
	assert.equal(
		stripSycophancy("That failed? You're absolutely right, the port was wrong."),
		'That failed? The port was wrong.'
	);
});

test('an opener on its own line, in bold or in a list item is removed', () => {
	assert.equal(
		stripSycophancy("You're absolutely right!\n\nThe fix is below."),
		'The fix is below.'
	);
	assert.equal(
		stripSycophancy("**You're absolutely right!** The fix is below."),
		'The fix is below.'
	);
	assert.equal(
		stripSycophancy("Notes:\n- You're absolutely right, fixed it."),
		'Notes:\n- Fixed it.'
	);
	assert.equal(stripSycophancy('Intro\n\nAbsolutely right. next part'), 'Intro\n\nNext part');
});

test('a phrase that carries meaning or sits inside a sentence is left alone', () => {
	for (const text of [
		"You're absolutely right about the race condition.",
		"I think you're absolutely right.",
		'That is absolutely right for this case.',
		'Nothing to strip here.'
	]) {
		assert.equal(stripSycophancy(text), text);
	}
});

test('code blocks and inline code are never touched', () => {
	const fenced = "```\nYou're absolutely right!\n```";
	assert.equal(stripSycophancy(fenced), fenced);
	const tilde = "~~~ts\n// You're absolutely right! x\n~~~";
	assert.equal(stripSycophancy(tilde), tilde);
	const inline = "Print `You're absolutely right!` here.";
	assert.equal(stripSycophancy(inline), inline);
	assert.equal(
		stripSycophancy('You\'re absolutely right! Run:\n```sh\necho "You\'re absolutely right!"\n```'),
		'Run:\n```sh\necho "You\'re absolutely right!"\n```'
	);
	assert.equal(
		stripSycophancy("Ran `make`. You're absolutely right, it passes."),
		'Ran `make`. It passes.'
	);
});

test('a message that is nothing but the opener is kept as is', () => {
	assert.equal(stripSycophancy("You're absolutely right!"), "You're absolutely right!");
	assert.equal(stripSycophancy(''), '');
});
