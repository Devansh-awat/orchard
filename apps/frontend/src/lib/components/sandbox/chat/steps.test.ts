import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtElapsed, plainLine, planLabel, stepLabel } from './steps';
import { transcriptFileName, transcriptMarkdown } from './transcript-text';
import type { OcMessage } from '../opencode';

test('fmtElapsed ticks in whole seconds, then minutes, then hours', () => {
	assert.equal(fmtElapsed(0), '0s');
	assert.equal(fmtElapsed(48_900), '48s');
	assert.equal(fmtElapsed(322_800), '5m 22s');
	assert.equal(fmtElapsed(3_840_000), '1h 4m');
	assert.equal(fmtElapsed(-5), '0s');
});

test('stepLabel prefers a bash description and keeps the command as the arg', () => {
	assert.deepEqual(
		stepLabel({
			name: 'Bash',
			input: { command: 'pnpm test', description: 'run the unit tests' },
			summary: 'pnpm test',
			status: 'completed'
		}),
		{ title: 'Run the unit tests', arg: 'pnpm test' }
	);
	assert.deepEqual(
		stepLabel({ name: 'Bash', input: { command: 'ls' }, summary: 'ls', status: 'running' }),
		{ title: 'Running', arg: 'ls' }
	);
	assert.deepEqual(
		stepLabel({ name: 'Read', input: {}, summary: 'turns.ts', status: 'completed' }),
		{ title: 'Read', arg: 'turns.ts' }
	);
	assert.deepEqual(stepLabel({ name: 'mcp_thing', input: {}, summary: '', status: null }), {
		title: 'mcp_thing',
		arg: null
	});
});

test('planLabel strips the created prefix and extension', () => {
	assert.equal(planLabel('1728000000000-fix-login-flow.md'), 'Fix login flow');
	assert.equal(planLabel('.opencode/plans/2026-10-08T12-30-00-rework-chat.md'), 'Rework chat');
	assert.equal(planLabel('notes.md'), 'Notes');
});

test('plainLine flattens the first meaningful markdown line', () => {
	assert.equal(plainLine('```ts\ncode\n```'), 'code');
	assert.equal(plainLine('- [link](http://x) and `code`'), 'link and code');
	assert.equal(plainLine('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
});

test('transcriptMarkdown keeps prompts, replies and tool one-liners', () => {
	const messages = [
		{
			info: { id: 'm1', sessionID: 's', role: 'user', time: { created: 1 } },
			parts: [
				{ id: 'p1', sessionID: 's', messageID: 'm1', type: 'text', text: 'fix it' },
				{ id: 'p2', sessionID: 's', messageID: 'm1', type: 'text', text: 'hidden', synthetic: true }
			]
		},
		{
			info: { id: 'm2', sessionID: 's', role: 'assistant', time: { created: 2 } },
			parts: [
				{
					id: 'p3',
					sessionID: 's',
					messageID: 'm2',
					type: 'tool',
					tool: 'bash',
					state: { status: 'completed', input: { command: 'pnpm `test`' } }
				},
				{
					id: 'p4',
					sessionID: 's',
					messageID: 'm2',
					type: 'tool',
					tool: 'read',
					state: { status: 'completed', input: { filePath: '/a/b.ts' } }
				},
				{ id: 'p5', sessionID: 's', messageID: 'm2', type: 'text', text: 'Fixed.' }
			]
		}
	] as OcMessage[];
	assert.equal(
		transcriptMarkdown('Login bug', messages),
		[
			'# Chat transcript: Login bug',
			'',
			'## User',
			'',
			'fix it',
			'',
			'## Assistant',
			'',
			"- bash: `pnpm 'test'`",
			'- read: `/a/b.ts`',
			'',
			'Fixed.',
			''
		].join('\n')
	);
	assert.match(transcriptMarkdown('', []), /no messages yet/);
	assert.equal(transcriptFileName('Fix the Login!'), 'chat-fix-the-login.md');
});
