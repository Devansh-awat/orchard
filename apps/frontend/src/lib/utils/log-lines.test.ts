import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildLogLines,
	guessLevel,
	htmlToText,
	leadingTime,
	textLogLines,
	withTimes
} from './log-lines.ts';

test('plain text keeps what is shown, minus markup', () => {
	assert.equal(htmlToText('<span class="x">a &lt;b&gt; &amp; c</span>'), 'a <b> & c');
});

test('a leading ISO timestamp becomes the line time', () => {
	assert.equal(
		leadingTime('2026-10-28T12:00:01.500Z GET /'),
		Date.parse('2026-10-28T12:00:01.500Z')
	);
	assert.equal(leadingTime('GET / 200'), null);
});

test('levels are guessed from the words people log, not from inside identifiers', () => {
	assert.equal(guessLevel('ERROR -- : PATCH /api/me 500'), 'error');
	assert.equal(guessLevel('[warn] slow query'), 'warn');
	assert.equal(guessLevel('Traceback (most recent call last):'), 'error');
	assert.equal(guessLevel('INFO -- : PrismaClientKnownRequestError handled'), undefined);
	assert.equal(guessLevel('0 errors found'), undefined);
});

test('runtime text lines carry their time and plain text', () => {
	const lines = textLogLines('2026-10-28T12:00:00Z hello\n\nsecond line');
	assert.equal(lines.length, 2);
	assert.equal(lines[0].ts, Date.parse('2026-10-28T12:00:00Z'));
	assert.match(lines[0].text ?? '', /hello/);
	assert.equal(lines[1].ts, null);
	assert.deepEqual(withTimes(lines), [lines[0].ts, lines[0].ts]);
});

test('build logs become one stream with the step as the source', () => {
	const raw = [
		'[1761652800000] [INFO] Waiting for build job',
		'[1761652801000] [INFO] #5 [builder 2/4] RUN pnpm install --frozen-lockfile',
		'[1761652802000] [INFO] #5 0.512 Progress: resolved 812',
		'[1761652803000] [INFO] #5 ERROR: process "/bin/sh -c pnpm install" did not complete',
		'[1761652804000] [ERROR] Build failed'
	].join('\n');
	const lines = buildLogLines(raw);
	assert.equal(lines.length, 5);
	assert.equal(lines[0].source, 'Orchard');
	assert.equal(lines[1].source, '[builder 2/4] RUN pnpm install --frozen-lockfile');
	assert.equal(lines[2].source, lines[1].source);
	assert.equal(lines[3].level, 'error');
	assert.equal(lines[4].level, 'error');
	assert.equal(lines[2].ts, 1761652802000);
	assert.match(lines[2].text ?? '', /Progress: resolved 812/);
	assert.doesNotMatch(lines[2].text ?? '', /1761652802000/);
});

test('duplicate lines still get unique keys', () => {
	const lines = textLogLines('same\nsame');
	assert.notEqual(lines[0].key, lines[1].key);
});
