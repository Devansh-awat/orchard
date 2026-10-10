import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEntry, FeedItem } from './session-store.svelte';
import { buildChunks, liveStep, liveWindow, railMarks, type AgentBlock } from './turns';

let seq = 0;

function prompt(text: string, time: number): FeedItem {
	seq += 1;
	return {
		type: 'prompt',
		key: `u${seq}`,
		entry: { kind: 'user', key: `u${seq}`, text, time },
		index: seq,
		author: null,
		own: true,
		grouped: false
	};
}

function comment(body: string, time: number): FeedItem {
	seq += 1;
	return {
		type: 'comment',
		key: `c${seq}`,
		comment: {
			id: `c${seq}`,
			author: { id: 'mate', name: 'Mate' },
			body,
			createdAt: time,
			sessionId: 's'
		},
		own: false,
		grouped: false
	};
}

function entry(value: ChatEntry): FeedItem {
	seq += 1;
	return { type: 'entry', key: value.key, entry: value, index: seq };
}

function tool(key: string, status: 'running' | 'completed', time: number): FeedItem {
	return entry({
		kind: 'tool',
		key,
		id: key,
		name: 'Bash',
		input: { command: 'pnpm test', description: 'run tests' },
		output: null,
		summary: 'pnpm test',
		title: 'pnpm test',
		diff: null,
		status,
		failed: false,
		expanded: null,
		time
	});
}

function text(key: string, body: string, time: number): FeedItem {
	return entry({ kind: 'text', key, text: body, time });
}

function result(key: string, time: number): FeedItem {
	return entry({ kind: 'result', key, cost: null, duration: 4000, files: [], time });
}

function rowTypes(feed: FeedItem[], busy: boolean): string[][] {
	return buildChunks(feed, busy).map((chunk) => chunk.rows.map((row) => row.type));
}

test('a comment that lands mid-turn renders after the live turn, not inside it', () => {
	const feed = [
		prompt('fix the build', 1000),
		tool('t1', 'completed', 1100),
		comment('hi', 1200),
		tool('t2', 'running', 1300)
	];
	const chunks = buildChunks(feed, true);
	assert.equal(chunks.length, 1);
	assert.deepEqual(
		chunks[0].rows.map((row) => row.type),
		['prompt', 'agent', 'comment']
	);
	const block = chunks[0].rows[1] as AgentBlock;
	assert.equal(block.steps.length, 2);
	assert.equal(block.result, null);
	assert.equal(block.start, 1000);
});

test('a busy turn with no output yet is a live block keyed by its prompt', () => {
	const ask = prompt('hello', 5000);
	const before = buildChunks([ask, comment('watching', 5100)], true);
	const block = before[0].rows[1] as AgentBlock;
	assert.equal(block.type, 'agent');
	assert.equal(block.key, `b:${ask.key}`);
	assert.equal(before[0].rows[2].type, 'comment');
	const after = buildChunks([ask, tool('t9', 'running', 5200)], true);
	assert.equal(after[0].rows[1].key, block.key);
});

test('held comments are released after the turn result', () => {
	const feed = [
		prompt('go', 1),
		tool('a', 'completed', 2),
		comment('nice', 3),
		text('x', 'done', 4),
		result('r', 5),
		comment('after', 6)
	];
	assert.deepEqual(rowTypes(feed, false), [['prompt', 'agent', 'comment', 'comment']]);
	const block = buildChunks(feed, false)[0].rows[1] as AgentBlock;
	assert.equal(block.answer.length, 1);
	assert.ok(block.result);
});

test('every prompt after an answered turn starts its own chunk', () => {
	const feed = [
		prompt('one', 1),
		text('a', 'first', 2),
		result('r1', 3),
		comment('chat', 4),
		prompt('two', 5),
		text('b', 'second', 6),
		result('r2', 7)
	];
	assert.deepEqual(rowTypes(feed, false), [
		['prompt', 'agent', 'comment'],
		['prompt', 'agent']
	]);
});

test('an idle prompt with no output and no busy flag gets no phantom block', () => {
	assert.deepEqual(rowTypes([prompt('lost', 1), comment('hm', 2)], false), [['prompt', 'comment']]);
});

test('busy after a finished turn shows a live block at the end', () => {
	const feed = [prompt('one', 1), text('a', 'x', 2), result('r', 3), comment('c', 4)];
	const rows = buildChunks(feed, true).flatMap((chunk) => chunk.rows);
	assert.equal(rows[rows.length - 1].type, 'agent');
	assert.equal((rows[rows.length - 1] as AgentBlock).result, null);
});

test('liveStep names what the turn is doing right now', () => {
	const chunks = buildChunks([prompt('go', 1), tool('t', 'running', 2)], true);
	assert.equal(liveStep(chunks[0].rows[1] as AgentBlock), 'Running pnpm test');
	const idle = buildChunks([prompt('go', 1)], true);
	assert.equal(liveStep(idle[0].rows[1] as AgentBlock), 'Thinking');
	const between = buildChunks([prompt('go', 1), tool('t', 'completed', 2)], true);
	assert.equal(liveStep(between[0].rows[1] as AgentBlock), 'Planning the next step');
});

test('liveWindow keeps the newest steps and counts the rest', () => {
	assert.deepEqual(liveWindow([1, 2, 3], 5), { hidden: 0, shown: [1, 2, 3] });
	assert.deepEqual(liveWindow([1, 2, 3, 4, 5], 2), { hidden: 3, shown: [4, 5] });
});

test('railMarks gives one mark per row with a readable preview', () => {
	const feed = [
		prompt('## Fix **the** build', 1),
		tool('t', 'completed', 2),
		text('a', 'All green now.\n\nMore detail', 3),
		result('r', 4),
		comment('nice work', 5)
	];
	const chunks = buildChunks(feed, false);
	const marks = railMarks(chunks, null);
	assert.deepEqual(
		marks.map((m) => [m.kind, m.who, m.preview]),
		[
			['prompt', 'You', 'Fix the build'],
			['agent', 'Agent', 'All green now.'],
			['comment', 'Mate', 'nice work']
		]
	);
});
